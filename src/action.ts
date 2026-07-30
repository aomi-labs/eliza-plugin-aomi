/**
 * Implements the single follow-up-capable Aomi action and its mandatory two-turn wallet gate.
 */
import type { AomiMessage } from "@aomi-labs/client";
import {
	type Action,
	type ActionResult,
	type HandlerCallback,
	type HandlerOptions,
	type IAgentRuntime,
	type Memory,
	type ProviderDataRecord,
	requireConfirmation,
	type State,
} from "@elizaos/core";
import { AomiError, toAomiError } from "./errors.js";
import { AOMI_DIRECT_ROUTE_TAG } from "./routing.js";
import { AomiService } from "./service.js";
import type { AomiBoundary } from "./types.js";

const AOMI_CONFIRM_ACTION = "AOMI_WALLET";
const FOLLOW_UP_CAPABLE_ACTION_TAG = "follow-up-capable";
// Only an explicit affirmative signs, and only an explicit rejection tears the
// request down. The `(?!.*\?)` guard keeps a question ("ok, but what's the fee?")
// from matching either, so it is re-prompted instead of silently acted on.
const AOMI_CONFIRM_REGEX =
	/^(?!.*\?)\s*(y|yes|yep|yeah|yup|ok|okay|confirm|confirmed|approve|approved|go ahead|proceed|sign it|send it|do it)\b/i;
const AOMI_CANCEL_REGEX =
	/^(?!.*\?)\s*(n|no|nope|nah|cancel|reject|decline|stop|abort|never mind|nevermind)\b/i;

function isExplicitRejection(message: Memory): boolean {
	const text =
		typeof message.content.text === "string" ? message.content.text : "";
	return AOMI_CANCEL_REGEX.test(text);
}

function serviceFromRuntime(runtime: IAgentRuntime): AomiService | null {
	return runtime.getService<AomiService>(AomiService.serviceType);
}

function promptFrom(
	message: Memory,
	options?: HandlerOptions | Record<string, unknown>,
): string {
	const parameters =
		options && "parameters" in options ? options.parameters : undefined;
	const parameterPrompt =
		typeof parameters === "object" && parameters !== null
			? Reflect.get(parameters, "prompt")
			: undefined;
	if (typeof parameterPrompt === "string" && parameterPrompt.trim()) {
		return parameterPrompt.trim();
	}
	return typeof message.content.text === "string"
		? message.content.text.trim()
		: "";
}

function finalAgentText(messages: readonly AomiMessage[]): string {
	const message = [...messages]
		.reverse()
		.find(
			(candidate) =>
				(candidate.sender === "agent" || candidate.sender === "assistant") &&
				typeof candidate.content === "string" &&
				candidate.content.trim(),
		);
	return message?.content?.trim() ?? "Aomi completed the delegated request.";
}

function completedResult(
	boundary: Extract<AomiBoundary, { status: "completed" }>,
): ActionResult {
	const text = finalAgentText(boundary.result.messages);
	return {
		success: true,
		text,
		userFacingText: text,
		verifiedUserFacing: true,
		values: {
			aomiActionCompleted: true,
			aomiPendingConfirmation: false,
		},
		data: {
			status: "completed",
			title: boundary.result.title ?? null,
			messageCount: boundary.result.messages.length,
		},
	};
}

function pendingResult(
	boundary: Extract<AomiBoundary, { status: "wallet_required" }>,
): ActionResult {
	return {
		success: true,
		text: boundary.preview,
		userFacingText: boundary.preview,
		verifiedUserFacing: true,
		values: {
			aomiActionCompleted: false,
			aomiPendingConfirmation: true,
		},
		data: {
			status: "awaiting_confirmation",
			requiresConfirmation: true,
			awaitingUserInput: true,
			requestId: boundary.request.id,
			requestKind: boundary.request.kind,
		},
	};
}

async function handleBoundary(
	runtime: IAgentRuntime,
	message: Memory,
	service: AomiService,
	roomId: string,
	initiatingSubjectId: string,
	boundary: AomiBoundary,
	callback?: HandlerCallback,
): Promise<ActionResult> {
	if (boundary.status === "completed") {
		return completedResult(boundary);
	}

	const confirmationArgs = {
		runtime,
		message,
		actionName: AOMI_CONFIRM_ACTION,
		pendingKey: `${roomId}:${boundary.request.id}`,
		prompt: boundary.preview,
		callback,
		confirmRegex: AOMI_CONFIRM_REGEX,
		cancelRegex: AOMI_CANCEL_REGEX,
		metadata: {
			roomId,
			initiatingSubjectId,
			requestId: boundary.request.id,
			requestKind: boundary.request.kind,
		},
	};
	const decision = await requireConfirmation(confirmationArgs);
	if (decision.status === "pending") {
		return pendingResult(boundary);
	}
	if (decision.status === "cancelled") {
		// core maps every non-affirmative reply to "cancelled"; only an explicit
		// rejection may tear down the prepared request. Anything else re-arms the
		// confirmation (the decision consumed the record) and keeps the request
		// pending, so a clarifying question is never destructive.
		if (!isExplicitRejection(message)) {
			await requireConfirmation(confirmationArgs);
			return pendingResult(boundary);
		}
		const next = await service.reject(
			roomId,
			initiatingSubjectId,
			undefined,
			boundary.request.id,
		);
		if (next.status === "wallet_required") {
			return handleBoundary(
				runtime,
				message,
				service,
				roomId,
				initiatingSubjectId,
				next,
				callback,
			);
		}
		const text = "Aomi wallet request rejected. No signature was produced.";
		return {
			success: true,
			text,
			userFacingText: text,
			verifiedUserFacing: true,
			values: {
				aomiActionCompleted: false,
				aomiPendingConfirmation: false,
			},
			data: {
				status: "rejected",
				requestId: boundary.request.id,
			},
		};
	}

	const next = await service.confirm(
		roomId,
		initiatingSubjectId,
		boundary.request.id,
	);
	return handleBoundary(
		runtime,
		message,
		service,
		roomId,
		initiatingSubjectId,
		next,
		callback,
	);
}

function failureResult(error: unknown): ActionResult {
	const normalized = toAomiError(error, "AOMI_ACTION_FAILED");
	// Surface a message only for our own classified errors. A raw viem/RPC/backend
	// error can embed RPC URLs (with API keys), request bodies, and signed
	// payloads, so it must be replaced with a generic message.
	const known = error instanceof AomiError;
	const text = known
		? normalized.message
		: "Aomi could not complete the request. Check the plugin configuration and try again.";
	const data: ProviderDataRecord = {
		status: "failed",
		errorCode: normalized.code,
		retryable: normalized.severity !== "fatal",
	};
	return {
		success: false,
		text,
		userFacingText: text,
		verifiedUserFacing: true,
		values: {
			aomiActionCompleted: false,
		},
		data,
	};
}

export const aomiAction: Action = {
	name: "AOMI",
	description:
		"Delegate an open-ended on-chain task to Aomi. Use for protocol research, balances, simulations, DeFi workflows, transaction construction, and multi-step blockchain operations. Aomi wallet requests always pause for a separate user confirmation before signing or submission.",
	descriptionCompressed:
		"AOMI delegates open-ended on-chain research or execution; wallet writes require a later yes/no confirmation",
	routingHint:
		"open-ended on-chain workflow or explicit Aomi request -> AOMI; simple native wallet transfer/swap may use WALLET",
	contexts: ["finance", "crypto", "wallet", "onchain"],
	contextGate: { anyOf: ["finance", "crypto", "wallet", "onchain"] },
	roleGate: { minRole: "ADMIN" },
	tags: [FOLLOW_UP_CAPABLE_ACTION_TAG, AOMI_DIRECT_ROUTE_TAG],
	similes: [
		"USE_AOMI",
		"AOMI_ONCHAIN",
		"ONCHAIN_AGENT",
		"DEFI_AGENT",
		"BLOCKCHAIN_WORKFLOW",
	],
	parameters: [
		{
			name: "prompt",
			description:
				"The complete natural-language task for Aomi. Preserve protocol names, chains, tokens, amounts, addresses, and user constraints.",
			required: true,
			schema: { type: "string", minLength: 1, maxLength: 8_000 },
		},
	],
	validate: async (runtime, message, _state, options) => {
		void _state;
		const service = serviceFromRuntime(runtime);
		if (!service) return false;
		const roomId = String(message.roomId);
		return (
			service.pending(roomId) !== null ||
			promptFrom(message, options).length > 0
		);
	},
	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
		options?: HandlerOptions | Record<string, unknown>,
		callback?: HandlerCallback,
	): Promise<ActionResult> => {
		void _state;
		const service = serviceFromRuntime(runtime);
		if (!service) {
			return failureResult(
				new Error(
					"Aomi service is not running. Enable @aomi-labs/eliza-plugin-aomi.",
				),
			);
		}

		const roomId = String(message.roomId);
		const initiatingSubjectId = String(message.entityId ?? "").trim();
		if (
			initiatingSubjectId.length === 0 ||
			initiatingSubjectId === "null" ||
			initiatingSubjectId === "undefined"
		) {
			return failureResult(
				new AomiError("Aomi requires an authenticated initiating subject.", {
					code: "AOMI_INITIATING_SUBJECT_REQUIRED",
					severity: "fatal",
				}),
			);
		}
		try {
			const existing = service.pendingFor(roomId, initiatingSubjectId);
			const boundary = existing
				? {
						status: "wallet_required" as const,
						request: existing.request,
						preview: existing.preview,
					}
				: await service.submit(
						roomId,
						initiatingSubjectId,
						promptFrom(message, options),
					);
			return await handleBoundary(
				runtime,
				message,
				service,
				roomId,
				initiatingSubjectId,
				boundary,
				callback,
			);
		} catch (error) {
			// error-policy:J1 The action boundary converts classified failures into planner-visible results.
			return failureResult(error);
		}
	},
	examples: [
		[
			{
				name: "{{user1}}",
				content: {
					text: "Use Aomi to find the best lending rate for USDC on Base.",
				},
			},
			{
				name: "{{agent}}",
				content: {
					text: "I’ll delegate that on-chain comparison to Aomi.",
					action: "AOMI",
				},
			},
		],
		[
			{
				name: "{{user1}}",
				content: {
					text: "Ask Aomi to swap 0.01 ETH for USDC on Base.",
				},
			},
			{
				name: "{{agent}}",
				content: {
					text: "I’ll have Aomi construct the swap and show the exact wallet request before anything is signed.",
					action: "AOMI",
				},
			},
		],
	],
};
