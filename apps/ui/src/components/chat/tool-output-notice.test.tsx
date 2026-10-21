import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/services/backend/coreApi", () => ({
  loadThreadActivityOutput: vi.fn(),
}))

import { HttpError } from "@/lib/errors/types"
import {
  fullOutputErrorMessage,
  fullOutputText,
  ToolOutputNotice,
  type ToolFullOutputState,
} from "./tool-output-notice"

function render(
  props: Partial<Parameters<typeof ToolOutputNotice>[0]> & {
    fullOutput?: ToolFullOutputState
  }
) {
  return renderToStaticMarkup(
    <ToolOutputNotice
      canLoadFullOutput={false}
      fullOutput={{ status: "idle" }}
      onLoadFullOutput={() => {}}
      {...props}
    />
  )
}

describe("ToolOutputNotice", () => {
  it("renders nothing for a complete output", () => {
    expect(render({})).toBe("")
  })

  it("keeps the preview note for an output that was only shortened for the preview", () => {
    const html = render({ outputTruncated: true, outputBytes: 20_000 })
    expect(html).toContain("Output truncated in chat preview.")
    expect(html).not.toContain("<button")
  })

  it("names the whole output's size and offers it when the backend has it", () => {
    const html = render({
      outputTruncated: true,
      outputBounded: true,
      outputBytes: 2 * 1024 * 1024,
      canLoadFullOutput: true,
    })
    expect(html).toContain(
      "Output truncated: 2 MiB total, the middle is not shown."
    )
    expect(html).toMatch(
      /<button[^>]*type="button"[^>]*>Show full output<\/button>/
    )
  })

  it("offers nothing to load for a step the renderer bounded itself", () => {
    const html = render({ outputBounded: true, outputBytes: 70_000 })
    expect(html).toContain("68.4 KiB total")
    expect(html).not.toContain("<button")
  })

  it("disables the action while loading", () => {
    const html = render({
      outputBounded: true,
      canLoadFullOutput: true,
      fullOutput: { status: "loading" },
    })
    expect(html).toContain("Loading full output…")
    expect(html).toMatch(/<button[^>]*disabled=""/)
    expect(html).toContain('aria-busy="true"')
  })

  it("announces a failure and offers a retry", () => {
    const html = render({
      outputBounded: true,
      canLoadFullOutput: true,
      fullOutput: {
        status: "error",
        message: "The full output of this tool call is no longer retained.",
      },
    })
    expect(html).toContain('role="alert"')
    expect(html).toContain("no longer retained")
    expect(html).toContain(">Try again</button>")
  })

  it("says when the loaded output is complete and when the recording was cut", () => {
    expect(
      render({
        outputBounded: true,
        canLoadFullOutput: true,
        fullOutput: {
          status: "loaded",
          text: "x",
          bytes: 3 * 1024 * 1024,
          truncated: false,
        },
      })
    ).toContain("Showing the full output (3 MiB).")
    expect(
      render({
        outputBounded: true,
        canLoadFullOutput: true,
        fullOutput: {
          status: "loaded",
          text: "x",
          bytes: 1024 * 1024,
          truncated: true,
        },
      })
    ).toContain("The recording was already shortened")
  })
})

describe("fullOutputText", () => {
  it("shows a result's text the way the step derives it", () => {
    expect(fullOutputText("plain log")).toBe("plain log")
    expect(fullOutputText({ stdout: "out\n", stderr: "err" })).toBe("out\nerr")
    expect(fullOutputText({ exit_code: 0 })).toBe('{\n  "exit_code": 0\n}')
    expect(fullOutputText(null)).toBe("")
  })
})

describe("fullOutputErrorMessage", () => {
  it("passes the backend's explanation through and hides transport details", () => {
    expect(
      fullOutputErrorMessage(
        new HttpError(
          "The full output of this tool call is no longer retained.",
          404,
          "/threads/t/activities/a/output",
          { code: "activity_output_not_retained" }
        )
      )
    ).toBe("The full output of this tool call is no longer retained.")
    expect(fullOutputErrorMessage(new TypeError("fetch failed"))).toBe(
      "The full output could not be loaded. Try again in a moment."
    )
  })
})
