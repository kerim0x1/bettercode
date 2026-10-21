import { describe, expect, it } from "vitest"
import type { ThreadActivity } from "@betterc0de/schema"
import { buildActivityTools } from "@betterc0de/schema/activity-tools"
import { withActivityOutputBounds } from "./tool-full-output"
import { OUTPUT_BOUNDED_IN_RENDERER } from "./tool-output-bounds"

function activity(
  kind: string,
  sequence: number,
  payload: Record<string, unknown>,
  id = `thread-1::${kind}::${String(payload.toolId ?? sequence)}`
): ThreadActivity {
  return {
    id,
    threadId: "thread-1",
    turnId: "turn-1",
    kind,
    tone: "tool",
    summary: kind,
    payload,
    sequence,
    createdAt: `2026-10-07T00:00:0${sequence}.000Z`,
  }
}

const boundedOutput = `HEAD\n… [output truncated: 2 MiB total, showing the first 30 KiB and the last 30 KiB] …\nTAIL`

describe("withActivityOutputBounds", () => {
  it("adds the stored size and the read-back reference of a bounded output", () => {
    const activities = [
      activity("tool.started", 1, {
        toolId: "tool-1",
        toolName: "exec_command",
        input: { command: "cat big.log" },
      }),
      activity("tool.completed", 2, {
        toolId: "tool-1",
        toolName: "exec_command",
        output: boundedOutput,
        outputTruncated: true,
        outputBytes: 2 * 1024 * 1024,
        truncatedFields: ["output"],
      }),
    ]

    const [tool] = withActivityOutputBounds(
      buildActivityTools(activities),
      activities
    )

    expect(tool).toMatchObject({
      id: "tool-1",
      outputBounded: true,
      outputTruncated: true,
      // The size of the whole output, not of the cut copy the text holds.
      outputBytes: 2 * 1024 * 1024,
      fullOutput: {
        threadId: "thread-1",
        activityId: "thread-1::tool.completed::tool-1",
      },
    })
  })

  it("leaves a complete output alone", () => {
    const activities = [
      activity("tool.started", 1, { toolId: "tool-2", toolName: "Read" }),
      activity("tool.completed", 2, { toolId: "tool-2", output: "short" }),
    ]
    const tools = buildActivityTools(activities)

    const [tool] = withActivityOutputBounds(tools, activities)

    expect(tool).toBe(tools[0])
    expect(tool?.outputBounded).toBeUndefined()
    expect(tool?.fullOutput).toBeUndefined()
  })

  it("offers no read-back for an output the renderer bounded itself", () => {
    const activities = [
      activity("tool.completed", 1, {
        toolId: "plugin-tool",
        output: boundedOutput,
        outputTruncated: true,
        outputBytes: 4_000_000,
        [OUTPUT_BOUNDED_IN_RENDERER]: true,
      }),
    ]

    const [tool] = withActivityOutputBounds(
      buildActivityTools(activities),
      activities
    )

    expect(tool?.outputBounded).toBe(true)
    expect(tool?.outputBytes).toBe(4_000_000)
    expect(tool?.fullOutput).toBeUndefined()
  })

  it("uses the latest completion of a tool and ignores bounded deltas", () => {
    const activities = [
      activity(
        "tool.updated",
        1,
        {
          toolId: "tool-3",
          output_delta: boundedOutput,
          outputTruncated: true,
          outputBytes: 9_999,
        },
        "thread-1::tool.updated::tool-3::1"
      ),
      activity(
        "tool.failed",
        2,
        { toolId: "tool-3", error: "exit 1", output: "short failure" },
        "thread-1::tool.failed::tool-3"
      ),
    ]

    const [tool] = withActivityOutputBounds(
      buildActivityTools(activities),
      activities
    )

    expect(tool?.outputBounded).toBeUndefined()
    expect(tool?.fullOutput).toBeUndefined()
  })

  it("ignores a truncation flag without the output it describes", () => {
    const activities = [
      activity("tool.completed", 1, {
        toolId: "tool-4",
        detail: boundedOutput,
        outputTruncated: true,
        outputBytes: 1_000_000,
      }),
    ]

    const [tool] = withActivityOutputBounds(
      buildActivityTools(activities),
      activities
    )

    expect(tool?.fullOutput).toBeUndefined()
  })
})
