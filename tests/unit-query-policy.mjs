import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
	ASKCLAUDE_FULL_DISALLOWED_TOOLS,
	ASKCLAUDE_READ_TOOLS,
	DEFAULT_PERMISSION_MODE,
	managedPolicyLabels,
	observePermissionMode,
	resolveDelegationPolicy,
	resolvePermissionMode,
	resolveProviderPermissionPolicy,
	summarizeManagedPolicy,
} from "../src/query-policy.js";

describe("Claude query permission policy", () => {
	it("defaults every query path to auto", () => {
		assert.equal(DEFAULT_PERMISSION_MODE, "auto");
		assert.equal(resolveProviderPermissionPolicy().permissionMode, "auto");
		assert.equal(resolveDelegationPolicy("read").permissionMode, "auto");
	});

	it("accepts SDK permission modes without coupling them to capability", () => {
		const read = resolveDelegationPolicy("read", { permissionMode: "dontAsk" });
		const full = resolveDelegationPolicy("full", { permissionMode: "dontAsk" });

		assert.equal(read.permissionMode, "dontAsk");
		assert.equal(full.permissionMode, "dontAsk");
		assert.deepEqual(read.tools, [...ASKCLAUDE_READ_TOOLS]);
		assert.deepEqual(full.tools, { type: "preset", preset: "claude_code" });
	});

	it("requires an explicit SDK acknowledgement for configured bypass", () => {
		assert.deepEqual(resolveProviderPermissionPolicy({ permissionMode: "bypassPermissions" }), {
			requestedPermissionMode: "bypassPermissions",
			permissionMode: "bypassPermissions",
			allowDangerouslySkipPermissions: true,
		});
	});

	it("fails malformed JSON permission modes closed to auto", () => {
		assert.equal(resolvePermissionMode("automatic"), "auto");
		assert.equal(resolveProviderPermissionPolicy({ permissionMode: "automatic" }).permissionMode, "auto");
	});

	it("records runtime overrides without attributing their cause", () => {
		assert.deepEqual(observePermissionMode("auto", "default"), {
			requested: "auto",
			effective: "default",
			overridden: true,
		});
		assert.deepEqual(observePermissionMode("auto", "auto"), {
			requested: "auto",
			effective: "auto",
			overridden: false,
		});
		assert.equal(observePermissionMode("auto", undefined), undefined);
	});

	it("summarizes managed constraints without exposing rule contents", () => {
		const summary = summarizeManagedPolicy({
			effective: {},
			provenance: {},
			sources: [{
				source: "managed",
				policyOrigin: "plist",
				settings: {
					permissions: {
						disableBypassPermissionsMode: "disable",
						deny: ["Read(**/secret/**)"],
					},
					allowManagedPermissionRulesOnly: true,
					sandbox: {
						enabled: true,
						failIfUnavailable: true,
						allowUnsandboxedCommands: false,
						allowManagedReadPathsOnly: true,
						network: { allowManagedDomainsOnly: true },
					},
				},
			}],
		});

		assert.deepEqual(summary, {
			origin: "plist",
			disableBypassPermissions: true,
			permissionRulesOnly: true,
			denyRuleCount: 1,
			askRuleCount: 0,
			sandboxRequired: true,
			unsandboxedCommandsDisabled: true,
			managedDomainsOnly: true,
			managedReadPathsOnly: true,
		});
		assert.deepEqual(managedPolicyLabels(summary), [
			"sandbox required",
			"unsandboxed commands disabled",
			"managed permission rules only",
			"bypass disabled",
			"managed network domains only",
			"managed read paths only",
			"1 managed deny rule",
		]);
		assert.doesNotMatch(managedPolicyLabels(summary).join(" "), /secret/);
	});

	it("wires all extension query paths through resolved policy", () => {
		const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
		const resolvedAssignments = source.match(
			/permissionMode:\s*(?:permissionPolicy|delegationPolicy)\.permissionMode/g,
		) ?? [];

		assert.equal(resolvedAssignments.length, 3, "provider, compaction, and delegation must all use resolved policy");
		assert.doesNotMatch(source, /permissionMode:\s*["'][^"']+["']/,
			"an extension query path hard-codes a permission mode");
		assert.doesNotMatch(source, /canUseTool\s*:/,
			"the bridge must not override Claude or organization permission decisions");
	});
});

describe("AskClaude capability policy", () => {
	it("uses a structural read-only tool inventory without nested Agent", () => {
		const policy = resolveDelegationPolicy("read");

		assert.deepEqual(policy.tools, [...ASKCLAUDE_READ_TOOLS]);
		assert.ok(!policy.tools.includes("Agent"));
		assert.ok(!policy.tools.includes("Bash"));
		assert.ok(!policy.tools.includes("Edit"));
		assert.equal(policy.disallowedTools, undefined);
	});

	it("uses an empty tool inventory for no-access mode", () => {
		assert.deepEqual(resolveDelegationPolicy("none").tools, []);
	});

	it("keeps unsupported interactive tools out of full mode", () => {
		const policy = resolveDelegationPolicy("full");

		assert.deepEqual(policy.tools, { type: "preset", preset: "claude_code" });
		assert.deepEqual(policy.disallowedTools, [...ASKCLAUDE_FULL_DISALLOWED_TOOLS]);
	});
});
