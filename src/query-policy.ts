import type { PermissionMode, ResolvedSettings } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "./config.js";

export type CapabilityMode = "full" | "read" | "none";

export const DEFAULT_PERMISSION_MODE: PermissionMode = "auto";

const PERMISSION_MODES = new Set<PermissionMode>([
	"default",
	"acceptEdits",
	"bypassPermissions",
	"plan",
	"dontAsk",
	"auto",
]);

// An explicit `tools` list is a capability boundary. Unlike `allowedTools`, it
// controls what Claude can see and call rather than merely skipping permission
// prompts. Keep Agent out until nested-agent capabilities can be bounded.
export const ASKCLAUDE_READ_TOOLS = [
	"Read",
	"Glob",
	"Grep",
	"WebFetch",
	"WebSearch",
] as const;

// These require interaction or host lifecycle support that DelegateToClaude does not
// provide. Full capability still excludes them; permission policy is separate.
export const ASKCLAUDE_FULL_DISALLOWED_TOOLS = [
	"AskUserQuestion",
	"EnterPlanMode",
	"ExitPlanMode",
	"ToolSearch",
	"ScheduleWakeup",
] as const;

export interface PermissionPolicy {
	requestedPermissionMode: PermissionMode;
	permissionMode: PermissionMode;
	allowDangerouslySkipPermissions?: true;
}

export interface DelegationPolicy extends PermissionPolicy {
	capabilityMode: CapabilityMode;
	tools: string[] | { type: "preset"; preset: "claude_code" };
	disallowedTools?: string[];
}

export interface PermissionObservation {
	requested: PermissionMode;
	effective: PermissionMode;
	overridden: boolean;
}

export interface ManagedPolicySummary {
	origin?: string;
	disableBypassPermissions: boolean;
	permissionRulesOnly: boolean;
	denyRuleCount: number;
	askRuleCount: number;
	sandboxRequired: boolean;
	unsandboxedCommandsDisabled: boolean;
	managedDomainsOnly: boolean;
	managedReadPathsOnly: boolean;
}

export function resolvePermissionMode(value: unknown): PermissionMode {
	return typeof value === "string" && PERMISSION_MODES.has(value as PermissionMode)
		? value as PermissionMode
		: DEFAULT_PERMISSION_MODE;
}

export function resolveProviderPermissionPolicy(config: Config["provider"] = {}): PermissionPolicy {
	return permissionPolicy(config?.permissionMode);
}

export function resolveDelegationPolicy(
	mode: CapabilityMode,
	config: Config["delegation"] = {},
): DelegationPolicy {
	const permission = permissionPolicy(config?.permissionMode);

	if (mode === "none") {
		return { capabilityMode: mode, tools: [], ...permission };
	}

	if (mode === "read") {
		return {
			capabilityMode: mode,
			tools: [...ASKCLAUDE_READ_TOOLS],
			...permission,
		};
	}

	return {
		capabilityMode: mode,
		tools: { type: "preset", preset: "claude_code" },
		disallowedTools: [...ASKCLAUDE_FULL_DISALLOWED_TOOLS],
		...permission,
	};
}

export function observePermissionMode(
	requested: PermissionMode,
	effective: PermissionMode | undefined,
): PermissionObservation | undefined {
	if (!effective) return undefined;
	return { requested, effective, overridden: effective !== requested };
}

/**
 * Summarize only policy facts the SDK's settings resolver actually attributes
 * to the managed tier. Keep rule contents out of tool output and logs.
 */
export function summarizeManagedPolicy(resolved: ResolvedSettings): ManagedPolicySummary | undefined {
	const source = resolved.sources.find((item) => item.source === "managed");
	if (!source) return undefined;

	const settings = source.settings as Record<string, any>;
	const permissions = settings.permissions ?? {};
	const sandbox = settings.sandbox ?? {};
	return {
		origin: source.policyOrigin,
		disableBypassPermissions: permissions.disableBypassPermissionsMode === "disable",
		permissionRulesOnly: settings.allowManagedPermissionRulesOnly === true,
		denyRuleCount: Array.isArray(permissions.deny) ? permissions.deny.length : 0,
		askRuleCount: Array.isArray(permissions.ask) ? permissions.ask.length : 0,
		sandboxRequired: sandbox.enabled === true && sandbox.failIfUnavailable === true,
		unsandboxedCommandsDisabled: sandbox.allowUnsandboxedCommands === false,
		managedDomainsOnly: sandbox.network?.allowManagedDomainsOnly === true,
		managedReadPathsOnly: sandbox.allowManagedReadPathsOnly === true
			|| sandbox.filesystem?.allowManagedReadPathsOnly === true,
	};
}

export function managedPolicyLabels(policy: ManagedPolicySummary | undefined): string[] {
	if (!policy) return [];
	const labels: string[] = [];
	if (policy.sandboxRequired) labels.push("sandbox required");
	if (policy.unsandboxedCommandsDisabled) labels.push("unsandboxed commands disabled");
	if (policy.permissionRulesOnly) labels.push("managed permission rules only");
	if (policy.disableBypassPermissions) labels.push("bypass disabled");
	if (policy.managedDomainsOnly) labels.push("managed network domains only");
	if (policy.managedReadPathsOnly) labels.push("managed read paths only");
	if (policy.denyRuleCount) labels.push(`${policy.denyRuleCount} managed deny rule${policy.denyRuleCount === 1 ? "" : "s"}`);
	if (policy.askRuleCount) labels.push(`${policy.askRuleCount} managed ask rule${policy.askRuleCount === 1 ? "" : "s"}`);
	return labels;
}

function permissionPolicy(value: unknown): PermissionPolicy {
	const permissionMode = resolvePermissionMode(value);
	return {
		requestedPermissionMode: permissionMode,
		permissionMode,
		// The SDK requires this acknowledgement. It does not override managed
		// settings: an organization can still disable bypass mode entirely.
		...(permissionMode === "bypassPermissions"
			? { allowDangerouslySkipPermissions: true as const }
			: {}),
	};
}
