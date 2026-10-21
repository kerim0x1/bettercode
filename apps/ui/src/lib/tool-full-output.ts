/**
 * What a tool step's stored activity says about the output it carries.
 *
 * The backend bounds a tool activity's payload (RAM-04,
 * `apps/backend/src/provider/activity-projection/output-bounds.ts`): a large
 * output keeps its head and tail with a marker between them, and the payload
 * records `outputTruncated` and `outputBytes`, the size of the whole output.
 * `GET /threads/:id/activities/:activityId/output` reads the whole output back
 * from the provider journal while the journal still retains the event.
 *
 * `buildActivityTools` (`@betterc0de/schema/activity-tools`) measures the
 * text it is given, which for a bounded output is the cut copy, and keeps no
 * activity id. {@link withActivityOutputBounds} adds both from the activities.
 */
import type { ThreadActivity } from "@betterc0de/schema"
import { compareActivities } from "@betterc0de/schema/activity-tools"
import { isRecord, nonEmptyString } from "@betterc0de/schema/json-read"
import { OUTPUT_BOUNDED_IN_RENDERER } from "./tool-output-bounds"

/** Where the whole output of a bounded tool activity can be read back. */
export interface ToolFullOutputRef {
  readonly threadId: string
  readonly activityId: string
}

/** The output facts a tool step gains from its stored activity. */
export interface ToolOutputBounds {
  /**
   * The output text itself was cut in the middle (head and tail kept, a
   * marker between them), not just shortened for the chat preview.
   */
  outputBounded?: boolean
  /** UTF-8 bytes of the whole output when `outputBounded`. */
  outputBytes?: number
  /**
   * Set when the whole output can be requested from the backend. Absent for
   * an activity the renderer bounded itself (a provider plugin's live step),
   * which has no journal row behind it.
   */
  fullOutput?: ToolFullOutputRef
}

type ToolLike = {
  id: string
  outputBytes?: number
  outputTruncated?: boolean
}

function explicitToolId(payload: Record<string, unknown>): string | undefined {
  return (
    nonEmptyString(payload.toolId) ??
    nonEmptyString(payload.tool_id) ??
    nonEmptyString(payload.id)
  )
}

function boundedOutputBytes(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined
}

/**
 * The tool steps with the output bounds of the activity that supplied their
 * final output: the latest `tool.completed` / `tool.failed` activity for the
 * step's tool id whose payload carries the output itself. A step whose output
 * was not bounded is returned unchanged.
 */
export function withActivityOutputBounds<T extends ToolLike>(
  tools: ReadonlyArray<T>,
  activities: ReadonlyArray<ThreadActivity>
): Array<T & ToolOutputBounds> {
  const completedByToolId = new Map<string, ThreadActivity>()
  for (const activity of [...activities].sort(compareActivities)) {
    if (activity.kind !== "tool.completed" && activity.kind !== "tool.failed") {
      continue
    }
    if (!isRecord(activity.payload)) continue
    const toolId = explicitToolId(activity.payload)
    if (toolId) completedByToolId.set(toolId, activity)
  }
  if (completedByToolId.size === 0) {
    return tools.map((tool) => tool as T & ToolOutputBounds)
  }

  return tools.map((tool): T & ToolOutputBounds => {
    const activity = completedByToolId.get(tool.id)
    const payload =
      activity && isRecord(activity.payload) ? activity.payload : undefined
    if (
      !activity ||
      !payload ||
      payload.outputTruncated !== true ||
      payload.output === undefined ||
      payload.output === null
    ) {
      return tool as T & ToolOutputBounds
    }
    const bytes = boundedOutputBytes(payload.outputBytes)
    const fetchable =
      payload[OUTPUT_BOUNDED_IN_RENDERER] !== true &&
      activity.threadId.length > 0 &&
      activity.id.length > 0
    return {
      ...tool,
      outputTruncated: true,
      outputBounded: true,
      ...(bytes !== undefined ? { outputBytes: bytes } : {}),
      ...(fetchable
        ? {
            fullOutput: {
              threadId: activity.threadId,
              activityId: activity.id,
            },
          }
        : {}),
    }
  })
}
