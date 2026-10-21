import { describe, expect, it } from "vitest"
import { HttpError, TimeoutError } from "@/lib/errors/types"
import {
  cleanTerminalTitle,
  isGestureRequiredError,
  isRetryableTerminalError,
  isTerminalGoneError,
  isTerminalUnreadableError,
  looksLikeShellPrompt,
  readTerminalSnapshot,
  shellDisplayName,
  takeTerminalInputChunk,
  terminalDisplayName,
  terminalErrorMessage,
  terminalPollDelay,
} from "./terminal-protocol"

describe("readTerminalSnapshot", () => {
  it("collects output after the cursor and skips the service's own notes", () => {
    const update = readTerminalSnapshot(0, {
      status: "running",
      nextCursor: 3,
      events: [
        {
          seq: 1,
          type: "system",
          data: "C:\\Windows\\system32\\cmd.exe",
          at: 1,
        },
        { seq: 2, type: "data", data: "Microsoft Windows\r\n", at: 2 },
        { seq: 3, type: "data", data: "C:\\repo>", at: 3 },
      ],
    })
    expect(update).toEqual({
      output: "Microsoft Windows\r\nC:\\repo>",
      nextCursor: 3,
      skipped: false,
      exit: null,
    })
  })

  it("reports output the backend dropped before it was read", () => {
    const update = readTerminalSnapshot(4, {
      status: "running",
      nextCursor: 12,
      events: [{ seq: 10, type: "data", data: "tail", at: 1 }],
    })
    expect(update.skipped).toBe(true)
    expect(update.nextCursor).toBe(12)
    expect(
      readTerminalSnapshot(0, { status: "running", nextCursor: 0, events: [] })
        .skipped
    ).toBe(false)
  })

  it("ends on the exit event, or on a status that is no longer running", () => {
    expect(
      readTerminalSnapshot(5, {
        status: "exited",
        nextCursor: 7,
        events: [
          { seq: 6, type: "data", data: "bye\r\n", at: 1 },
          { seq: 7, type: "exit", exitCode: 130, at: 2 },
        ],
      }).exit
    ).toEqual({ exitCode: 130 })
    expect(
      readTerminalSnapshot(7, {
        status: "cleanup_failed",
        nextCursor: 7,
        events: [],
      }).exit
    ).toEqual({ exitCode: null })
  })
})

describe("terminalPollDelay", () => {
  it("reads quickly after output and backs off while quiet", () => {
    expect(
      terminalPollDelay({ idleReads: 0, failures: 0, visible: true })
    ).toBe(25)
    expect(
      terminalPollDelay({ idleReads: 1, failures: 0, visible: true })
    ).toBe(50)
    expect(
      terminalPollDelay({ idleReads: 40, failures: 0, visible: true })
    ).toBe(500)
    expect(
      terminalPollDelay({ idleReads: 3, failures: 0, visible: false })
    ).toBe(1_500)
  })

  it("waits longer after each failed read, up to five seconds", () => {
    expect(
      terminalPollDelay({ idleReads: 0, failures: 1, visible: true })
    ).toBe(250)
    expect(
      terminalPollDelay({ idleReads: 0, failures: 3, visible: true })
    ).toBe(1_000)
    expect(
      terminalPollDelay({ idleReads: 0, failures: 30, visible: true })
    ).toBe(5_000)
  })
})

describe("terminal errors", () => {
  const ipc = (message: string) =>
    new Error(
      `Error invoking remote method 'shell:capability': Error: ${message}`
    )

  it("strips Electron's wrapper from main-process errors", () => {
    expect(terminalErrorMessage(ipc("Backend is not ready."))).toBe(
      "Backend is not ready."
    )
    expect(terminalErrorMessage(null)).toBe(
      "The terminal could not be started."
    )
  })

  it("tells a missing click apart from other refusals", () => {
    expect(
      isGestureRequiredError(
        ipc("This command needs a recent click or key press in BetterC0de.")
      )
    ).toBe(true)
    expect(
      isGestureRequiredError(new HttpError("forbidden", 403, "/shell/pty/open"))
    ).toBe(false)
  })

  it("retries rate limits and outages, never a terminal that is gone", () => {
    expect(
      isRetryableTerminalError(ipc("Shell capability request failed (429)."))
    ).toBe(true)
    expect(
      isRetryableTerminalError(new HttpError("busy", 503, "/shell/pty/write"))
    ).toBe(true)
    expect(isRetryableTerminalError(new TimeoutError("slow", 15_000))).toBe(
      true
    )
    expect(isRetryableTerminalError(new TypeError("Failed to fetch"))).toBe(
      true
    )
    const gone = new HttpError(
      "Terminal session not found.",
      404,
      "/shell/pty/write"
    )
    expect(isRetryableTerminalError(gone)).toBe(false)
    expect(isTerminalGoneError(gone)).toBe(true)
    expect(
      isRetryableTerminalError(new HttpError("denied", 403, "/shell/pty/write"))
    ).toBe(false)
  })

  it("stops reading a terminal that is gone or no longer this caller's", () => {
    expect(
      isTerminalUnreadableError(new HttpError("gone", 404, "/shell/pty/read"))
    ).toBe(true)
    expect(
      isTerminalUnreadableError(
        new HttpError("revoked", 403, "/shell/pty/read")
      )
    ).toBe(true)
    expect(
      isTerminalUnreadableError(new HttpError("busy", 503, "/shell/pty/read"))
    ).toBe(false)
    expect(isTerminalUnreadableError(new TypeError("Failed to fetch"))).toBe(
      false
    )
  })
})

describe("terminal input", () => {
  it("cuts writes without splitting a surrogate pair", () => {
    expect(takeTerminalInputChunk("abc", 8)).toBe("abc")
    expect(takeTerminalInputChunk("abcdef", 4)).toBe("abcd")
    // "ab" + 😀 (two code units): a cut after "ab\uD83D" would split it.
    expect(takeTerminalInputChunk("ab\u{1F600}cd", 3)).toBe("ab")
  })
})

describe("terminal names", () => {
  it("recognizes common idle prompts", () => {
    for (const prompt of [
      "PS C:\\repo> ",
      "C:\\repo>",
      "me@box:~/repo$ ",
      "% ",
      "❯ ",
      ">>> ",
      "root# ",
    ]) {
      expect(looksLikeShellPrompt(prompt)).toBe(true)
    }
    for (const busy of [
      "",
      "  VITE v6 ready in 300 ms",
      "  ➜  Local:   http://localhost:5173/",
      "PS C:\\repo> git sta",
    ]) {
      expect(looksLikeShellPrompt(busy)).toBe(false)
    }
  })

  it("names shells and programs the way a tab shows them", () => {
    expect(shellDisplayName("gitbash")).toBe("Git Bash")
    expect(shellDisplayName(undefined)).toBe("Terminal")
    expect(shellDisplayName("nu")).toBe("nu")
    expect(cleanTerminalTitle("C:\\WINDOWS\\system32\\cmd.exe")).toBe("cmd")
    expect(cleanTerminalTitle("/usr/bin/vim")).toBe("vim")
    expect(cleanTerminalTitle("npm run dev\u0007")).toBe("npm run dev")
    expect(terminalDisplayName({ shellKind: "powershell" }, true)).toBe(
      "PowerShell"
    )
    expect(
      terminalDisplayName({ processTitle: "vim", shellKind: "bash" }, true)
    ).toBe("vim")
    expect(terminalDisplayName({ processTitle: "vim" }, false)).toBe("Terminal")
  })
})
