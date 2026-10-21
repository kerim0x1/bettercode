import { describe, expect, it } from "vitest"
import {
  LIVE_GUEST_ENTER_MARGIN,
  LIVE_GUEST_EXIT_MARGIN,
  MAX_LIVE_CANVAS_GUESTS,
  canvasObjectGuestId,
  decideCanvasGuests,
  liveGuestIds,
  sameGuestStates,
  touchRecentGuest,
  type CanvasCamera,
  type CanvasGuestCandidate,
} from "./canvas-live-guests"

const camera: CanvasCamera = {
  zoom: 1,
  pan: { x: 0, y: 0 },
  width: 1000,
  height: 800,
}

function guest(
  id: string,
  x: number,
  y = 0,
  extra: Partial<CanvasGuestCandidate> = {}
): CanvasGuestCandidate {
  return { id, rect: { x, y, width: 400, height: 300 }, ...extra }
}

function decide(
  candidates: CanvasGuestCandidate[],
  options: {
    camera?: CanvasCamera | null
    previous?: string[]
    recent?: string[]
    max?: number
  } = {}
) {
  return decideCanvasGuests({
    candidates,
    camera: options.camera === undefined ? camera : options.camera,
    previous: new Set(options.previous ?? []),
    recent: options.recent ?? [],
    max: options.max,
  })
}

describe("live canvas guests", () => {
  it("keeps guests in view live and pauses those far outside it", () => {
    const states = decide([guest("near", 100), guest("far", 5000)])
    expect(states.get("near")).toBe("live")
    expect(states.get("far")).toBe("offscreen")
  })

  it("follows pan and zoom into screen space", () => {
    const panned = { ...camera, pan: { x: -4800, y: 0 } }
    const states = decide([guest("near", 100), guest("far", 5000)], {
      camera: panned,
    })
    expect(states.get("near")).toBe("offscreen")
    expect(states.get("far")).toBe("live")
  })

  it("uses a wider margin to keep a guest than to start one", () => {
    // Just outside the right edge: further than the enter margin, closer
    // than the exit margin.
    const x =
      camera.width + (LIVE_GUEST_ENTER_MARGIN + LIVE_GUEST_EXIT_MARGIN) / 2
    const candidates = [guest("edge", x)]
    expect(decide(candidates).get("edge")).toBe("offscreen")
    expect(decide(candidates, { previous: ["edge"] }).get("edge")).toBe("live")
  })

  it("pauses guests the zoom has shrunk below a readable size, with hysteresis", () => {
    const candidates = [guest("page", 0)]
    // 400px wide at zoom 0.25 is 100 screen px: between keep and start.
    const zoomedOut = { ...camera, zoom: 0.25 }
    expect(decide(candidates, { camera: zoomedOut }).get("page")).toBe("small")
    expect(
      decide(candidates, { camera: zoomedOut, previous: ["page"] }).get("page")
    ).toBe("live")
    expect(
      decide(candidates, {
        camera: { ...camera, zoom: 0.15 },
        previous: ["page"],
      }).get("page")
    ).toBe("small")
  })

  it("never pauses a pinned guest, wherever the camera is", () => {
    const states = decide([guest("inspected", 9000, 9000, { pinned: true })], {
      camera: { ...camera, zoom: 0.1 },
    })
    expect(states.get("inspected")).toBe("live")
  })

  it("caps live guests, preferring pinned, preferred, recent, then already live", () => {
    const candidates = [
      guest("a", 0),
      guest("b", 10),
      guest("c", 20),
      guest("d", 30, 0, { preferred: true }),
      guest("e", 9000, 0, { pinned: true }),
    ]
    const states = decide(candidates, {
      max: 3,
      recent: ["c"],
      previous: ["b"],
    })
    expect(liveGuestIds(states)).toEqual(new Set(["e", "d", "c"]))
    expect(states.get("a")).toBe("capped")
    expect(states.get("b")).toBe("capped")

    // Without recency, the guest that was already live keeps its slot.
    const stable = decide(candidates, { max: 3, previous: ["b"] })
    expect(liveGuestIds(stable)).toEqual(new Set(["e", "d", "b"]))
  })

  it("defaults to the documented cap", () => {
    const many = Array.from({ length: MAX_LIVE_CANVAS_GUESTS + 3 }, (_, i) =>
      guest(`g${i}`, i * 10)
    )
    expect(liveGuestIds(decide(many)).size).toBe(MAX_LIVE_CANVAS_GUESTS)
  })

  it("treats every guest as visible until the viewport is measured", () => {
    const states = decide([guest("far", 50_000)], { camera: null })
    expect(states.get("far")).toBe("live")
    const unmeasured = decide([guest("far", 50_000)], {
      camera: { ...camera, width: 0, height: 0 },
    })
    expect(unmeasured.get("far")).toBe("live")
  })

  it("compares decisions by content and keeps a short recency list", () => {
    const first = decide([guest("a", 0), guest("b", 5000)])
    const second = decide([guest("b", 5000), guest("a", 0)])
    expect(sameGuestStates(first, second)).toBe(true)
    expect(sameGuestStates(first, decide([guest("a", 0)]))).toBe(false)

    expect(touchRecentGuest(["a", "b", "c"], "c")).toEqual(["c", "a", "b"])
    expect(touchRecentGuest(["a", "b"], "z", 2)).toEqual(["z", "a"])
    expect(canvasObjectGuestId("x1")).toBe("object:x1")
  })
})
