/**
 * Resolves the Aomi endpoint, app routing, and default-chain settings from the Eliza runtime.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { AomiError } from "./errors.js";

export interface AomiConfig {
	readonly apiUrl: string;
	readonly apiKey?: string;
	readonly app: string;
	readonly applicationId?: string;
	readonly chainId: number;
	readonly evmRpcUrl?: string;
}

function optionalString(
	runtime: IAgentRuntime,
	key: string,
): string | undefined {
	const value = runtime.getSetting(key);
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function readChainId(runtime: IAgentRuntime, fallback: number): number {
	const value = runtime.getSetting("AOMI_CHAIN_ID");
	if (value === undefined || value === null) return fallback;
	if (typeof value === "string" && value.trim().length === 0) return fallback;
	// `Number` (unlike parseInt) rejects trailing garbage and accepts 0x forms,
	// so "0x89" resolves to 137 while "sepolia" / "137x" fail closed.
	const parsed =
		typeof value === "number" ? value : Number(String(value).trim());
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		// error-policy:J2 A malformed operator setting must fail loudly, not
		// silently default to Ethereum mainnet.
		throw new AomiError("AOMI_CHAIN_ID must be a positive integer chain id.", {
			code: "AOMI_INVALID_CHAIN_ID",
			context: { value: String(value) },
			severity: "fatal",
		});
	}
	return parsed;
}

export function readAomiConfig(runtime: IAgentRuntime): AomiConfig {
	const apiUrl =
		optionalString(runtime, "AOMI_API_URL") ?? "https://api.aomi.dev";
	let normalizedUrl: string;
	try {
		normalizedUrl = new URL(apiUrl).toString().replace(/\/$/, "");
	} catch (cause) {
		// error-policy:J2 A malformed operator setting needs a classified cause.
		throw new AomiError("AOMI_API_URL must be an absolute URL.", {
			code: "AOMI_INVALID_API_URL",
			context: { apiUrl },
			cause,
			severity: "fatal",
		});
	}

	return {
		apiUrl: normalizedUrl,
		apiKey: optionalString(runtime, "AOMI_API_KEY"),
		app: optionalString(runtime, "AOMI_APP") ?? "default",
		applicationId: optionalString(runtime, "AOMI_APPLICATION_ID"),
		chainId: readChainId(runtime, 1),
		evmRpcUrl: optionalString(runtime, "AOMI_EVM_RPC_URL"),
	};
}
