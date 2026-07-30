/**
 * Verifies chain-id parsing fails closed instead of silently defaulting to mainnet.
 */
import { describe, expect, it } from "vitest";
import { fakeRuntime } from "./__tests__/test-helpers.js";
import { readAomiConfig } from "./config.js";

describe("readAomiConfig chain id", () => {
	it("defaults to chain 1 only when AOMI_CHAIN_ID is unset", () => {
		expect(readAomiConfig(fakeRuntime().runtime).chainId).toBe(1);
	});

	it("parses decimal and hex chain ids", () => {
		expect(
			readAomiConfig(fakeRuntime({ AOMI_CHAIN_ID: "8453" }).runtime).chainId,
		).toBe(8453);
		expect(
			readAomiConfig(fakeRuntime({ AOMI_CHAIN_ID: "0x89" }).runtime).chainId,
		).toBe(137);
	});

	it("throws instead of silently defaulting to mainnet on a malformed value", () => {
		expect(() =>
			readAomiConfig(fakeRuntime({ AOMI_CHAIN_ID: "sepolia" }).runtime),
		).toThrow(/AOMI_CHAIN_ID/);
		expect(() =>
			readAomiConfig(fakeRuntime({ AOMI_CHAIN_ID: "137x" }).runtime),
		).toThrow(/AOMI_CHAIN_ID/);
	});
});
