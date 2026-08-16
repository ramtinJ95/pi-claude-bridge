import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

function readPackage(relativePath) {
	return JSON.parse(readFileSync(join(ROOT, relativePath), "utf8"));
}

export function installedRuntimeVersions() {
	const agentSdk = readPackage("node_modules/@anthropic-ai/claude-agent-sdk/package.json");
	return {
		piAi: readPackage("node_modules/@earendil-works/pi-ai/package.json").version,
		piCodingAgent: readPackage("node_modules/@earendil-works/pi-coding-agent/package.json").version,
		piTui: readPackage("node_modules/@earendil-works/pi-tui/package.json").version,
		agentSdk: agentSdk.version,
		bundledClaudeCode: agentSdk.claudeCodeVersion ?? "unknown",
	};
}

export function formatRuntimeVersions(versions = installedRuntimeVersions()) {
	return [
		`Pi ai/coding-agent/tui ${versions.piAi}/${versions.piCodingAgent}/${versions.piTui}`,
		`Agent SDK ${versions.agentSdk}`,
		`bundled Claude Code ${versions.bundledClaudeCode}`,
	].join("; ");
}
