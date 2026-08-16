#!/usr/bin/env node

// Portable timeout fallback for macOS, which does not ship GNU timeout.
// The child owns a process group so a timeout terminates Pi and every Claude
// Code subprocess it started instead of orphaning credential-consuming work.

import { spawn } from "node:child_process";

const [secondsText, command, ...args] = process.argv.slice(2);
const seconds = Number(secondsText);
if (!command || !Number.isFinite(seconds) || seconds <= 0) {
	console.error("usage: timeout.mjs <seconds> <command> [args...]");
	process.exit(2);
}

const child = spawn(command, args, { stdio: "inherit", detached: true });
let timedOut = false;
let forceTimer;

function signalGroup(signal) {
	if (!child.pid) return;
	try {
		process.kill(-child.pid, signal);
	} catch (error) {
		if (error?.code !== "ESRCH") throw error;
	}
}

const timer = setTimeout(() => {
	timedOut = true;
	signalGroup("SIGTERM");
	forceTimer = setTimeout(() => signalGroup("SIGKILL"), 2_000);
}, seconds * 1_000);

for (const signal of ["SIGINT", "SIGTERM"]) {
	process.once(signal, () => signalGroup(signal));
}

child.once("error", (error) => {
	clearTimeout(timer);
	if (forceTimer) clearTimeout(forceTimer);
	console.error(`timeout: could not start ${command}: ${error.message}`);
	process.exitCode = 127;
});

child.once("exit", (code, signal) => {
	clearTimeout(timer);
	if (forceTimer) clearTimeout(forceTimer);
	if (timedOut) {
		process.exitCode = 124;
	} else if (code !== null) {
		process.exitCode = code;
	} else {
		console.error(`timeout: ${command} exited from ${signal ?? "an unknown signal"}`);
		process.exitCode = 1;
	}
});
