export type AomiErrorSeverity = "fatal" | "ephemeral";

export interface AomiErrorOptions {
	readonly code: string;
	readonly severity: AomiErrorSeverity;
	readonly context?: Record<string, unknown>;
	readonly cause?: unknown;
}

/**
 * Stable plugin-local error contract.
 *
 * elizaOS beta packages have shipped type declarations for ElizaError without
 * the matching runtime export. Keeping the classified error at this package
 * boundary makes standalone npm installs behave the same as monorepo source
 * builds.
 */
export class AomiError extends Error {
	readonly code: string;
	readonly severity: AomiErrorSeverity;
	readonly context?: Record<string, unknown>;

	constructor(message: string, options: AomiErrorOptions) {
		super(message, { cause: options.cause });
		this.name = "AomiError";
		this.code = options.code;
		this.severity = options.severity;
		this.context = options.context;
	}
}

export function toAomiError(error: unknown, fallbackCode: string): AomiError {
	if (error instanceof AomiError) return error;
	if (error instanceof Error) {
		return new AomiError(error.message, {
			code: fallbackCode,
			severity: "ephemeral",
			cause: error,
		});
	}
	return new AomiError("Aomi encountered an unknown failure.", {
		code: fallbackCode,
		severity: "ephemeral",
		context: { valueType: typeof error },
		cause: error,
	});
}
