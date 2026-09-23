import { describe, expect, it } from "vitest"
import {
  createCanvasObject,
  hasText,
  moveObject,
  objectRect,
  OBJECT_SIZES,
  readCanvasObjects,
  referencedAssets,
  resizeObject,
  type CanvasObject,
} from "@/lib/canvas-objects"

const at = { x: 10.4, y: -20.6 }

describe("createCanvasObject", () => {
  it("rounds the corner onto whole pixels and takes the kind's size", () => {
    const text = createCanvasObject("text", at)
    expect(text).toMatchObject({
      kind: "text",
      x: 10,
      y: -21,
      width: OBJECT_SIZES.text.width,
      height: OBJECT_SIZES.text.height,
    })
  })

  it("centres the words inside a shape but leaves text left aligned", () => {
    expect(createCanvasObject("shape", at)).toMatchObject({ align: "center" })
    expect(createCanvasObject("text", at)).toMatchObject({ align: "left" })
  })

  it("takes a patch without letting it change the kind or the id", () => {
    const made = createCanvasObject("image", at, {
      src: "https://a.dev/x.png",
      kind: "text",
      id: "forced",
    } as Partial<CanvasObject>)
    expect(made.kind).toBe("image")
    expect(made.id).not.toBe("forced")
    expect(made).toMatchObject({ src: "https://a.dev/x.png" })
  })

  it("clamps a patched size into the kind's range", () => {
    expect(
      createCanvasObject("image", at, { width: 5, height: 99999 })
    ).toMatchObject({ width: OBJECT_SIZES.image.minWidth, height: 4000 })
  })
})

describe("moveObject and resizeObject", () => {
  it("moves to whole pixels", () => {
    expect(
      moveObject(createCanvasObject("text", at), { x: 3.6, y: 4.2 })
    ).toMatchObject({ x: 4, y: 4 })
  })

  it("keeps a resize inside the kind's range", () => {
    const frame = createCanvasObject("frame", at)
    expect(resizeObject(frame, { width: 10, height: 10 })).toMatchObject({
      width: OBJECT_SIZES.frame.minWidth,
      height: OBJECT_SIZES.frame.minHeight,
    })
  })

  it("reports the rectangle the board lays out with", () => {
    const shape = createCanvasObject("shape", { x: 1, y: 2 })
    expect(objectRect(shape)).toEqual({
      x: 1,
      y: 2,
      width: OBJECT_SIZES.shape.width,
      height: OBJECT_SIZES.shape.height,
    })
  })
})

describe("hasText", () => {
  it("is true only where the format bar has something to style", () => {
    expect(hasText(createCanvasObject("text", at))).toBe(true)
    expect(hasText(createCanvasObject("shape", at))).toBe(true)
    expect(hasText(createCanvasObject("frame", at))).toBe(false)
  })
})

describe("readCanvasObjects", () => {
  it("returns nothing for absent or unparseable storage", () => {
    expect(readCanvasObjects(null)).toEqual([])
    expect(readCanvasObjects("nope")).toEqual([])
    expect(readCanvasObjects('{"not":"an array"}')).toEqual([])
  })

  it("drops entries without an id or with an unknown kind", () => {
    expect(
      readCanvasObjects(
        JSON.stringify([{ kind: "text" }, { id: "a", kind: "hologram" }, null])
      )
    ).toEqual([])
  })

  it("fills in the defaults of a bare entry", () => {
    const [text] = readCanvasObjects(
      JSON.stringify([{ id: "a", kind: "text" }])
    )
    expect(text).toMatchObject({
      id: "a",
      x: 0,
      y: 0,
      text: "",
      size: "m",
      bold: false,
      align: "left",
      color: "default",
    })
  })

  it("replaces styles it does not know with the defaults", () => {
    const [shape] = readCanvasObjects(
      JSON.stringify([
        {
          id: "a",
          kind: "shape",
          size: "gigantic",
          align: "justify",
          fill: "neon",
        },
      ])
    )
    expect(shape).toMatchObject({ size: "m", align: "left", fill: "default" })
  })

  it("keeps a picture only when it has bytes or an address", () => {
    const restored = readCanvasObjects(
      JSON.stringify([
        { id: "a", kind: "image" },
        { id: "b", kind: "image", assetId: "asset-1" },
        { id: "c", kind: "image", src: "https://a.dev/x.png", ratio: 1.5 },
      ])
    )
    expect(restored.map((one) => one.id)).toEqual(["b", "c"])
    expect(restored[1]).toMatchObject({ ratio: 1.5 })
  })

  it("keeps an embed only when it can be reopened", () => {
    const restored = readCanvasObjects(
      JSON.stringify([
        { id: "a", kind: "embed", source: "web" },
        { id: "b", kind: "embed", source: "local" },
        { id: "c", kind: "embed", source: "web", url: "https://a.dev" },
        {
          id: "d",
          kind: "embed",
          source: "local",
          projectPath: "C:/repo",
          relativePath: "a.html",
        },
      ])
    )
    expect(restored.map((one) => one.id)).toEqual(["c", "d"])
  })

  it("clamps a stored size that is out of range", () => {
    const [task] = readCanvasObjects(
      JSON.stringify([{ id: "a", kind: "task", width: 1, height: 99999 }])
    )
    expect(task).toMatchObject({
      width: OBJECT_SIZES.task.minWidth,
      height: 4000,
    })
  })
})

describe("referencedAssets", () => {
  it("lists the stored pictures still on the board", () => {
    const objects = readCanvasObjects(
      JSON.stringify([
        { id: "a", kind: "image", assetId: "keep" },
        { id: "b", kind: "image", src: "https://a.dev/x.png" },
        { id: "c", kind: "text" },
      ])
    )
    expect([...referencedAssets(objects)]).toEqual(["keep"])
  })
})
