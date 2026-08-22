import type { ReviewerDiffArtifact } from "./reviewer-diff.js";

export type AgentProfileId = "explorer" | "reviewer" | "worker";

export const AGENT_PROFILE_IDS = ["explorer", "reviewer", "worker"] as const;

/** Profiles that never mutate; enforced structurally by the read tool inventory. */
export const READ_ONLY_AGENT_PROFILE_IDS = ["explorer", "reviewer"] as const;

/**
 * Profile data for spawned Claude agents. Profiles select inputs to the pure
 * policy/options boundary — the capability mode names an existing inventory in
 * `resolveDelegationPolicy`; no profile carries its own tool list or policy.
 */
export interface AgentProfile {
	id: AgentProfileId;
	label: string;
	capabilityMode: "read" | "full";
	requiresDiffArtifact: boolean;
	rolePrompt: string;
}

export const AGENT_PROFILES: Record<AgentProfileId, AgentProfile> = {
	explorer: {
		id: "explorer",
		label: "Explorer",
		capabilityMode: "read",
		requiresDiffArtifact: false,
		rolePrompt: [
			"You are an independent exploration agent.",
			"Investigate the repository — and the web where it genuinely helps — using your read-only tools (Read, Glob, Grep, WebFetch, WebSearch).",
			"You cannot run shell commands, edit files, or spawn agents; do not attempt to.",
			"Report concrete findings with file paths and line references, state what you could not determine, and make the final answer self-contained.",
		].join("\n"),
	},
	reviewer: {
		id: "reviewer",
		label: "Reviewer",
		capabilityMode: "read",
		requiresDiffArtifact: true,
		rolePrompt: [
			"You are an independent code-review agent.",
			"Review the repository change captured in the diff artifact below, including tracked and untracked files. Use your read-only tools (Read, Glob, Grep, WebFetch, WebSearch) for surrounding context.",
			"You cannot run shell commands, edit files, or spawn agents; the diff artifact was captured for you when this job launched and is the only diff you will see.",
			"Report findings ordered by severity with file paths and line references. Review only what the artifact shows: if it marks content as truncated or omitted, say so instead of guessing.",
		].join("\n"),
	},
	worker: {
		id: "worker",
		label: "Worker",
		capabilityMode: "full",
		requiresDiffArtifact: false,
		rolePrompt: [
			"You are an independent Claude Code worker agent with full tool capability (including Bash, Edit, and Write), governed by Claude Code permission policy.",
			"You work directly in the current checkout — the same working tree the requesting agent uses. There is no separate worktree or sandbox copy; while you run, you are the only writer of this working tree.",
			"Do NOT commit, push, open pull requests, create or delete branches, or perform destructive cleanup (git reset/checkout/clean, deleting or reverting files beyond the task) unless the task explicitly authorizes that exact action.",
			"Make the requested changes, verify them where the task allows (build, tests, targeted checks), and report what you changed with file paths, what you verified, and anything left undone.",
		].join("\n"),
	},
};

export interface AgentJobLaunchContext {
	cwd: string;
	capturedAt: number;
	diff?: ReviewerDiffArtifact;
}

function diffSection(diff: ReviewerDiffArtifact): string {
	const truncationNote = diff.diffTruncated || diff.statusTruncated
		? "\nParts of this artifact were truncated at capture; the omitted content was NOT captured and must not be treated as reviewed."
		: "";
	return [
		`Repository status at launch (git status --porcelain${diff.statusTruncated ? ", truncated" : ""}):`,
		diff.statusText.trim() ? diff.statusText : "(clean)",
		"",
		`Diff artifact (frozen at launch; ${diff.source}${diff.diffTruncated ? "; truncated" : ""}):${truncationNote}`,
		"```diff",
		diff.diffText.trim() ? diff.diffText : `(no changes detected: ${diff.source})`,
		"```",
	].join("\n");
}

/**
 * Compose one background job prompt from the profile role, the immutable
 * launch context, the reviewer's frozen diff artifact, and the task.
 *
 * The honesty note is load-bearing: the diff artifact is frozen at launch, but
 * Read/Glob/Grep operate on the live working tree, which can already contain
 * later edits by the time the job reads a file.
 */
export function buildAgentJobPrompt(input: {
	profile: AgentProfile;
	task: string;
	launch: AgentJobLaunchContext;
}): string {
	const { profile, task, launch } = input;
	const sections = [
		profile.rolePrompt,
		[
			`Launch context (captured ${new Date(launch.capturedAt).toISOString()}):`,
			`- Working directory: ${launch.cwd}`,
			"- Files you open with Read/Glob/Grep reflect the live working tree, which may have changed since launch"
				+ (launch.diff ? "; the diff artifact below has not — it is frozen at launch." : "."),
		].join("\n"),
	];
	if (launch.diff) sections.push(diffSection(launch.diff));
	sections.push(`Task:\n${task}`);
	return sections.join("\n\n");
}
