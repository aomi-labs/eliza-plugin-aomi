/**
 * Proves the action cannot execute a wallet request until a separate user confirmation turn.
 */
import type { ActionResult, HandlerOptions, Memory } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
	EVM_REQUEST,
	FakeAomiSession,
	fakeRuntime,
	memory,
	ROOM_ID,
	SECOND_ENTITY_ID,
} from "./__tests__/test-helpers.js";
import { aomiAction } from "./action.js";
import { AomiService } from "./service.js";

describe("AOMI action confirmation", () => {
	it("previews on the initiating turn and executes only after a later yes", async () => {
		const { runtime, services } = fakeRuntime();
		const session = new FakeAomiSession(EVM_REQUEST);
		let executions = 0;
		const service = new AomiService(
			runtime,
			{
				apiUrl: "https://api.aomi.dev",
				app: "default",
				chainId: 8453,
			},
			{
				createSession: () => session,
				executeWallet: async () => {
					executions += 1;
					return { kind: "transaction", txHash: "0xfeed" };
				},
			},
		);
		services.set(AomiService.serviceType, service);

		const first = (await aomiAction.handler(
			runtime,
			memory("Ask Aomi to transfer funds."),
			undefined,
			{
				parameters: { prompt: "Transfer the requested funds on Base." },
			} as HandlerOptions,
		)) as ActionResult;

		expect(first.success).toBe(true);
		expect(first.data?.status).toBe("awaiting_confirmation");
		expect(executions).toBe(0);
		expect(session.resolved).toHaveLength(0);

		const second = (await aomiAction.handler(
			runtime,
			memory("yes"),
		)) as ActionResult;

		expect(second.success).toBe(true);
		expect(second.data?.status).toBe("completed");
		expect(executions).toBe(1);
		expect(session.resolved).toHaveLength(1);
		expect(service.pending(String(ROOM_ID))).toBeNull();
	});

	it("rejects the exact pending request on a non-confirming reply", async () => {
		const { runtime, services } = fakeRuntime();
		const session = new FakeAomiSession(EVM_REQUEST);
		const service = new AomiService(
			runtime,
			{
				apiUrl: "https://api.aomi.dev",
				app: "default",
				chainId: 8453,
			},
			{
				createSession: () => session,
				executeWallet: async () => {
					throw new Error("wallet execution should not run");
				},
			},
		);
		services.set(AomiService.serviceType, service);

		await aomiAction.handler(runtime, memory("Prepare a transfer."));
		const rejected = (await aomiAction.handler(
			runtime,
			memory("no"),
		)) as ActionResult;

		expect(rejected.data?.status).toBe("rejected");
		expect(session.rejected).toEqual([
			{
				id: EVM_REQUEST.id,
				reason: "User rejected the wallet request.",
			},
		]);
		expect(session.resolved).toHaveLength(0);
	});

	it("does not let another room participant answer the confirmation", async () => {
		const { runtime, services } = fakeRuntime();
		const session = new FakeAomiSession(EVM_REQUEST);
		let executions = 0;
		const service = new AomiService(
			runtime,
			{
				apiUrl: "https://api.aomi.dev",
				app: "default",
				chainId: 8453,
			},
			{
				createSession: () => session,
				executeWallet: async () => {
					executions += 1;
					return { kind: "transaction", txHash: "0xfeed" };
				},
			},
		);
		services.set(AomiService.serviceType, service);

		await aomiAction.handler(runtime, memory("Prepare a transfer."));
		const unauthorized = (await aomiAction.handler(
			runtime,
			memory("yes", ROOM_ID, SECOND_ENTITY_ID),
		)) as ActionResult;

		expect(unauthorized.success).toBe(false);
		expect(unauthorized.data?.errorCode).toBe(
			"AOMI_CONFIRMATION_SUBJECT_MISMATCH",
		);
		expect(executions).toBe(0);
		expect(session.resolved).toHaveLength(0);
		expect(session.rejected).toHaveLength(0);

		const authorized = (await aomiAction.handler(
			runtime,
			memory("yes"),
		)) as ActionResult;
		expect(authorized.success).toBe(true);
		expect(authorized.data?.status).toBe("completed");
		expect(executions).toBe(1);
	});

	it("does not leak raw execution errors into user-facing text", async () => {
		const { runtime, services } = fakeRuntime();
		const session = new FakeAomiSession(EVM_REQUEST);
		const service = new AomiService(
			runtime,
			{ apiUrl: "https://api.aomi.dev", app: "default", chainId: 8453 },
			{
				createSession: () => session,
				executeWallet: async () => {
					throw new Error(
						"RPC https://SECRET_KEY@node.example failed: reverted 0xdeadbeef",
					);
				},
			},
		);
		services.set(AomiService.serviceType, service);

		await aomiAction.handler(runtime, memory("Prepare a transfer."));
		const failed = (await aomiAction.handler(
			runtime,
			memory("yes"),
		)) as ActionResult;

		expect(failed.success).toBe(false);
		expect(failed.userFacingText).not.toContain("SECRET_KEY");
		expect(failed.userFacingText).not.toContain("node.example");
		expect(failed.userFacingText).toMatch(/could not complete the request/i);
		expect(failed.data?.errorCode).toBe("AOMI_ACTION_FAILED");
	});

	it("rejects a wallet request with no authenticated initiating subject", async () => {
		const { runtime, services } = fakeRuntime();
		const session = new FakeAomiSession(EVM_REQUEST);
		const service = new AomiService(
			runtime,
			{ apiUrl: "https://api.aomi.dev", app: "default", chainId: 8453 },
			{
				createSession: () => session,
				executeWallet: async () => ({ kind: "transaction", txHash: "0x0" }),
			},
		);
		services.set(AomiService.serviceType, service);

		const noSubject = {
			roomId: ROOM_ID,
			content: { text: "Ask Aomi to swap." },
		} as unknown as Memory;
		const result = (await aomiAction.handler(runtime, noSubject, undefined, {
			parameters: { prompt: "swap" },
		} as HandlerOptions)) as ActionResult;

		expect(result.success).toBe(false);
		expect(result.data?.errorCode).toBe("AOMI_INITIATING_SUBJECT_REQUIRED");
	});

	it("keeps the request pending when the reply is a clarifying question", async () => {
		const { runtime, services } = fakeRuntime();
		const session = new FakeAomiSession(EVM_REQUEST);
		let executions = 0;
		const service = new AomiService(
			runtime,
			{ apiUrl: "https://api.aomi.dev", app: "default", chainId: 8453 },
			{
				createSession: () => session,
				executeWallet: async () => {
					executions += 1;
					return { kind: "transaction", txHash: "0xquestion" };
				},
			},
		);
		services.set(AomiService.serviceType, service);

		await aomiAction.handler(runtime, memory("Prepare a transfer."));
		const question = (await aomiAction.handler(
			runtime,
			memory("how much gas is that?"),
		)) as ActionResult;

		expect(question.data?.status).toBe("awaiting_confirmation");
		expect(session.rejected).toHaveLength(0);
		expect(executions).toBe(0);
		expect(service.pending(String(ROOM_ID))).not.toBeNull();

		const yes = (await aomiAction.handler(
			runtime,
			memory("yes"),
		)) as ActionResult;
		expect(yes.data?.status).toBe("completed");
		expect(executions).toBe(1);
	});
});
