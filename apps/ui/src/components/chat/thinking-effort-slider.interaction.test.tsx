// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ThinkingEffortSlider } from "./thinking-effort-slider"

// Memory-only DOM: these events never reach a desktop window or input device.
const options = [
  { mode: null, label: "Off" },
  { mode: "Low", label: "Low" },
  { mode: "Medium", label: "Medium" },
  { mode: "High", label: "High" },
  { mode: "xHigh", label: "Extra High" },
  { mode: "max", label: "Max" },
  { mode: "ultracode", label: "Ultracode" },
]

describe("reasoning slider interactions", () => {
  let host: HTMLDivElement
  let root: Root
  const onSelect = vi.fn()

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    )
    const captured = new Set<Element>()
    vi.stubGlobal("PointerEvent", MouseEvent)
    Object.defineProperties(Element.prototype, {
      setPointerCapture: {
        configurable: true,
        value() {
          captured.add(this)
        },
      },
      releasePointerCapture: {
        configurable: true,
        value() {
          captured.delete(this)
        },
      },
      hasPointerCapture: {
        configurable: true,
        value() {
          return captured.has(this)
        },
      },
    })
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 240,
      bottom: 32,
      width: 240,
      height: 32,
      toJSON() {
        return {}
      },
    })
    host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)
    onSelect.mockClear()
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    for (const name of [
      "setPointerCapture",
      "releasePointerCapture",
      "hasPointerCapture",
    ])
      Reflect.deleteProperty(Element.prototype, name)
  })

  function render(
    mode: string | null = "High",
    selectionKey = "thread:claude:opus"
  ) {
    act(() =>
      root.render(
        <ThinkingEffortSlider
          options={options}
          thinkingMode={mode}
          selectionKey={selectionKey}
          onSelect={onSelect}
        />
      )
    )
  }
  function slider() {
    return host.querySelector<HTMLElement>('[role="slider"]')!
  }
  function key(key: string) {
    act(() =>
      slider().dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true })
      )
    )
  }
  function pointer(type: string, clientX: number) {
    act(() =>
      host
        .querySelector('[data-slot="reasoning-slider"]')!
        .dispatchEvent(
          new MouseEvent(type, { bubbles: true, clientX, clientY: 16 })
        )
    )
  }

  it("retains a drag on release while the parent has not yet acknowledged the selection", () => {
    render()
    pointer("pointerdown", 160)
    expect(slider().getAttribute("aria-valuetext")).toBe("Extra High")
    expect(onSelect).not.toHaveBeenCalled()
    pointer("pointerup", 160)
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("xHigh")
    expect(slider().getAttribute("aria-valuetext")).toBe("Extra High")
    // An unrelated render with the old persisted value must not snap back.
    render()
    expect(slider().getAttribute("aria-valuetext")).toBe("Extra High")
    render("xHigh")
    expect(slider().getAttribute("aria-valuetext")).toBe("Extra High")
  })

  it("steps through every level by keyboard and preserves focus on acknowledgement", () => {
    render(null)
    act(() => slider().focus())
    for (const option of options.slice(1)) {
      key("ArrowRight")
      expect(onSelect).toHaveBeenLastCalledWith(option.mode)
      expect(slider().getAttribute("aria-valuetext")).toBe(option.label)
      render(option.mode)
      expect(document.activeElement).toBe(slider())
    }
    key("Home")
    expect(onSelect).toHaveBeenLastCalledWith(null)
    key("End")
    expect(slider().getAttribute("aria-valuetext")).toBe("Ultracode")
  })

  it("discards previews on provider changes and follows later external preferences", () => {
    render()
    pointer("pointerdown", 160)
    render("High", "thread:codex:gpt")
    expect(slider().getAttribute("aria-valuetext")).toBe("High")
    render("Medium", "thread:codex:gpt")
    expect(slider().getAttribute("aria-valuetext")).toBe("Medium")
    render("High")
    expect(slider().getAttribute("aria-valuetext")).toBe("High")
  })

  it("cancels a drag without saving and resets with a stable local preview", () => {
    render("Low")
    pointer("pointerdown", 200)
    pointer("pointercancel", 200)
    expect(slider().getAttribute("aria-valuetext")).toBe("Low")
    expect(onSelect).not.toHaveBeenCalled()
    act(() =>
      host
        .querySelector<HTMLButtonElement>('[aria-label="Reset to High"]')!
        .click()
    )
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("High")
    expect(slider().getAttribute("aria-valuetext")).toBe("High")
  })
})
