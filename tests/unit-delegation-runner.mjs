import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runDelegation } from "../src/delegation-runner.js";

function fakeQuery(messages, hooks = {}) {
	return {
		async *[Symbol.asyncIterator]() {
			for (const message of messages) {
				if (hooks.closed) return;
				yield message;
				await new Promise((resolve) => setImmediate(resolve));
			}
		},
		async interrupt() { hooks.interrupts = (hooks.interrupts ?? 0) + 1; },
		close() { hooks.closes = (hooks.closes ?? 0) + 1; hooks.closed = true; },
	};
}

const init = {
	type: "system",
	subtype: "init",
	session_id: "session-1",
	cwd: "/tmp/project",
	model: "claude-test",
	permissionMode: "default",
};

const success = {
	type: "result",
	subtype: "success",
	is_error: false,
	result: "ANSWER",
	stop_reason: "end_turn",
	duration_ms: 20,
	duration_api_ms: 10,
	num_turns: 1,
	total_cost_usd: 0.01,
	usage: { input_tokens: 2, output_tokens: 3 },
	modelUsage: {},
	permission_denials: [],
};

describe("delegation runner", () => {
	it("owns the query lifecycle and returns the normalized result", async () => {
		const hooks = {};
		const snapshots = [];
		let received;
		const result = await runDelegation({
			prompt: "question",
			options: { cwd: "/tmp/project" },
			requestedPermissionMode: "auto",
			managedPolicy: Promise.resolve({ sandboxRequired: true }),
			queryFactory: (params) => { received = params; return fakeQuery([init, success], hooks); },
			onSnapshot: (snapshot) => snapshots.push(snapshot),
			now: (() => { let n = 0; return () => ++n; })(),
		});

		assert.equal(received.prompt, "question");
		assert.deepEqual(received.options, { cwd: "/tmp/project" });
		assert.equal(result.responseText, "ANSWER");
		assert.equal(result.snapshot.status, "succeeded");
		assert.deepEqual(result.permission, { requested: "auto", effective: "default", overridden: true });
		assert.equal(result.managedPolicy.sandboxRequired, true);
		assert.ok(hooks.closes >= 1);
		assert.ok(snapshots.some((snapshot) => snapshot.status === "succeeded"));
	});

	it("publishes a failed terminal snapshot before propagating an SDK result error", async () => {
		const snapshots = [];
		const failure = { ...success, is_error: true, result: "capacity exhausted" };

		await assert.rejects(
			runDelegation({
				prompt: "question",
				options: {},
				requestedPermissionMode: "auto",
				queryFactory: () => fakeQuery([failure]),
				onSnapshot: (snapshot) => snapshots.push(snapshot),
			}),
			/capacity exhausted/,
		);
		assert.equal(snapshots.at(-1).status, "failed");
		assert.equal(snapshots.at(-1).error, "capacity exhausted");
	});

	it("interrupts, closes, and reports cancellation through the same lifecycle", async () => {
		const controller = new AbortController();
		const hooks = {};
		const result = await runDelegation({
			prompt: "question",
			options: {},
			requestedPermissionMode: "auto",
			signal: controller.signal,
			queryFactory: () => fakeQuery([init, success], hooks),
			onSnapshot: (snapshot) => {
				if (snapshot.sessionId) controller.abort();
			},
		});

		assert.equal(result.stopReason, "cancelled");
		assert.equal(result.snapshot.status, "cancelled");
		assert.equal(hooks.interrupts, 1);
		assert.ok(hooks.closes >= 1);
	});
});
