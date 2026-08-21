import { execFile } from "node:child_process";
import { redactSensitiveText, retainTextWithOmissions } from "./delegation-retention.js";

// Named launch-artifact bounds, independent of the delegation retention caps:
// the diff is one immutable prompt artifact, not a streamed display field.
export const REVIEWER_DIFF_MAX_CHARS = 40_000;
export const REVIEWER_STATUS_MAX_CHARS = 4_000;

/**
 * Immutable repository change snapshot captured by the extension at job launch.
 *
 * The reviewer profile has no Bash capability, so this artifact is the only
 * diff it ever sees. It is frozen at `capturedAt`: the reviewer's Read/Glob/Grep
 * calls still hit the live working tree, which may have moved on since.
 */
export interface ReviewerDiffArtifact {
	cwd: string;
	capturedAt: number;
	/** What the diff compares, including the resolved base when one was given. */
	source: string;
	baseRef?: string;
	headRef: string;
	/** `git status --porcelain` at launch; bounded, redacted, marker on truncation. */
	statusText: string;
	statusTruncated: boolean;
	/** Unified diff at launch; bounded, redacted, marker on truncation. */
	diffText: string;
	diffTruncated: boolean;
}

export type GitRunner = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

/** A capture failure the tool should surface verbatim as its error result. */
export class ReviewerDiffError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ReviewerDiffError";
	}
}

function defaultGitRunner(cwd: string): GitRunner {
	return (args) => new Promise((resolve) => {
		execFile("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
			resolve({ code: error ? 1 : 0, stdout: stdout ?? "", stderr: stderr ?? "" });
		});
	});
}

function firstLine(text: string): string {
	return text.split("\n", 1)[0]?.trim() ?? "";
}

function gitFailure(step: string, result: { stderr: string }): ReviewerDiffError {
	return new ReviewerDiffError(`Reviewer diff capture failed (${step}): ${firstLine(result.stderr) || "unknown git error"}`);
}

/**
 * Capture the reviewer's launch-time status/diff artifact.
 *
 * With an explicit `base`, the diff spans from the merge base of `base` and
 * HEAD to the launch-time working tree — branch/PR semantics, so changes that
 * exist only on the base side do not show up as reversals. Without one, it
 * captures the staged and unstaged working-tree changes from HEAD.
 *
 * Failures throw rather than degrade: a non-git directory, an unborn HEAD, or
 * an unresolvable base must become a visible error, never an empty diff that a
 * reviewer would read as "no changes".
 */
export async function captureReviewerDiff(input: {
	cwd: string;
	base?: string;
	capturedAt?: number;
	git?: GitRunner;
}): Promise<ReviewerDiffArtifact> {
	const git = input.git ?? defaultGitRunner(input.cwd);
	const base = input.base?.trim();
	// Refs are passed as positional git arguments; reject anything that would
	// parse as an option instead of silently diffing something else.
	if (base !== undefined && (base === "" || base.startsWith("-"))) {
		throw new ReviewerDiffError(`Invalid comparison base ${JSON.stringify(input.base)}: expected a git ref.`);
	}

	const inTree = await git(["rev-parse", "--is-inside-work-tree"]);
	if (inTree.code !== 0 || inTree.stdout.trim() !== "true") {
		throw new ReviewerDiffError(`Reviewer diff capture failed: ${input.cwd} is not inside a git work tree.`);
	}
	const head = await git(["rev-parse", "--short=12", "HEAD"]);
	if (head.code !== 0) {
		throw new ReviewerDiffError(`Reviewer diff capture failed: cannot resolve HEAD in ${input.cwd} (${firstLine(head.stderr) || "repository may have no commits"}).`);
	}
	const headRef = head.stdout.trim();

	let diffFrom = "HEAD";
	let source = `working tree at launch vs HEAD ${headRef} (staged + unstaged changes)`;
	if (base !== undefined) {
		const verified = await git(["rev-parse", "--verify", "--quiet", `${base}^{commit}`]);
		if (verified.code !== 0) {
			throw new ReviewerDiffError(`Invalid comparison base "${base}": not a commit in this repository.`);
		}
		const mergeBase = await git(["merge-base", base, "HEAD"]);
		if (mergeBase.code !== 0) {
			throw new ReviewerDiffError(`Invalid comparison base "${base}": no merge base with HEAD.`);
		}
		diffFrom = mergeBase.stdout.trim();
		source = `working tree at launch vs merge-base of "${base}" and HEAD (${diffFrom.slice(0, 12)})`;
	}

	const status = await git(["status", "--porcelain"]);
	if (status.code !== 0) throw gitFailure("git status", status);
	const diff = await git(["diff", "--no-color", diffFrom]);
	if (diff.code !== 0) throw gitFailure("git diff", diff);

	return {
		cwd: input.cwd,
		capturedAt: input.capturedAt ?? Date.now(),
		source,
		...(base !== undefined ? { baseRef: base } : {}),
		headRef,
		statusText: retainTextWithOmissions(status.stdout, REVIEWER_STATUS_MAX_CHARS),
		statusTruncated: redactSensitiveText(status.stdout).length > REVIEWER_STATUS_MAX_CHARS,
		diffText: retainTextWithOmissions(diff.stdout, REVIEWER_DIFF_MAX_CHARS),
		diffTruncated: redactSensitiveText(diff.stdout).length > REVIEWER_DIFF_MAX_CHARS,
	};
}
