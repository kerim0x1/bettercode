import { isRecord } from "./json-read"

/**
 * Bounds for the tool output a thread activity carries (RAM-04).
 *
 * A tool activity is stored in `projection_thread_activities`, broadcast to
 * every client on `thread.activity`, and kept in each renderer's store for
 * every loaded thread. The provider journal caps one event at 1 MiB, so an
 * activity used to hold up to a megabyte of command output, often twice
 * (`output` plus the `detail` / `data.rawOutput` copies a provider mirrors).
 *
 * A bounded payload keeps the head and the tail of each large value (the
 * first lines and the final error are what a reader looks at), marks the
 * cut in the text itself, and records what was cut: `outputTruncated`,
 * `outputBytes` (the original size of the primary output) and
 * `truncatedFields`. `GET /threads/:id/activities/:activityId/output` reads
 * the full value back from the provider runtime journal while the journal
 * still retains the event (`apps/backend/src/provider/activity-projection/
 * full-output.ts`).
 *
 * One implementation for both sides, so a bounded live activity looks
 * exactly like a bounded stored one: the backend bounds every activity it
 * projects and every `provider.runtimeEvent` frame it broadcasts
 * (`apps/backend/src/provider/activity-projection`), and the renderer bounds
 * the tool activities it projects itself from provider plugin events
 * (`apps/ui/src/lib/tool-output-bounds.ts`, which adds its own flag). UTF-8
 * sizes are counted here and text is cut through `TextEncoder` /
 * `TextDecoder`, so the module runs unchanged in Node and in a browser.
 */

/** Most bytes a tool activity's payload takes as JSON. */
export const TOOL_ACTIVITY_PAYLOAD_BUDGET_BYTES = 64 * 1024
/** The summary and presentation text render inline, as one row. */
export const TOOL_ACTIVITY_INLINE_TEXT_MAX_CHARS = 2_000

/** Room kept for the truncation record the bounded payload gains. */
const TRUNCATION_RECORD_RESERVE_BYTES = 2_560
/** No string is cut below this; a value this small is never the problem. */
const MIN_STRING_CAP_BYTES = 1_024
const MAX_LISTED_TRUNCATED_FIELDS = 16
const MAX_TRUNCATED_FIELD_PATH_CHARS = 120
const MAX_WALK_DEPTH = 32
const MAX_CAP_ATTEMPTS = 12
const MAX_STRUCTURAL_CUTS = 8
/** Slack for the marker's size labels, whose width depends on the sizes. */
const MARKER_SIZE_LABEL_SLACK_BYTES = 24

/**
 * Keys under which a payload holds a tool's result rather than its request:
 * the result itself and the streamed or mirrored copies of it. The first pass
 * cuts only strings below one of these, so the call's input stays intact
 * whenever the output alone can be made to fit.
 */
const OUTPUT_KEYS: ReadonlySet<string> = new Set([
  "output",
  "output_delta",
  "delta",
  "detail",
  "rawOutput",
  "raw_output",
  "result",
  "content",
  "stdout",
  "stderr",
  "aggregatedOutput",
  "aggregated_output",
  "formattedOutput",
  "formatted_output",
  "output_for_prompt",
])

/**
 * Keys under which a payload holds the call's request. A value below one of
 * these is input even when its own key reads like output (`input.content`
 * of a file write), so the output pass leaves it alone.
 */
const INPUT_KEYS: ReadonlySet<string> = new Set([
  "input",
  "rawInput",
  "raw_input",
  "arguments",
  "args",
  "params",
])

/** Whether a value sits below an output key, an input key, or neither. */
type Region = "none" | "input" | "output"

function regionBelow(region: Region, key: string): Region {
  if (region !== "none") return region
  if (OUTPUT_KEYS.has(key)) return "output"
  if (INPUT_KEYS.has(key)) return "input"
  return "none"
}

/**
 * Never cut, at any depth: the identity and correlation keys the renderer
 * groups tool rows by, the derived presentation (bounded on its own), and the
 * journal's and this module's truncation records. A flag a caller adds to a
 * bounded payload (`boundedPayloadFields`) needs no entry as long as it is a
 * boolean or a number: only strings and containers are ever cut.
 */
const PROTECTED_KEYS: ReadonlySet<string> = new Set([
  "eventType",
  "toolId",
  "tool_id",
  "toolUseId",
  "tool_use_id",
  "toolName",
  "tool_name",
  "itemId",
  "item_id",
  "itemType",
  "item_type",
  "turnId",
  "turn_id",
  "dispatchTurnId",
  "threadId",
  "thread_id",
  "eventId",
  "event_id",
  "requestId",
  "request_id",
  "sessionId",
  "session_id",
  "taskId",
  "task_id",
  "parentTaskId",
  "parent_task_id",
  "agentId",
  "agent_id",
  "parentAgentId",
  "parent_agent_id",
  "parentToolId",
  "parent_tool_id",
  "providerKind",
  "provider_kind",
  "providerInstanceId",
  "provider_instance_id",
  "kind",
  "presentation",
  "journal_truncation",
  "payloadTruncated",
  "outputTruncated",
  "outputBytes",
  "inputTruncated",
  "inputBytes",
  "truncatedFields",
])

/**
 * An approval request is answered from what the card shows, so beyond the
 * keys above these stay whole too:
 *
 * - what the request is and how "Always allow" is scoped: the request kind and
 *   type, the provider's permission suggestions, the blocked path, the reason;
 * - the strings the user authorizes as such: the command a shell approval
 *   runs (the card promises the whole command is reachable, because a padded
 *   command could otherwise hide its payload in a cut), its working directory
 *   and the path a file tool writes.
 *
 * Bulk input — a file body, an edit's old and new text, a large MCP argument —
 * is what gets cut, head and tail kept, marked as cut input.
 */
const APPROVAL_PROTECTED_KEYS: ReadonlySet<string> = new Set([
  ...PROTECTED_KEYS,
  "requestKind",
  "request_kind",
  "requestType",
  "request_type",
  "suggestions",
  "permissionSuggestions",
  "permission_suggestions",
  "blockedPath",
  "blocked_path",
  "decisionReason",
  "decision_reason",
  "pluginId",
  "tool",
  "command",
  "cwd",
  "file_path",
  "filePath",
  "path",
  "notebook_path",
])

/** The activity kind an approval request projects to. */
const APPROVAL_REQUESTED_KIND = "approval.requested"

/**
 * The payload keys a tool's primary output lives under, in the order the
 * renderer reads them: the final result, then a streamed chunk or the
 * mirrored copy a provider sends while the call runs.
 */
const PRIMARY_OUTPUT_KEYS = [
  "output",
  "output_delta",
  "delta",
  "rawOutput",
  "raw_output",
  "result",
  "detail",
] as const

export interface PrimaryToolOutput {
  readonly key: (typeof PRIMARY_OUTPUT_KEYS)[number]
  readonly value: unknown
}

/** The value a tool activity's output is about, or undefined when it has none. */
export function primaryToolActivityOutput(
  payload: Record<string, unknown>
): PrimaryToolOutput | undefined {
  for (const key of PRIMARY_OUTPUT_KEYS) {
    const value = payload[key]
    if (value !== undefined && value !== null) return { key, value }
  }
  return undefined
}

/**
 * UTF-8 bytes of `text`, counted without encoding it: what `TextEncoder`
 * (and Node's `Buffer.byteLength`) gives. A lone surrogate counts as the
 * three bytes of the replacement character it is encoded as.
 */
export function utf8ByteLength(text: string): number {
  let bytes = 0
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        index += 1
      } else {
        bytes += 3
      }
    } else {
      bytes += 3
    }
  }
  return bytes
}

/** UTF-8 bytes of a string, or of any other value's JSON. */
export function toolOutputByteSize(value: unknown): number {
  if (typeof value === "string") return utf8ByteLength(value)
  const json = jsonOf(value)
  return json === undefined ? 0 : utf8ByteLength(json)
}

/** `512 B`, `32 KiB`, `1.2 MiB`. */
export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ["KiB", "MiB", "GiB"] as const
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${Number(value.toFixed(1))} ${units[unit]}`
}

/** What the marker calls the cut value: a tool's output, or a call's input. */
export type TruncationLabel = "output" | "input"

function truncationMarker(
  totalBytes: number,
  headBytes: number,
  tailBytes: number,
  label: TruncationLabel = "output"
): string {
  return `\n… [${label} truncated: ${formatByteSize(totalBytes)} total, showing the first ${formatByteSize(headBytes)} and the last ${formatByteSize(tailBytes)}] …\n`
}

export interface MiddleTruncation {
  readonly text: string
  readonly truncated: boolean
  /** UTF-8 bytes of the input. */
  readonly originalBytes: number
}

const utf8Encoder = new TextEncoder()
// `ignoreBOM` keeps a leading byte order mark, as `Buffer#toString` does.
const utf8Decoder = new TextDecoder("utf-8", { ignoreBOM: true })

/**
 * Keeps the head and the tail of `text` within `maxBytes` UTF-8 bytes, the
 * marker included, and puts a marker naming the sizes between them. Cuts
 * fall on character boundaries: no multi-byte sequence or surrogate pair is
 * split. `label` names the value in the marker ("output" by default).
 */
export function truncateTextMiddle(
  text: string,
  maxBytes: number,
  label: TruncationLabel = "output"
): MiddleTruncation {
  // UTF-8 never takes more than three bytes per UTF-16 unit.
  if (text.length * 3 <= maxBytes) {
    return { text, truncated: false, originalBytes: utf8ByteLength(text) }
  }
  const originalBytes = utf8ByteLength(text)
  if (originalBytes <= maxBytes) {
    return { text, truncated: false, originalBytes }
  }
  const bytes = utf8Encoder.encode(text)
  const reserve =
    utf8ByteLength(truncationMarker(originalBytes, maxBytes, maxBytes, label)) +
    MARKER_SIZE_LABEL_SLACK_BYTES
  const keep = Math.max(0, maxBytes - reserve)
  const headEnd = utf8BoundaryAtOrBefore(bytes, Math.ceil(keep / 2))
  const tailStart = utf8BoundaryAtOrAfter(
    bytes,
    bytes.length - Math.floor(keep / 2)
  )
  const head = utf8Decoder.decode(bytes.subarray(0, headEnd))
  const tail = utf8Decoder.decode(bytes.subarray(tailStart))
  return {
    text: `${head}${truncationMarker(originalBytes, headEnd, bytes.length - tailStart, label)}${tail}`,
    truncated: true,
    originalBytes,
  }
}

/** True for a UTF-8 continuation byte (`10xxxxxx`). */
function isContinuationByte(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80
}

function utf8BoundaryAtOrBefore(bytes: Uint8Array, index: number): number {
  let boundary = Math.min(Math.max(index, 0), bytes.length)
  while (boundary > 0 && isContinuationByte(bytes[boundary])) boundary -= 1
  return boundary
}

function utf8BoundaryAtOrAfter(bytes: Uint8Array, index: number): number {
  let boundary = Math.min(Math.max(index, 0), bytes.length)
  while (boundary < bytes.length && isContinuationByte(bytes[boundary])) {
    boundary += 1
  }
  return boundary
}

/** Cuts inline text at `maxChars` with an ellipsis, never inside a surrogate pair. */
export function truncateInlineText(
  text: string,
  maxChars: number = TOOL_ACTIVITY_INLINE_TEXT_MAX_CHARS
): string {
  if (text.length <= maxChars) return text
  let end = Math.max(0, maxChars - 1)
  const last = text.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end -= 1
  return `${text.slice(0, end)}…`
}

type CapScope = "output" | "all"

interface CutRecord {
  readonly path: string
  readonly originalBytes: number
  /** The region the cut value sat in. */
  readonly region: Region
}

interface StringCandidate {
  readonly jsonBytes: number
}

/**
 * Cuts `payload` down to `budgetBytes` of JSON, never touching a key in
 * `protectedKeys` (nor, with `keepProtectedWhole`, a record that holds one).
 * Null when the payload is within the budget (or cannot be serialized) or
 * nothing could be cut.
 */
function boundPayload(
  payload: Record<string, unknown>,
  budgetBytes: number,
  protectedKeys: ReadonlySet<string>,
  keepProtectedWhole: boolean
): { value: Record<string, unknown>; cuts: CutRecord[] } | null {
  const totalBytes = jsonBytes(payload)
  if (totalBytes === undefined || totalBytes <= budgetBytes) return null

  const contentBudget = Math.max(
    MIN_STRING_CAP_BYTES * 2,
    budgetBytes - TRUNCATION_RECORD_RESERVE_BYTES
  )
  let bounded: Record<string, unknown> = payload
  let boundedBytes = totalBytes
  let cuts: CutRecord[] = []

  for (const scope of ["output", "all"] as const) {
    if (boundedBytes <= contentBudget) break
    const attempt = capStringsToFit(
      payload,
      scope,
      totalBytes,
      contentBudget,
      protectedKeys
    )
    if (attempt) {
      bounded = attempt.value
      boundedBytes = attempt.bytes
      cuts = attempt.cuts
    }
  }

  if (boundedBytes > contentBudget) {
    const structural = cutLargestValues(
      bounded,
      boundedBytes,
      contentBudget,
      cuts,
      protectedKeys,
      keepProtectedWhole
    )
    bounded = structural.value
    boundedBytes = structural.bytes
    cuts = structural.cuts
  }

  return cuts.length === 0 ? null : { value: bounded, cuts }
}

function listTruncatedFields(cuts: ReadonlyArray<CutRecord>): string[] {
  return cuts
    .slice(0, MAX_LISTED_TRUNCATED_FIELDS)
    .map((cut) => cut.path.slice(0, MAX_TRUNCATED_FIELD_PATH_CHARS))
}

/**
 * Bounds a tool activity payload to `budgetBytes` of JSON. A payload within
 * the budget is returned as is (same reference). Otherwise large strings are
 * cut in the middle, output values first; a value that is large without
 * being one big string (a byte array, thousands of entries) is replaced by a
 * cut copy of its JSON as a last resort. The result lists what was cut.
 */
export function boundToolActivityPayload(
  payload: Record<string, unknown>,
  budgetBytes: number = TOOL_ACTIVITY_PAYLOAD_BUDGET_BYTES
): Record<string, unknown> {
  const result = boundPayload(payload, budgetBytes, PROTECTED_KEYS, false)
  if (!result) return payload
  const { value: bounded, cuts } = result
  const primary = primaryToolActivityOutput(payload)
  const outputCut = cuts.some((cut) => cut.region === "output")
  return {
    ...bounded,
    ...(outputCut
      ? {
          outputTruncated: true,
          ...(primary
            ? { outputBytes: toolOutputByteSize(primary.value) }
            : {}),
        }
      : {}),
    truncatedFields: listTruncatedFields(cuts),
  }
}

/**
 * Bounds an approval request's payload to `budgetBytes` of JSON, the same
 * way a tool activity's is, except that everything the approval card needs
 * to render the request and answer it stays whole (`APPROVAL_PROTECTED_KEYS`).
 * When the call's input was cut, `inputTruncated` and `inputBytes` (the
 * original size of `input`, or of `args` when there is no `input`) say so,
 * next to `truncatedFields`. Within the budget the payload is returned as is.
 */
export function boundApprovalRequestPayload(
  payload: Record<string, unknown>,
  budgetBytes: number = TOOL_ACTIVITY_PAYLOAD_BUDGET_BYTES
): Record<string, unknown> {
  const result = boundPayload(
    payload,
    budgetBytes,
    APPROVAL_PROTECTED_KEYS,
    true
  )
  if (!result) return payload
  const { value: bounded, cuts } = result
  const input = payload.input ?? payload.args
  const inputCut = cuts.some((cut) => cut.region === "input")
  return {
    ...bounded,
    ...(inputCut
      ? {
          inputTruncated: true,
          ...(input !== undefined && input !== null
            ? { inputBytes: toolOutputByteSize(input) }
            : {}),
        }
      : {}),
    truncatedFields: listTruncatedFields(cuts),
  }
}

/**
 * What the bound reads of an activity: the backend's stored row
 * (`ThreadActivityProjection`) and the renderer's `ThreadActivity` both fit.
 * Every other field is copied as is.
 */
export interface BoundableActivity {
  readonly kind: string
  readonly summary: string
  readonly payload: unknown
}

export interface BoundToolActivityOptions {
  /** Most bytes the payload takes as JSON; {@link TOOL_ACTIVITY_PAYLOAD_BUDGET_BYTES} by default. */
  readonly budgetBytes?: number
  /**
   * Fields the payload gains, after its truncation record, when the payload
   * itself was cut (not when only the summary or the presentation text was
   * shortened). The renderer marks the activities it bounded this way.
   */
  readonly boundedPayloadFields?: Readonly<Record<string, unknown>>
}

/**
 * A thread activity as it is stored and sent: tool activities through
 * `boundToolActivity`, approval requests with their payload bounded by
 * `boundApprovalRequestPayload`. Every other kind passes through untouched;
 * a plan or a diff must never be cut in the middle.
 */
export function boundThreadActivity<T extends BoundableActivity>(
  activity: T
): T {
  if (activity.kind === APPROVAL_REQUESTED_KIND) {
    const stored: unknown = activity.payload
    if (!isRecord(stored)) return activity
    const payload = boundApprovalRequestPayload(stored)
    return payload === stored ? activity : { ...activity, payload }
  }
  return boundToolActivity(activity)
}

/**
 * The tool activity as it is stored and sent: payload bounded, summary and
 * presentation text cut to one inline row. Other activity kinds pass through
 * untouched (`boundThreadActivity` also bounds approval requests).
 */
export function boundToolActivity<T extends BoundableActivity>(
  activity: T,
  options: BoundToolActivityOptions = {}
): T {
  if (!activity.kind.startsWith("tool.")) return activity
  const summary = truncateInlineText(activity.summary)
  const payload: unknown = activity.payload
  if (!isRecord(payload)) {
    return summary === activity.summary ? activity : { ...activity, summary }
  }
  const presentation = boundPresentation(payload.presentation)
  const withPresentation =
    presentation === payload.presentation
      ? payload
      : { ...payload, presentation }
  const bounded = boundToolActivityPayload(
    withPresentation,
    options.budgetBytes
  )
  const marked =
    bounded === withPresentation || !options.boundedPayloadFields
      ? bounded
      : { ...bounded, ...options.boundedPayloadFields }
  if (marked === payload && summary === activity.summary) return activity
  return { ...activity, summary, payload: marked }
}

function boundPresentation(value: unknown): unknown {
  if (!isRecord(value)) return value
  let next: Record<string, unknown> | null = null
  for (const key of ["summary", "detail"] as const) {
    const text = value[key]
    if (typeof text !== "string") continue
    const cut = truncateInlineText(text)
    if (cut === text) continue
    next ??= { ...value }
    next[key] = cut
  }
  return next ?? value
}

/**
 * Finds the largest per-string cap that brings the payload within budget
 * (an even share of what the other values leave), then tightens it while
 * JSON escaping keeps the result over. Null when no cap in range is enough.
 */
function capStringsToFit(
  payload: Record<string, unknown>,
  scope: CapScope,
  totalBytes: number,
  budget: number,
  protectedKeys: ReadonlySet<string>
): { value: Record<string, unknown>; bytes: number; cuts: CutRecord[] } | null {
  const candidates: StringCandidate[] = []
  collectStringCandidates(payload, scope, "none", 0, candidates, protectedKeys)
  if (candidates.length === 0) return null
  let cap = initialCap(candidates, totalBytes, budget)
  let best: {
    value: Record<string, unknown>
    bytes: number
    cuts: CutRecord[]
  } | null = null
  for (let attempt = 0; attempt < MAX_CAP_ATTEMPTS; attempt += 1) {
    const cuts: CutRecord[] = []
    const value = capStrings(
      payload,
      cap,
      scope,
      [],
      "none",
      0,
      cuts,
      protectedKeys
    ) as Record<string, unknown>
    const bytes = jsonBytes(value) ?? totalBytes
    best = { value, bytes, cuts }
    if (bytes <= budget || cap <= MIN_STRING_CAP_BYTES) break
    cap = Math.max(MIN_STRING_CAP_BYTES, Math.floor(cap * 0.75))
  }
  return best && best.cuts.length > 0 ? best : null
}

/** Water-filling: the cap at which the cut strings share what is left. */
function initialCap(
  candidates: ReadonlyArray<StringCandidate>,
  totalBytes: number,
  budget: number
): number {
  const candidateBytes = candidates.reduce(
    (sum, item) => sum + item.jsonBytes,
    0
  )
  const markerBytes =
    utf8ByteLength(truncationMarker(totalBytes, budget, budget)) +
    MARKER_SIZE_LABEL_SLACK_BYTES
  let available =
    budget - (totalBytes - candidateBytes) - candidates.length * markerBytes
  const sizes = candidates.map((item) => item.jsonBytes).sort((a, b) => a - b)
  for (let index = 0; index < sizes.length; index += 1) {
    const size = sizes[index] ?? 0
    const share = available / (sizes.length - index)
    if (size > share) {
      return Math.max(MIN_STRING_CAP_BYTES, Math.floor(share + markerBytes))
    }
    available -= size
  }
  return Math.max(MIN_STRING_CAP_BYTES, budget)
}

function collectStringCandidates(
  value: unknown,
  scope: CapScope,
  region: Region,
  depth: number,
  out: StringCandidate[],
  protectedKeys: ReadonlySet<string>
): void {
  if (typeof value === "string") {
    if (scope === "output" && region !== "output") return
    if (value.length * 3 <= MIN_STRING_CAP_BYTES) return
    const bytes = jsonBytes(value) ?? 0
    if (bytes > MIN_STRING_CAP_BYTES) out.push({ jsonBytes: bytes })
    return
  }
  if (depth >= MAX_WALK_DEPTH || value === null || typeof value !== "object") {
    return
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (
        entry !== null &&
        (typeof entry === "object" || typeof entry === "string")
      ) {
        collectStringCandidates(
          entry,
          scope,
          region,
          depth + 1,
          out,
          protectedKeys
        )
      }
    }
    return
  }
  for (const [key, entry] of Object.entries(value)) {
    if (protectedKeys.has(key)) continue
    collectStringCandidates(
      entry,
      scope,
      regionBelow(region, key),
      depth + 1,
      out,
      protectedKeys
    )
  }
}

/** Copies only the containers on the path to a cut value. */
function capStrings(
  value: unknown,
  cap: number,
  scope: CapScope,
  path: Array<string | number>,
  region: Region,
  depth: number,
  cuts: CutRecord[],
  protectedKeys: ReadonlySet<string>
): unknown {
  if (typeof value === "string") {
    if (scope === "output" && region !== "output") return value
    const result = truncateTextMiddle(value, cap, labelFor(region))
    if (!result.truncated) return value
    cuts.push({
      path: formatPath(path),
      originalBytes: result.originalBytes,
      region,
    })
    return result.text
  }
  if (depth >= MAX_WALK_DEPTH || value === null || typeof value !== "object") {
    return value
  }
  if (Array.isArray(value)) {
    let next: unknown[] | null = null
    for (let index = 0; index < value.length; index += 1) {
      const entry: unknown = value[index]
      if (
        entry === null ||
        (typeof entry !== "object" && typeof entry !== "string")
      ) {
        continue
      }
      path.push(index)
      const capped = capStrings(
        entry,
        cap,
        scope,
        path,
        region,
        depth + 1,
        cuts,
        protectedKeys
      )
      path.pop()
      if (capped !== entry) {
        next ??= [...value]
        next[index] = capped
      }
    }
    return next ?? value
  }
  let next: Record<string, unknown> | null = null
  for (const [key, entry] of Object.entries(value)) {
    if (protectedKeys.has(key)) continue
    path.push(key)
    const capped = capStrings(
      entry,
      cap,
      scope,
      path,
      regionBelow(region, key),
      depth + 1,
      cuts,
      protectedKeys
    )
    path.pop()
    if (capped !== entry) {
      next ??= { ...(value as Record<string, unknown>) }
      next[key] = capped
    }
  }
  return next ?? value
}

/**
 * Last resort for values that are large without one large string: replace
 * the biggest one (descending while a single child holds most of it) by a
 * cut copy of its JSON, until the payload fits or nothing is left to cut.
 */
function cutLargestValues(
  payload: Record<string, unknown>,
  bytes: number,
  budget: number,
  cuts: CutRecord[],
  protectedKeys: ReadonlySet<string>,
  keepProtectedWhole: boolean
): { value: Record<string, unknown>; bytes: number; cuts: CutRecord[] } {
  let value = payload
  let total = bytes
  const allCuts = [...cuts]
  for (
    let round = 0;
    round < MAX_STRUCTURAL_CUTS && total > budget;
    round += 1
  ) {
    const target = largestCuttableValue(
      value,
      protectedKeys,
      keepProtectedWhole
    )
    if (!target) break
    const label = labelFor(target.region)
    const json = jsonOf(target.value)
    if (json === undefined) break
    const targetBytes = utf8ByteLength(json)
    // What the replacement may take as a JSON string literal; escaping makes
    // the literal longer than the text, so measure it and tighten.
    const room = budget - (total - targetBytes)
    let limit = Math.max(MIN_STRING_CAP_BYTES, room - 2)
    let cut = truncateTextMiddle(json, limit, label)
    for (let attempt = 0; attempt < 4 && cut.truncated; attempt += 1) {
      const literalBytes = jsonBytes(cut.text) ?? Number.POSITIVE_INFINITY
      if (literalBytes <= room || limit <= MIN_STRING_CAP_BYTES) break
      limit = Math.max(
        MIN_STRING_CAP_BYTES,
        Math.floor((limit * room) / literalBytes) - 16
      )
      cut = truncateTextMiddle(json, limit, label)
    }
    if (!cut.truncated) break
    value = setAtPath(value, target.path, cut.text) as Record<string, unknown>
    allCuts.push({
      path: formatPath(target.path),
      originalBytes: cut.originalBytes,
      region: target.region,
    })
    total = jsonBytes(value) ?? total
  }
  return { value, bytes: total, cuts: allCuts }
}

/**
 * The value the structural pass replaces next. With `keepProtectedWhole`
 * (approval requests) a record that directly holds a protected key is never
 * replaced as a whole, since that would cut the protected value with it: the
 * walk goes on into its largest other child, and gives up when it has none.
 */
function largestCuttableValue(
  root: Record<string, unknown>,
  protectedKeys: ReadonlySet<string>,
  keepProtectedWhole: boolean
): { path: Array<string | number>; value: unknown; region: Region } | null {
  let best: { key: string; value: unknown; bytes: number } | null = null
  for (const [key, entry] of Object.entries(root)) {
    if (protectedKeys.has(key) || entry === null || typeof entry !== "object") {
      continue
    }
    const bytes = jsonBytes(entry) ?? 0
    if (!best || bytes > best.bytes) best = { key, value: entry, bytes }
  }
  if (!best || best.bytes <= MIN_STRING_CAP_BYTES) return null
  const path: Array<string | number> = [best.key]
  let region = regionBelow("none", best.key)
  let current = best.value
  let currentBytes = best.bytes
  for (let depth = 0; depth < MAX_WALK_DEPTH; depth += 1) {
    const children: Array<[string | number, unknown]> = Array.isArray(current)
      ? current.map((entry, index): [number, unknown] => [index, entry])
      : isRecord(current)
        ? Object.entries(current).filter(([key]) => !protectedKeys.has(key))
        : []
    const mustDescend =
      keepProtectedWhole &&
      isRecord(current) &&
      Object.keys(current).some((key) => protectedKeys.has(key))
    let dominant: {
      key: string | number
      value: unknown
      bytes: number
    } | null = null
    for (const [key, entry] of children) {
      if (entry === null || typeof entry !== "object") continue
      const bytes = jsonBytes(entry) ?? 0
      const qualifies = mustDescend
        ? bytes > MIN_STRING_CAP_BYTES
        : bytes * 2 > currentBytes
      if (qualifies && (!dominant || bytes > dominant.bytes)) {
        dominant = { key, value: entry, bytes }
      }
    }
    if (!dominant) {
      if (mustDescend) return null
      break
    }
    path.push(dominant.key)
    if (typeof dominant.key === "string") {
      region = regionBelow(region, dominant.key)
    }
    current = dominant.value
    currentBytes = dominant.bytes
  }
  return { path, value: current, region }
}

function labelFor(region: Region): TruncationLabel {
  return region === "input" ? "input" : "output"
}

function setAtPath(
  root: unknown,
  path: ReadonlyArray<string | number>,
  replacement: unknown
): unknown {
  if (path.length === 0) return replacement
  const [head, ...rest] = path
  if (Array.isArray(root) && typeof head === "number") {
    const next = [...root]
    next[head] = setAtPath(root[head], rest, replacement)
    return next
  }
  if (isRecord(root) && typeof head === "string") {
    return { ...root, [head]: setAtPath(root[head], rest, replacement) }
  }
  return root
}

function formatPath(path: ReadonlyArray<string | number>): string {
  return path
    .map((segment, index) =>
      typeof segment === "number"
        ? `[${segment}]`
        : index === 0
          ? segment
          : `.${segment}`
    )
    .join("")
}

function jsonOf(value: unknown): string | undefined {
  try {
    return JSON.stringify(value)
  } catch {
    return undefined
  }
}

function jsonBytes(value: unknown): number | undefined {
  const json = jsonOf(value)
  return json === undefined ? undefined : utf8ByteLength(json)
}
