import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { test } from "node:test"

const require = createRequire(import.meta.url)
const {
  checkpointRefForThreadTurn, normalizeModelSlug, threadCheckpointRevertSchema,
  threadWorktreeRemoveSchema, threadWorktreeResetSchema,
} = require("@betterc0de/schema")

test("unknown model aliases remain strings even when they name prototype properties", () => {
  for (const provider of [undefined, "codex", "claude", "cursor", "betterc0de"]) {
    for (const model of ["constructor", "__proto__"]) {
      assert.equal(normalizeModelSlug(model, provider), model)
    }
  }
  assert.equal(normalizeModelSlug("5.4", "codex"), "gpt-5.4")
  assert.equal(normalizeModelSlug(" private-model ", "claude"), "private-model")
})

test("checkpoint refs reject turn numbers that cannot be represented exactly", () => {
  assert.throws(() => checkpointRefForThreadTurn("thread", Number.MAX_SAFE_INTEGER + 1), /turnCount/)
  assert.throws(() => checkpointRefForThreadTurn("thread", Infinity), /turnCount/)
  assert.equal(checkpointRefForThreadTurn("thread", Number.MAX_SAFE_INTEGER),
    "refs/betterc0de/checkpoints/dGhyZWFk/turn/9007199254740991")
})

test("destructive worktree flags require JSON booleans rather than truthy strings", () => {
  for (const [schema, base, flags] of [
    [threadWorktreeRemoveSchema, {}, ["deleteBranch", "force"]],
    [threadWorktreeResetSchema, {}, ["clean", "updateSubmodules"]],
    [threadCheckpointRevertSchema, { turnCount: 1 }, ["preserveFuture"]],
  ]) {
    for (const flag of flags) {
      assert.equal(schema.safeParse({ ...base, [flag]: "false" }).success, false)
      assert.equal(schema.parse({ ...base, [flag]: false })[flag], false)
      assert.equal(schema.parse({ ...base, [flag]: true })[flag], true)
    }
  }
  assert.deepEqual(threadWorktreeRemoveSchema.parse({}), { deleteBranch: false, force: true })
  assert.deepEqual(threadWorktreeResetSchema.parse({}), { clean: true, updateSubmodules: true })
})

test("provider kind aliases resolve through one shared table", () => {
  const {
    canonicalProviderKindAlias, compactProviderAlias, providerKindFromDriver,
  } = require("@betterc0de/schema/provider-kind")
  const cases = [
    ["", null], [undefined, null], ["codex", "codex"], ["codex-cli", "codex_cli"],
    ["claudeAgent", "claude"], ["claude_cli", "claude"], ["anthropic-cli", "anthropic_cli"],
    ["cursor_agent", "cursor"], ["cursor-acp", "cursor"], ["grok_cli", "grok_cli"],
    ["grok-build", "grok_cli"], ["grok", "grok"], ["BetterCode Agent", "betterc0de"],
    ["openai", "openai"], ["lm-studio", "lmstudio"], ["constructor", null], ["mystery", null],
  ]
  for (const [input, expected] of cases) {
    assert.equal(canonicalProviderKindAlias(input), expected, String(input))
  }
  assert.equal(compactProviderAlias(" Claude-Agent "), "claudeagent")
  assert.equal(providerKindFromDriver("codex_cli"), "codex")
  assert.equal(providerKindFromDriver("claudeAgent"), "claude")
  assert.equal(providerKindFromDriver("anthropic-cli"), "anthropic_cli")
  assert.equal(providerKindFromDriver("cursor_agent"), "cursor_agent")
  assert.equal(providerKindFromDriver(""), undefined)
})

test("skill scope keys are a storage key, distinct from the runtime provider kind", () => {
  const { canonicalProviderKind, skillScopeProviderKey } = require("@betterc0de/schema/prompt-context")
  assert.equal(skillScopeProviderKey("anthropic-cli"), "claude")
  assert.equal(skillScopeProviderKey("grok_cli"), "grok-cli")
  assert.equal(skillScopeProviderKey("Codex CLI"), "codex")
  assert.equal(canonicalProviderKind, skillScopeProviderKey)
})

test("whole-word search treats identifier characters, $ and - as part of a word", () => {
  const { isSearchWordChar, isWholeWordMatch } = require("@betterc0de/schema/search-text")
  assert.equal(isSearchWordChar("a"), true)
  assert.equal(isSearchWordChar("$"), true)
  assert.equal(isSearchWordChar("-"), true)
  assert.equal(isSearchWordChar(" "), false)
  assert.equal(isSearchWordChar(undefined), false)
  assert.equal(isWholeWordMatch("let foo = 1", 4, 3), true)
  assert.equal(isWholeWordMatch("let foobar = 1", 4, 3), false)
  assert.equal(isWholeWordMatch("$foo", 1, 3), false)
  assert.equal(isWholeWordMatch("foo", 0, 3), true)
})

test("json readers are named for what they return", () => {
  const { asRecord, nonEmptyString, recordOrUndefined } = require("@betterc0de/schema/json-read")
  assert.deepEqual(asRecord(null), {})
  assert.equal(recordOrUndefined(null), undefined)
  assert.equal(recordOrUndefined([]), undefined)
  assert.deepEqual(recordOrUndefined({ a: 1 }), { a: 1 })
  assert.equal(nonEmptyString(""), undefined)
  assert.equal(nonEmptyString(" x "), " x ")
  assert.equal(nonEmptyString(1), undefined)
})

test("pending requests: one order, settled ids first, any resolution settles", () => {
  const {
    affectsPendingRequests, derivePendingRequests, isStalePendingRequestFailureDetail,
    pendingRequestKindOpenedBy, settledRequestIds, settlesPendingRequest,
  } = require("@betterc0de/schema/pending-requests")
  let n = 0
  const act = (kind, payload, extra = {}) => {
    n += 1
    return {
      id: `activity-${n}`, threadId: "t", kind, tone: "info", summary: kind, payload,
      sequence: n * 10, createdAt: `2026-10-07T10:00:${String(n).padStart(2, "0")}.000Z`,
      ...extra,
    }
  }
  const ids = (activities, options) =>
    derivePendingRequests(activities, options).map((request) => request.requestId)

  // Route-written and projected activities carry sequences from two emitters:
  // a resolution can sort before its request and must still settle it.
  const asked = act("user-input.requested", { requestId: "q1" }, { sequence: 200 })
  const answered = act("user-input.resolved", { requestId: "q1" }, { sequence: 100 })
  assert.deepEqual(ids([asked, answered]), [])
  assert.deepEqual(ids([answered, asked]), [])
  // One request id, one callback: a question the provider cancelled is
  // projected as `approval.resolved` and is settled all the same.
  assert.deepEqual(ids([
    act("user-input.requested", { requestId: "q2" }),
    act("approval.resolved", { requestId: "q2", decision: "cancel" }),
  ]), [])

  // A failed response settles only when the provider no longer knows it.
  const approval = act("approval.requested", { requestId: "p1", providerKind: "claude" })
  const failure = (kind, payload) => act(kind, { requestId: "p1", ...payload })
  for (const [kind, payload, open] of [
    ["provider.approval.respond.failed", { detail: "Provider approval response failed." }, ["p1"]],
    ["provider.approval.respond.failed", { detail: "Unknown pending request p1" }, ["p1"]],
    ["provider.approval.respond.failed", { data: { detail: "Stale pending approval request: p1." } }, []],
    ["provider.user-input.respond.failed", { error: "Unknown pending user-input request p1" }, []],
    ["provider.other.failed", { detail: "Stale pending approval request: p1." }, ["p1"]],
  ]) {
    assert.deepEqual(ids([approval, failure(kind, payload)]), open, JSON.stringify(payload))
  }
  for (const [detail, stale] of [
    ["Stale pending plan-approval request: x", true], ["UNKNOWN PENDING PERMISSION REQUEST", true],
    ["unknown pending request", false], ["", false], [undefined, false],
  ]) {
    assert.equal(isStalePendingRequestFailureDetail(detail), stale, String(detail))
  }

  // Unsequenced activities sort first, then creation time, then id.
  const at = (requestId, sequence, second, id) =>
    act("approval.requested", { requestId }, {
      sequence, createdAt: `2026-10-07T10:00:${second}.000Z`, ...(id ? { id } : {}),
    })
  assert.deepEqual(
    ids([at("late", 5, "09"), at("early", 5, "01"), at("zero", 0, "00"), at("unsequenced", null, "59")]),
    ["unsequenced", "zero", "early", "late"]
  )
  assert.deepEqual(ids([at("by-id-b", 7, "00", "b"), at("by-id-a", 7, "00", "a")]), ["by-id-a", "by-id-b"])

  // Reported again: the first position, the latest report.
  const reported = derivePendingRequests([
    act("approval.requested", { requestId: "d1", toolName: "Bash" }),
    act("approval.requested", { requestId: "d2" }),
    act("approval.requested", { requestId: "d1", toolName: "Edit" }),
  ])
  assert.deepEqual(reported.map((request) => [request.requestId, request.payload.toolName]),
    [["d1", "Edit"], ["d2", undefined]])

  // Nested request ids, folded provider kinds, no guessed provider, and a
  // question request without questions is still open.
  assert.deepEqual(ids([
    act("approval.requested", { data: { requestId: "nested-data" } }),
    act("approval.requested", { item: { request_id: "nested-item" } }),
  ]), ["nested-data", "nested-item"])
  const [folded, viaProvider, unnamed] = derivePendingRequests([
    act("approval.requested", { requestId: "k1", providerKind: "claudeAgent", turn_id: "turn-a" }),
    act("approval.requested", { requestId: "k2", provider: "codex_cli", provider_instance_id: "codex-2" }),
    act("user-input.requested", { requestId: "k3" }, { providerInstanceId: "inst-3", turnId: "turn-c" }),
  ])
  assert.deepEqual([folded.providerKind, folded.turnId, folded.kind], ["claude", "turn-a", "approval"])
  assert.deepEqual([viaProvider.providerKind, viaProvider.providerInstanceId], ["codex", "codex-2"])
  assert.deepEqual([unnamed.providerKind, unnamed.providerInstanceId, unnamed.turnId, unnamed.kind],
    [undefined, "inst-3", "turn-c", "user-input"])
  assert.equal("planMarkdown" in folded, false)

  // A plan approval without its plan recovers the plan of its own turn,
  // even one proposed after it; without a turn, the newest plan.
  const plans = derivePendingRequests([
    act("turn.proposed.completed", { planMarkdown: "# Own plan" }, { turnId: "turn-1" }),
    act("plan-approval.requested", { requestId: "plan-1", turn_id: "turn-1" }),
    act("turn.proposed.completed", { planMarkdown: "# Later turn" }, { turnId: "turn-2" }),
    act("plan-approval.requested", { requestId: "plan-2" }, { turnId: "turn-3" }),
    act("turn.proposed.completed", { plan_markdown: "# Proposed after its request" }, { turnId: "turn-3" }),
    act("plan-approval.requested", { requestId: "plan-3" }),
    act("plan-approval.requested", { requestId: "plan-4", plan: "# Inline" }),
  ])
  assert.deepEqual(plans.map((request) => [request.requestId, request.kind, request.planMarkdown]), [
    ["plan-1", "plan-approval", "# Own plan"],
    ["plan-2", "plan-approval", "# Proposed after its request"],
    ["plan-3", "plan-approval", "# Proposed after its request"],
    ["plan-4", "plan-approval", "# Inline"],
  ])

  const mixed = [
    act("approval.requested", { requestId: "m1" }),
    act("plan-approval.requested", { requestId: "m2" }),
    act("user-input.requested", { requestId: "m3" }),
  ]
  assert.deepEqual(ids(mixed), ["m1", "m2", "m3"])
  assert.deepEqual(ids(mixed, { kinds: ["user-input", "approval"] }), ["m1", "m3"])

  assert.equal(pendingRequestKindOpenedBy({ kind: "plan-approval.requested" }), "plan-approval")
  assert.equal(pendingRequestKindOpenedBy({ kind: "constructor" }), undefined)
  assert.equal(settlesPendingRequest(act("plan-approval.resolved", { requestId: "x" })), true)
  assert.equal(affectsPendingRequests(act("tool.updated", { output: "..." })), false)
  assert.equal(affectsPendingRequests(act("user-input.requested", { requestId: "y" })), true)
  assert.deepEqual([...settledRequestIds([answered, act("approval.resolved", {})])], ["q1"])
})
