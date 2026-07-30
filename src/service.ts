/**
 * Owns room-isolated Aomi sessions and pauses each turn at completion or a wallet boundary.
 *
 * A submitted wallet result is retained until Aomi acknowledges it, making a
 * failed callback retry safe from duplicate broadcasts.
 */
import {
	type SendResult,
	Session,
	type WalletRequest,
	type WalletRequestResult,
} from "@aomi-labs/client";
import { type IAgentRuntime, Service } from "@elizaos/core";
import { type AomiConfig, readAomiConfig } from "./config.js";
import { AomiError } from "./errors.js";
import type {
	AomiBoundary,
	AomiPendingOperation,
	AomiSession,
	AomiSessionFactory,
} from "./types.js";
import {
	executeWalletRequest,
	walletRequestPreview,
	walletRequestSupportError,
} from "./wallet.js";
import {
	WALLET_BACKEND_SERVICE_TYPE,
	type WalletBackendServiceLike,
} from "./wallet-backend.js";

export const AOMI_SERVICE_TYPE = "aomi" as const;

// Stop rejecting a backend that keeps re-staging unexecutable requests instead of
// looping forever, and treat sustained poll failures (~10s at the client's 500ms
// interval) as an unreachable backend so a dead turn cannot wedge the room.
const MAX_UNSUPPORTED_REJECTIONS = 5;
const MAX_CONSECUTIVE_POLL_ERRORS = 20;

type SettlementOperation = "confirmation" | "rejection";

interface PendingSettlement {
	readonly operation: SettlementOperation;
	readonly promise: Promise<AomiBoundary>;
}

interface PendingState {
	readonly request: WalletRequest;
	readonly preview: string;
	readonly initiatingSubjectId: string;
	execution?: Promise<WalletRequestResult>;
	settlement?: PendingSettlement;
}

interface RoomConversation {
	readonly session: AomiSession;
	completion?: Promise<SendResult>;
	initiatingSubjectId?: string;
	pending?: PendingState;
}

export interface AomiServiceDependencies {
	readonly createSession: AomiSessionFactory;
	readonly executeWallet: (
		runtime: IAgentRuntime,
		config: AomiConfig,
		request: WalletRequest,
	) => Promise<WalletRequestResult>;
}

export interface AomiServiceStatus {
	readonly apiUrl: string;
	readonly app: string;
	readonly walletReady: boolean;
	readonly evmAddress: string | null;
	readonly solanaAddress: string | null;
	readonly pending: AomiPendingOperation | null;
}

const defaultDependencies: AomiServiceDependencies = {
	createSession: (options, sessionOptions) =>
		new Session(options, sessionOptions),
	executeWallet: executeWalletRequest,
};

export class AomiService extends Service {
	static override serviceType = AOMI_SERVICE_TYPE;

	override capabilityDescription =
		"Room-isolated Aomi on-chain agent sessions with confirmed wallet execution";

	readonly aomiConfig: AomiConfig;

	private readonly conversations = new Map<string, RoomConversation>();

	constructor(
		runtime?: IAgentRuntime,
		aomiConfig?: AomiConfig,
		private readonly dependencies: AomiServiceDependencies = defaultDependencies,
	) {
		super(runtime);
		if (aomiConfig) {
			this.aomiConfig = aomiConfig;
		} else if (runtime) {
			this.aomiConfig = readAomiConfig(runtime);
		} else {
			throw new AomiError(
				"AomiService requires an Eliza runtime when no explicit configuration is supplied.",
				{
					code: "AOMI_RUNTIME_REQUIRED",
					severity: "fatal",
				},
			);
		}
	}

	static override async start(runtime: IAgentRuntime): Promise<AomiService> {
		return new AomiService(runtime, readAomiConfig(runtime));
	}

	async submit(
		roomId: string,
		initiatingSubjectId: string,
		prompt: string,
	): Promise<AomiBoundary> {
		const normalizedPrompt = prompt.trim();
		if (!normalizedPrompt) {
			throw new AomiError("Aomi requires a non-empty request.", {
				code: "AOMI_EMPTY_PROMPT",
				severity: "fatal",
			});
		}

		const reusedConversation = this.conversations.has(roomId);
		let conversation = this.conversation(roomId);
		if (conversation.completion || conversation.pending) {
			throw new AomiError(
				"This room already has an Aomi operation awaiting completion.",
				{
					code: "AOMI_ROOM_BUSY",
					context: { roomId },
					severity: "ephemeral",
				},
			);
		}

		// A fresh turn must not inherit a wallet request left in a reused session by
		// a prior aborted turn; recreate the session so nothing binds this new prompt
		// (and initiating subject) to a stale, previously-staged request.
		if (
			reusedConversation &&
			conversation.session.getPendingRequests().length > 0
		) {
			conversation.session.close();
			this.conversations.delete(roomId);
			conversation = this.conversation(roomId);
		}

		const normalizedSubjectId = initiatingSubjectId.trim();
		if (!normalizedSubjectId) {
			throw new AomiError(
				"Aomi requires an authenticated initiating subject.",
				{
					code: "AOMI_INITIATING_SUBJECT_REQUIRED",
					severity: "fatal",
				},
			);
		}

		conversation.initiatingSubjectId = normalizedSubjectId;
		conversation.session.syncRuntimeOptions({
			app: this.aomiConfig.app,
			applicationId: this.aomiConfig.applicationId,
			apiKey: this.aomiConfig.apiKey,
			userState: this.walletUserState(),
		});
		conversation.completion = conversation.session.send(normalizedPrompt);
		return this.waitForBoundary(roomId, conversation);
	}

	async confirm(
		roomId: string,
		initiatingSubjectId: string,
		requestId?: string,
	): Promise<AomiBoundary> {
		const conversation = this.requiredConversation(roomId);
		const pending = this.requiredPending(
			roomId,
			initiatingSubjectId,
			"confirmation",
		);
		this.assertRequestId(roomId, pending, requestId);
		return this.settle(conversation, pending, "confirmation", () =>
			this.confirmPending(roomId, conversation, pending),
		);
	}

	async reject(
		roomId: string,
		initiatingSubjectId: string,
		reason = "User rejected the wallet request.",
		requestId?: string,
	): Promise<AomiBoundary> {
		const conversation = this.requiredConversation(roomId);
		const pending = this.requiredPending(
			roomId,
			initiatingSubjectId,
			"rejection",
		);
		this.assertRequestId(roomId, pending, requestId);
		return this.settle(conversation, pending, "rejection", () =>
			this.rejectPending(roomId, conversation, pending, reason),
		);
	}

	/**
	 * Memoizes the in-flight settlement so concurrent confirmations share one
	 * wallet execution, but keeps confirmation and rejection distinct: a rejection
	 * must never resolve to a confirmation's outcome (or the caller would report a
	 * broadcast transaction as "rejected"). A failed settlement is cleared so the
	 * user can retry.
	 */
	private async settle(
		conversation: RoomConversation,
		pending: PendingState,
		operation: SettlementOperation,
		run: () => Promise<AomiBoundary>,
	): Promise<AomiBoundary> {
		const existing = pending.settlement;
		if (existing) {
			if (existing.operation === operation) {
				return existing.promise;
			}
			throw new AomiError(
				operation === "rejection"
					? "This Aomi wallet request is already being confirmed."
					: "This Aomi wallet request is already being rejected.",
				{
					code: "AOMI_SETTLEMENT_IN_FLIGHT",
					context: { operation },
					severity: "ephemeral",
				},
			);
		}
		const promise = run();
		pending.settlement = { operation, promise };
		try {
			return await promise;
		} catch (error) {
			if (
				conversation.pending === pending &&
				pending.settlement?.promise === promise
			) {
				pending.settlement = undefined;
			}
			throw error;
		}
	}

	private assertRequestId(
		roomId: string,
		pending: PendingState,
		requestId: string | undefined,
	): void {
		if (requestId !== undefined && pending.request.id !== requestId) {
			throw new AomiError(
				"This Aomi confirmation does not match the pending wallet request.",
				{
					code: "AOMI_CONFIRMATION_REQUEST_MISMATCH",
					context: {
						roomId,
						requestId,
						pendingRequestId: pending.request.id,
					},
					severity: "fatal",
				},
			);
		}
	}

	private toPendingOperation(pending: PendingState): AomiPendingOperation {
		return {
			request: pending.request,
			preview: pending.preview,
			executionReady: pending.execution !== undefined,
		};
	}

	pendingFor(
		roomId: string,
		initiatingSubjectId: string,
	): AomiPendingOperation | null {
		const pending = this.conversations.get(roomId)?.pending;
		if (!pending) return null;
		this.assertInitiatingSubject(
			roomId,
			initiatingSubjectId,
			pending,
			"access",
		);
		return this.toPendingOperation(pending);
	}

	private async confirmPending(
		roomId: string,
		conversation: RoomConversation,
		pending: PendingState,
	): Promise<AomiBoundary> {
		// Retain the execution promise before resolving with Aomi so a failed
		// callback retry cannot broadcast twice.
		pending.execution ??= this.dependencies.executeWallet(
			this.runtime,
			this.aomiConfig,
			pending.request,
		);
		let execution: WalletRequestResult;
		try {
			execution = await pending.execution;
		} catch (error) {
			// Provably pre-broadcast failures (our own validation errors, never the
			// post-broadcast AOMI_SOLANA_TRANSACTION_FAILED) are safe to retry, so
			// drop the cached rejection. Ambiguous transport failures stay cached to
			// preserve the no-double-broadcast guarantee.
			if (
				error instanceof AomiError &&
				error.code !== "AOMI_SOLANA_TRANSACTION_FAILED"
			) {
				pending.execution = undefined;
			}
			throw error;
		}
		await conversation.session.resolve(pending.request.id, execution);
		if (conversation.pending === pending) {
			conversation.pending = undefined;
		}
		return this.waitForBoundary(roomId, conversation);
	}

	private async rejectPending(
		roomId: string,
		conversation: RoomConversation,
		pending: PendingState,
		reason: string,
	): Promise<AomiBoundary> {
		await conversation.session.reject(pending.request.id, reason);
		if (conversation.pending === pending) {
			conversation.pending = undefined;
		}
		return this.waitForBoundary(roomId, conversation);
	}

	private requiredPending(
		roomId: string,
		initiatingSubjectId: string,
		operation: "confirmation" | "rejection",
	): PendingState {
		const pending = this.requiredConversation(roomId).pending;
		if (!pending) {
			throw new AomiError(`No Aomi wallet request is awaiting ${operation}.`, {
				code: "AOMI_NO_PENDING_WALLET_REQUEST",
				context: { roomId },
				severity: "ephemeral",
			});
		}
		this.assertInitiatingSubject(
			roomId,
			initiatingSubjectId,
			pending,
			operation,
		);
		return pending;
	}

	private assertInitiatingSubject(
		roomId: string,
		initiatingSubjectId: string,
		pending: PendingState,
		operation: "access" | "confirmation" | "rejection",
	): void {
		if (pending.initiatingSubjectId !== initiatingSubjectId) {
			throw new AomiError(
				"Only the user who initiated this Aomi wallet request can resolve it.",
				{
					code: "AOMI_CONFIRMATION_SUBJECT_MISMATCH",
					context: { roomId, operation },
					severity: "fatal",
				},
			);
		}
	}

	pending(roomId: string): AomiPendingOperation | null {
		const pending = this.conversations.get(roomId)?.pending;
		return pending ? this.toPendingOperation(pending) : null;
	}

	status(roomId: string, requestingSubjectId?: string): AomiServiceStatus {
		const addresses = this.walletAddresses();
		const pending = this.conversations.get(roomId)?.pending;
		// Only surface the pending preview to its initiator so a shared room cannot
		// leak another user's staged transaction into the planner context.
		const visiblePending =
			pending &&
			(requestingSubjectId === undefined ||
				pending.initiatingSubjectId === requestingSubjectId)
				? this.toPendingOperation(pending)
				: null;
		return {
			apiUrl: this.aomiConfig.apiUrl,
			app: this.aomiConfig.app,
			walletReady: Boolean(addresses.evm || addresses.solana),
			evmAddress: addresses.evm,
			solanaAddress: addresses.solana,
			pending: visiblePending,
		};
	}

	private walletAddresses(): {
		readonly evm: string | null;
		readonly solana: string | null;
	} {
		const service = this.runtime.getService(WALLET_BACKEND_SERVICE_TYPE);
		const backend = (
			service as unknown as WalletBackendServiceLike | null
		)?.getWalletBackendOrNull();
		const addresses = backend?.getAddresses();
		return {
			evm: addresses?.evm ?? null,
			solana: addresses?.solana?.toBase58() ?? null,
		};
	}

	override async stop(): Promise<void> {
		for (const conversation of this.conversations.values()) {
			conversation.session.close();
		}
		this.conversations.clear();
	}

	private conversation(roomId: string): RoomConversation {
		const existing = this.conversations.get(roomId);
		if (existing) return existing;

		const session = this.dependencies.createSession(
			{
				baseUrl: this.aomiConfig.apiUrl,
				apiKey: this.aomiConfig.apiKey,
				logger: {
					debug: (...args: unknown[]) =>
						this.runtime.logger.debug({ roomId, args }, "[AomiService] client"),
				},
			},
			{
				app: this.aomiConfig.app,
				applicationId: this.aomiConfig.applicationId,
				apiKey: this.aomiConfig.apiKey,
				clientType: "elizaos",
				userState: this.walletUserState(),
			},
		);
		const conversation = { session };
		this.conversations.set(roomId, conversation);
		return conversation;
	}

	private requiredConversation(roomId: string): RoomConversation {
		const conversation = this.conversations.get(roomId);
		if (!conversation) {
			throw new AomiError("No Aomi session exists for this room.", {
				code: "AOMI_SESSION_NOT_FOUND",
				context: { roomId },
				severity: "ephemeral",
			});
		}
		return conversation;
	}

	private walletUserState(): Record<string, unknown> {
		const addresses = this.walletAddresses();
		const connected = Boolean(addresses.evm || addresses.solana);
		return {
			connection: { is_connected: connected },
			...(addresses.evm
				? {
						evm: {
							address: addresses.evm,
							chain_id: this.aomiConfig.chainId,
							aa: { mode: "none" },
						},
					}
				: {}),
			...(addresses.solana
				? {
						svm: {
							address: addresses.solana,
							cluster: this.solanaCluster(),
							capabilities: [
								"solana:signTransaction",
								"solana:signMessage",
								"solana:signAndSendTransaction",
							],
						},
					}
				: {}),
			ext: { client_type: "elizaos" },
		};
	}

	private solanaCluster(): string {
		const configured = this.runtime.getSetting("SOLANA_CLUSTER");
		return typeof configured === "string" && configured.trim()
			? configured.trim()
			: "solana:mainnet";
	}

	private resetConversation(conversation: RoomConversation): void {
		conversation.completion = undefined;
		conversation.initiatingSubjectId = undefined;
		conversation.pending = undefined;
	}

	private async waitForBoundary(
		roomId: string,
		conversation: RoomConversation,
		rejectionBudget = MAX_UNSUPPORTED_REJECTIONS,
	): Promise<AomiBoundary> {
		const completion = conversation.completion;
		if (!completion) {
			throw new AomiError("Aomi room has no active completion promise.", {
				code: "AOMI_SESSION_INVARIANT",
				context: { roomId },
				severity: "fatal",
			});
		}

		type Boundary =
			| { readonly kind: "completed"; readonly result: SendResult }
			| { readonly kind: "wallet"; readonly request: WalletRequest };

		const existing = conversation.session.getPendingRequests()[0];
		const boundary: Boundary = existing
			? { kind: "wallet", request: existing }
			: await new Promise<Boundary>((resolve, reject) => {
					let settled = false;
					let pollErrors = 0;
					const unsubscribes: Array<() => void> = [];
					const cleanup = () => {
						for (const unsubscribe of unsubscribes) unsubscribe();
					};
					const settle = (value: Boundary) => {
						if (settled) return;
						settled = true;
						cleanup();
						resolve(value);
					};
					const fail = (cause: unknown) => {
						if (settled) return;
						settled = true;
						cleanup();
						// The delegated turn is dead; clear room state so it is not left
						// permanently busy and a later submit can start fresh.
						this.resetConversation(conversation);
						reject(
							new AomiError("Aomi did not complete the delegated request.", {
								code: "AOMI_REQUEST_FAILED",
								context: { roomId },
								cause,
								severity: "ephemeral",
							}),
						);
					};
					unsubscribes.push(
						conversation.session.on("wallet_requests_changed", (requests) => {
							pollErrors = 0;
							if (requests[0]) settle({ kind: "wallet", request: requests[0] });
						}),
					);
					// The Aomi client never rejects send(); it only emits "error" on poll
					// failures. Treat a sustained run of them as an unreachable backend so
					// an outage cannot hang the handler forever and wedge the room.
					unsubscribes.push(
						conversation.session.on("error", () => {
							pollErrors += 1;
							if (pollErrors >= MAX_CONSECUTIVE_POLL_ERRORS) {
								fail(
									new Error(
										`Aomi backend was unreachable across ${pollErrors} consecutive polls.`,
									),
								);
							}
						}),
					);
					completion.then(
						(result) => settle({ kind: "completed", result }),
						(cause) => fail(cause),
					);
				});

		if (boundary.kind === "completed") {
			this.resetConversation(conversation);
			return { status: "completed", result: boundary.result };
		}

		const unsupported = walletRequestSupportError(
			boundary.request,
			this.walletAddresses(),
		);
		if (unsupported) {
			if (rejectionBudget <= 0) {
				this.resetConversation(conversation);
				throw new AomiError(
					"Aomi kept returning wallet requests this wallet cannot execute.",
					{
						code: "AOMI_UNSUPPORTED_REQUEST_LOOP",
						context: { roomId },
						severity: "ephemeral",
					},
				);
			}
			try {
				await conversation.session.reject(boundary.request.id, unsupported);
			} catch (cause) {
				// A failed rejection must not leave the room wedged with an
				// unclearable completion; reset so the room can recover.
				this.resetConversation(conversation);
				throw new AomiError(
					"Aomi could not reject an unsupported wallet request.",
					{
						code: "AOMI_REQUEST_FAILED",
						context: { roomId },
						cause,
						severity: "ephemeral",
					},
				);
			}
			return this.waitForBoundary(roomId, conversation, rejectionBudget - 1);
		}

		const preview = walletRequestPreview(boundary.request);
		const initiatingSubjectId = conversation.initiatingSubjectId;
		if (!initiatingSubjectId) {
			throw new AomiError(
				"Aomi room has no initiating subject for its wallet request.",
				{
					code: "AOMI_SESSION_INVARIANT",
					context: { roomId },
					severity: "fatal",
				},
			);
		}
		conversation.pending = {
			request: boundary.request,
			preview,
			initiatingSubjectId,
		};
		return { status: "wallet_required", request: boundary.request, preview };
	}
}
