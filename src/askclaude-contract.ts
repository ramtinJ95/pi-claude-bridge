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

const PREFER_DIRECT = "Handle straightforward tasks directly.";

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
	const base = `Ask Claude Code for analysis${allowFull ? " or delegated work" : ""}.`;
	if (defaultMode === "full") {
		return `${base} Defaults to full; use read for analysis only. Full can write and run Bash under Claude Code permissions. ${PREFER_DIRECT}`;
	}
	if (defaultMode === "none") {
		const available = allowFull
			? "use read for codebase access or full for changes"
			: "use read for codebase access";
		return `${base} Defaults to none; ${available}. ${PREFER_DIRECT}`;
	}
	if (allowFull) {
		return `${base} Defaults to read; use full only for user-requested changes. ${PREFER_DIRECT}`;
	}
	return `${base} Read-only codebase access. ${PREFER_DIRECT}`;
}

function promptDescription(defaultIsolated: boolean): string {
	const context = defaultIsolated
		? "Fresh session without Pi history by default"
		: "Pi history included by default";
	return `Question or task. ${context}; let Claude explore.`;
}

function modeDescription(defaultMode: AskClaudeMode, allowFull: boolean): string {
	const marker = (mode: AskClaudeMode) => mode === defaultMode ? " (default)" : "";
	const parts = [
		`"read"${marker("read")}: codebase analysis.`,
		`"none"${marker("none")}: no tools.`,
	];
	if (allowFull) {
		parts.push(`"full"${marker("full")}: Bash/Edit/Write without Pi feedback; Claude Code permissions apply.`);
	}
	return parts.join(" ");
}

function isolatedDescription(defaultIsolated: boolean): string {
	return `true: fresh session. false: include Pi conversation history. Default: ${defaultIsolated}.`;
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
