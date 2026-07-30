/**
 * Verifies room isolation, busy-room protection, and idempotent wallet callback retries.
 */
import { describe, expect, it } from "vitest";
import {
	ENTITY_ID,
	EVM_REQUEST,
	FakeAomiSession,
	fakeRuntime,
	ROOM_ID,
	SECOND_ENTITY_ID,
	SECOND_ROOM_ID,
} from "./__tests__/test-helpers.js";
import { AomiService } from "./service.js";

const CONFIG = {
	apiUrl: "https://api.aomi.dev",
	app: "default",
	chainId: 8453,
};

describe("AomiService", () => {
	it("keeps Aomi sessions isolated by Eliza room", async () => {
		const { runtime } = fakeRuntime();
		const sessions: FakeAomiSession[] = [];
		const service = new AomiService(runtime, CONFIG, {
			createSession: () => {
				const session = new FakeAomiSession(null);
				sessions.push(session);
				return session;
			},
			executeWallet: async () => {
				throw new Error("wallet execution should not run");
			},
		});

		await Promise.all([
			service.submit(String(ROOM_ID), String(ENTITY_ID), "first room"),
			service.submit(String(SECOND_ROOM_ID), String(ENTITY_ID), "second room"),
		]);

		expect(sessions).toHaveLength(2);
		expect(sessions[0].prompts).toEqual(["first room"]);
		expect(sessions[1].prompts).toEqual(["second room"]);
	});

	it("rejects a second operation while the room has a pending wallet request", async () => {
		const { runtime } = fakeRuntime();
		const service = new AomiService(runtime, CONFIG, {
			createSession: () => new FakeAomiSession(EVM_REQUEST),
			executeWallet: async () => ({
				kind: "transaction",
				txHash: "0x123",
			}),
		});

		const first = await service.submit(
			String(ROOM_ID),
			String(ENTITY_ID),
			"prepare transfer",
		);
		expect(first.status).toBe("wallet_required");
		await expect(
			service.submit(String(ROOM_ID), String(ENTITY_ID), "replace transfer"),
		).rejects.toMatchObject({ code: "AOMI_ROOM_BUSY" });
	});

	it("does not execute a wallet request twice when the Aomi callback is retried", async () => {
		const { runtime } = fakeRuntime();
		const session = new FakeAomiSession(EVM_REQUEST);
		session.failResolveCount = 1;
		let executions = 0;
		const service = new AomiService(runtime, CONFIG, {
			createSession: () => session,
			executeWallet: async () => {
				executions += 1;
				return {
					kind: "transaction",
					txHash: "0xabc",
				};
			},
		});

		await service.submit(
			String(ROOM_ID),
			String(ENTITY_ID),
			"prepare transfer",
		);
		await expect(
			service.confirm(String(ROOM_ID), String(ENTITY_ID)),
		).rejects.toThrow("callback failed");
		expect(service.pending(String(ROOM_ID))?.executionReady).toBe(true);

		const completed = await service.confirm(String(ROOM_ID), String(ENTITY_ID));
		expect(completed.status).toBe("completed");
		expect(executions).toBe(1);
		expect(session.resolved).toHaveLength(2);
	});

	it("single-flights concurrent confirmations through one wallet execution", async () => {
		const { runtime } = fakeRuntime();
		const session = new FakeAomiSession(EVM_REQUEST);
		let executions = 0;
		let releaseExecution!: () => void;
		const executionGate = new Promise<void>((resolve) => {
			releaseExecution = resolve;
		});
		const service = new AomiService(runtime, CONFIG, {
			createSession: () => session,
			executeWallet: async () => {
				executions += 1;
				await executionGate;
				return {
					kind: "transaction",
					txHash: "0xsingleflight",
				};
			},
		});

		await service.submit(
			String(ROOM_ID),
			String(ENTITY_ID),
			"prepare transfer",
		);
		const confirmations = Promise.all([
			service.confirm(String(ROOM_ID), String(ENTITY_ID)),
			service.confirm(String(ROOM_ID), String(ENTITY_ID)),
		]);

		await Promise.resolve();
		expect(executions).toBe(1);
		releaseExecution();

		const [first, second] = await confirmations;
		expect(first.status).toBe("completed");
		expect(second.status).toBe("completed");
		expect(executions).toBe(1);
		expect(session.resolved).toHaveLength(1);
	});

	it("allows only the initiating subject to confirm or reject", async () => {
		const { runtime } = fakeRuntime();
		const session = new FakeAomiSession(EVM_REQUEST);
		let executions = 0;
		const service = new AomiService(runtime, CONFIG, {
			createSession: () => session,
			executeWallet: async () => {
				executions += 1;
				return {
					kind: "transaction",
					txHash: "0xowned",
				};
			},
		});

		await service.submit(
			String(ROOM_ID),
			String(ENTITY_ID),
			"prepare transfer",
		);

		expect(() =>
			service.pendingFor(String(ROOM_ID), String(SECOND_ENTITY_ID)),
		).toThrow(/Only the user who initiated/i);
		await expect(
			service.confirm(String(ROOM_ID), String(SECOND_ENTITY_ID)),
		).rejects.toMatchObject({ code: "AOMI_CONFIRMATION_SUBJECT_MISMATCH" });
		await expect(
			service.reject(String(ROOM_ID), String(SECOND_ENTITY_ID)),
		).rejects.toMatchObject({ code: "AOMI_CONFIRMATION_SUBJECT_MISMATCH" });

		expect(executions).toBe(0);
		expect(session.resolved).toHaveLength(0);
		expect(session.rejected).toHaveLength(0);

		const completed = await service.confirm(String(ROOM_ID), String(ENTITY_ID));
		expect(completed.status).toBe("completed");
		expect(executions).toBe(1);
	});

	it("clears failed completion state instead of leaving the room permanently busy", async () => {
		const { runtime } = fakeRuntime();
		const session = new FakeAomiSession(null, undefined, false);
		const service = new AomiService(runtime, CONFIG, {
			createSession: () => session,
			executeWallet: async () => {
				throw new Error("wallet execution should not run");
			},
		});

		const failed = service.submit(
			String(ROOM_ID),
			String(ENTITY_ID),
			"read-only request",
		);
		session.failCompletion(new Error("backend unavailable"));
		await expect(failed).rejects.toMatchObject({ code: "AOMI_REQUEST_FAILED" });
		expect(service.pending(String(ROOM_ID))).toBeNull();

		await expect(
			service.submit(String(ROOM_ID), String(ENTITY_ID), "retry request"),
		).rejects.toMatchObject({ code: "AOMI_REQUEST_FAILED" });
	});

	it("recovers a room when the Aomi backend stops responding", async () => {
		const { runtime } = fakeRuntime();
		const session = new FakeAomiSession(null, undefined, false);
		const service = new AomiService(runtime, CONFIG, {
			createSession: () => session,
			executeWallet: async () => {
				throw new Error("wallet execution should not run");
			},
		});

		const pending = service.submit(
			String(ROOM_ID),
			String(ENTITY_ID),
			"read-only request",
		);
		await Promise.resolve();
		for (let i = 0; i < 20; i += 1) session.emitPollError();

		await expect(pending).rejects.toMatchObject({
			code: "AOMI_REQUEST_FAILED",
		});
		expect(service.pending(String(ROOM_ID))).toBeNull();
	});

	it("does not let a rejection hijack an in-flight confirmation", async () => {
		const { runtime } = fakeRuntime();
		const session = new FakeAomiSession(EVM_REQUEST);
		let releaseExecution!: () => void;
		const executionGate = new Promise<void>((resolve) => {
			releaseExecution = resolve;
		});
		const service = new AomiService(runtime, CONFIG, {
			createSession: () => session,
			executeWallet: async () => {
				await executionGate;
				return { kind: "transaction", txHash: "0xinflight" };
			},
		});

		await service.submit(
			String(ROOM_ID),
			String(ENTITY_ID),
			"prepare transfer",
		);
		const confirming = service.confirm(String(ROOM_ID), String(ENTITY_ID));
		await Promise.resolve();

		await expect(
			service.reject(String(ROOM_ID), String(ENTITY_ID)),
		).rejects.toMatchObject({ code: "AOMI_SETTLEMENT_IN_FLIGHT" });

		releaseExecution();
		const completed = await confirming;
		expect(completed.status).toBe("completed");
		expect(session.rejected).toHaveLength(0);
		expect(session.resolved).toHaveLength(1);
	});

	it("only confirms the exact pending request id", async () => {
		const { runtime } = fakeRuntime();
		const session = new FakeAomiSession(EVM_REQUEST);
		let executions = 0;
		const service = new AomiService(runtime, CONFIG, {
			createSession: () => session,
			executeWallet: async () => {
				executions += 1;
				return { kind: "transaction", txHash: "0xexact" };
			},
		});

		await service.submit(
			String(ROOM_ID),
			String(ENTITY_ID),
			"prepare transfer",
		);
		await expect(
			service.confirm(String(ROOM_ID), String(ENTITY_ID), "not-the-pending-id"),
		).rejects.toMatchObject({ code: "AOMI_CONFIRMATION_REQUEST_MISMATCH" });
		expect(executions).toBe(0);

		const completed = await service.confirm(
			String(ROOM_ID),
			String(ENTITY_ID),
			EVM_REQUEST.id,
		);
		expect(completed.status).toBe("completed");
		expect(executions).toBe(1);
	});
});
