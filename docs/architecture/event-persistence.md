# Provider Event Persistence

BetterC0de keeps provider rendering responsive while preserving recoverable
conversation state. The runtime uses two durability lanes:

- Structural events (turn/session lifecycle, tool calls/results, approvals,
  plans, errors) are appended to the provider journal before projection and
  broadcast.
- High-frequency assistant and reasoning deltas are broadcast immediately and
  folded into an idempotent assistant-message snapshot. A snapshot is written
  at most 250 ms after the first pending delta, immediately after 16 KiB of new
  buffered data, and again at every terminal boundary.

If no transcript snapshot store is configured, deltas fall back to the strict
journal-first lane. This keeps test harnesses and alternate embeddings durable
without assuming the full application persistence stack.

Terminal events flush the latest transcript before they are broadcast. Failed
snapshot writes use bounded retry and the durable recovery spool; failed
journal writes block later projection and enter the journal recovery queue.
The renderer-facing provider event schema is unchanged.

The renderer batches adjacent deltas of the same kind, preserving the order of
reasoning, answer and plan runs within each frame. Structural events flush that
queue before changing state. A tool first observed as an update or completion
(the ACP path) establishes the same reasoning boundary as a start event; later
updates to that tool do not interrupt a new reasoning phase. Mobile tracks
these first-observed tool boundaries too. This is client projection only and
does not add a persistence lane or alter provider events.

## Live tool snapshots

`ws/ToolSnapshotBuffer.ts` batches cumulative output on both wire channels. Both
`thread.activity` and `provider.runtimeEvent` may retain only the latest full
tool-output snapshot per thread, turn, provider instance, and tool id over
50 ms. Anonymous calls, incremental chunks, and other event types flush the
pending run. An input patch is preserved if a later output snapshot omits it.
Surviving frames keep their source order. Authentication, replay, and shutdown
also flush pending snapshots. Shutdown switches the buffer to immediate delivery,
so final provider events cannot start another batching timer during teardown.

This operates **after** journaling and projection and **before** assigning
WebSocket replay sequences. The durable event history is unchanged; clients
receive contiguous wire sequences, and reconnect replays the same survivors.
One pending batch is bounded by 512 entries and 1 MiB of encoded JSON. Replaced
snapshots release their charge; reaching either bound flushes instead of
dropping data. No renderer or mobile protocol changes are required.

Local counters expose journal event volume, transcript snapshot count, and
snapshot bytes through the authenticated `/api/v1/runtime/metrics` endpoint.
No telemetry leaves the machine through this endpoint.

## Provider goal projection

Goal updates use the existing structural `thread.metadata.updated` lane.
After journaling, ingestion projects `payload.metadata.goal` into
`projection_threads.provider_goal_json`; a failed projection remains
unreceipted for startup replay. The shared schema normalizes native status,
timestamps, and accounting for both clients. A normal turn completion never
marks the goal achieved.

SQL NULL means no goal metadata has been observed by this projection; the
JSON literal `null` records an explicit provider clear. Thread-list responses
omit unknown state and include authoritative clears. Renderer metadata/message
saves cannot write this column. Goal accounting does not change the thread's
sidebar sort timestamp. Deleting the thread deletes its goal, and late provider
notifications do not recreate it. Conversation auto-save controls persistence
through the existing ingestion setting.

Desktop fences initial goal hydration with a local metadata revision, including
repeated clears. Mobile preserves goal updates received while fetching a thread
snapshot. These projections store provider-reported state only; they do not
authorize native automatic continuations or introduce a second dispatch path.

## What the journal stores

The journal (`orchestration_events`, `aggregate_kind = 'provider_runtime'`)
holds two row shapes, told apart by `metadata_json.$.schema`:

| `schema`            | Row shape                                              | Written by                                                     |
| ------------------- | ------------------------------------------------------ | -------------------------------------------------------------- |
| `1`, `2` (or absent)| Legacy `{event_type, thread_id, payload}` (`LegacyProviderEvent`, `provider/types.ts`) | Every row before canonical journaling; the frozen in-process provider stack (`provider/adapters/`, `provider/service.ts`); the checkpoint reactor's own emissions (`turn.diff.updated`, `checkpoint.captured`) |
| `3`                 | Canonical `ProviderRuntimeEvent` (`packages/schema`)   | The provider hub, for every runtime adapter (Claude, Codex, Cursor, Grok, BetterC0deCompat) |

Migration 51 stamps `schema: 1` onto rows that had no marker so every row
carries an explicit shape; the replayer still treats a missing marker as
legacy.

**Canonical rows are journaled before the legacy bridge runs.** The hub
publishes its events unchanged on the bus's `canonical` lane; ingestion
journals the entry exactly as emitted (minus `raw`, the native provider
envelope, which nothing behind the journal reads and which would roughly
double the row for ACP and BetterC0deCompat), and only then translates it
through `canonicalToLegacy` for projections and the wire. A bridge that
declines an event (it has no legacy twin) or fails no longer loses what the
provider said: the row is durable, and a declined row is receipted while a
failed one is left for the startup replayer. The replayer dispatches on the
row's `schema` and feeds both shapes through the same bridge, so a legacy row
and a canonical row of the same event project to identical activities.

The legacy shape is a documented exception, not a target: the in-process
stack is frozen (see AGENTS.md, open decision 2) and its events lack the ids
a canonical row needs, so it keeps writing `schema: 2` until it is retired.

Oversized events are bounded to the 1 MiB row limit in both shapes. A legacy
row carries the `payloadTruncated` / `journal_truncation` markers inside its
`payload`; a canonical row stays pure and records the cut in `metadata_json`
(`payloadTruncated`, `originalBytes`, `stringCapBytes`, `truncatedFields`),
and the legacy view is decorated with the same two marker keys on the way out
— live from the persist result, on replay from the row metadata — so the
activity payload and the wire frame do not depend on the row shape.
`truncatedFields` paths are event-root relative for canonical rows
(`output`, `payload.data.stdout`) and payload relative for legacy rows.

Oversized checkpoint patches are omitted whole and marked with
`diffTruncated: true` and `diffTruncationReason: "journal_limit"`. The checkpoint
projection accepts this explicit summary form, recording the turn, checkpoint
ref and available file totals with an empty patch blob. An absent patch without
that marker is still ignored. This lets startup recover an existing failed
checkpoint admission through the normal journal and projection lane before
acknowledging it; the Git snapshots retain the actual file contents. Admission
durability checks and journal size limits remain enforced.

## The bus lanes

`provider/events.ts` carries three lanes. `event` is raw legacy input (the
in-process stack, the reactor); `canonical` is raw hub input; `projected` is
the legacy view ingestion publishes for every bridged live event after it has
processed it — journaled first whenever journaling applies. Not every event
is journaled: with conversation auto-save off only the terminal event of a
tracked dispatch is, and transcript-lane deltas fold into the snapshot
instead; those still reach `projected`. A journaled event reaches it only
once projected and receipted, and an event the bridge declined or failed on
never does. The checkpoint reactor listens on `projected`, so it cannot
observe an event before the journal did, whichever component subscribed
first. Nothing re-enters `event` from `projected`, so there is no loop.

The WebSocket wire (`provider.runtimeEvent`) is unchanged: frames keep the
legacy shape and are built from the same decorated legacy view projections
consumed, so live never shows more than replay can.

The filesystem recovery spool records the entry shape (`version: 3` records
carry `shape` next to `event`); older `version: 1`/`2` records are legacy.

## Managed goal execution

`services/chat/goals.ts` owns a per-thread continuation scheduler with injected
ports. `goal-runtime.ts` connects it to the existing chat dispatch, event bus,
and durable goal projection. This adds no second message or thread write path.
`POST /chat/goal` shares validated chat context through `httpContracts.chatGoal`;
Desktop and Mobile route commands there before optimistic messages or streaming
state are created. Controls do not dispatch slash text to a provider.

A goal mutation emits `thread.metadata.updated` with a unique mutation id and
waits for synchronous acknowledgement on the post-journal `projected` lane.
If projection is unavailable, no new provider work is scheduled. Startup replays
the journal first, then journals a pause for every recovered managed active goal.
Provider-native snapshots remain distinct from goals with `source: betterc0de`.

Each continuation calls `dispatchChatTurn` and waits for the Hub's `settled`
promise, including checkpoint finalization. Generation guards run again inside
admission and after compaction so pause, clear, shutdown or an edit cannot admit
stale work. A remote goal reserves ownership again for each turn, using its
original remote-session identity; revocation interrupts an owned active turn
and prevents another reservation. Permission changes are read for continuation.
A normal admitted user turn pauses the goal. Goal pause/clear interrupts only
its captured admission id. Shutdown cancels timers and unsubscribes observation.

The scheduler retains only a bounded assistant-text tail for the current cycle.
A nonce-bound final HTML comment reports continue, complete or blocked plus
supporting evidence. A turn terminal alone never establishes completion. Three
missing reports block instead of generating an endless protocol retry loop.
A report for an old objective cannot complete an edited goal. Provider failures
and uncertain dispatches require explicit resumption. Token limits are rejected
until provider accounting has a reliable, shared per-turn contract.
