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

interface PendingState {
	readonly request: WalletRequest;
	readonly preview: string;
	readonly initiatingSubjectId: string;
	execution?: Promise<WalletRequestResult>;
	settlement?: Promise<AomiBoundary>;
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

		const conversation = this.conversation(roomId);
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
	): Promise<AomiBoundary> {
		const conversation = this.requiredConversation(roomId);
		const pending = this.requiredPending(
			roomId,
			initiatingSubjectId,
			"confirmation",
		);

		if (pending.settlement) {
			return pending.settlement;
		}

		const settlement = this.confirmPending(roomId, conversation, pending);
		pending.settlement = settlement;
		try {
			return await settlement;
		} catch (error) {
			if (
				conversation.pending === pending &&
				pending.settlement === settlement
			) {
				pending.settlement = undefined;
			}
			throw error;
		}
	}

	async reject(
		roomId: string,
		initiatingSubjectId: string,
		reason = "User rejected the wallet request.",
	): Promise<AomiBoundary> {
		const conversation = this.requiredConversation(roomId);
		const pending = this.requiredPending(
			roomId,
			initiatingSubjectId,
			"rejection",
		);

		if (pending.settlement) {
			return pending.settlement;
		}

		const settlement = this.rejectPending(
			roomId,
			conversation,
			pending,
			reason,
		);
		pending.settlement = settlement;
		try {
			return await settlement;
		} catch (error) {
			if (
				conversation.pending === pending &&
				pending.settlement === settlement
			) {
				pending.settlement = undefined;
			}
			throw error;
		}
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
		return {
			request: pending.request,
			preview: pending.preview,
			executionReady: pending.execution !== undefined,
		};
	}

	private async confirmPending(
		roomId: string,
		conversation: RoomConversation,
		pending: PendingState,
	): Promise<AomiBoundary> {
		pending.execution ??= this.dependencies.executeWallet(
			this.runtime,
			this.aomiConfig,
			pending.request,
		);
		const execution = await pending.execution;
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
		return pending
			? {
					request: pending.request,
					preview: pending.preview,
					executionReady: pending.execution !== undefined,
				}
			: null;
	}

	status(roomId: string): AomiServiceStatus {
		const service = this.runtime.getService(WALLET_BACKEND_SERVICE_TYPE);
		const backend = (
			service as unknown as WalletBackendServiceLike | null
		)?.getWalletBackendOrNull();
		const addresses = backend?.getAddresses();
		return {
			apiUrl: this.aomiConfig.apiUrl,
			app: this.aomiConfig.app,
			walletReady: Boolean(addresses?.evm || addresses?.solana),
			evmAddress: addresses?.evm ?? null,
			solanaAddress: addresses?.solana?.toBase58() ?? null,
			pending: this.pending(roomId),
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
		const service = this.runtime.getService(WALLET_BACKEND_SERVICE_TYPE);
		const backend = (
			service as unknown as WalletBackendServiceLike | null
		)?.getWalletBackendOrNull();
		const addresses = backend?.getAddresses();
		const connected = Boolean(addresses?.evm || addresses?.solana);
		return {
			connection: { is_connected: connected },
			...(addresses?.evm
				? {
						evm: {
							address: addresses.evm,
							chain_id: this.aomiConfig.chainId,
							aa: { mode: "none" },
						},
					}
				: {}),
			...(addresses?.solana
				? {
						svm: {
							address: addresses.solana.toBase58(),
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

	private async waitForBoundary(
		roomId: string,
		conversation: RoomConversation,
	): Promise<AomiBoundary> {
		const completion = conversation.completion;
		if (!completion) {
			throw new AomiError("Aomi room has no active completion promise.", {
				code: "AOMI_SESSION_INVARIANT",
				context: { roomId },
				severity: "fatal",
			});
		}

		const existing = conversation.session.getPendingRequests()[0];
		const boundary = existing
			? { kind: "wallet" as const, request: existing }
			: await new Promise<
					| { readonly kind: "completed"; readonly result: SendResult }
					| { readonly kind: "wallet"; readonly request: WalletRequest }
				>((resolve, reject) => {
					let settled = false;
					let unsubscribe: () => void = () => undefined;
					const settle = (
						value:
							| { readonly kind: "completed"; readonly result: SendResult }
							| { readonly kind: "wallet"; readonly request: WalletRequest },
					) => {
						if (settled) return;
						settled = true;
						unsubscribe();
						resolve(value);
					};
					unsubscribe = conversation.session.on(
						"wallet_requests_changed",
						(requests) => {
							if (requests[0]) settle({ kind: "wallet", request: requests[0] });
						},
					);
					completion.then(
						(result) => settle({ kind: "completed", result }),
						(cause) => {
							if (settled) return;
							settled = true;
							unsubscribe();
							conversation.completion = undefined;
							conversation.initiatingSubjectId = undefined;
							conversation.pending = undefined;
							reject(
								new AomiError("Aomi did not complete the delegated request.", {
									code: "AOMI_REQUEST_FAILED",
									context: { roomId },
									cause,
									severity: "ephemeral",
								}),
							);
						},
					);
				});

		if (boundary.kind === "completed") {
			conversation.completion = undefined;
			conversation.initiatingSubjectId = undefined;
			conversation.pending = undefined;
			return { status: "completed", result: boundary.result };
		}

		const unsupported = walletRequestSupportError(boundary.request);
		if (unsupported) {
			await conversation.session.reject(boundary.request.id, unsupported);
			return this.waitForBoundary(roomId, conversation);
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
