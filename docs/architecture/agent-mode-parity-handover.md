# Agent Mode parity handover

Date: 2026-07-24  
Source state: shared, uncommitted working tree based on `d9df024`  
Implementation status: delivered and validated in the shared working tree

## Executive summary

BetterC0de now has one provider-neutral Agent Mode control plane across native
providers, direct API providers, and ACP providers while retaining the
project's existing Hono, SQLite, Electron, React, and canonical-event seams.

The implementation is authoritative rather than presentation-only:

- permissions, trust, compaction decisions, effective rules, hunk operations,
  checkpoint recovery, and Git mutations are backend-owned;
- advertised direct-loop and MCP tools are executable, validated, permission
  gated, bounded, and observable;
- denial remains a normal canonical activity and a model-visible tool result;
- planning stays read-only until a correlated proposed-plan request is
  explicitly approved;
- context, session, task, agent, and tool relationships use stable typed
  artifacts instead of UI inference;
- diff hunk controls invoke exact Git operations with patch identities,
  idempotency receipts, and conflict results;
- all source-producing Agent Mode surfaces share one workspace-confined opener;
- no new third-party package/version, visual system, font, icon set, or copied
  reference asset was introduced. Three already-installed backend runtimes are
  now also declared at the packaging root so electron-builder includes them.

The architecture inventory and detailed completion appendix are in
`docs/architecture/agent-mode-parity-inventory.md`.

## Source ownership and reference hygiene

- The supplied reference implementation was treated as read-only behavioral
  evidence. It is not a build input and must remain excluded from product
  source, packaging, and identity scans.
- The working tree was already dirty before the parity work began. Do not use
  reset/checkout cleanup commands. In particular, preserve the pre-existing
  user work around backend HTTP errors, Claude runtime handling, chat input,
  plan implementation UI/service code, and app modals.
- No commit was created as part of this implementation. Review and commit the
  combined working tree intentionally.
- Compatibility readers exist only where required to preserve existing
  BetterC0de data or imported CLI configuration. Product-facing names and new
  storage/config behavior use BetterC0de conventions.

## Delivered architecture

### 1. Canonical runtime and provider harness

Primary seams:

- `packages/schema/src/provider-runtime.ts`
- `apps/backend/src/provider/runtime/ProviderHub.ts`
- `apps/backend/src/provider/runtime/ProviderRuntimeIngestion.ts`
- `apps/backend/src/provider/runtime/legacyBridge.ts`
- `apps/backend/src/provider/activity-projection/` (`index.ts` dispatches to `tool-events.ts`, `request-events.ts`, `session-events.ts`, `turn-events.ts`; helpers in `shared.ts`)
- `apps/ui/src/lib/provider-events/` (`normalize.ts` → `handle.ts`, which fans out to `activities.ts`, `delta-coalescing.ts`, `turn-artifacts.ts`; payload readers in `payload.ts`)

Delivered behavior:

- additive session, task, agent, parent-event, and parent-tool correlation;
- canonical `tool.denied` activity and graceful continuation;
- journal-first structural ordering retained across replay/projection;
- dispatch failures cannot leave a turn permanently active;
- provider-native details stay in metadata while common lifecycle events remain
  provider-neutral;
- direct API loops have explicit maximum-turn exhaustion rather than silently
  ending without a final answer;
- direct tool execution has a 60-second ceiling, propagates cancellation, waits
  for process-tree/edit settlement, and emits exactly one terminal tool result;
- token/cache/context/cost/duration/tool-use data is normalized without
  presenting estimates as provider billing truth.

### 2. Executable tools and direct API MCP

Primary seams:

- `apps/backend/src/provider/agent-loop/tool-catalog.ts`
- `apps/backend/src/provider/agent-loop/tool-executor.ts`
- `apps/backend/src/provider/agent-loop/tool-gate.ts`
- `apps/backend/src/provider/agent-loop/direct-mcp-tools.ts`
- `apps/backend/src/provider/adapters/openaiCompat.ts`
- `apps/backend/src/provider/adapters/claudeApi.ts`
- `apps/backend/src/provider/runtime/acp/AcpMcpServers.ts`
- `apps/backend/src/inProcess.ts`

Delivered behavior:

- one canonical built-in descriptor registry supplies provider JSON schemas and
  executable validation;
- malformed/unknown inputs fail as tool results rather than escaping the loop;
- direct OpenAI-compatible and Claude API adapters dynamically discover MCP
  tools for Agent-capable modes;
- imported runtime, live backend settings, and project/global MCP
  configurations share one resolver with imported < settings < project
  precedence;
- Cursor and Grok ACP session creation/load receive the same enabled resolved
  MCP descriptors;
- external names are collision-resistant provider-safe
  `mcp__server__tool_hash` identifiers while calls retain the original server
  tool name;
- every connection is turn/session bounded and closes after success,
  cancellation, fallback, or failure.

### 3. Permissions, workspace trust, and denial

Primary seams:

- `packages/schema/src/agent-permissions.ts`
- `apps/backend/src/provider/agent-permission-policy.ts`
- `apps/backend/src/provider/agent-permission-runtime.ts`
- `apps/backend/src/provider/project-tool-policy.ts`
- `apps/backend/src/http/routes/permissions.ts`
- `apps/backend/src/persistence/migrations.ts`
- `apps/backend/src/http/routes/git.ts`

Delivered behavior:

- durable user and workspace grants with allow/ask/deny behavior;
- tool and normalized workspace-relative path scopes;
- deny > ask > allow selection across applicable grants;
- workspace confinement before path-scoped evaluation;
- explicit trusted/untrusted records with authenticated read/write routes;
- ProviderHub pre-dispatch trust checks and direct-loop/native callback policy
  integration;
- explicit untrusted guards before Git mutation/checkpoint work;
- denial emits canonical activity, resolves the tool request, and supplies a
  safe explanation to the model.

Compatibility note: a workspace with no persisted trust record remains
implicitly trusted so an upgrade does not disable existing projects. An
explicit `untrusted` record always fails closed.

### 4. Effective rules and inspectable context

Primary seams:

- `packages/schema/src/workspace.ts`
- `apps/backend/src/services/effective-rules.ts`
- `apps/backend/src/services/context-artifact.ts`
- `apps/backend/src/http/routes/workspace.ts`
- `apps/ui/src/components/settings/rules-section.tsx`
- `apps/ui/src/components/chat/context-source-tree.tsx`
- `apps/ui/src/components/chat/simple-context-indicator.tsx`

Delivered behavior:

- deterministic global -> settings -> project -> ancestor directory ->
  target-glob precedence;
- provenance, scope, applicability, reason, truncation, and precedence for
  every candidate;
- effective content injected at the backend turn boundary and inspectable
  through the workspace API/settings UI;
- a backend-owned context artifact describing effective rules, normalized
  provider history, actual system-instruction size, individual messages, tool
  results, pending draft/attachment metadata, provider usage, token estimates,
  and compaction exclusions;
- an expandable token-aware source tree using existing BetterC0de primitives
  and semantic tokens.

### 5. Automatic compaction

Primary seams:

- `apps/backend/src/services/auto-compaction.ts`
- `apps/backend/src/http/routes/chat.ts`
- `apps/ui/src/lib/auto-thread-compaction.ts`
- `apps/ui/src/hooks/use-chat-submit.ts`
- `apps/ui/src/lib/thread-compaction.ts`

Delivered behavior:

- the backend makes the threshold decision from effective configuration,
  current/provider usage, incoming prompt estimate, model limits, recent
  preservation budget, and completed turns;
- provider-native automatic compaction is not duplicated;
- an active turn, unavailable configuration, unknown/invalid capacity,
  insufficient history, or stale preservation budget fails closed;
- every `/chat/send` caller, including desktop, mobile, and direct HTTP, passes
  through the same coordinator-owned backend preflight before admission;
- the bounded transcript is built only from durable active history and excludes
  the renderer's optimistic incoming message, failed/uncertain/reverted
  messages, and already-compacted generations;
- provider sessions stop before the summary/checkpoint/epoch transaction
  commits; generation and last-message preconditions are rechecked with one
  bounded retry;
- summary, persistence, and session-stop failures block provider admission with
  explicit errors. The original durable user message remains retryable and is
  never recursively submitted.

### 6. CLI imports and provider-native assets

Primary seams:

- `apps/shell/cli-scanner.cjs`
- `apps/shell/cli-plugins.cjs`
- `apps/shell/onboarding-ipc.cjs`
- `scripts/cli-scanner.test.mjs`
- provider-native home/snapshot code under
  `apps/backend/src/provider/runtime/{claude,codex,cursor,grok-cli}`

Delivered behavior:

- bounded discovery of commands, agents, skills, MCP servers, and native
  configuration;
- documented native/user/project precedence rather than a last-writer accident;
- enabled imported/configured MCP servers become usable by applicable ACP and
  direct API runtimes;
- Codex remote static headers and environment-referenced headers normalize
  through the portable MCP descriptor without logging secret values;
- malformed, disabled, missing-secret, or unsupported auth configurations are
  skipped instead of partially forwarded.

### 7. Planning and implementation transition

Primary seams:

- `packages/schema/src/chat.ts`
- `apps/backend/src/http/routes/chat.ts`
- `apps/backend/src/provider/shared/chat-mode-tools.ts`
- `apps/ui/src/lib/plan-implement.ts`
- `apps/ui/src/components/chat/plan-implementation-card.tsx`
- `apps/ui/src/components/layout/app-modals.tsx`

Delivered behavior:

- Plan mode advertises read-only/planning-safe tools and preserves provider
  sandbox/allowlist ceilings;
- the proposed plan remains request-correlated and editable;
- approval, denial, and implementation use persisted pending state and stable
  identifiers;
- duplicate/racing implementation attempts are guarded;
- implementation begins only after explicit approval and does not create a
  parallel turn while the planning request is blocked.

### 8. Authoritative hunks, diffs, checkpoints, and Git

Primary seams:

- `packages/schema/src/git.ts`
- `apps/backend/src/services/git/` (`process.ts` runs git; `refs.ts`, `status.ts`, `commands.ts`, `diff.ts`, `worktrees.ts`, `checkpoints.ts`, `profile.ts`)
- `apps/backend/src/http/routes/git.ts`
- `apps/ui/src/services/backend/gitApi.ts`
- `apps/ui/src/lib/git-diff.ts`
- `apps/ui/src/components/diff-panel.tsx`
- `apps/ui/src/components/git-panel.tsx`

Delivered behavior:

- strict single-hunk patch parsing with file headers;
- SHA-256 patch identities and optimistic `expectedPatchId` checks;
- source-aware accept/reject/unstage action validation;
- dry-run, operation IDs, command receipts, idempotent replay, and request
  binding;
- receipts are prepared before Git mutation; restart reconciliation distinguishes
  a still-present source hunk, positive destination evidence, and an ambiguous
  external edit;
- staged and working-tree hunk mutation with explicit stale/conflict results;
- direct Write/Edit tools carry preimage and result SHA-256 identities, reject a
  changed preimage before atomic rename, and emit bounded structured
  `turn.diff.updated` artifacts;
- unified/split diff controls invoke backend operations and refresh on conflict;
- commit-message generation is wired to the existing text-generation seam;
- push, pull, discard, checkout, stash, and stash-pop request confirmation;
- every backend Git mutation passes the trust/checkpoint wrapper;
- raw restore/delete behavior remains disabled in favor of the existing
  recoverable checkpoint saga;
- spawned and in-process backends publish namespaced startup-liveness
  heartbeats behind a 30-second silence watchdog and a five-minute absolute
  ceiling, so bounded crash recovery is not killed by the ordinary readiness
  timeout;
- checkpoint capture enables Git for Windows long-path handling without
  changing user configuration, reuses an already-persisted target ref on
  retry, and cleans its temporary index/lock only after process-tree
  termination is confirmed;
- patches beyond the 32 MiB output ceiling retain exact checkpoint refs and
  project a numstat summary bounded to 4,096 files and 512 KiB of UTF-8 JSON,
  with explicit truncation and total-file metadata instead of permanently
  blocking startup;
- output-limit fallback never begins while the original Git process tree is
  unconfirmed, and durable diff projections preserve the true total file count
  even when only a bounded summary is retained.

Crash-boundary note: Git and SQLite cannot share one atomic transaction.
Prepared receipts plus source/destination inspection make deterministic retries
safe after restart. If unrelated external edits make both sides ambiguous, the
operation returns a conflict instead of guessing or applying twice.

### 9. Typed opener and inspection trees

Primary seams:

- `apps/ui/src/lib/source-target.ts`
- `apps/ui/src/lib/source-opener.ts`
- `apps/ui/src/lib/session-tree.ts`
- `apps/ui/src/lib/tool-call-tree.ts`
- `apps/ui/src/components/chat/tool-call-group.tsx`
- `apps/ui/src/components/sidebar/thread-list.tsx`

Delivered behavior:

- typed file, line, column, inclusive/exclusive range, symbol, and HTTP(S)
  external targets;
- Windows drive/UNC, POSIX absolute, file URL, and workspace-relative parsing;
- workspace confinement by default and an explicit trusted escape hatch;
- shared opening from markdown, inline code, tool activity, diff, file tree,
  search, symbols, references, diagnostics, Git, and Monaco;
- stable parent/fork session trees and agent/task/tool-use trees;
- orphaned and cyclic relationships remain visible instead of disappearing;
- collapse/expansion state persists by stable tree identity.

### 10. Shortcuts, identity, and visual system

Primary seams:

- `apps/ui/src/lib/shortcut-parity.ts`
- `apps/ui/src/hooks/use-global-shortcuts.ts`
- terminal/browser preview event helpers and the keyboard-shortcuts dialog
- identity changes across backend, shell, UI, docs, tests, and configuration

Delivered behavior:

- non-breaking command/terminal/browser/chat aliases with platform modifiers;
- editor and terminal focus guards preserved;
- active product labels, configuration namespaces, storage names, comments,
  fixtures, and branch prefixes use BetterC0de conventions;
- worktree branches use `agent/<8hex>/<slug>`;
- changed UI composes existing primitives and semantic color/theme variables;
- no new package was installed. Existing backend runtime dependencies
  `node-pty`, `openai`, and `ws` are also root production declarations so the
  packaged dependency walker cannot omit them;
- platform package matchers retain a positive allowlist, explicitly exclude
  `Example/`, mobile/public sources and source maps, and are regression-tested
  through electron-builder's normalized matcher implementation.

## Security and resource limits

The main implementation limits are deliberate safety boundaries:

| Area | Boundary |
| --- | --- |
| Direct MCP discovery | 12 servers/turn, 32 tools/server, 96 tools total |
| MCP schemas/descriptions | 64 KiB schema with depth/node limits; 2,048-character description |
| MCP deadlines | 8 seconds connect, 8 seconds list, 60 seconds call |
| MCP transport | argv stdio; HTTPS or loopback HTTP; no redirects, credential-bearing URL, unsafe header, legacy SSE, or incomplete OAuth |
| MCP secret handling | environment/header/query values scrubbed from advertisement, output, and errors |
| Direct built-in tools | 60-second total ceiling; cancellation propagation; bounded output/diffs; process-tree and edit settlement |
| Effective rules | 64 KiB per file, 96 KiB merged content, bounded source/provenance content, four ancestor levels, 96 target files, 256 KiB final system instruction |
| Context artifact | latest 80 active message sources; three displayed tool/attachment children per message |
| Compaction | 20,000 default reserved tokens, 2,000-8,000 recent preservation default, two tail turns, at least 2,000 compactable tokens; 90-message/60,000-character transcript bound |
| Agent loops | Ask 10 model turns, Plan 20, Agent/Debug/default 50 |
| Git | 120-second default command timeout, 32 MiB output cap, bounded 8 global/4 per-workspace active processes and 64 queued operations |
| Source targets | 4,096-character reference, 512-character symbol, workspace confinement |
| Permission schemas | 256-character tool name, 2,048-character relative path scope, 4,096-character workspace/request paths |

## Provider/platform adaptations

- Claude Terminal does not expose a reliable interactive per-tool callback.
  BetterC0de applies CLI allow/disallow options, permission modes, workspace
  trust, process supervision, and observable JSONL at the closest enforceable
  boundary.
- ProviderHub can interpose directly only on providers that expose a
  request/approval event. Direct OpenAI-compatible and Claude API loops invoke
  the same BetterC0de gate inside their owned execution loop.
- Direct Bash executes through a supervised native host shell. BetterC0de
  confines file tools, gates the command, bounds output/time, and terminates the
  process tree, but it is not an operating-system sandbox: an approved command
  can access host resources outside the workspace.
- Direct MCP supports portable stdio and Streamable HTTP/static-header
  descriptors. Legacy SSE and interactive OAuth descriptors are not silently
  downgraded. Native clients may continue to use provider-supported auth flows.
- An enabled stdio MCP descriptor is trusted configuration and starts a process
  during discovery; each advertised tool call still traverses permission
  policy.
- Native provider context, cost, cache, and compaction fields are projected
  only when available. BetterC0de estimates are marked and bounded.
- External Git commands cannot participate in the SQLite receipt transaction;
  optimistic patch identities and idempotent operation IDs are the recovery
  mechanism.
- Provider-session shutdown cannot be atomic with the SQLite compaction
  transaction. All stops must complete first; a failed stop commits nothing and
  the original turn is not admitted.
- Checkpoint undo is authoritative and restart-safe. Redo is intentionally not
  advertised because a revert retires future checkpoint refs and provider
  history; fabricating a local redo would misrepresent backend state.

## Intermediate validation evidence

These results were observed during implementation. They are not a substitute
for the final settled-tree run:

| Check | Result |
| --- | --- |
| Schema build | Passed |
| UI/backend typechecks | Passed at integration checkpoints |
| Backend full-suite checkpoint | 1,586 passed; 9 skipped |
| Permission/runtime focused tests | 93 passed; 3 skipped |
| Effective-rules/UI focused tests | 79 passed |
| Provider-event and tree UI tests | 86 passed |
| Runtime contracts/legacy bridge tests | 43 passed |
| Context artifact tests | 6 passed |
| Git route tests | 5 passed |
| Session/tool tree tests | 8 passed |
| Direct MCP resolver/client/adapter tests | 33 passed, including real SDK stdio and loopback Streamable HTTP |
| ACP resolver/runtime integration tests | 73 passed |
| Intermediate diff check | Clean |
| Intermediate identity/theme/dependency audits | Exact identity and added-line theme scans clean; no dependency diff at that checkpoint |

## Final validation record

Status: **complete on 2026-07-24**.

| Gate | Command/check | Final result |
| --- | --- | --- |
| Whitespace/patch integrity | `git diff --check` | Passed; only existing line-ending notices were emitted. |
| Schema/UI/backend compile | `npm run verify:source` | Passed. |
| Mobile typecheck | `npm run typecheck:mobile` | Passed. |
| Repository lint | `npm run lint` through aggregate | Passed. |
| Packaging/source tests | `npm run test:packaging` | 33/33 passed. |
| UI tests | `npm test` | 119 files; 1,446/1,446 passed. |
| Backend tests | `npm run test:backend` | 145 files; 1,678 passed, 9 skipped, 0 failed. |
| Production build/chunk audits | `npm run build` and package build | Passed; 6,981 modules transformed and configured chunk/bundle budgets passed. Existing Vite static/dynamic-import and large-chunk warnings remain informational. |
| Backend startup | `npm run smoke:backend` | Passed in 646 ms at 137.6 MB RSS. |
| Remote-access smoke | `npm run smoke:remote` | Passed static app, browser/native pairing, cookie/bearer APIs, terminal, WebSocket, replay rejection, owner boundary, revocation, logout, and clean drain. |
| Source verification aggregate | `npm run verify:source` | Passed after all runtime, package, and smoke-harness changes. |
| Forbidden identity | Case-insensitive active-tree scan excluding the read-only reference, dependencies, generated output, coverage, and lockfile hashes | No matches. |
| Theme/dependency audit | Added-line hardcoded color/inline-style scan, manifests/lock review, and actual renderer inspection | Clean. No new package/version; `node-pty`, `openai`, and `ws` are existing backend runtimes promoted to root production declarations for packaging. |
| Renderer inspection | Real Electron/Vite renderer through Chromium DevTools at 845x900 | App shell and Permissions/Trust settings rendered with no error overlay, horizontal overflow, runtime exception, log error, or console error. Stateful Plan/context/tree/diff/Git/opener paths are additionally covered by focused UI/backend integration tests. |
| Package allowlist/size | `npm run package:dir:win` plus archive inspection | Passed: 646.92 MB installed and 96.99 MB `app.asar`, within 650/100 MB budgets. Archive contains zero `Example/`, mobile, UI-public-source, or source-map entries and includes the required runtime packages. |
| Packaged startup | `npm run smoke:package` | Passed backend health, packaged renderer mount, fatal-diagnostic scan, child-tree exit, and temporary-profile cleanup. |

### Startup-recovery incident validation

The final source tree was additionally exercised against the real development
profile that originally failed readiness. Its pending `coke-runner` admission
contained 32,294 changed paths, Windows-long-path entries, and a patch larger
than the 32 MiB ceiling. The backend:

- stayed alive beyond the former 30-second cutoff through namespaced
  liveness heartbeats;
- retained and reused the exact captured checkpoint ref;
- projected 4,096 bounded file summaries with `diffFileCount=32294` and
  explicit truncation metadata;
- cleared the admission and checkpoint-cleanup queues;
- reached `/health` with `status=ok`; and
- completed a subsequent clean restart without replaying the admission.

After this hardening, `npm run verify:source`, `npm run build`,
`npm run smoke:backend`, and `git diff --check` all passed. The packaged binary
and packaged-startup measurements above remain the preceding Windows package
artifact; the source packaging closure test confirms the new shell watchdog is
included by the normal next package build.

## Optional reviewer walkthrough

The final automated/integration gates and real Electron inspection above are
complete. A downstream reviewer can manually reproduce the principal flows
with configured provider credentials by following this path:

1. Open a trusted project and verify effective-rule provenance and the context
   source tree.
2. Mark the workspace untrusted and confirm an Agent turn and Git mutation fail
   before provider/process execution; restore trust.
3. Create allow, ask, and deny grants for a path-scoped tool and verify deny >
   ask > allow across at least one direct and one native provider.
4. Run an Agent turn that calls a built-in tool, an imported MCP tool, and a
   denied tool; confirm nested activity, bounded output, and continuation.
5. Enter Plan mode, attempt a mutation, edit the proposed plan, approve once,
   and confirm exactly one implementation transition.
6. Drive context near its model threshold and verify automatic compaction
   commits one new generation without losing the pending user prompt.
7. Open source references from chat, tool output, search, diagnostics, diff,
   Git, and the file tree, including a range and a symbol.
8. Accept/reject or stage/unstage a hunk, then retry with a stale patch identity
   and confirm a conflict rather than silent overwrite.
9. Exercise push/pull/discard/checkout/stash confirmations and generated commit
   text.
10. Restart/reload and verify grants, trust, plan state, compaction boundary,
    session nesting, and tool activity replay.

## Handover cautions

- Keep the read-only reference excluded; do not rename or copy from it during
  cleanup.
- Do not overwrite the pre-existing user-owned files while resolving final
  lint/test conflicts.
- Do not weaken explicit untrusted checks or the deny > ask > allow policy to
  make provider-specific tests pass.
- Do not make direct MCP errors expose raw SDK messages; those may contain
  command arguments, URLs, or authorization headers.
- Do not convert renderer hunk state into optimistic success. Backend
  receipts/conflicts remain authoritative.
- Do not add a second opener, rules resolver, context estimator, or MCP
  precedence reader. The shared services are the parity mechanism.
- Keep all visual cleanup on existing BetterC0de primitives and semantic
  tokens; no design-system expansion is needed. Preserve the three intentional
  root runtime declarations required by electron-builder.
