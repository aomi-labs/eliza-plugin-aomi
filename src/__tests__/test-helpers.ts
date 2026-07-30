/**
 * Shared deterministic harness for the Aomi plugin's room, confirmation, and retry unit tests.
 */
import type {
	AomiMessage,
	SendResult,
	WalletRequest,
	WalletRequestResult,
} from "@aomi-labs/client";
import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import type { AomiSession } from "../types.js";

export const ROOM_ID = "11111111-1111-4111-8111-111111111111" as UUID;
export const SECOND_ROOM_ID = "22222222-2222-4222-8222-222222222222" as UUID;
export const ENTITY_ID = "33333333-3333-4333-8333-333333333333" as UUID;
export const SECOND_ENTITY_ID = "44444444-4444-4444-8444-444444444444" as UUID;

export function memory(
	text: string,
	roomId: UUID = ROOM_ID,
	entityId: UUID = ENTITY_ID,
): Memory {
	return {
		entityId,
		roomId,
		content: { text, source: "test" },
	};
}

export function completedResult(
	text = "Aomi completed the request.",
): SendResult {
	const messages: AomiMessage[] = [{ sender: "agent", content: text }];
	return { messages, title: "Aomi test" };
}

export class FakeAomiSession implements AomiSession {
	readonly sessionId = crypto.randomUUID();
	readonly prompts: string[] = [];
	readonly resolved: Array<{
		id: string;
		result: WalletRequestResult;
	}> = [];
	readonly rejected: Array<{ id: string; reason?: string }> = [];
	readonly synced: Record<string, unknown>[] = [];
	failResolveCount = 0;

	private walletListeners = new Set<(requests: WalletRequest[]) => void>();
	private errorListeners = new Set<(payload: { error: unknown }) => void>();
	private requests: WalletRequest[];
	private completionResolve!: (result: SendResult) => void;
	private completionReject!: (error: unknown) => void;
	private completion = this.createCompletion();

	constructor(
		request: WalletRequest | null,
		private readonly result = completedResult(),
		private readonly autoComplete = true,
	) {
		this.requests = request ? [request] : [];
	}

	send(message: string): Promise<SendResult> {
		this.prompts.push(message);
		if (this.requests.length === 0 && this.autoComplete) {
			this.completionResolve(this.result);
		}
		return this.completion;
	}

	async resolve(id: string, result: WalletRequestResult): Promise<void> {
		this.resolved.push({ id, result });
		if (this.failResolveCount > 0) {
			this.failResolveCount -= 1;
			throw new Error("callback failed");
		}
		this.requests = [];
		this.emit();
		this.completionResolve(this.result);
	}

	async reject(id: string, reason?: string): Promise<void> {
		this.rejected.push({ id, reason });
		this.requests = [];
		this.emit();
		this.completionResolve(this.result);
	}

	close(): void {
		this.walletListeners.clear();
		this.errorListeners.clear();
	}

	getPendingRequests(): WalletRequest[] {
		return [...this.requests];
	}

	syncRuntimeOptions(options: Record<string, unknown>): void {
		this.synced.push(options);
	}

	on(
		event: "wallet_requests_changed",
		handler: (requests: WalletRequest[]) => void,
	): () => void;
	on(
		event: "error",
		handler: (payload: { error: unknown }) => void,
	): () => void;
	on(
		event: "wallet_requests_changed" | "error",
		handler:
			| ((requests: WalletRequest[]) => void)
			| ((payload: { error: unknown }) => void),
	): () => void {
		if (event === "error") {
			const errorHandler = handler as (payload: { error: unknown }) => void;
			this.errorListeners.add(errorHandler);
			return () => this.errorListeners.delete(errorHandler);
		}
		const walletHandler = handler as (requests: WalletRequest[]) => void;
		this.walletListeners.add(walletHandler);
		return () => this.walletListeners.delete(walletHandler);
	}

	failCompletion(error: unknown): void {
		this.completionReject(error);
	}

	/** Simulate a client poll failure (the client emits "error", never rejects). */
	emitPollError(error: unknown = new Error("backend unreachable")): void {
		for (const listener of this.errorListeners) listener({ error });
	}

	private emit(): void {
		for (const listener of this.walletListeners)
			listener(this.getPendingRequests());
	}

	private createCompletion(): Promise<SendResult> {
		return new Promise<SendResult>((resolve, reject) => {
			this.completionResolve = resolve;
			this.completionReject = reject;
		});
	}
}

export interface FakeRuntime {
	readonly runtime: IAgentRuntime;
	readonly services: Map<string, unknown>;
}

export function fakeRuntime(
	settings: Record<string, string | number> = {},
): FakeRuntime {
	const cache = new Map<string, unknown>();
	const services = new Map<string, unknown>();
	const runtime = {
		getSetting: (key: string) => settings[key],
		getService: (key: string) => services.get(key) ?? null,
		getCache: async <T>(key: string) => cache.get(key) as T | undefined,
		setCache: async (key: string, value: unknown) => {
			cache.set(key, value);
			return true;
		},
		deleteCache: async (key: string) => {
			cache.delete(key);
			return true;
		},
		logger: {
			debug: () => undefined,
			info: () => undefined,
			warn: () => undefined,
			error: () => undefined,
			log: () => undefined,
		},
	} as unknown as IAgentRuntime;
	return { runtime, services };
}

export const EVM_REQUEST: WalletRequest = {
	id: "tx-7",
	kind: "transaction",
	timestamp: 1,
	payload: {
		txId: 7,
		txIds: [7],
		chainId: 8453,
		to: "0x000000000000000000000000000000000000dEaD",
		value: "1000",
		data: "0x",
	},
};
