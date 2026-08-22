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

The intended experience now centers on `SpawnClaudeAgent`: `mode` selects the
same explicit `none`/`read`/`full` capability contract as AskClaude, optional
`review` specializes read mode with a frozen launch diff, and `execution`
selects foreground/blocking or background/nonblocking delivery. Advisor,
explorer, reviewer, and worker are derived role/presentation labels rather than
capability inputs. `AskClaude` remains a temporary compatibility surface while
runtime parity and removal UX are evaluated.

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

### 4. Rich foreground-delegation observability

Foreground Claude delegation should expose substantially more of the Claude
Code session without forcing all of it into the main model's context. This was
first built for `AskClaude`; foreground `SpawnClaudeAgent` now uses the same
runner, retained event model, live updates, and unified details overlay rather
than maintaining a second observability path.

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

### 6. Keep `SpawnClaudeAgent` separate from Pi agents

`SpawnClaudeAgent` is Claude-native, not a wrapper around Pi's `spawn_agent`.
Background execution returns promptly with a job identifier so the main agent
can continue; foreground execution blocks and returns the result directly.

Public capability contract:

- `mode: "none"`: advisor role with no repository, filesystem, shell, agent, or
  web capabilities.
- `mode: "read"`: explorer role with structural repository/web read-only
  capability.
- `mode: "read", review: { base?: string }`: reviewer role with the same
  structural read capability plus a frozen launch-time diff artifact.
- `mode: "full"`: worker role with full Claude Code capability in the current
  checkout, available only for explicit user-requested implementation
  delegation.

All derived roles:

- Use `permissionMode: "auto"` by default.
- Run in independent Claude sessions by default.
- Receive a stable context snapshot at launch.
- Support configurable Claude model and effort.
- Emit the same normalized events and telemetry as blocking `AskClaude`.
- Can run in foreground or background; foreground may explicitly share Pi
  conversation history.

None/read modes remain structurally bounded. Full-mode mutation uses one
process-global checkout lease shared with AskClaude full mode, so concurrent
Claude writers fail visibly, including across extension reload. A background
full-mode worker also exposes a single-writer warning requiring the main agent to avoid
mutating the checkout until the worker actually settles.

### 7. Use one explicit background-job control tool

Register one small first-class Pi tool, provisionally named `ClaudeAgentJob`,
for model-initiated lifecycle operations on background jobs that already
exist. It supports `status`, `result`, and `cancel` actions and delegates
directly to the session-scoped in-memory job manager.

Keep this separate from `SpawnClaudeAgent`:

- `SpawnClaudeAgent` creates work. It either starts a background job and
  returns its ID or runs a foreground delegation to completion.
- `ClaudeAgentJob` never creates work. It inspects, retrieves, or cancels a
  background job identified by that ID.

This separation keeps both schemas small and honest. Do not overload
`SpawnClaudeAgent` with a conditional create-or-manage contract, and do not add
three separate status/result/cancel tools.

The control tool calls the existing manager in-process. Do not add local IPC,
socket authentication, endpoint discovery, command clients, TOML definitions,
or a second job store unless a future requirement genuinely needs out-of-process
control. The earlier deferred `pi-codex-conversion` custom-tool design is
superseded by this simpler architecture.

Control behavior remains bounded and explicit:

- `status` returns concise lifecycle and current-activity facts; without a job
  ID it may list the manager's bounded session records.
- `result` requires a job ID and returns the same bounded/redacted result shape
  used by completion delivery. A running job returns an explicit not-ready
  state rather than partial narration presented as a final result.
- `cancel` requires a job ID and only confirms that cancellation was requested.
  The job becomes `cancelled` only when the executor actually settles; otherwise
  the manager's existing shutdown/abandonment rules remain authoritative.
- Unknown, evicted, foreground, or prior-runtime job IDs fail visibly as
  unavailable. The tool does not imply persistence across session shutdown.

### 8. Background state belongs in the UI, not model polling

Show active Claude jobs in a persistent Pi panel or widget with elapsed time,
current action, capability mode, derived role, model, token usage, and completion state. Human status
inspection and cancellation should also be available through TUI commands or
keybindings without consuming model context.

Model-driven inspection through `ClaudeAgentJob` is optional. It must not become
a polling loop or replace the normal bounded next-turn completion delivery.

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
- The **delegation lane** uses one Claude-native runner for foreground
  `AskClaude`/`SpawnClaudeAgent` calls and background jobs.
- Share only pure query policy/options resolution and normalized SDK event
  parsing where doing so removes real duplication.

Do not reuse provider `QueryContext` or MCP result-routing machinery for
background jobs. Do not introduce a role/plugin framework, generic event-bus
package, repository layer, or persistence abstraction for four fixed derived
roles and the session-scoped job store.

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
- Expose the stable in-process contract used by the UI and the lifecycle tool.
- Make terminal states explicit: succeeded, failed, cancelled, or abandoned.

### Pi adapter and UI

- Register the provider, `AskClaude`, `SpawnClaudeAgent`, and the single
  `ClaudeAgentJob` lifecycle tool while the compatibility surface remains.
- Render blocking sessions and background jobs from the same normalized event
  model.
- Keep verbose details expandable and outside model context by default.

### Background-job control adapter

- Provide status, result, and cancellation actions through one narrow Pi tool.
- Read and mutate lifecycle only through `BackgroundJobManager`; never cache or
  reconstruct a parallel view of job state.
- Reuse the existing retained snapshots, completion-result assembly, and
  redaction/size limits rather than introducing another serializer.
- Return concise model-facing results; rich inspection remains in the unified
  Claude Sessions overlay.

## Delivery status and handoff

### Completed through Phase 3c

- PRs [#2](https://github.com/ramtinJ95/pi-claude-bridge/pull/2)–[#7](https://github.com/ramtinJ95/pi-claude-bridge/pull/7)
  established the Pi 0.84.2 baseline, structural capability/permission policy,
  shared delegation runner, bounded telemetry, rich AskClaude rendering, and
  the original details overlay.
- [PR #8](https://github.com/ramtinJ95/pi-claude-bridge/pull/8) added the
  session-scoped background job core and read-only explorer/reviewer profiles.
- [PR #9](https://github.com/ramtinJ95/pi-claude-bridge/pull/9) added the live
  widget, human cancellation, restore-safe completion entries, and bounded
  next-turn delivery.
- [PR #10](https://github.com/ramtinJ95/pi-claude-bridge/pull/10) replaced the
  AskClaude-only viewer with the unified Claude Sessions overlay.
- [PR #11](https://github.com/ramtinJ95/pi-claude-bridge/pull/11) completed
  Phase 3c: worker profile, foreground/background execution, shared foreground
  AskClaude compatibility path, structured worker authorization, immediate
  hard-close on cancellation, and one process-global checkout write lease
  across every full-capability Claude delegation.

PR #11 validation is 447 passing unit tests, clean TypeScript typecheck and
`git diff --check`, and a package dry-run containing the new lease module.
Runtime dogfooding has not yet been recorded.

### Phase 3d in progress: consolidate SpawnClaudeAgent capability

Before Phase 4, replace SpawnClaudeAgent's public `profile` input with the same
explicit `none | read | full` capability modes AskClaude uses. Keep review as
an optional read-only specialization (`review: { base?: string }`) because a
frozen diff and review role prompt are task shaping, not another capability
mode. Derive advisor/explorer/reviewer/worker labels for prompts and UI only.

This gives foreground SpawnClaudeAgent behavioral parity with AskClaude's
capability vocabulary while preserving background execution, explicit full-mode
authorization, reviewer artifact capture, and every existing lease/lifecycle
invariant. Keep AskClaude registered through the runtime gate; removal is a
separate compatibility change, not part of the contract migration.

### Current handoff: dogfood Phase 3d

This checkout is loaded directly from
`/Users/ramtin/personal/pi-claude-bridge`; after local `main` is updated,
`/reload` activates Phase 3d. Start Pi from the repository root for review tests
because diff capture deliberately fails outside a Git worktree.

Run these checks in order and record observed results here:

1. **Capability mapping:** run `mode: "none"` and confirm an advisor has no
   tools; run `mode: "read"` and confirm an explorer has only the structural
   read inventory. Check both foreground and background dispatch at least once.
2. **Review specialization:** run `mode: "read", review: {}` and
   `review: { base: "main" }`; reject review with none/full mode and reject an
   invalid base. Confirm one bounded background result arrives on a later turn.
3. **Foreground full mode:** use a harmless explicit edit with
   `user_requested: true`, first isolated and then shared
   (`isolated: false`). Confirm live row updates, direct result delivery,
   correct cwd/permission metadata, and foreground records in the unified
   overlay.
4. **Background full-mode ownership:** run one harmless worker and confirm the
   spawn/widget warning. While it runs, verify a second background worker,
   foreground worker, and AskClaude full call all fail on the same checkout
   lease. Cancel mid-edit and confirm the lease releases only after real
   settlement.
5. **Reload/termination:** reload during a long worker. Confirm the SDK child is
   gone, no orphan keeps editing, and a replacement runtime cannot acquire the
   writer lease before the old executor settles.
6. **Restore and layout:** resume the session and inspect mixed AskClaude,
   foreground SpawnClaudeAgent, and background records through `Ctrl+N`,
   `/claude-details`, and `/claude-jobs`; check small-terminal and fullscreen
   rendering.
7. **Negative contracts:** reject background `isolated: false`, reject full
   calls without `user_requested: true`, reject that assertion in none/read
   mode, and confirm `allowFullMode: false` removes/rejects full mode.

A real Opus/high explorer job already confirmed nonblocking execution, the live
widget, structural read-only tools, and later-turn result delivery. Do not
repeat that run unless another change touches those paths.

After the gate passes, proceed to Phase 4. SpawnClaudeAgent foreground now
covers AskClaude's none/read/full capability vocabulary, blocking delivery,
telemetry, and shared-session behavior. AskClaude removal does not need to block
the lifecycle tool, but its deprecation/removal timeline must be decided and
documented separately.

### Deferred Herdr investigation

Investigate an explicit optional Herdr backend only after the in-process path
is proven. A probe must establish no-focus-steal pane creation, captured cwd,
explicit model/thinking launch, reliable lifecycle/result observation without
viewport scraping, owned cancellation/cleanup, and the same policy/retention
guarantees as the SDK path. It must be visibly unavailable outside Herdr and
must never silently replace or fall back from the structured SDK backend.

### Phase 4: one background-job control tool

Phase 4 adds control over the background execution built in Phase 3; it does
not add another runner, capability mode, persistence layer, or UI.

Implement it as one PR with three reviewable commits:

1. **Pure contract and result shaping**
   - Define the `status | result | cancel` request contract and explicit success,
     not-ready, unavailable, and rejected outcomes.
   - Reuse retained `BackgroundJobRecord` data and the existing bounded result
     assembler; extract presentation-neutral helpers from the UI module only
     where necessary.
   - Unit-test malformed actions, missing/unknown IDs, running and terminal
     states, evicted records, truncation, and cancellation races.
2. **Pi tool adapter**
   - Register `ClaudeAgentJob` only when Claude delegation is enabled.
   - Keep its schema concise: optional `job_id` for `status`, required for
     `result` and `cancel` at runtime.
   - Route directly to the existing manager. Cancellation means requested, not
     settled; terminal state remains first-wins in the manager.
   - A full-mode worker's cancel response must repeat that checkout write
     ownership remains in force until actual settlement.
   - Update SpawnClaudeAgent's temporary "there are no status/result/cancel
     tools" descriptions and result text in the same commit so the model never
     receives contradictory instructions.
   - Promote rejected operations to visible Pi tool errors without turning
     ordinary `running/not-ready` status into an error.
3. **Documentation and runtime verification**
   - Document the distinction between spawning and controlling a job.
   - Verify status while running, bounded result after success/failure/cancel,
     cancellation settlement, unknown IDs, restore/reload unavailability, and
     that completion still arrives exactly once without polling.

Contract details settled by the design review:

- Unknown/evicted/prior-runtime IDs and cancellation of a terminal job are
  visible errors; terminal cancellation includes the actual status.
- Repeated cancellation while a job remains running is idempotent success.
- `result` on a running job is a non-error not-ready outcome and reminds the
  model that completion arrives automatically.
- A no-ID `status` listing is a bounded facts-only summary; never concatenate
  retained task bodies across the manager's record limit.
- Explicit result retrieval does not consume or suppress an already queued
  automatic next-turn completion. Duplicate visibility is acceptable and must
  be stated rather than coupling the control tool to UI delivery state.

The intended gain is operational control with very little new architecture:
the main agent can check a long job when that is genuinely useful, recover its
bounded result while it remains in the manager, or cancel work that is no
longer wanted. Humans continue to use the widget, `Ctrl+N`, `/claude-details`,
and `/claude-jobs`; automatic next-turn delivery remains the normal model path.

Do not begin Phase 4 implementation until Phase 3d dogfooding confirms worker
termination and checkout-write ownership. Those are safety preconditions for
exposing model-initiated cancellation, not optional polish.

### Phase 5: independent packaging

- Decide whether divergence warrants a new package/provider/config namespace.
- Preserve upstream attribution, document migration, and retain an explicit
  upstream-sync policy for high-value correctness fixes.

## Non-goals

- Reimplementing the existing session bridge from scratch.
- Circumventing organization-managed Claude policy or sandbox controls.
- Replacing or overloading Pi's native `spawn_agent`.
- Adding one first-class Pi tool per background lifecycle operation, or
  overloading `SpawnClaudeAgent` with unrelated lifecycle actions.
- Exposing or claiming access to private/raw chain-of-thought.
- Allowing multiple Claude delegations to mutate the checkout concurrently or
  releasing write ownership before an executor actually settles.
- Automatically dumping full Claude transcripts or tool output into the main
  model's context.
- Building one universal runner around both provider MCP orchestration and
  Claude-native delegation.
- Claiming that background jobs or lifecycle tools survive Pi session shutdown
  in the initial implementation.

## Open decisions

These implementation and later-product decisions remain open:

1. **AskClaude compatibility:** after Phase 3d dogfooding confirms
   SpawnClaudeAgent parity for none/read/full foreground calls, decide the
   AskClaude deprecation and removal timeline.
2. **Launch cwd:** decide whether repository-root Pi startup remains the
   reviewer contract or SpawnClaudeAgent needs an explicit cwd parameter.
3. **Provider scope:** decide how much rich telemetry and UI from delegation
   should also apply when Claude Bridge is selected as Pi's primary provider.
4. **Herdr backend:** decide from a live probe whether its lifecycle/result
   contract is reliable enough to support as an explicit optional backend.
5. **Independent name:** choose a package, provider, and config namespace only
   after the architecture has materially diverged.

## Load-bearing invariants

- Pi remains the source of truth for Pi conversation history.
- Session rebuilds must preserve valid tool-use/tool-result pairing.
- A background job operates on the context and working directory captured when
  it starts, not mutable ambient state.
- None/read capability modes must be enforced by available tools, not merely
  requested in role prose.
- Every full-capability Claude delegation must hold the process-global checkout
  write lease until its executor actually settles.
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
