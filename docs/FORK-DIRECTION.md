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

## Internal architecture

The implementation uses these boundaries; preserve them as later phases add
adapters:

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

## Delivery status and handoff

### Completed foundation: Phases 0–2

- [PR #2](https://github.com/ramtinJ95/pi-claude-bridge/pull/2): Pi 0.84.2 and
  Node.js 22.19 baseline, matching development packages, and truthful provider
  lifecycle-hook compatibility characterization.
- [PR #3](https://github.com/ramtinJ95/pi-claude-bridge/pull/3): structural
  capability policy, configurable `permissionMode: "auto"`, safe AskClaude
  read/isolated defaults, and visible runtime policy overrides.
- [PR #4](https://github.com/ramtinJ95/pi-claude-bridge/pull/4) and
  [PR #5](https://github.com/ramtinJ95/pi-claude-bridge/pull/5): shared
  Claude-native delegation runner, normalized bounded/redacted snapshots, and
  rich blocking AskClaude rendering.
- [PR #6](https://github.com/ramtinJ95/pi-claude-bridge/pull/6): scrollable
  `/askclaude-details` / `Ctrl+N` overlay with Claude-only telemetry and retained
  tool/timeline inspection.
- [PR #7](https://github.com/ramtinJ95/pi-claude-bridge/pull/7): pre-aborted
  runner safety and live characterization of the installed nested-Agent stream
  behavior. Production profiles still exclude nested `Agent`.

### Phase 3: background Claude agents — implementation complete

- [PR #8](https://github.com/ramtinJ95/pi-claude-bridge/pull/8) added the
  headless `SpawnClaudeAgent` core: one session-scoped job, isolated read-only
  `explorer`/`reviewer` profiles, bounded tracked-and-untracked reviewer
  artifacts, collision-resistant IDs, explicit terminal states, cancellation,
  and bounded shutdown/reset cleanup.
- [PR #9](https://github.com/ramtinJ95/pi-claude-bridge/pull/9) adds the Phase
  3b presentation/delivery adapter over that same manager and snapshot:
  a compact sticky live widget; `/claude-jobs` status and human cancellation;
  one restore-safe TUI-only completion entry; and one bounded model-visible
  completion queued with
  `sendMessage(..., { triggerTurn: false, deliverAs: "nextTurn" })`.
  Shutdown/reset settlements are suppressed so an old job cannot deliver into
  a replacement session. No model-callable lifecycle tools or second job-state
  system were added.

Phase 3 validation is 375 passing unit tests, clean TypeScript typecheck and
`git diff --check`, and a package dry-run containing the new UI module. The
Phase 3b review found and fixed two restore-path bugs: malformed/future entry
payloads now degrade visibly rather than throwing, and persisted entries remain
renderable if AskClaude is later disabled.

### Unified Claude Sessions overlay — current implementation

The AskClaude-only details overlay from PR #6 has been superseded by one
unified "Claude Sessions" overlay covering both AskClaude calls and background
jobs, reusing the same overlay component, scrolling, responsive rendering, and
retained/redacted snapshots — no second viewer framework or retention path.

- One flat chronological list across both kinds with clear kind/profile/status
  labels; AskClaude ISO timestamps and background epoch timestamps are
  normalized before sorting, with deterministic branch order as the fallback.
- `Ctrl+N` toggles the overlay, focusing a running background job first
  (pinned across live updates), else the chronologically latest record. The
  already-shipped Pi 0.84.2 `Ctrl+N` session-picker conflict is accepted;
  configurability is deferred.
- `/claude-details [n]` is the canonical command with an optional 1-based
  index into the merged list. `/askclaude-details [n]` remains as a
  compatibility alias — the same unfiltered overlay focused on the latest
  AskClaude record, with `n` resolved among AskClaude calls only — not a
  separately filtered view.
- `/claude-jobs` with no arguments opens the overlay focused on the running
  (else latest) background job, notifies honestly when the session has none,
  and keeps its textual status output outside the TUI; `/claude-jobs cancel`
  is unchanged. The live widget hint mentions `Ctrl+N` details alongside the
  cancel guidance.
- Background records come from the persisted `claude-background-job`
  completion entries (validated by the same guard the transcript renderer
  uses, so malformed/future entries degrade visibly) merged with the job
  manager's records, deduplicated by job ID: the persisted entry wins for
  settled jobs; the manager supplies running state and is the terminal
  fallback when persistence is absent.
- The overlay stays behind the `askClaude.enabled` registration gate;
  persisted completion entries remain renderable in the transcript when it is
  disabled. One overlay owner and one close toggle; the overlay subscribes to
  the AskClaude live slot and the manager while open and releases both on
  dispose.

### Current handoff: runtime dogfooding

The implementation is complete; the next gate is real Pi runtime validation.
This workstation loads `/Users/ramtin/personal/pi-claude-bridge` directly from
`~/.pi/agent/settings.json`, so `/reload` loads the current worktree.

Completed runtime evidence before the unified-overlay change:

- A real `explorer` job using Opus/high ran independently for 6m58s while the
  main Pi session remained usable. Its isolated prompt and structural read-only
  inventory were correct, the live widget updated, and one bounded completion
  reached the model on a later turn.
- The run launched from Pi's process cwd (`/Users/ramtin`) rather than the
  repository it explored (`/Users/ramtin/personal/pi-claude-bridge`). Explorer
  could locate the repository, but a reviewer launched from that cwd would fail
  the git-work-tree check. Decide after overlay dogfooding whether starting Pi
  in the target repository is an acceptable contract or launch cwd needs an
  explicit product control; do not hide the failure with cwd guessing.
- `/claude-jobs`' old multiline notification duplicated the better live widget
  and went stale immediately. That observation directly motivated the unified
  overlay and its new TUI command behavior.

1. Run a real `reviewer` job from a repository-root Pi session. Confirm visible
   rejection of a second concurrent spawn and explicit invalid-base failures.
2. Exercise the live widget in regular, fullscreen, and a small terminal. Test
   `/claude-jobs` opening the unified overlay (running job, latest settled job,
   and empty session) and `/claude-jobs cancel`, including completion and human
   cancellation.
3. Repeat the confirmed one-completion next-turn delivery while a main-agent
   turn is active as the job settles. Quitting Pi before the next prompt is a
   known loss boundary for the in-memory queued message; the persisted TUI
   entry remains.
4. Run `/reload` during a real job and inspect for orphaned Claude Code
   processes. Resume a session containing completion entries and confirm their
   renderer restores correctly.
5. Finish the outstanding Claude Sessions overlay checks: running-call and
   running-job open/close via `Ctrl+N`, `/claude-details`, and the
   `/askclaude-details` compatibility alias; mixed AskClaude/background
   navigation; small/fullscreen rendering; and restored records after a
   session resume. The Pi 0.84.2 `Ctrl+N` session-picker conflict is accepted
   as shipped.

Do not begin Phase 4 by default until this dogfooding is recorded and any
blocking runtime issue is fixed.

### Deferred Herdr investigation

Investigate an explicit optional Herdr backend only after the in-process path
is proven. A probe must establish no-focus-steal pane creation, captured cwd,
explicit model/thinking launch, reliable lifecycle/result observation without
viewport scraping, owned cancellation/cleanup, and the same policy/retention
guarantees as the SDK path. It must be visibly unavailable outside Herdr and
must never silently replace or fall back from the structured SDK backend.

### Phase 4: dynamic lifecycle tools

- Add deferred `pi-codex-conversion` code-mode tools for bounded status, result,
  and cancellation without expanding Pi's first-class model tool list.
- Add authenticated local IPC and per-session endpoint discovery over the
  in-memory manager.
- Test concurrent Pi sessions, stale endpoints, bounded replies, and explicit
  unavailability after session shutdown.

### Phase 5: independent packaging

- Decide whether divergence warrants a new package/provider/config namespace.
- Preserve upstream attribution, document migration, and retain an explicit
  upstream-sync policy for high-value correctness fixes.

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

1. **IPC transport:** choose a Unix-domain socket, localhost authenticated
   endpoint, or another explicit protocol for code-mode lifecycle tools.
2. **Provider scope:** decide how much rich telemetry and UI from delegation
   should also apply when Claude Bridge is selected as Pi's primary provider.
3. **Herdr backend:** decide from a live probe whether its lifecycle/result
   contract is reliable enough to support as an explicit optional backend.
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
