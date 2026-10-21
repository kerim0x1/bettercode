import { afterEach, describe, expect, it, vi } from "vitest"
import { onSystemResume } from "./system-resume"

describe("onSystemResume", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("is a no-op outside the desktop shell", () => {
    vi.stubGlobal("window", {})
    const listener = vi.fn()
    const unsubscribe = onSystemResume(listener)
    expect(() => unsubscribe()).not.toThrow()
    expect(listener).not.toHaveBeenCalled()
  })

  it("forwards the shell's resume event and contains a failing listener", () => {
    let emit: (() => void) | undefined
    const off = vi.fn()
    vi.stubGlobal("window", {
      electronAPI: {
        onSystemResume: (callback: () => void) => {
          emit = callback
          return off
        },
      },
    })
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const listener = vi.fn(() => {
      throw new Error("boom")
    })

    const unsubscribe = onSystemResume(listener)
    expect(() => emit?.()).not.toThrow()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalled()

    unsubscribe()
    expect(off).toHaveBeenCalledTimes(1)
  })
})
