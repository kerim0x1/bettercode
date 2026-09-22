import { describe, expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import {
  createCanvasObject,
  type CanvasObject,
  type CanvasObjectKind,
} from "@/lib/canvas-objects"
import { CanvasObjectCard } from "./canvas-object-card"

function render(object: CanvasObject, selected = false, editing = false) {
  return renderToStaticMarkup(
    <CanvasObjectCard
      object={object}
      selected={selected}
      editing={editing}
      panActive={false}
      zoom={1}
      onSelect={vi.fn()}
      onEdit={vi.fn()}
      onChange={vi.fn()}
      onMoveStart={vi.fn()}
    />
  )
}

const at = { x: 0, y: 0 }

describe("CanvasObjectCard", () => {
  it("tags every kind so the board can find it again", () => {
    const kinds: CanvasObjectKind[] = [
      "text",
      "shape",
      "image",
      "embed",
      "frame",
      "task",
    ]
    for (const kind of kinds) {
      const html = render(
        createCanvasObject(kind, at, kind === "image" ? { src: "x.png" } : {})
      )
      expect(html).toContain(`data-object-kind="${kind}"`)
    }
  })

  it("keeps a text field inert until the board says it is being edited", () => {
    const text = createCanvasObject("text", at)
    expect(render(text)).toContain("pointer-events:none")
    expect(render(text, true, true)).toContain("pointer-events:auto")
  })

  it("applies the stored typography to a text object", () => {
    const html = render(
      createCanvasObject("text", at, {
        text: "Ingame user",
        size: "xl",
        bold: true,
        italic: true,
        mono: true,
        align: "center",
        color: "rose",
      } as Partial<CanvasObject>)
    )
    expect(html).toContain("Ingame user")
    for (const cls of [
      "text-[32px]",
      "font-semibold",
      "italic",
      "font-mono",
      "text-center",
      "text-rose-300",
    ])
      expect(html).toContain(cls)
  })

  it("clips a diamond instead of rounding it", () => {
    const html = render(
      createCanvasObject("shape", at, {
        shape: "diamond",
      } as Partial<CanvasObject>)
    )
    expect(html).toContain("clip-path")
    expect(html).not.toContain("rounded-2xl")
  })

  it("shows a remote picture straight from its address", () => {
    const html = render(
      createCanvasObject("image", at, {
        src: "https://a.dev/logo.png",
        alt: "logo",
      } as Partial<CanvasObject>)
    )
    expect(html).toContain('src="https://a.dev/logo.png"')
    expect(html).toContain('alt="logo"')
  })

  it("says so when a picture has neither bytes nor an address", () => {
    // The reader drops such an object, but a live one can still lose its blob.
    const html = render({
      id: "a",
      kind: "image",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      alt: "",
    })
    expect(html).toContain("Picture unavailable")
  })

  it("asks for a link before it will embed anything", () => {
    const html = render(createCanvasObject("embed", at))
    expect(html).toContain("Paste a link to embed the page.")
    expect(html).not.toContain("<iframe")
  })

  it("captions a local embed with its file, not a URL", () => {
    const html = render(
      createCanvasObject("embed", at, {
        source: "local",
        projectPath: "C:/repo",
        relativePath: "dist/index.html",
        title: "index.html",
      } as Partial<CanvasObject>)
    )
    expect(html).toContain("index.html")
  })

  it("lays a task card out the way the board shows one", () => {
    const html = render(
      createCanvasObject("task", at, {
        breadcrumb: "Arbeitsraum / Learning / List",
        title: "React 2 Guide",
        status: "IN PROGRESS",
        assignee: "Sam",
        flagged: true,
      } as Partial<CanvasObject>)
    )
    expect(html).toContain("Arbeitsraum / Learning / List")
    expect(html).toContain("React 2 Guide")
    expect(html).toContain("IN PROGRESS")
    expect(html).toContain('aria-label="Clear flag"')
    // The avatar carries the assignee's initial.
    expect(html).toContain(">S<")
  })

  it("only rings the object that is selected", () => {
    expect(render(createCanvasObject("frame", at))).not.toContain(
      "ring-primary"
    )
    expect(render(createCanvasObject("frame", at), true)).toContain(
      "ring-primary"
    )
  })
})
