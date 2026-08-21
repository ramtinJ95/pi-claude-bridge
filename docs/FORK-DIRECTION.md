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

- The Pi `tool_result` promotion of AskClaude cancellation/error details is
  unit-tested but has not had an end-to-end live cancellation exercise.
- Expanded rendering performance should be measured before adding caching.
- Oversized tool input labels honestly degrade to visibly truncated JSON.

The Phase 3 readiness work settles two former edges: a signal already aborted
before runner entry returns the normal cancelled outcome without creating an SDK
query, and a live `tests/int-cc-contracts.mjs` probe establishes that completed
nested Agent assistant messages carry their parent tool-use ID. The installed
SDK/Claude Code emits no nested token-level partial stream frames even with
`forwardSubagentText` and partial messages enabled. Nested tool parenting remains
covered by synthetic reducer tests, not this live probe.

#### Phase 2 dogfooding follow-up: AskClaude details overlay — PR #6 merged

[PR #6](https://github.com/ramtinJ95/pi-claude-bridge/pull/6) merged as
`cd71dab`. It adds the missing
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

### Phase 3: background job core — Phase 3a PR #8 open, Phase 3b pending

Readiness landed in
[PR #7](https://github.com/ramtinJ95/pi-claude-bridge/pull/7) (`111c40a`): a
signal already aborted at runner entry produces the normal cancelled outcome,
and a live probe pins the nested-`Agent` streaming contract. The probe permits
treeing completed nested assistant messages but does not prove nested tool
events and forbids depending on token-level nested text for live status; it
enables `Agent`/`forwardSubagentText` directly and is not production wiring —
if a future profile launches nested agents, add both capabilities deliberately
through the pure options boundary and that profile's explicit inventory.

#### Phase 3a: headless job core — implemented in PR #8

[PR #8](https://github.com/ramtinJ95/pi-claude-bridge/pull/8) is open from
`phase-3a-background-job-core`. Its commits deliberately separate shared
snapshot retention, profile/diff capture, the job manager, Pi adapter wiring,
and documentation. The branch passes 348 unit tests, TypeScript typecheck, npm
package dry-run, and diff checks.

Phase 3a is the in-process job core on the merged Phase 2 stack, with no UI:

- `SpawnClaudeAgent` is a first-class Pi tool registered under the same opt-in
  as AskClaude (and, like AskClaude, only usable from non-claude-bridge
  providers — the claude-bridge provider gets a visible circular-delegation
  error). It returns promptly with a stable job ID and takes
  AskClaude-consistent `model`/`thinking` parameters plus `profile`, `task`,
  and an optional reviewer `base`. A background job is another caller of the
  shared delegation runner: it never enters AskClaude finalization, provider
  `QueryContext`, shared-session synchronization, or MCP result routing. The
  wiring lives behind a narrow injected adapter seam
  (`registerSpawnClaudeAgent`), so registration, launch, and lifecycle cleanup
  are unit-tested without launching Claude.
- The launch honors the initiating tool call's `AbortSignal`: a call cancelled
  before or during reviewer diff capture returns a visible error and starts no
  detached job (and a spawn the manager would reject anyway skips diff capture
  entirely). Once the job ID is returned, the job's own per-job
  `AbortController` owns its lifecycle — the initiating call's signal plays no
  further part.
- `src/background-jobs.ts` owns the Pi-session-scoped lifecycle: one running
  job per session (a second spawn throws and is promoted to a visible error
  tool result, never queued — configurability deferred until dogfooding shows
  a need), per-job `AbortController`, explicit first-wins terminal states
  (`succeeded`, `failed`, `cancelled`, `abandoned`), bounded in-memory records
  (20, oldest terminal evicted), and session shutdown/switch cleanup. Job IDs
  are a collision-resistant random per-manager prefix (12 hex chars from Node
  crypto) plus a monotonic counter (e.g. `claude-job-3f9c2d1a7b4e-1`): a new
  extension runtime gets a new prefix, so cross-runtime collisions are
  overwhelmingly unlikely, and a session reset never reuses an ID within one
  manager. Shutdown and reset are
  async — Pi 0.84.2 awaits `session_shutdown`/`session_start` handlers — so
  they abort running jobs (the runner interrupts and closes the Claude Code
  query) and wait up to a named 2-second grace
  (`BACKGROUND_JOB_SHUTDOWN_GRACE_MS`) for settlement. A job that settles
  inside the grace keeps its genuine terminal state (usually `cancelled`);
  only jobs still unconfirmed when the grace expires are recorded as
  `abandoned`, and a late settlement never rewrites a terminal state.
  `abandoned` is a job-layer state only; `DelegationSnapshot` keeps its four
  delegation statuses.
- `src/agent-profiles.ts` holds the profiles as explicit data that select the
  existing pure policy boundary: `explorer` and `reviewer` both resolve to the
  read inventory (`Read`, `Glob`, `Grep`, `WebFetch`, `WebSearch`; no Bash,
  mutation, or `Agent`) with distinct role prompts, and jobs always run
  isolated. No profile carries its own policy code.
- `src/reviewer-diff.ts` captures the reviewer's immutable status/diff artifact
  at launch — by the extension, never by Claude. An explicit `base` diffs from
  the merge base of `base` and HEAD to the launch-time working tree (branch/PR
  semantics); without one it captures staged and unstaged changes from HEAD.
  The artifact is bounded under named tested limits (40k diff / 4k status)
  with visible truncation, best-effort redaction, and a recorded source;
  non-git directories and invalid refs fail the spawn instead of yielding a
  misleading empty diff. Launch cwd/context are captured immutably, and the
  job prompt states honestly that Read/Glob/Grep see the live working tree
  while the artifact stays frozen.
- Job records reuse the retained/redacted `DelegationSnapshot`, and a job that
  settles through the runner (succeeded/cancelled) also keeps the runner's
  observed permission mode and non-sensitive managed-policy summary — bounded
  facts, never raw policy rules — so Phase 3b can render the actual delegation
  policy state without rerunning or inventing it; failed and abandoned jobs
  record neither. There is no second event format, framework, persistence,
  IPC, or Herdr backend.

Current handoff before Phase 3b:

- Review PR #8 for lifecycle correctness and parity with the Phase 3a boundary;
  do not pull widget/completion-delivery work into this PR.
- Before merge, reload Pi from this local worktree and exercise a real explorer
  and reviewer launch from a non-claude-bridge provider. Confirm the tool returns
  a job ID without blocking the main turn, a second concurrent spawn fails
  visibly, and reviewer base/diff capture failures are explicit.
- Exercise `/reload` while a real job runs. Confirm shutdown stays within the
  two-second grace when cancellation does not settle, and inspect for an
  orphaned Claude Code process. Unit tests characterize both confirmed
  cancellation and timeout-to-`abandoned`; the real runtime timing remains the
  only material Phase 3a uncertainty.
- Phase 3a intentionally has no user-facing way to inspect a completed job
  beyond its retained in-process record. Do not mistake that headless boundary
  for lost scope: the widget, completion entry/message, and human lifecycle
  commands are the next PR.

#### Phase 3b: background job UI and completion delivery — remaining

- The sticky live-jobs widget and human status/cancel commands (the manager's
  `cancel` contract exists and is tested; nothing invokes it yet).
- Bounded completed-job details as a TUI-only custom entry.
- One bounded non-triggering model-visible completion message using Pi
  0.84.2's `sendMessage(..., { triggerTurn: false, deliverAs: "nextTurn" })`.
- The interactive AskClaude-overlay dogfooding checks listed under Phase 2,
  plus live dogfooding of a real background job end-to-end.

#### Deferred investigation: observable Herdr-backed Claude jobs

Investigate, after the in-process `SpawnClaudeAgent` job core works, whether an
explicit alternate execution mode can launch Claude Code in a user-visible Herdr
pane. The product goal is observability: the user can watch Claude's native
session while Pi still receives a job identifier, lifecycle state, cancellation,
and a bounded final result. It is not part of the readiness or initial job-core
PR and must not make Herdr a required dependency.

The probe must establish rather than assume that a Pi session running inside
Herdr can:

- create a background pane without stealing focus and preserve the captured cwd;
- start the installed Claude agent kind with an explicit model and thinking
  level, then submit the captured body of work;
- observe working, blocked, completed, and unknown states and obtain a reliable
  bounded result rather than scraping an incomplete alternate-screen viewport;
- cancel and clean up only the pane/job it owns; and
- preserve the same profile capability guarantees, managed-policy behavior,
  retention/redaction boundaries, and visible terminal-state semantics as the
  Agent SDK backend.

Treat this as a deliberate backend choice, never a silent fallback. If Pi is not
running inside Herdr, the mode must be visibly unavailable. Decide from the probe
whether Herdr is merely an optional observable frontend for the same job contract
or too lifecycle-ambiguous to support. Do not replace the structured Agent SDK
path solely to gain terminal visibility.

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
