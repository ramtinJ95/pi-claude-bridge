# Fork Direction

This document records the product and architecture decisions for this fork. It
is intentionally separate from the implementation backlog: decisions marked
**Settled** should guide the design, while **Open** items still require judgment
before implementation.

## Starting point

- Fork: `ramtinJ95/pi-claude-bridge`
- Upstream: `elidickinson/pi-claude-bridge`
- Forked from upstream commit `500eea1`
- Preserve the existing MIT license, attribution, Git history, test suite, and
  `upstream` remote.
- Reuse and progressively refactor the existing session, conversion, MCP,
  provider, and concurrency plumbing. Do not rewrite those systems from
  scratch.
- Keep taking upstream correctness fixes selectively while the fork diverges in
  product behavior and UI.
- PR #1 already fixed effective AskClaude defaults across schema text, call
  rendering, and execution, including malformed-config fail-closed behavior.

## Product direction

The fork should make Claude Code delegation observable, policy-correct, and
capable of running independent background agents without expanding Pi's native
tool surface unnecessarily.

The intended experience has two prominent Claude operations:

1. `AskClaude` for blocking delegation when the main agent needs Claude's answer
   before it can proceed.
2. `SpawnClaudeAgent` for independent background exploration and review while
   the main Pi session continues working.

Pi's existing `spawn_agent` remains separate and Pi-native. This fork will not
turn it into a model-selection mechanism or silently route it through Claude.

## Settled decisions

### 1. Fork first, then refactor

The fork is the migration vehicle. Preserve working behavior and tests while
extracting clearer internal boundaries. A one-time copy of selected files into
a new extension would lose provenance and make upstream fixes harder to port.

Rename the package, provider, configuration namespace, and distributed product
only when the implementation has become independently maintainable. Avoid
premature renaming while the code is still tracking upstream closely.

### 2. Keep capability and permission policy separate

Capability modes answer which tools Claude may use:

- `none`: no repository, shell, agent, or web capabilities.
- `read`: repository inspection and appropriate search/research capabilities,
  without mutation.
- `full`: mutation and shell capabilities are available.

Enforce `none` and `read` with explicit tool allowlists rather than a denylist
that silently weakens when Claude Code adds tools. The initial read-only set may
include repository read/search and web research tools, but excludes Claude's
`Agent` tool until nested capabilities can be bounded and verified. Pin the
actual SDK tool inventory with live contract tests before claiming structural
read-only behavior.

Permission mode answers how allowed operations are governed. It must not be
implied by capability mode.

- Default the fork's Claude Code queries to `permissionMode: "auto"`, including
  both `AskClaude` and the Claude provider path.
- Make permission mode configurable instead of hard-coding
  `bypassPermissions`.
- Never attempt to bypass organization-managed Claude policy.
- Surface effective sandbox and managed-policy restrictions when the SDK makes
  them observable.

The current machine's managed Claude policy disables bypass mode and enforces a
sandbox. The fork must cooperate with that policy rather than request a mode it
prohibits.

### 3. Tool contracts must describe effective configuration

Tool descriptions, parameter descriptions, tags, and call rendering must be
generated from effective configuration.

In particular, configured `defaultMode` and `defaultIsolated` values must not
disagree with model-facing text or TUI rendering. This mismatch is tracked
upstream in [issue #65](https://github.com/elidickinson/pi-claude-bridge/issues/65).

Tests must cover non-package defaults, especially:

- `defaultMode: "full"`
- `defaultIsolated: true`
- Explicit `false` overriding a configured `true`

### 4. Rich `AskClaude` observability

The blocking tool should expose substantially more of the Claude Code session
without forcing all of it into the main model's context.

The TUI should support:

- A live tool/action timeline.
- Tool inputs, outputs, duration, status, and errors.
- Streaming Claude response text.
- Input/output tokens, cache reads/writes, turns, and cost when supplied by the
  SDK.
- Model, effort, capability mode, permission mode, isolation state, working
  directory, and Claude session ID.
- Reasoning summaries or thinking text that Claude Code explicitly emits. Do
  not claim access to or expose private/raw chain-of-thought.
- Clear abort, permission, sandbox, and policy state.
- Compact default rendering with expandable details, especially for verbose or
  potentially sensitive tool output.

The model-facing tool result should stay bounded and useful. Rich telemetry and
transcripts belong primarily in the TUI or external job record, not
automatically in conversation context.

### 5. Preserve explicit isolation semantics

`isolated: true` means a fresh Claude conversation with no Pi branch history and
no persisted Claude session. It does not mean a hermetic process: Claude Code
still has its system prompt, working directory, applicable settings and managed
policy, and any explicitly forwarded skills.

The UI and documentation must state this distinction clearly.

`isolated: false` may continue to use the existing Pi-to-Claude session import,
repair, resume, and rebuild machinery. Preserve the current tests around tool
pairing, attachments, cursor management, and divergent histories.

### 6. Add a separate background `SpawnClaudeAgent`

`SpawnClaudeAgent` is Claude-native, not a wrapper around Pi's `spawn_agent`.
It returns promptly with a job identifier so the main agent can continue.

Initial profiles:

- `explorer`: repository reading/search and appropriate web research; no edits.
- `reviewer`: repository and diff inspection; no edits.

Both profiles:

- Use `permissionMode: "auto"` by default.
- Run in independent Claude sessions.
- Receive a stable context snapshot at launch.
- Support configurable Claude model and effort.
- Emit the same normalized events and telemetry as blocking `AskClaude`.
- Are read-only initially, making concurrent execution safe with the main
  agent's working tree.

Background mutation is deferred. If later supported, use an isolated worktree
or an explicit conflict protocol rather than allowing Claude and the main agent
to edit the same files concurrently.

### 7. Keep lifecycle operations out of Pi's native tool list

Do not register separate first-class Pi tools for status, result retrieval, and
cancellation.

Expose lower-frequency lifecycle operations as `pi-codex-conversion` code-mode
custom tools, callable through `exec`, for example:

```js
await tools.claude_agent_status(...)
await tools.claude_agent_result(...)
await tools.claude_agent_cancel(...)
```

Use `defer_loading = true` where practical so these operations do not add usage
text to the normal system prompt and remain discoverable through `ALL_TOOLS`.

The extension and command-backed custom tools need one small authenticated IPC
protocol over the extension's session-scoped in-memory job manager. Endpoint
discovery metadata may be written locally, but job durability must not be
implied: a stale endpoint must fail clearly as unavailable rather than appearing
to own recoverable jobs. Do not use untracked detached processes or treat PID
files alone as a job protocol.

### 8. Background state belongs in the UI, not model polling

Show active Claude jobs in a persistent Pi panel or widget with elapsed time,
current action, profile, model, token usage, and completion state. Human status
inspection and cancellation should also be available through TUI commands or
keybindings without consuming model context.

Model-driven polling remains optional through the deferred code-mode tools. It
must not be the normal completion path.

### 9. Target Pi 0.84.2 and honor its provider contracts

Require Pi 0.84.2 or newer for this fork. Develop and test against matching
0.84.2 versions of `pi-ai`, `pi-coding-agent`, and `pi-tui` rather than carrying
compatibility branches for older Pi releases.

Use Pi 0.84's native UI capabilities instead of building parallel framework
code:

- Render active background jobs in the widget/status dock, which remains sticky
  in fullscreen mode.
- Use Pi's themed Markdown components for expanded final output.
- Use custom entries for bounded, session-persisted TUI-only completion details.
- Use a non-triggering custom message for bounded model-visible completion
  delivery. Pi 0.84.2 fixes
  `sendMessage(..., { triggerTurn: false })` so it records rather than steering
  an active run.

Pi 0.84 also requires custom `streamSimple` providers to honor the
`SimpleStreamOptions.onPayload` and `onResponse` hooks. The Claude Agent SDK
does not expose its underlying HTTP response, so this cannot be satisfied by
inventing a fake response. Before larger feature work:

- Characterize which hooks the current provider can support faithfully.
- Forward and apply payload replacements only if the bridge can define and
  document a truthful provider payload contract.
- Never synthesize HTTP status or headers that the Agent SDK did not expose.
- If `onResponse` cannot be implemented faithfully, make that limitation
  explicit in tests and documentation and raise the adapter gap with Pi rather
  than silently pretending full hook support.

### 10. Use safe, session-scoped delegation defaults

The fork defaults `AskClaude` to `read` capability mode and `isolated: true`.
Users must explicitly request shared Pi history or mutation. Treat this as a
documented fork behavior change for every configuration that omits those keys;
schemas, descriptions, and renderers must expose the effective defaults.

Background jobs are session-scoped in the initial implementation:

- Active jobs are cancelled during Pi session shutdown and do not claim to
  survive reload, navigation to another session, or process exit.
- If termination cannot be confirmed, report the truthful terminal state as
  `abandoned` rather than silently treating the job as cancelled.
- Live state appears in Pi's sticky widget/status dock.
- Completion creates one bounded TUI-only custom entry containing reviewable
  details and one bounded model-visible custom message containing the result
  needed by the main agent.
- The model-visible completion uses Pi 0.84.2's non-triggering
  `sendMessage(..., { triggerTurn: false, deliverAs: "nextTurn" })` behavior so
  it neither interrupts nor steers the active main-agent turn.

Retain bounded tool inputs, outputs, timing, errors, and usage in the Pi session
so completed work remains expandable and searchable. Apply per-item and total
caps before persistence, mark truncation visibly, and redact before data enters
the session. Exact cap values and redaction rules remain implementation details
to characterize and test; unbounded transcripts are not permitted.

## Complexity strategy

Keep two execution lanes rather than forcing the whole fork through one generic
runner:

- The **provider lane** keeps its specialized Pi stream lifecycle, MCP tool
  result routing, steering, reentrant `QueryContext` handling, and shared-session
  synchronization.
- The **delegation lane** uses one Claude-native runner for blocking
  `AskClaude` and background `SpawnClaudeAgent` jobs.
- Share only pure query policy/options resolution and normalized SDK event
  parsing where doing so removes real duplication.

Do not reuse provider `QueryContext` or MCP result-routing machinery for
background jobs. Do not introduce a profile/plugin framework, generic event-bus
package, repository layer, or persistence abstraction for the initial two
profiles and session-scoped job store.

## Proposed internal architecture

Refactor toward the following boundaries while keeping behavior characterized
by tests:

### Shared query policy and options

- Resolve model, effort, settings sources, permission mode, sandbox visibility,
  child environment, and executable selection.
- Return explicit effective metadata for rendering and diagnostics.
- Remain pure: it owns no query lifecycle, session state, job state, or UI.

### Existing provider engine

- Preserve Pi stream translation, MCP tool bridging, result routing, steering,
  reentrant query handling, and abort cleanup.
- Consume shared query options only where their semantics genuinely match.
- Do not reshape this engine around the delegation runner.

### Delegation runner

- Own one Claude-native Agent SDK query lifecycle.
- Power both blocking `AskClaude` and background jobs.
- Consume normalized events and expose cancellation without importing provider
  `QueryContext` or MCP result routing.

### Session bridge core

- Preserve Pi-to-Claude message conversion.
- Preserve shared-session synchronization, resume/rebuild behavior, attachment
  carrying, tool pairing repair, and session verification.
- Keep this independent of TUI rendering and background-job presentation.

### Event and telemetry model

- Normalize SDK stream events into stable events for text, thinking summaries,
  tool starts/updates/results, usage, rate limits, errors, and session metadata.
- Retain enough structured detail for rich rendering without placing the whole
  stream in Pi conversation context.
- Treat unknown SDK events as visible diagnostics rather than silently dropping
  them.
- Apply this model to delegation first; adapt provider parsing selectively only
  where it reduces duplication without changing provider lifecycle semantics.

### Job manager

- Own background query lifecycle, cancellation, bounded in-memory records, and
  cleanup on Pi session shutdown.
- Snapshot launch context and working directory.
- Expose a stable in-process contract that a later IPC adapter can call.
- Make terminal states explicit: succeeded, failed, cancelled, or abandoned.

### Pi adapter and UI

- Register the provider, `AskClaude`, and `SpawnClaudeAgent`.
- Render blocking sessions and background jobs from the same normalized event
  model.
- Keep verbose details expandable and outside model context by default.

### Code-mode custom-tool adapter

- Provide deferred status, result, and cancellation commands through
  `pi-codex-conversion`.
- Communicate only through the job manager's supported IPC contract.
- Return concise, bounded machine-readable results.
- Treat an absent or stale extension endpoint as an explicit unavailable state;
  it does not recover jobs from a prior Pi process.

## Delivery phases

### Phase 0: establish the fork baseline — complete

Completed in [PR #2](https://github.com/ramtinJ95/pi-claude-bridge/pull/2).
The fork requires Pi 0.84.2 and Node.js 22.19, tests against matching Pi
packages, records Agent SDK/Claude Code versions, and explicitly documents the
provider lifecycle-hook gap without fabricating payload or HTTP response data.

### Phase 1: correctness and policy semantics — complete

Completed in [PR #3](https://github.com/ramtinJ95/pi-claude-bridge/pull/3),
merged as `1754acc`. Capability and permission policy are separate; provider,
compaction, and delegation queries use configurable `auto` by default; and
AskClaude defaults to structural read capability in a fresh isolated session.
Requested/runtime permission differences, denials, and observable managed-policy
constraints remain visible. Managed policy still wins: this machine currently
forces runtime `default`, requires sandboxing, and may deny provider MCP tools
until an administrator grants their exact aliases.

### Phase 2: normalized events and richer blocking UI — complete

Completed in [PR #4](https://github.com/ramtinJ95/pi-claude-bridge/pull/4)
(`5b5740a`) and [PR #5](https://github.com/ramtinJ95/pi-claude-bridge/pull/5)
(`7c80a88`). The delegation lane now has a provider-independent Agent SDK runner,
pure policy/options boundary, normalized snapshot, explicit terminal states, and
bounded live/final AskClaude rendering. The provider remains on its specialized
`QueryContext`/MCP/session path.

The retained AskClaude record uses named, independently tested limits rather
than a persistence promise: about 16k characters for the model-facing result,
2k per tool input/output, 32k/100 timeline events, 4k thinking summary, and
bounded retained lists. Truncation is visible; credential redaction is
best-effort. The authoritative SDK result wins over streamed narration, terminal
errors remain visible, and policy annotations survive the total model-result
budget.

Open Phase 2 runtime edges are deliberately visible:

- A signal already aborted before runner entry still takes the generic error
  path rather than cancellation.
- The Pi `tool_result` promotion of AskClaude cancellation/error details is
  unit-tested but has not had an end-to-end live cancellation exercise.
- Whether nested Agent partial events carry the expected parent relation needs
  a live `tests/int-cc-contracts.mjs` probe before Phase 3 depends on it.
- Expanded rendering performance should be measured before adding caching.
- Oversized tool input labels honestly degrade to visibly truncated JSON.

#### Phase 2 dogfooding follow-up: AskClaude details overlay — PR #6 open

[PR #6](https://github.com/ramtinJ95/pi-claude-bridge/pull/6) adds the missing
deep-inspection surface found during dogfooding. `/askclaude-details` and
`ctrl+n` open one centered, scrollable Pi overlay for the latest or a prior
AskClaude call. Its pinned header uses only Claude delegation data—runtime model,
SDK usage/cost/turns, Claude session/cwd, runtime permission, status, capability,
isolation, and requested thinking—with no Pi metadata fallback. The body shows
the original persisted prompt, emitted thinking summary, retained nested tools,
retained timeline, and authoritative response.

The inline expanded row is intentionally concise: Claude metadata, policy and
error state, prompt/thinking/response, one grouped action summary, and aggregate
tool counts. Per-tool inputs/outputs/durations/nesting and lifecycle events live
only in the overlay. This keeps the transcript readable without changing what
the retained snapshot stores.

Implementation boundaries remain narrow:

- `askclaude-details.ts` extracts view models from real branch tool-call/result
  records, including a configured custom AskClaude name and restored sessions.
- `askclaude-overlay.ts` owns the component, command/shortcut registration, and
  one bounded in-memory live slot. It is not a general viewer framework and
  Phase 3 does not depend on it.
- The live slot receives the same retained/redacted details used by the inline
  row, is shadowed by the persisted result, replaced by the next call, and
  cleared on session change/shutdown.

The repository tests completed-call extraction, navigation, Claude-only
metadata, scrolling, responsive rendering, live-store merge/cleanup, and the
inline/overlay division. Interactive behavior while blocking AskClaude runs is
still a dogfooding check because the harness has no live TUI driver:

- Open and close with both `ctrl+n` and `/askclaude-details` during a running
  call; confirm live updates and no focus leak.
- Exercise regular/fullscreen modes and a small terminal.
- Confirm the documented Pi 0.84.2 `ctrl+n` session-picker overlap is acceptable
  in practice; the extension owns it in the main editor but Pi may show a
  startup warning.
- Resume a session and inspect earlier AskClaude calls.

#### Local dogfooding state — this workstation only

`~/.pi/agent/settings.json` points at
`/Users/ramtin/personal/pi-claude-bridge`, so a restarted Pi process loads this
worktree directly. This path is local machine state, not a repository or
packaging requirement.

### Phase 3: background job core — next, after the Phase 2 follow-up ships

Do not start Phase 3 until the AskClaude details overlay follow-up above is
reviewed, merged, and its dogfooding checks have been exercised.

- Implement the job manager and lifecycle state machine.
- Add `SpawnClaudeAgent` with `explorer` and `reviewer` profiles.
- Enforce read-only capabilities structurally, not only through prompts.
- Add cancellation and session-shutdown cleanup tests.
- Add the sticky live-jobs widget and human status/cancel commands.
- Persist bounded completed-job details as TUI-only custom entries and deliver
  one bounded non-triggering model-visible result message.

#### Starting handoff

Build on what Phase 2 merged instead of standing up a second execution stack:

- **Reuse the delegation runner.** It already owns one Claude-native Agent SDK
  query lifecycle and exposes cancellation without importing provider
  `QueryContext` or MCP result routing. A background job is another caller of
  that runner, not a fork of it.
- **Reuse the normalized snapshot as the job record.** Retention caps, visible
  truncation, and redaction already produce a bounded record suitable for a
  TUI-only custom entry and a bounded model-visible message. Do not invent a
  second background-job event format.
- **Resolve policy through the existing pure options boundary.** Model, effort,
  capability inventory, permission mode, settings sources, and child environment
  come from there, and `isolated: true` stays unrepresentable together with
  `resumeSessionId`. Profiles select inputs to that boundary; they do not gain
  their own policy code.
- **Keep the lanes apart.** Background lifecycle stays outside blocking
  `AskClaude` finalization and outside provider `QueryContext`, shared-session
  synchronization, and MCP tool-result routing. Background jobs get their own
  lifecycle owner rather than reentering the AskClaude glue.
- **Do not generalize.** Two read-only profiles and a session-scoped store do
  not justify a profile/plugin framework, a generic event bus, a repository
  layer, or a persistence abstraction.

First PR boundary — keep it small and reviewable without its UI: the in-process
job manager and lifecycle state machine over the merged runner, plus
`SpawnClaudeAgent` returning promptly with a job identifier, with `explorer` and
`reviewer` capabilities enforced by explicit tool inventories, a launch-time
context and working-directory snapshot, explicit terminal states (`succeeded`,
`failed`, `cancelled`, `abandoned`), cancellation, and Pi session-shutdown
cleanup covered by tests. Leave the sticky live-jobs widget, the TUI-only
completion entry, the non-triggering model-visible completion message, and the
human status/cancel commands to a second PR.

Two Phase 2 deferrals become load-bearing here and should be settled early: the
live subagent partial-stream probe, since nested `Agent` relations decide whether
background jobs can be rendered as a tree, and the pre-aborted-signal edge, since
a job manager will cancel work it did not launch on the current call stack.

### Phase 4: dynamic lifecycle tools

- Add deferred `pi-codex-conversion` custom tools for status, result, and cancel.
- Add authenticated local IPC and per-session endpoint discovery over the
  already-proven in-memory job manager.
- Test multiple concurrent Pi sessions, stale endpoint cleanup, bounded replies,
  and explicit unavailable behavior after session shutdown.

### Phase 5: independent packaging

- Decide whether divergence warrants a new package/provider/config namespace.
- Preserve upstream attribution and document migration from
  `pi-claude-bridge`.
- Keep an upstream-sync policy for high-value correctness fixes.

## Non-goals

- Reimplementing the existing session bridge from scratch.
- Circumventing organization-managed Claude policy or sandbox controls.
- Replacing or overloading Pi's native `spawn_agent`.
- Adding first-class Pi tools for every background lifecycle operation.
- Exposing or claiming access to private/raw chain-of-thought.
- Allowing background Claude agents to mutate the main working tree in the
  initial implementation.
- Automatically dumping full Claude transcripts or tool output into the main
  model's context.
- Building one universal runner around both provider MCP orchestration and
  Claude-native delegation.
- Claiming that background jobs or lifecycle tools survive Pi session shutdown
  in the initial implementation.

## Open decisions

These implementation and later-product decisions remain open:

1. **Retention bounds and redaction:** choose and characterize per-item and
   total caps, sensitive-field handling, and the exact bounded custom-entry
   schema. The product decision to retain bounded, visibly truncated details in
   the Pi session is settled.
2. **IPC transport:** choose a Unix-domain socket, localhost authenticated
   endpoint, or another explicit protocol for code-mode lifecycle tools.
3. **Provider scope:** decide how much rich telemetry and UI from delegation
   should also apply when Claude Bridge is selected as Pi's primary provider.
4. **Independent name:** choose a package, provider, and config namespace only
   after the architecture has materially diverged.

## Load-bearing invariants

- Pi remains the source of truth for Pi conversation history.
- Session rebuilds must preserve valid tool-use/tool-result pairing.
- A background job operates on the context and working directory captured when
  it starts, not mutable ambient state.
- Read-only profiles must be enforced by available tools, not merely requested
  in prose.
- Managed Claude policy always wins over user or extension preferences.
- Every started job reaches a visible terminal state and has a cancellation and
  cleanup path.
- Rich observability must not silently become unbounded model context.
- Provider request/response hooks must report only payload and transport facts
  the bridge can actually observe.
- Provider `QueryContext`, shared-session state, and MCP result routing must not
  leak into background-job execution.
- Pi 0.84.2 is the minimum supported runtime; do not add fallback branches for
  older extension APIs.
