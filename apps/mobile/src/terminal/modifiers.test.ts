import { describe, expect, it } from "vitest"
import { withModifiers } from "./modifiers"

const none = { ctrl: false, alt: false }
const ctrl = { ctrl: true, alt: false }
const alt = { ctrl: false, alt: true }

describe("Ctrl and Alt from the key bar", () => {
  it("leave input alone when not held", () => {
    expect(withModifiers("ls -la\r", none)).toBe("ls -la\r")
  })

  it("turn Ctrl with a letter into its control character", () => {
    expect(withModifiers("c", ctrl)).toBe("\u0003")
    expect(withModifiers("C", ctrl)).toBe("\u0003")
    expect(withModifiers("d", ctrl)).toBe("\u0004")
    expect(withModifiers("[", ctrl)).toBe("\u001b")
    expect(withModifiers(" ", ctrl)).toBe("\u0000")
    expect(withModifiers("?", ctrl)).toBe("\u007f")
    // Nothing a control character stands for: as typed.
    expect(withModifiers("1", ctrl)).toBe("1")
  })

  it("put Esc before the key with Alt, and hold Ctrl to one character", () => {
    expect(withModifiers("b", alt)).toBe("\u001bb")
    expect(withModifiers("x", { ctrl: true, alt: true })).toBe("\u001b\u0018")
    expect(withModifiers("pasted", ctrl)).toBe("pasted")
    expect(withModifiers("\u001b[A", alt)).toBe("\u001b\u001b[A")
  })
})
