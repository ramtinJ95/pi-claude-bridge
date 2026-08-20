import type {
	EffortLevel,
	Options,
	SettingSource,
} from "@anthropic-ai/claude-agent-sdk";
import type { DelegationPolicy } from "./query-policy.js";

export interface DelegationQueryOptionsInput {
	policy: DelegationPolicy;
	cwd: string;
	env: Options["env"];
	settings: NonNullable<Options["settings"]>;
	cliModel: string;
	effort?: EffortLevel;
	systemPromptAppend?: string;
	resumeSessionId?: string | null;
	isolated: boolean;
	pathToClaudeCodeExecutable?: string;
	debugOptions?: Pick<Options, "debug" | "debugFile" | "stderr">;
}

export interface ResolvedDelegationQueryOptions {
	options: Options;
	policy: DelegationPolicy;
}

/**
 * Build the Agent SDK options for a Claude-native delegation query.
 *
 * This function deliberately owns no session lookup, settings resolution,
 * prompt capture, query lifecycle, or UI. Callers must resolve those inputs
 * before entering this pure boundary.
 */
export function buildDelegationQueryOptions(
	input: DelegationQueryOptionsInput,
): ResolvedDelegationQueryOptions {
	const policy = input.policy;
	const extraArgs: Record<string, string | null> = {
		"strict-mcp-config": null,
		model: input.cliModel,
	};
	if (input.effort) extraArgs["thinking-display"] = "summarized";

	return {
		policy,
		options: {
			cwd: input.cwd,
			env: input.env,
			permissionMode: policy.permissionMode,
			...(policy.allowDangerouslySkipPermissions
				? { allowDangerouslySkipPermissions: true }
				: {}),
			settings: input.settings,
			skills: [],
			tools: policy.tools,
			...(policy.disallowedTools
				? { disallowedTools: policy.disallowedTools }
				: {}),
			...(input.effort ? { effort: input.effort } : {}),
			systemPrompt: {
				type: "preset",
				preset: "claude_code",
				append: input.systemPromptAppend,
			},
			settingSources: ["user", "project"] as SettingSource[],
			extraArgs,
			...(input.resumeSessionId ? { resume: input.resumeSessionId } : {}),
			...(input.isolated ? { persistSession: false } : {}),
			...(input.pathToClaudeCodeExecutable
				? { pathToClaudeCodeExecutable: input.pathToClaudeCodeExecutable }
				: {}),
			...input.debugOptions,
		},
	};
}
