/**
 * Keeps explicit Aomi requests from being mistaken for static-knowledge chat
 * before the planner has a chance to expose the AOMI action.
 */
import type { IAgentRuntime } from "@elizaos/core";

export const AOMI_DIRECT_ROUTE_TAG = "aomi-direct-route";

export function looksLikeExplicitAomiRequest(text: string): boolean {
	return /\baomi\b/iu.test(text);
}

export async function registerAomiDirectRoute(
	runtime: IAgentRuntime,
): Promise<void> {
	const core = await import("@elizaos/core");
	const register = Reflect.get(core, "registerDirectActionRoutingRule");
	if (typeof register !== "function") {
		// The direct-route registry is not present in every @elizaos/core build.
		// Log rather than silently no-op so an inactive route is observable.
		runtime.logger?.debug(
			"[aomi] registerDirectActionRoutingRule unavailable; explicit-Aomi direct routing is inactive.",
		);
		return;
	}
	register(runtime, {
		id: "plugin-aomi.explicit-request",
		actionNames: ["AOMI"],
		requiredActionTags: [AOMI_DIRECT_ROUTE_TAG],
		contexts: ["crypto"],
		matches: looksLikeExplicitAomiRequest,
	});
}
