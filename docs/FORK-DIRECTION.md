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

**Completed in [PR #2](https://github.com/ramtinJ95/pi-claude-bridge/pull/2).**
The fork now requires Pi 0.84.2 and Node.js 22.19, pins matching Pi development
packages, runs its test harnesses against the repository-local Pi CLI, records
the installed Pi/Agent SDK/bundled Claude Code versions, and has an offline
extension-load/provider-registration smoke test. The provider lifecycle-hook
adapter gap is explicitly documented and guarded by characterization tests; no
payload or HTTP response data is fabricated.

Phase 0 validation passed typecheck, package dry-run, the real Pi load smoke,
and all 200 unit tests. The remaining tool-heavy live-test failures on the
current workstation are the known managed-policy interaction with the existing
hard-coded `bypassPermissions` mode. Phase 1 replaced that request with
configurable `auto`; the organization policy still restricts provider MCP tools,
now deliberately and visibly rather than as an adapter accident.

- Run the existing unit suite and typecheck unchanged.
- Raise the supported Pi baseline to 0.84.2 and pin matching development
  dependencies.
- Add a Pi 0.84.2 extension-load/provider-registration smoke test.
- Record the installed Agent SDK and Claude Code versions used by integration
  tests.
- Characterize Pi 0.84's `onPayload`/`onResponse` provider-hook behavior for the
  Agent-SDK-backed provider; record any unavoidable limitation explicitly and
  never fake an HTTP response.
- Add characterization tests before changing undocumented session behavior.

### Phase 1: correctness and policy semantics — complete

**Completed in [PR #3](https://github.com/ramtinJ95/pi-claude-bridge/pull/3),
merged as `1754acc`.** Capability and permission policy are now separate;
provider, compaction, and delegation queries use configurable `auto` by default;
and AskClaude defaults to structural read capability in a fresh isolated
conversation. Read and none use explicit model-callable tool inventories, with
nested `Agent` excluded from read mode. The TUI and bounded model-facing result
surface requested/runtime permission differences, denials, and non-sensitive
managed-policy constraints the Agent SDK can actually attribute.

Phase 1 validation passed typecheck, package dry-run, all 211 unit tests, and the
live Agent SDK contract suite (17 passed, one environment-dependent skip). A
Fable/high review found no high-severity or security-critical issues. Accepted
review fixes clarified provider-denial remediation and the deliberate rejection
of blanket `allowedTools`, removed an avoidable provider-init wait, distinguished
requested from observed permission rendering, strengthened source-wide policy
tripwires, and corrected an integration-test claim.

- Preserve PR #1's effective-default contract while changing fork defaults to
  `read` and `isolated: true`.
- Separate capability mode from permission mode.
- Default both provider and delegation paths to `auto` permission mode.
- Add configuration and tests for permission mode.
- Show the effective requested mode and managed-policy constraints where
  observable.

Live Phase 1 characterization on the current workstation shows that requesting
`auto` is changed by Claude Code to runtime `default`. The Agent SDK settings
resolver attributes the relevant constraints to a managed macOS plist: sandbox
is required, unsandboxed commands and bypass mode are disabled, only managed
permission rules may grant access, and managed network/read restrictions apply.
As a result, provider MCP tools remain denied unless organization policy permits
them. The bridge must report this state; it must not install a `canUseTool`
callback or other host-side override merely to make the provider appear to work.
It also deliberately does not pass every Pi MCP alias through the SDK's
`allowedTools`: that would auto-approve the provider's whole tool inventory on
unmanaged machines and make `provider.permissionMode` nominal. Users may grant
specific aliases such as `mcp__custom-tools__read` in Claude permission settings;
when managed permission rules are exclusive, an administrator must make that
grant.

Deferred, non-blocking review cleanup remains available for later opportunistic
work: retry a transient managed-settings resolution failure instead of caching
`undefined` for the process lifetime; simplify typed result-denial access and UI
permission resolution; and clarify the compatibility reason for probing both
managed read-path key locations. These are not prerequisites for Phase 2.

### Phase 2: normalized events and richer blocking UI — in progress

- Extract pure query options, the delegation runner, and the normalized event
  model without routing the provider through that runner.
- Capture tool results, usage, session metadata, and emitted thinking summaries.
- Replace the lightweight `AskClaude` status line with expandable live details.
- Use Pi 0.84's themed Markdown and stateful tool-row rendering rather than a
  parallel rendering framework.
- Keep final model-facing output bounded.

Deliver Phase 2 as two independently reviewable PRs:

1. **Delegation engine and normalized events — complete in
   [PR #4](https://github.com/ramtinJ95/pi-claude-bridge/pull/4).** Extract delegation query
   options and one Claude-native runner, normalize the SDK stream into a stable
   snapshot, and replace `promptAndWait` while preserving the existing
   `AskClaude` UI and model-facing behavior. Characterize fixture replay,
   tool-result matching, usage, unknown events, cancellation, and cleanup. The
   provider must remain outside this runner.
2. **Rich `AskClaude` observability — implemented on
   `phase-2-askclaude-observability`, pending review and merge.** Delegation now
   requests partial SDK messages and publishes throttled Pi partial updates from
   the same retained snapshot used by the final result. The Pi 0.84 stateful tool
   row has compact and expanded themed views for streaming response text,
   emitted thinking summaries, nested tools, inputs/results/durations, timeline,
   usage/cost, model/session/cwd, capability, isolation, permission denials,
   retries, rate limits, and observed managed-policy state. Named limits bound
   model output, prompt/thinking/tool fields, timeline, and retained lists;
   truncation is visible and persisted display details receive best-effort
   credential redaction.

For the second PR, prefer a small retained record: approximately 16k characters
for the model-facing answer, 2k per tool input or output, 32k/100 events for the
retained timeline, and 4k for emitted thinking summaries. Keep these as named,
independently tested constants rather than persistence-format promises.

PR #4's implementation and validation are complete: typecheck, package dry-run,
and all 243 unit tests pass. The live Agent SDK contract suite passed before the
final review round (17 passed, one environment-dependent skip) and was not rerun
because the final changes add no new undocumented SDK behavior assumption. A
Fable/high AskClaude review found two blockers and four non-blocking items. The
cancellation and resumed-session replay blockers were fixed, as were
failed-snapshot fallback text, single policy resolution, and result-helper type
narrowing.

A final Opus review produced these accepted fixes:

- **Cancellation is terminal and model-visible.** `runDelegation` still resolves
  on cancellation so partial work survives, but the AskClaude glue now finalizes
  that into a result that says it was cancelled, keeps the partial answer and
  action summary, and carries `cancelled`/`error` details. Pi's
  `AgentToolResult` has no `isError` field — only a throw sets it, and a throw
  discards details — so a `tool_result` hook promotes those details to the real
  `toolResult.isError`.
- **A missing result is a failure.** The runner tracks whether an authoritative
  SDK `result` arrived. An iterator that ends without one, and without an abort,
  publishes a failed snapshot and throws instead of reporting success; an
  assistant error seen earlier becomes the failure text.
- **`SDKAssistantMessage.error` is preserved** as an `assistant_error` event and
  snapshot field. It does not end the run on its own, since an authoritative
  result may still follow.
- **`parent_tool_use_id` is preserved** as `parentToolUseId` on normalized
  tool events and tool records. The `tool_use` frame is authoritative for the
  subagent relation; progress and result frames may only fill it in, never
  flatten it. The UI stays flat for now.
- **Diagnostics say `unhandled_sdk_message`, not `unknown`.** The SDK documents
  many more frames than delegation consumes; a brittle ignore list was rejected
  in favor of a name that only claims this reducer did not handle the frame.
- **`isolated: true` with `resumeSessionId` is unrepresentable** through a
  discriminated union, with the caller branching rather than casting.
- Terminal lifecycle ownership stays in `runDelegation`: the reducer cannot infer
  iterator completion, so a snapshot stays `running` until the runner finalizes
  it.

Enabling and documenting partial SDK messages is intentionally deferred to the
rich-observability PR, where live streaming becomes user-visible and can be
tested with its renderer. So are rich tool-row rendering, nested/subagent tree
display, retention caps, visible truncation, and redaction.

The Phase 2 PR 2 implementation started from the merged delegation runner and
event snapshot rather than reopening its provider/session boundaries. It first
enabled and characterized `includePartialMessages`, then drove Pi partial updates
and final rendering from the same snapshot. Two small runtime edges
remain visible rather than silently declared solved: a signal already aborted
before runner entry still takes the generic error path, and the Pi 0.84.2
`tool_result` hook that promotes AskClaude cancellation/error details to
`toolResult.isError` is source-verified and unit-tested through its pure decision
function but has not yet had an end-to-end live AskClaude cancellation exercise.

PR 2 follows that handoff without changing the provider, session, or permission
boundaries. `includePartialMessages` is asserted at the pure options boundary;
recorded SDK stream fixtures continue to characterize the partial text,
thinking, and tool event shapes. Renderer tests initialize the Pi 0.84 theme and
exercise compact, expanded, nested, Markdown, and stateful component reuse paths.
Retention tests pin every named limit, assembled-stream redaction, visible
truncation, list omission accounting, and the bounded/redacted model-facing
result. A Fable/high correctness review found three blockers, all fixed: the
authoritative SDK result is now retained separately from multi-turn streamed
narration and wins for the final model/UI answer; terminal failure text is
visible even when a failed snapshot exists; and capped fields now receive one
accurate truncation marker rather than a second pass that replaced the true
omission count.

The review's non-blocking items were then dispositioned. These were accepted and
implemented in the same PR:

- **Policy annotations survive the cap.** The bounded model-facing result no
  longer joins its segments and truncates the tail, which silently dropped a
  permission override or denial exactly when the answer reached
  `MODEL_RESULT_MAX_CHARS`. `assembleModelResult` spends one total budget in
  explicit priority order — policy annotations, then the action summary, then
  the answer — and the answer absorbs the shortfall because it is the only
  segment whose loss is self-describing. It is budgeted from the runner's own
  snapshot text plus its omission count, so a capped answer still carries one
  accurate marker rather than a second marker stacked on the display copy. The
  authoritative SDK result still wins over streamed narration. The action
  summary has its own named cap (`ACTION_SUMMARY_MAX_CHARS`), annotations have
  `POLICY_ANNOTATION_MAX_CHARS`, and a floor keeps the lower-priority segments
  from starving the answer even if a caller hands over an unbounded one.
- **One retained record per result.** The action summary is now derived inside
  finalization from the retained snapshot instead of being passed in from the
  raw one, and the error path summarizes the retained snapshot too, so the
  model-facing summary, persisted details, and rendered tool list describe the
  same bounded, redacted record on both the success and failure paths.
- **One requested model.** AskClaude execute resolves `requestedModel` once from
  `ASK_CLAUDE_DEFAULT_MODEL` and uses it for the delegation call and for all
  partial, final, and error metadata, so the query and the model shown beside it
  cannot disagree.
- **No test-shaped production cast.** Finalization requires a real complete
  `DelegationSnapshot`; the `as DelegationSnapshot` cast and the
  `responseText` fallback that existed only to tolerate a `{}` fixture are gone,
  and the unit fixtures build snapshots with `createDelegationSnapshot`.
- **Boundary-split credential fragments are documented, not defended against.**
  Redaction needs a whole credential in one string, and retention cuts strings
  at boundaries chosen for length. A secret straddling one leaves an unmatched
  fragment on the retained side. The caps are the real containment and
  redaction is a courtesy pass over what remains; a streaming secret detector
  carrying state across every field was rejected as more machinery than this
  display path warrants.

Three non-blocking items were deferred rather than implemented:

- **A live subagent stream-event probe** would pin whether nested `Agent` calls
  emit the `parent_tool_use_id` relation the renderer is prepared to indent.
  The uncertainty is real and belongs in Phase 3, where nested background jobs
  make it load-bearing and `tests/int-cc-contracts.mjs` can assert it against
  the installed SDK.
- **Expanded render performance** rebuilds every child component for each
  expanded frame. Measure it against a large retained snapshot before
  optimizing; a caching layer added on suspicion would be parallel rendering
  machinery this phase deliberately avoided.
- **The oversized-input compact label** stays as-is: a tool input over its field
  cap renders as visibly truncated JSON rather than a structured summary, which
  is honest about what was retained.

Final validation on this branch: 265 unit tests, typecheck, `npm pack`
dry-run, and `git diff --check` all pass. The live Agent SDK contract suite
passed after the blocker fixes (17 passed, one environment-dependent skip) and
was not rerun for the disposition changes, which add no new undocumented SDK
behavior assumption. The remaining step for Phase 2 is merge of this branch;
Phase 3 should start from its retained snapshot rather than inventing a second
background-job event format.

### Phase 3: background job core

- Implement the job manager and lifecycle state machine.
- Add `SpawnClaudeAgent` with `explorer` and `reviewer` profiles.
- Enforce read-only capabilities structurally, not only through prompts.
- Add cancellation and session-shutdown cleanup tests.
- Add the sticky live-jobs widget and human status/cancel commands.
- Persist bounded completed-job details as TUI-only custom entries and deliver
  one bounded non-triggering model-visible result message.

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
