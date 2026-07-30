/**
 * Runs the Aomi plugin's unit and opt-in live contract suites against its
 * standalone npm dependencies.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["src/**/*.test.ts"],
		exclude: ["node_modules/**", "dist/**"],
	},
});
