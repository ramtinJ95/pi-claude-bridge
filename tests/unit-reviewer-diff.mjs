import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	REVIEWER_DIFF_MAX_CHARS,
	REVIEWER_STATUS_MAX_CHARS,
	ReviewerDiffError,
	captureReviewerDiff,
} from "../src/reviewer-diff.js";

const ok = (stdout) => ({ code: 0, stdout, stderr: "" });
const fail = (stderr = "fatal: nope") => ({ code: 128, stdout: "", stderr });

/** Fake git keyed by joined args; records calls; unknown invocations fail loudly. */
function fakeGit(responses) {
	const calls = [];
	const runner = async (args) => {
		const key = args.join(" ");
		calls.push(key);
		const response = responses[key];
		if (!response) throw new Error(`unexpected git invocation: git ${key}`);
		return response;
	};
	runner.calls = calls;
	return runner;
}

function repoResponses(overrides = {}) {
	return {
		"rev-parse --is-inside-work-tree": ok("true\n"),
		"rev-parse --short=12 HEAD": ok("abcdef123456\n"),
		"status --porcelain": ok(" M src/app.ts\n"),
		"diff --no-color HEAD": ok("diff --git a/src/app.ts b/src/app.ts\n+new line\n"),
		"ls-files --others --exclude-standard -z": ok(""),
		...overrides,
	};
}

describe("reviewer diff capture", () => {
	it("pins the named artifact bounds", () => {
		assert.equal(REVIEWER_DIFF_MAX_CHARS, 40_000);
		assert.equal(REVIEWER_STATUS_MAX_CHARS, 4_000);
	});

	it("captures staged and unstaged changes from HEAD when no base is given", async () => {
		const git = fakeGit(repoResponses());
		const artifact = await captureReviewerDiff({ cwd: "/tmp/project", capturedAt: 42, git });

		assert.equal(artifact.cwd, "/tmp/project");
		assert.equal(artifact.capturedAt, 42);
		assert.equal(artifact.headRef, "abcdef123456");
		assert.equal(artifact.baseRef, undefined);
		assert.match(artifact.source, /HEAD abcdef123456/);
		assert.match(artifact.source, /tracked \+ untracked/);
		assert.equal(artifact.diffText, "diff --git a/src/app.ts b/src/app.ts\n+new line\n");
		assert.equal(artifact.statusText, " M src/app.ts\n");
		assert.equal(artifact.diffTruncated, false);
		assert.equal(artifact.statusTruncated, false);
		assert.ok(git.calls.includes("diff --no-color HEAD"));
		assert.ok(git.calls.includes("ls-files --others --exclude-standard -z"));
	});

	it("includes untracked file contents in the frozen artifact", async () => {
		const git = fakeGit(repoResponses({
			"status --porcelain": ok("?? src/new thing.ts\n?? src/empty.ts\n"),
			"diff --no-color HEAD": ok(""),
			"ls-files --others --exclude-standard -z": ok("src/new thing.ts\0src/empty.ts\0"),
			"diff --no-index --no-color -- /dev/null src/new thing.ts": {
				code: 1,
				stdout: "diff --git a/src/new thing.ts b/src/new thing.ts\n+new file contents\n",
				stderr: "",
			},
			"diff --no-index --no-color -- /dev/null src/empty.ts": ok(""),
		}));
		const artifact = await captureReviewerDiff({ cwd: "/tmp/project", git });

		assert.match(artifact.diffText, /new file contents/);
		assert.match(artifact.diffText, /Untracked empty file captured at launch: "src\/empty\.ts"/);
		assert.equal(artifact.diffTruncated, false);
	});

	it("diffs from the merge base of an explicit comparison base and records it", async () => {
		const git = fakeGit(repoResponses({
			"rev-parse --verify --quiet main^{commit}": ok("1111111111111111\n"),
			"merge-base main HEAD": ok("2222222222222222\n"),
			"diff --no-color 2222222222222222": ok("+branch change\n"),
		}));
		const artifact = await captureReviewerDiff({ cwd: "/tmp/project", base: "main", git });

		assert.equal(artifact.baseRef, "main");
		assert.match(artifact.source, /merge-base of "main" and HEAD \(222222222222\)/);
		assert.equal(artifact.diffText, "+branch change\n");
		assert.ok(git.calls.includes("diff --no-color 2222222222222222"));
		assert.ok(!git.calls.some((call) => call === "diff --no-color HEAD"));
	});

	it("fails clearly outside a git work tree instead of returning an empty diff", async () => {
		const git = fakeGit({ "rev-parse --is-inside-work-tree": fail("fatal: not a git repository") });
		await assert.rejects(
			captureReviewerDiff({ cwd: "/tmp/nowhere", git }),
			(error) => error instanceof ReviewerDiffError && /not inside a git work tree/.test(error.message),
		);
	});

	it("fails clearly when HEAD cannot be resolved", async () => {
		const git = fakeGit(repoResponses({
			"rev-parse --short=12 HEAD": fail("fatal: ambiguous argument 'HEAD'"),
		}));
		await assert.rejects(
			captureReviewerDiff({ cwd: "/tmp/project", git }),
			/cannot resolve HEAD/,
		);
	});

	it("fails clearly for a base that is not a commit", async () => {
		const git = fakeGit(repoResponses({
			"rev-parse --verify --quiet no-such-branch^{commit}": fail(""),
		}));
		await assert.rejects(
			captureReviewerDiff({ cwd: "/tmp/project", base: "no-such-branch", git }),
			/Invalid comparison base "no-such-branch": not a commit/,
		);
	});

	it("fails clearly for a base with no merge base with HEAD", async () => {
		const git = fakeGit(repoResponses({
			"rev-parse --verify --quiet orphan^{commit}": ok("3333333333333333\n"),
			"merge-base orphan HEAD": fail(""),
		}));
		await assert.rejects(
			captureReviewerDiff({ cwd: "/tmp/project", base: "orphan", git }),
			/no merge base with HEAD/,
		);
	});

	it("rejects option-shaped and empty bases before touching git", async () => {
		for (const base of ["--exec=evil", "-x", "", "  "]) {
			const git = fakeGit({});
			await assert.rejects(
				captureReviewerDiff({ cwd: "/tmp/project", base, git }),
				/Invalid comparison base/,
			);
			assert.equal(git.calls.length, 0);
		}
	});

	it("bounds the diff at the named limit with a visible truncation marker", async () => {
		const hugeDiff = "+x".repeat(REVIEWER_DIFF_MAX_CHARS);
		const git = fakeGit(repoResponses({ "diff --no-color HEAD": ok(hugeDiff) }));
		const artifact = await captureReviewerDiff({ cwd: "/tmp/project", git });

		assert.equal(artifact.diffTruncated, true);
		assert.ok(artifact.diffText.length <= REVIEWER_DIFF_MAX_CHARS);
		assert.match(artifact.diffText, /\[… truncated \d+ chars\]/);
	});

	it("bounds the status output at its own named limit", async () => {
		const hugeStatus = "?? f\n".repeat(REVIEWER_STATUS_MAX_CHARS);
		const git = fakeGit(repoResponses({ "status --porcelain": ok(hugeStatus) }));
		const artifact = await captureReviewerDiff({ cwd: "/tmp/project", git });

		assert.equal(artifact.statusTruncated, true);
		assert.ok(artifact.statusText.length <= REVIEWER_STATUS_MAX_CHARS);
		assert.match(artifact.statusText, /\[… truncated \d+ chars\]/);
	});

	it("redacts credential-shaped content before it enters the artifact", async () => {
		const git = fakeGit(repoResponses({
			"diff --no-color HEAD": ok('+const key = "sk-ant-abcdefghijklmnop";\n'),
		}));
		const artifact = await captureReviewerDiff({ cwd: "/tmp/project", git });

		assert.ok(!artifact.diffText.includes("sk-ant-abcdefghijklmnop"));
		assert.ok(artifact.diffText.includes("[REDACTED]"));
	});

	it("returns an honest empty artifact for a clean tree in a valid repository", async () => {
		const git = fakeGit(repoResponses({
			"status --porcelain": ok(""),
			"diff --no-color HEAD": ok(""),
		}));
		const artifact = await captureReviewerDiff({ cwd: "/tmp/project", git });

		assert.equal(artifact.diffText, "");
		assert.equal(artifact.statusText, "");
		assert.equal(artifact.diffTruncated, false);
		assert.equal(artifact.statusTruncated, false);
	});
});
