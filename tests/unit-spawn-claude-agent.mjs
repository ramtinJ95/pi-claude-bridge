import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BackgroundJobManager } from "../src/background-jobs.js";
import { __test } from "../src/index.js";

const { registerSpawnClaudeAgent } = __test;

/** Minimal Pi extension API double: records registrations, replays events. */
function fakePi() {
	const tools = new Map();
	const handlers = new Map();
	return {
		tools,
		handlers,
		registerTool(tool) {
			tools.set(tool.name, tool);
		},
		on(type, handler) {
			const list = handlers.get(type) ?? [];
			list.push(handler);
			handlers.set(type, list);
		},
		// Pi 0.84.2's extension runner awaits every handler; mirror that.
		async emit(type, event) {
			const results = [];
			for (const handler of handlers.get(type) ?? []) results.push(await handler(event, {}));
			return results;
		},
	};
}

const DIFF_ARTIFACT = {
	cwd: "/repo",
	capturedAt: 0,
	source: "working tree at launch vs HEAD abcdef123456 (staged + unstaged changes)",
	headRef: "abcdef123456",
	statusText: " M src/a.ts",
	statusTruncated: false,
	diffText: "+changed line",
	diffTruncated: false,
};

function runResult() {
	return {
		responseText: "done",
		stopReason: "stop",
		permissionDenials: [],
		snapshot: { status: "succeeded", tools: [], permissionDenials: [], diagnostics: [], timeline: [], responseText: "done", thinkingText: "" },
		messageCount: 1,
	};
}

/** Wire the seam with recording fakes; every effect is injectable and observed. */
function wire(overrides = {}) {
	const pi = fakePi();
	const jobs = new BackgroundJobManager({ idPrefix: "t", sleep: () => Promise.resolve() });
	const captures = [];
	const runs = [];
	const deps = {
		enabled: true,
		jobs,
		captureDiff: async (input) => {
			captures.push(input);
			return { ...DIFF_ARTIFACT, cwd: input.cwd, capturedAt: input.capturedAt };
		},
		runJob: (input) => {
			runs.push(input);
			return new Promise(() => {}); // background work outlives the tool call
		},
		cwd: () => "/repo",
		now: () => 42,
		...overrides,
	};
	registerSpawnClaudeAgent(pi, deps);
	return { pi, jobs, captures, runs, deps };
}

function execute(pi, params, { signal, ctx } = {}) {
	const tool = pi.tools.get("SpawnClaudeAgent");
	assert.ok(tool, "SpawnClaudeAgent must be registered");
	return tool.execute(
		"call-1",
		params,
		signal ?? new AbortController().signal,
		undefined,
		ctx ?? { model: { baseUrl: "anthropic" } },
	);
}

describe("SpawnClaudeAgent adapter wiring", () => {
	it("registers nothing when the AskClaude opt-in is off", () => {
		const pi = fakePi();
		registerSpawnClaudeAgent(pi, {
			enabled: false,
			jobs: new BackgroundJobManager({ idPrefix: "t" }),
			captureDiff: async () => { throw new Error("unreachable"); },
			runJob: async () => runResult(),
		});
		assert.equal(pi.tools.size, 0);
		assert.equal(pi.handlers.size, 0);
	});

	it("returns the job ID before the injected background executor settles", async () => {
		const { pi, jobs, captures, runs } = wire();
		const result = await execute(pi, { task: "map the module graph", profile: "explorer" });

		// The executor is still pending — the tool already answered.
		assert.equal(runs.length, 1);
		assert.equal(result.details.jobId, "claude-job-t-1");
		assert.equal(result.details.error, undefined);
		assert.equal(result.details.launchCwd, "/repo");
		assert.equal(result.details.launchCapturedAt, 42);
		assert.ok(result.content[0].text.includes("claude-job-t-1"));
		assert.equal(jobs.get("claude-job-t-1").status, "running");
		// Explorer never pays for diff capture.
		assert.equal(captures.length, 0);
	});

	it("passes profile, model, thinking, cwd, and the diff-bearing prompt into the execution path", async () => {
		const { pi, captures, runs } = wire();
		const result = await execute(pi, {
			task: "review the change",
			profile: "reviewer",
			model: "sonnet",
			thinking: "high",
			base: "main",
		});

		assert.deepEqual(captures, [{ cwd: "/repo", base: "main", capturedAt: 42 }]);
		assert.equal(result.details.diffSource, DIFF_ARTIFACT.source);
		assert.equal(result.details.diffArtifactTruncated, false);
		assert.equal(runs.length, 1);
		const run = runs[0];
		assert.equal(run.profile.id, "reviewer");
		assert.equal(run.requestedModel, "sonnet");
		assert.equal(run.thinking, "high");
		assert.equal(run.cwd, "/repo");
		assert.ok(run.signal instanceof AbortSignal);
		assert.ok(run.prompt.includes("background code-review agent"));
		assert.ok(run.prompt.includes("+changed line"));
		assert.ok(run.prompt.includes("Task:\nreview the change"));
	});

	it("reports the truncation fact honestly for status-only truncation of the launch artifact", async () => {
		const { pi } = wire({
			captureDiff: async (input) => ({
				...DIFF_ARTIFACT,
				cwd: input.cwd,
				capturedAt: input.capturedAt,
				statusTruncated: true,
				diffTruncated: false,
			}),
		});
		const result = await execute(pi, { task: "review", profile: "reviewer" });
		assert.equal(result.details.error, undefined);
		assert.equal(result.details.diffArtifactTruncated, true);
	});

	it("promotes a second concurrent spawn to an error without paying for diff capture", async () => {
		const { pi, captures } = wire();
		const first = await execute(pi, { task: "explore", profile: "explorer" });
		const second = await execute(pi, { task: "review", profile: "reviewer" });

		assert.equal(second.details.error, true);
		assert.ok(second.content[0].text.includes(first.details.jobId));
		// The rejection happened before any reviewer git capture.
		assert.equal(captures.length, 0);
	});

	it("promotes a diff-capture failure to an error result and starts no job", async () => {
		const { pi, jobs, runs } = wire({
			captureDiff: async () => { throw new Error('Invalid comparison base "nope": not a commit in this repository.'); },
		});
		const result = await execute(pi, { task: "review", profile: "reviewer", base: "nope" });

		assert.equal(result.details.error, true);
		assert.ok(result.content[0].text.includes('Invalid comparison base "nope"'));
		assert.deepEqual(jobs.list(), []);
		assert.equal(runs.length, 0);
	});

	it("starts no job when the tool call was cancelled before launch", async () => {
		const { pi, jobs, captures, runs } = wire();
		const controller = new AbortController();
		controller.abort();
		const result = await execute(pi, { task: "review", profile: "reviewer" }, { signal: controller.signal });

		assert.equal(result.details.error, true);
		assert.ok(result.content[0].text.includes("cancelled"));
		assert.equal(captures.length, 0);
		assert.equal(runs.length, 0);
		assert.deepEqual(jobs.list(), []);
	});

	it("starts no detached job when the tool call is cancelled during diff capture", async () => {
		const controller = new AbortController();
		const { pi, jobs, runs } = wire({
			captureDiff: async (input) => {
				controller.abort(); // cancellation lands while the capture is awaited
				return { ...DIFF_ARTIFACT, cwd: input.cwd, capturedAt: input.capturedAt };
			},
		});
		const result = await execute(pi, { task: "review", profile: "reviewer" }, { signal: controller.signal });

		assert.equal(result.details.error, true);
		assert.ok(result.content[0].text.includes("cancelled during launch capture"));
		assert.equal(runs.length, 0);
		assert.deepEqual(jobs.list(), []);
	});

	it("hands the running job to its own controller — the tool-call signal plays no further part", async () => {
		const { pi, jobs, runs } = wire();
		const controller = new AbortController();
		await execute(pi, { task: "explore", profile: "explorer" }, { signal: controller.signal });

		controller.abort();
		assert.equal(runs[0].signal.aborted, false);
		assert.equal(jobs.get("claude-job-t-1").status, "running");
		// The manager's own cancel still reaches the job.
		assert.equal(jobs.cancel("claude-job-t-1"), true);
		assert.equal(runs[0].signal.aborted, true);
	});

	it("wires session shutdown and session-start reset cleanup", async () => {
		const { pi, jobs } = wire();
		await execute(pi, { task: "explore", profile: "explorer" });
		assert.equal(jobs.get("claude-job-t-1").status, "running");

		// The executor never settles and the injected sleep is instant, so the
		// awaited shutdown handler records the job as abandoned.
		await pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
		assert.equal(jobs.get("claude-job-t-1").status, "abandoned");

		await pi.emit("session_start", { type: "session_start", reason: "new" });
		assert.deepEqual(jobs.list(), []);
	});

	it("wires tool_result promotion for its own failed results", async () => {
		const { pi } = wire();
		const [promoted] = await pi.emit("tool_result", { toolName: "SpawnClaudeAgent", isError: false, details: { error: true } });
		assert.deepEqual(promoted, { isError: true });
		const [ignored] = await pi.emit("tool_result", { toolName: "SpawnClaudeAgent", isError: false, details: { jobId: "claude-job-t-1" } });
		assert.equal(ignored, undefined);
	});

	it("keeps the claude-bridge circular-delegation block", async () => {
		const { pi, jobs, runs } = wire();
		const result = await execute(pi, { task: "explore", profile: "explorer" }, { ctx: { model: { baseUrl: "claude-bridge" } } });

		assert.equal(result.details.error, true);
		assert.ok(result.content[0].text.includes("claude-bridge"));
		assert.deepEqual(jobs.list(), []);
		assert.equal(runs.length, 0);
	});

	it("rejects the base parameter outside the reviewer profile", async () => {
		const { pi, jobs } = wire();
		const result = await execute(pi, { task: "explore", profile: "explorer", base: "main" });
		assert.equal(result.details.error, true);
		assert.ok(result.content[0].text.includes("only applies to the reviewer profile"));
		assert.deepEqual(jobs.list(), []);
	});
});
