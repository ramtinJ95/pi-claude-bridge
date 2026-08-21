# pi-claude-bridge

[![npm version](https://img.shields.io/npm/v/pi-claude-bridge)](https://www.npmjs.com/package/pi-claude-bridge)

Pi extension that integrates Claude Code via the [Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript). Based initially on [claude-agent-sdk-pi](https://github.com/prateekmedia/claude-agent-sdk-pi) by Prateek Sunal. This fork adds streaming, MCP tool bridging, custom pi tool bridging, session resume/persistence, context sync, thinking support, skills forwarding, and many correctness fixes.

1. **Provider** — Use Opus/Sonnet/Haiku as models in pi, with all tool calls flowing through pi's TUI
2. **AskClaude tool** — Delegate tasks or questions to Claude Code when using another provider


**FYI:** Anthropic [announced and then unannounced](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) a change to how you would be billed for tools that use the Agent SDK like this one. It currently uses your regular subscription quota just like Claude Code.

<p>
<a href="assets/claude-bridge1.png"><img src="assets/claude-bridge1.png" width="49%"></a>&nbsp;
<a href="assets/claude-bridge2.png"><img src="assets/claude-bridge2.png" width="49%"></a>
</p>

## Install

```
pi install npm:pi-claude-bridge
```

This fork requires Pi 0.84.2 or newer and Node.js 22.19 or newer.

## Provider

Use `/model` to select `claude-bridge/claude-fable-5`, `claude-bridge/claude-opus-5`, `claude-bridge/claude-opus-4-8`, `claude-bridge/claude-opus-4-7`, `claude-bridge/claude-opus-4-6`, `claude-bridge/claude-sonnet-5`, `claude-bridge/claude-sonnet-4-6`, or `claude-bridge/claude-haiku-4-5`.

Behind the scenes, pi's tools are bridged to Claude Code but it should all work like normal in pi. Bash commands get a 120-second default timeout (matching Claude Code's default) since pi's bash has no timeout by default. Skills in pi are copied over to Claude Code's system prompt so should work as they would with any other pi provider. Steering works mid-turn: a message sent while Claude is running a tool reaches it at that tool boundary, not after the whole turn finishes.

**1M Context:** Opus 5, Opus 4.8, and Opus 4.7 get 1M context by default. Opus 4.6 only gets 1M if you're on a Max plan or pay for Extra Usage. Sonnet 4.6 only gets 1M if you pay for Extra Usage. You will need to set `provider.plan` and/or `provider.longContextExtraUsage` for 1M context in Opus 4.6/Sonnet 4.6 as described in [Configuration](#configuration).

## AskClaude Tool

Opt-in: set `askClaude.enabled` to `true` (see [Configuration](#configuration)). Available when using any non-claude-bridge provider. Pi's LLM can delegate tasks to Claude Code and wait for it to answer a question or perform a task. Examples of how to use:

- "Ask Claude to plan a fix"
- "If you get stuck, ask claude for help"
- "Ask claude to review the plan in @foo.md, implement it, then ask an isolated=true claude to review the implementation"
- "Ask claude to poke holes in this theory"
- "Find all the places in the codebase that handle auth"

You could also create skills or add something to AGENTS.md to e.g. "Always call Ask Claude to review complicated feature implementations before considering the task complete."

### Parameters

- **`prompt`** — the question or task for Claude Code
- **`mode`** — `read` (default; model-callable tools are limited to Read, Glob, Grep, WebFetch, and WebSearch), `none` (no model-callable tools), or `full` (Claude Code's normal tools except unsupported interactive/lifecycle tools; disable with `allowFullMode: false`)
- **`model`** — `opus` (default), `sonnet`, `haiku`, or a full model ID
- **`thinking`** — effort level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`
- **`isolated`** — when `true`, Claude gets a fresh conversation with no Pi history or persisted Claude session (default: `true`). This is conversation isolation, not a hermetic process: working-directory access, settings, sandbox, and managed policy still apply.

While a call runs, AskClaude streams Claude's response and a compact tool/action
summary into one Pi tool row. Expand the row for the prompt, emitted thinking
summaries, a grouped action summary with one aggregate tool-status line,
usage/cost, session metadata, observed permission or managed-policy state, and
the authoritative response. Per-tool inputs/outputs, durations, nesting, and the
retained event timeline live only in the details overlay below, not inline.
Thinking is emitted summary text, not private chain-of-thought. Persisted display
details use bounded fields, visible truncation, and best-effort credential
redaction; the model-facing result is separately capped at about 16k characters.

### Details overlay

For deep inspection beyond the inline row, `/askclaude-details` opens a centered
overlay with the latest AskClaude call (`/askclaude-details 2` opens call #2);
`Ctrl+N` toggles the same overlay. Calls are read from the current session
branch, so completed calls stay inspectable after a session resume, and the
latest call updates live while it runs.

Pi 0.84.2 also assigns `Ctrl+N` inside its session picker. The extension owns
the shortcut in the main editor, so Pi may report that overlap as an extension
shortcut warning at startup; the session picker's focused binding still works.

The pinned header shows only what the Claude delegation itself reported —
runtime model, tokens/cache/cost/turns, Claude session ID, Claude working
directory, runtime permission mode, status, capability, isolation, and requested
thinking level. Values the delegation did not report read `unavailable` rather
than borrowing anything from the active Pi session. The scrollable body shows
the full original prompt (from the persisted tool-call arguments), the emitted
thinking summary, retained nested tools with inputs/outputs/durations/status,
the retained timeline, and the authoritative response. Tool outputs and lists
remain subject to the same retained limits as the inline row — truncation and
omission notices are shown as persisted, not re-expanded.

Keys while the overlay is focused: `↑`/`↓` or `j`/`k` scroll by line,
`PgUp`/`PgDn` (including your configured select-page bindings) by page,
`Home`/`End` jump, `1`-`9` jump to a section, `←`/`→` (or `p`/`n`) switch to the
previous/next AskClaude call, and `q`, `Esc`, or `Ctrl+N` close.

## Configuration

Config: `~/.pi/agent/claude-bridge.json` (global) or the project Pi config directory, usually `.pi/claude-bridge.json` (project; merged over global).

```json
{
  "askClaude": {
    "enabled": true,
    "allowFullMode": true,
    "defaultIsolated": true,
    "permissionMode": "auto",
    "description": "Custom tool description override"
  },
  "provider": {
    "plan": "max",
    "longContextExtraUsage": false,
    "strictMcpConfig": true,
    "permissionMode": "auto",
    "pathToClaudeCodeExecutable": "/home/you/.nix-profile/bin/claude"
  }
}
```

`askClaude`:
- `enabled` — register the AskClaude tool (default `false`). If it's unset, the startup notice below points this out once.
- `name` — override the tool's pi-side name (default `"AskClaude"`)
- `label` — override the TUI label (default `"Ask Claude Code"`)
- `description` — override the tool description. Default when `allowFullMode: true`: *"Delegate to Claude Code for a second opinion or analysis (code review, architecture questions, debugging theories), or to autonomously handle a task. Defaults to read-only mode — use full mode when the user wants to delegate a task that requires changes. Prefer to handle straightforward tasks yourself."*
- `defaultMode` — `"read"` (default), `"none"`, or `"full"`
- `defaultIsolated` — start each call in a fresh conversation without Pi history or Claude session persistence (default `true`)
- `allowFullMode` — allow `mode: "full"`; set `false` to lock it out
- `appendSkills` — forward pi's skills block into the system prompt (default `true`)
- `permissionMode` — Claude Code permission policy within the selected capability mode (default `"auto"`). Supported SDK values are `"auto"`, `"default"`, `"acceptEdits"`, `"dontAsk"`, `"plan"`, and `"bypassPermissions"`. Bypass is dangerous, must be explicit, and cannot override organization-managed policy.

`provider`:
- `plan` (default `"pro"`) — set to `"max"` if you have a Max (or Team Premium/Enterprise) Anthropic plan. This enables Opus with 1M context.
- `longContextExtraUsage` — set to `true` to enable 1M context models even if they cost money through Extra Usage on your plan. It enables Sonnet 4.6 with 1M on every plan and Opus 4.6 with 1M on Pro. Not needed for Opus 4.7 or 4.8.
- `strictMcpConfig` — block MCP servers from `~/.claude.json` / `.mcp.json` (default `true`). Cloud MCP (Gmail/Drive via claude.ai OAuth) is always blocked.
- `autoMemoryEnabled` — enable Claude Code's auto-memory system (default `false`)
- `permissionMode` — Claude Code permission policy for provider queries and isolated summaries (default `"auto"`). The bridge does not install a host callback that overrides denials; Claude settings and managed policy may therefore reject Pi MCP calls.
- `pathToClaudeCodeExecutable` — path to the `claude` binary. Useful if your OS/filesystem has the SDK's bundled musl/glibc binaries in a place where they can't run. For example, with Nix you can set the binary to e.g. `"/home/you/.nix-profile/bin/claude"`.

If a provider tool is denied, allow its exact Claude-side MCP alias in Claude
permission settings (for example, `mcp__custom-tools__read`) or explicitly choose
a different `provider.permissionMode`. Organization-managed permission rules may
require an administrator to add the grant. The bridge deliberately does not pass
`allowedTools` for every Pi tool: doing so would auto-approve the entire Pi tool
inventory and make the configured provider permission mode nominal rather than
effective.

Capability and permission are independent: `mode` controls which tools exist,
while `permissionMode` controls how Claude Code governs calls to those tools.
Claude Code may replace the requested permission mode because of user, project,
or managed settings. AskClaude renders the requested and runtime modes when they
differ and reports observable permission denials; the provider emits the same
override as a warning. The bridge also summarizes non-sensitive constraints that
the Agent SDK attributes to its managed settings tier (for example, required
sandboxing or disabled bypass) without exposing permission-rule contents. The
resolver does not execute an administrator `policyHelper`, and the SDK does not
expose a complete effective sandbox decision, so the bridge does not claim that
this summary is exhaustive.


**Startup notice:** the first interactive session to reach Claude Code lists whichever of `provider.plan` and `askClaude.enabled` you have left unset, then records `startupNoticeShown` (the date, `YYYY-MM-DD`) in the global config so it doesn't nag again.

**Extension providers and models.json:** pi's `modelOverrides` in `~/.pi/agent/models.json` do not currently apply to extension-registered providers (like claude-bridge). Overriding `contextWindow` or other fields requires editing `src/models.ts` directly.

## Tests

`npm run test:unit` for offline tests (`tests/unit-*.mjs`: queue, import, skills). 

The offline suite also launches the repository-local Pi 0.84.2 CLI to verify
that the extension loads and registers its provider. Test output records the
installed Pi, Agent SDK, and bundled Claude Code versions.

`npm test` for the full suite, which adds integration tests that hit APIs (`tests/int-*.{sh,mjs}`: smoke, multi-turn, cache, session-resume, session-rebuild, tool-message). Set `CLAUDE_BRIDGE_TESTING_ALT_MODEL` in `.env.test` for the alt-provider smoke test (e.g. `openrouter/z-ai/glm-4.7-flash`).

Integration tests spawn real `pi` and Claude Code subprocesses, so they need write access to `~/.claude` for CC's session state — a sandbox that blocks it makes the next turn's `--resume` fail with `No conversation found with session ID`. The RPC harness probes for this at startup and fails fast.

## Debugging

Set `CLAUDE_BRIDGE_DEBUG=1` to enable debug output:

- **Bridge log** at `~/.pi/agent/claude-bridge.log` — every provider call, session sync decision, tool result delivery, and CC's stderr. Override location with `CLAUDE_BRIDGE_DEBUG_PATH`.
- **Per-query Claude Code CLI logs** at `~/.pi/agent/cc-cli-logs/<timestamp>-<tag>-<seq>.log` — the CC subprocess's own debug stream, one file per `query()` call. Tags are `provider` (main turn) or `askclaude` (sub-delegation). Useful when a resume fails or CC misbehaves internally — shows the CLI's own view of session loading, API requests, and tool calls.

When filing a bug about a session-resume failure (e.g. "No conversation found"), the most useful attachments are the `syncResult:` lines from the bridge log plus the matching `cc-cli-logs/` file for the failing query.

## Known issues

**Pi provider request/response hooks are not available through the Agent SDK.**
Claude Bridge cannot faithfully implement Pi 0.84.2's `onPayload` replacement
or `onResponse` observation contracts because the Agent SDK exposes neither the
final wire payload nor the underlying HTTP response. It does not fabricate
either one. This means `before_provider_request` and `after_provider_response`
extensions do not observe bridge traffic. See
[Pi 0.84 compatibility baseline](docs/PI-084-COMPATIBILITY.md).

**Sessions get rebuilt more often than they need to be, and a rebuild is expensive.** The bridge rewrites Claude Code's session from pi's history whenever pi's messages move underneath it — after an abort, `/compact`, tree navigation, or an API error. Measured over this repo's own bridge log, a rebuild boundary loses the prompt cache roughly 58% of the time against 26% for a plain resume, so an abort-heavy session costs noticeably more than a clean one. Aborts alone are 46% of rebuilds.

**Files Claude Code edits are not carried across a rebuild.** CC records the post-edit contents as an `edited_text_file` attachment; those aren't carried, because they hang off a tool-result record rather than a prompt and so have no stable position to restore them to. The edit itself survives — it's in the history as a tool call and its result — so this costs Claude the file snapshot, not the knowledge that it made the change. `@file` expansions *are* carried.
