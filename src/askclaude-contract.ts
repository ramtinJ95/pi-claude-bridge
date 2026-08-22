import type { Config } from "./config.js";

export type AskClaudeMode = "full" | "read" | "none";

export const DEFAULT_ASKCLAUDE_MODE: AskClaudeMode = "read";
export const DEFAULT_ASKCLAUDE_ISOLATED = true;

export interface AskClaudeContract {
	allowFull: boolean;
	defaultMode: AskClaudeMode;
	defaultIsolated: boolean;
	modeValues: readonly AskClaudeMode[];
	toolDescription: string;
	promptDescription: string;
	modeDescription: string;
	isolatedDescription: string;
}

const ANALYSIS_USE_CASES = "code review, architecture questions, debugging theories";
const PREFER_DIRECT = "Prefer to handle straightforward tasks yourself.";

/**
 * Build the model-facing DelegateToClaude contract from the same effective defaults
 * execution uses. Keeping this in one value prevents the schema, rendering and
 * runtime from each inventing their own default.
 */
export function buildAskClaudeContract(config: Config["delegation"] = {}): AskClaudeContract {
	// Full mode is available by default, but malformed JSON must not become an
	// accidental opt-in. Only the documented boolean true (or omission) enables it.
	const allowFull = config?.allowFullMode === undefined || config.allowFullMode === true;
	// Config is parsed from JSON without runtime schema validation. Treat an
	// unknown value as read rather than letting it miss every denylist preset.
	const configuredMode = isAskClaudeMode(config?.defaultMode)
		? config.defaultMode
		: DEFAULT_ASKCLAUDE_MODE;
	// allowFullMode is a lockout, including calls that omit `mode`. Previously a
	// configured full default bypassed the schema's removal of the full enum value.
	const defaultMode = !allowFull && configuredMode === "full"
		? DEFAULT_ASKCLAUDE_MODE
		: configuredMode;
	const defaultIsolated = typeof config?.defaultIsolated === "boolean"
		? config.defaultIsolated
		: DEFAULT_ASKCLAUDE_ISOLATED;
	const modeValues = allowFull
		? ["read", "full", "none"] as const
		: ["read", "none"] as const;

	return {
		allowFull,
		defaultMode,
		defaultIsolated,
		modeValues,
		toolDescription: config?.description ?? toolDescription(defaultMode, allowFull),
		promptDescription: promptDescription(defaultIsolated),
		modeDescription: modeDescription(defaultMode, allowFull),
		isolatedDescription: isolatedDescription(defaultIsolated),
	};
}

function isAskClaudeMode(value: unknown): value is AskClaudeMode {
	return value === "full" || value === "read" || value === "none";
}

function toolDescription(defaultMode: AskClaudeMode, allowFull: boolean): string {
	const base = `Delegate to Claude Code for a second opinion or analysis (${ANALYSIS_USE_CASES})`;
	if (defaultMode === "full") {
		return `${base}, or to autonomously handle a task. Defaults to full mode, which makes writing and bash available without feedback to pi; Claude Code permission policy still applies. Use read mode for analysis-only work. ${PREFER_DIRECT}`;
	}
	if (defaultMode === "none") {
		const available = allowFull
			? "use read mode for codebase access or full mode for changes"
			: "use read mode for codebase access";
		return `${base}. Defaults to no-access mode — ${available}. ${PREFER_DIRECT}`;
	}
	if (allowFull) {
		return `${base}, or to autonomously handle a task. Defaults to read-only mode — use full mode when the user wants to delegate a task that requires changes. ${PREFER_DIRECT}`;
	}
	return `${base}. Read-only — Claude Code can explore the codebase but not make changes. ${PREFER_DIRECT}`;
}

function promptDescription(defaultIsolated: boolean): string {
	const context = defaultIsolated
		? "By default Claude starts a fresh session without Pi conversation history."
		: "By default Claude sees the full conversation history.";
	return `The question or task for Claude Code. ${context} Don't research up front, let Claude explore.`;
}

function modeDescription(defaultMode: AskClaudeMode, allowFull: boolean): string {
	const marker = (mode: AskClaudeMode) => mode === defaultMode ? " (default)" : "";
	const parts = [
		`"read"${marker("read")}: questions about the codebase — review, analysis, explain.`,
		`"none"${marker("none")}: general knowledge only (no file access).`,
	];
	if (allowFull) {
		parts.push(`"full"${marker("full")}: makes writing and bash available (careful: runs without feedback to pi); permission policy still applies.`);
	}
	return parts.join(" ");
}

function isolatedDescription(defaultIsolated: boolean): string {
	return `When true, Claude starts a fresh session without Pi conversation history or session persistence. When false, Claude sees the full conversation history. Defaults to ${defaultIsolated}.`;
}

export function askClaudeContextTags(
	args: { mode?: AskClaudeMode; isolated?: boolean },
	contract: Pick<AskClaudeContract, "defaultMode" | "defaultIsolated">,
): string[] {
	const mode = args.mode ?? contract.defaultMode;
	const isolated = args.isolated ?? contract.defaultIsolated;
	const tags: string[] = [];

	// Show every explicit mode and any configured non-package default. The former
	// makes an override visible; the latter prevents an omitted argument from
	// hiding that execution is actually full or no-access.
	if (args.mode !== undefined || mode !== DEFAULT_ASKCLAUDE_MODE) tags.push(`mode=${mode}`);
	if (isolated) tags.push("isolated");
	else if (args.isolated === false && contract.defaultIsolated) tags.push("shared");

	return tags;
}
