#!/usr/bin/env node

import { it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

it("the portable timeout kills the command's whole process group", () => {
	const grandchildProgram = [
		'import { spawn } from "node:child_process";',
		'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
		'console.log(child.pid);',
		'setInterval(() => {}, 1000);',
	].join("\n");
	const result = spawnSync(process.execPath, [
		join(ROOT, "tests/lib/timeout.mjs"),
		"0.2",
		process.execPath,
		"--input-type=module",
		"-e",
		grandchildProgram,
	], { encoding: "utf8", timeout: 5_000 });

	assert.equal(result.status, 124, result.stderr || result.error?.message);
	const grandchildPid = Number(result.stdout.trim());
	assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0, `invalid child pid: ${result.stdout}`);
	assert.throws(
		() => process.kill(grandchildPid, 0),
		(error) => error?.code === "ESRCH",
		`grandchild ${grandchildPid} survived the timeout`,
	);
});
