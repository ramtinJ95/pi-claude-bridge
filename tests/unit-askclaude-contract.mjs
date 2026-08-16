import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	askClaudeContextTags,
	buildAskClaudeContract,
} from "../src/askclaude-contract.js";

describe("AskClaude model-facing contract", () => {
	it("describes the package defaults", () => {
		const contract = buildAskClaudeContract();

		assert.equal(contract.defaultMode, "read");
		assert.equal(contract.defaultIsolated, true);
		assert.match(contract.toolDescription, /Defaults to read-only mode/);
		assert.match(contract.promptDescription, /fresh session without Pi conversation history/);
		assert.match(contract.modeDescription, /"read" \(default\)/);
		assert.doesNotMatch(contract.modeDescription, /"full" \(default\)/);
		assert.match(contract.isolatedDescription, /Defaults to true\./);
	});

	it("describes configured full and isolated defaults", () => {
		const contract = buildAskClaudeContract({
			defaultMode: "full",
			defaultIsolated: true,
		});

		assert.equal(contract.defaultMode, "full");
		assert.equal(contract.defaultIsolated, true);
		assert.match(contract.toolDescription, /Defaults to full mode/);
		assert.match(contract.promptDescription, /fresh session without Pi conversation history/);
		assert.match(contract.modeDescription, /"full" \(default\)/);
		assert.doesNotMatch(contract.modeDescription, /"read" \(default\)/);
		assert.match(contract.isolatedDescription, /Defaults to true\./);
	});

	it("allows configuration to restore shared history as the default", () => {
		const contract = buildAskClaudeContract({ defaultIsolated: false });

		assert.equal(contract.defaultIsolated, false);
		assert.match(contract.promptDescription, /full conversation history/);
		assert.match(contract.isolatedDescription, /Defaults to false\./);
	});

	it("honors a custom top-level description", () => {
		assert.equal(
			buildAskClaudeContract({ description: "Use the specialist" }).toolDescription,
			"Use the specialist",
		);
	});

	it("does not let a full default bypass allowFullMode=false", () => {
		const contract = buildAskClaudeContract({
			allowFullMode: false,
			defaultMode: "full",
		});

		assert.equal(contract.defaultMode, "read");
		assert.deepEqual(contract.modeValues, ["read", "none"]);
		assert.doesNotMatch(contract.modeDescription, /"full"/);
		assert.doesNotMatch(contract.toolDescription, /full mode/);
	});

	it("fails an invalid JSON defaultMode closed", () => {
		const contract = buildAskClaudeContract({
			allowFullMode: false,
			defaultMode: "ful",
		});

		assert.equal(contract.defaultMode, "read");
		assert.deepEqual(contract.modeValues, ["read", "none"]);
		assert.match(contract.modeDescription, /"read" \(default\)/);
		assert.doesNotMatch(contract.toolDescription, /full mode/);
	});

	it("fails a malformed allowFullMode closed", () => {
		const contract = buildAskClaudeContract({ allowFullMode: "false" });

		assert.equal(contract.allowFull, false);
		assert.deepEqual(contract.modeValues, ["read", "none"]);
		assert.doesNotMatch(contract.modeDescription, /"full"/);
	});

	it("uses the package isolation default for malformed JSON", () => {
		const contract = buildAskClaudeContract({ defaultIsolated: "false" });

		assert.equal(contract.defaultIsolated, true);
		assert.match(contract.promptDescription, /fresh session without Pi conversation history/);
		assert.match(contract.isolatedDescription, /Defaults to true\./);
	});
});

describe("AskClaude call tags", () => {
	it("shows configured non-package defaults when arguments are omitted", () => {
		const contract = buildAskClaudeContract({
			defaultMode: "full",
			defaultIsolated: true,
		});

		assert.deepEqual(askClaudeContextTags({}, contract), ["mode=full", "isolated"]);
	});

	it("shows explicit overrides", () => {
		const contract = buildAskClaudeContract({
			defaultMode: "full",
			defaultIsolated: true,
		});

		assert.deepEqual(
			askClaudeContextTags({ mode: "read", isolated: false }, contract),
			["mode=read", "shared"],
		);
	});

	it("shows the safe isolated package default", () => {
		assert.deepEqual(askClaudeContextTags({}, buildAskClaudeContract()), ["isolated"]);
	});
});
