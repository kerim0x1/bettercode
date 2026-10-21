import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import { describe, expect, it } from "vitest"
import {
  VISUAL_REPLIES_INSTRUCTIONS,
  buildSystemInstruction,
} from "@betterc0de/schema/system-instruction"
import {
  PREVIEWABLE_FENCE_LANGUAGES,
  VISUAL_REPLY_CSP,
  VISUAL_REPLY_MAX_HEIGHT,
  VISUAL_REPLY_MESSAGE,
  VISUAL_REPLY_MIN_HEIGHT,
  buildVisualReplyDocument,
  clampVisualReplyHeight,
  closedFenceBodies,
  fallbackVisualReplyTheme,
  hashVisualReply,
  isVisualReplyClassName,
  normalizeFenceBody,
  parseVisualReplyFrameMessage,
  readVisualReplyTheme,
  visualReplyFileName,
  visualReplyThemeKey,
  visualReplyTitle,
} from "@/lib/visual-reply"

const hostPage = readFileSync(
  new URL("../../public/visual-reply-frame.html", import.meta.url),
  "utf8"
)

function directives(policy: string): Record<string, string[]> {
  return Object.fromEntries(
    policy
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [name, ...sources] = part.split(/\s+/)
        return [name, sources]
      })
  )
}

function themeSource(values: Record<string, string>) {
  return { getPropertyValue: (property: string) => values[property] ?? "" }
}

describe("the visual reply policy", () => {
  it("allows no network beyond the listed CDNs and no frames or forms", () => {
    const policy = directives(VISUAL_REPLY_CSP)
    expect(policy["default-src"]).toEqual(["'none'"])
    expect(policy["connect-src"]).toEqual(["'none'"])
    expect(policy["frame-src"]).toEqual(["'none'"])
    expect(policy["form-action"]).toEqual(["'none'"])
    expect(policy["script-src"]).toEqual([
      "'unsafe-inline'",
      "https://cdn.jsdelivr.net",
      "https://cdnjs.cloudflare.com",
      "https://unpkg.com",
    ])
    expect(policy["img-src"]).toEqual(["data:", "blob:", "https:"])
    expect(Object.values(policy).flat()).not.toContain("'unsafe-eval'")
  })

  it("is the policy of the host page", () => {
    const meta =
      /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(
        hostPage
      )
    expect(meta?.[1]).toBe(VISUAL_REPLY_CSP)
    expect(hostPage).toContain('<meta name="referrer" content="no-referrer" />')
  })
})

describe("the host page", () => {
  const loader = /<script>([\s\S]*?)<\/script>/.exec(hostPage)?.[1] ?? ""

  interface FakeFrame {
    attributes: Record<string, string>
    style: { height?: string }
    srcdoc: string
    contentWindow: object
  }

  function load(options: { origin: string; framed?: boolean }) {
    const listeners = new Set<(event: unknown) => void>()
    const keyListeners = new Set<(event: { key: string }) => void>()
    const posted: unknown[] = []
    const targets: string[] = []
    const frames: FakeFrame[] = []
    const appended: FakeFrame[] = []
    const pageWindow = {}
    const parent = {
      postMessage: (message: unknown, target: string) => {
        posted.push(message)
        targets.push(target)
      },
    }
    const context: Record<string, unknown> = {
      origin: options.origin,
      addEventListener: (type: string, listener: (event: unknown) => void) => {
        if (type === "message") listeners.add(listener)
      },
      document: {
        createElement: (tag: string) => {
          expect(tag).toBe("iframe")
          const frame = {
            attributes: {} as Record<string, string>,
            style: {},
            srcdoc: "",
            contentWindow: pageWindow,
            setAttribute(name: string, value: string) {
              this.attributes[name] = value
            },
          }
          frames.push(frame)
          return frame
        },
        body: { append: (frame: FakeFrame) => appended.push(frame) },
        addEventListener: (
          type: string,
          listener: (event: { key: string }) => void
        ) => {
          if (type === "keydown") keyListeners.add(listener)
        },
      },
    }
    context.window = context
    context.self = context
    context.parent = options.framed === false ? context : parent
    runInNewContext(loader, context)
    const dispatch = (event: { source: unknown; data: unknown }) => {
      for (const listener of [...listeners]) listener(event)
    }
    const press = (key: string) => {
      for (const listener of [...keyListeners]) listener({ key })
    }
    return {
      parent,
      pageWindow,
      posted,
      targets,
      frames,
      appended,
      listeners,
      dispatch,
      press,
    }
  }

  const render = {
    type: VISUAL_REPLY_MESSAGE.render,
    html: "<p>Hi</p>",
    title: "Chart",
  }

  it("asks its parent for the page only inside an opaque-origin sandbox", () => {
    const sandboxed = load({ origin: "null" })
    expect(sandboxed.posted).toEqual([{ type: VISUAL_REPLY_MESSAGE.ready }])
    expect(sandboxed.targets).toEqual(["*"])
    expect(sandboxed.listeners.size).toBe(1)

    // Framed in the app's own origin, or opened as a page: nothing happens.
    for (const page of [
      load({ origin: "file://" }),
      load({ origin: "https://phone.tailnet.ts.net" }),
      load({ origin: "null", framed: false }),
    ]) {
      expect(page.posted).toEqual([])
      expect(page.listeners.size).toBe(0)
    }
  })

  it("shows the page from its parent once, in a nested sandboxed frame", () => {
    const host = load({ origin: "null" })
    host.dispatch({ source: {}, data: render })
    host.dispatch({ source: host.pageWindow, data: render })
    host.dispatch({ source: host.parent, data: { ...render, type: "other" } })
    host.dispatch({ source: host.parent, data: { ...render, html: 42 } })
    expect(host.frames).toEqual([])

    host.dispatch({ source: host.parent, data: render })
    expect(host.appended).toHaveLength(1)
    const [frame] = host.appended
    expect(frame.attributes).toEqual({
      sandbox: "allow-scripts",
      referrerpolicy: "no-referrer",
      title: "Chart",
    })
    expect(frame.srcdoc).toBe("<p>Hi</p>")

    host.dispatch({ source: host.parent, data: render })
    expect(host.frames).toHaveLength(1)
  })

  it("passes only a valid height and Escape on from its page", () => {
    const host = load({ origin: "null" })
    const height = { type: VISUAL_REPLY_MESSAGE.height, height: 321.4 }
    host.dispatch({ source: host.pageWindow, data: height })
    expect(host.posted).toHaveLength(1)

    host.dispatch({ source: host.parent, data: render })
    host.dispatch({ source: host.pageWindow, data: height })
    expect(host.posted.at(-1)).toEqual({
      type: VISUAL_REPLY_MESSAGE.height,
      height: 322,
    })
    // The page's frame keeps the host page's height and scrolls itself;
    // sizing it from the page's own report would never stop growing.
    expect(host.appended[0].style.height).toBeUndefined()

    host.dispatch({
      source: host.pageWindow,
      data: { type: VISUAL_REPLY_MESSAGE.escape },
    })
    expect(host.posted.at(-1)).toEqual({ type: VISUAL_REPLY_MESSAGE.escape })

    const before = host.posted.length
    for (const data of [
      { type: VISUAL_REPLY_MESSAGE.height, height: Number.NaN },
      { type: VISUAL_REPLY_MESSAGE.height, height: -1 },
      { type: VISUAL_REPLY_MESSAGE.height, height: "5" },
      { type: VISUAL_REPLY_MESSAGE.ready },
      render,
    ]) {
      host.dispatch({ source: host.pageWindow, data })
    }
    host.dispatch({ source: {}, data: height })
    expect(host.posted).toHaveLength(before)
    expect(host.frames).toHaveLength(1)

    // Escape while focus is on the host page itself.
    host.press("a")
    expect(host.posted).toHaveLength(before)
    host.press("Escape")
    expect(host.posted.at(-1)).toEqual({ type: VISUAL_REPLY_MESSAGE.escape })
  })

  it("refuses a page over its size limit", () => {
    const host = load({ origin: "null" })
    host.dispatch({
      source: host.parent,
      data: { ...render, html: "x".repeat(2_000_001) },
    })
    expect(host.frames).toEqual([])
  })
})

describe("buildVisualReplyDocument", () => {
  const theme = fallbackVisualReplyTheme("dark")

  it("puts the doctype and the policy before the page", () => {
    const html = buildVisualReplyDocument(
      '<!DOCTYPE html>\n<html lang="de"><body><p>Chart</p></body></html>',
      theme
    )
    expect(html.startsWith("<!DOCTYPE html>\n<meta http-equiv=")).toBe(true)
    expect(html).toContain(`content="${VISUAL_REPLY_CSP}"`)
    expect(html.match(/<!doctype/gi)).toHaveLength(1)
    expect(html.indexOf("Content-Security-Policy")).toBeLessThan(
      html.indexOf("<style>")
    )
    expect(html.indexOf("</script>")).toBeLessThan(
      html.indexOf('<html lang="de">')
    )
    expect(
      html.endsWith('<html lang="de"><body><p>Chart</p></body></html>')
    ).toBe(true)
  })

  it("gives the page the theme variables and color scheme", () => {
    const html = buildVisualReplyDocument("<p>x</p>", theme)
    expect(html).toContain("color-scheme:dark")
    expect(html).toContain(`--bc-bg:${theme.background}`)
    expect(html).toContain(`--bc-accent:${theme.accent}`)
    expect(html).toContain("--bc-font:")
    const light = buildVisualReplyDocument(
      "<p>x</p>",
      fallbackVisualReplyTheme("light")
    )
    expect(light).toContain("color-scheme:light")
  })

  it("reports the height and Escape with the message types the chat reads", () => {
    const html = buildVisualReplyDocument("<p>x</p>", theme)
    expect(html).toContain(VISUAL_REPLY_MESSAGE.height)
    expect(html).toContain(VISUAL_REPLY_MESSAGE.escape)
    // The runtime script is closed exactly once, before the page.
    expect(html.match(/<\/script>/g)).toHaveLength(1)
  })
})

describe("readVisualReplyTheme", () => {
  it("maps the app's tokens to the page's variables", () => {
    const theme = readVisualReplyTheme(
      themeSource({
        "--background": " #1e1e1e ",
        "--card": "#252526",
        "--foreground": "oklch(0.985 0 0)",
        "--muted": "rgb(40, 40, 40)",
        "--muted-foreground": "#999",
        "--border": "oklch(1 0 0 / 10%)",
        "--primary": "#0078d4",
        "--primary-foreground": "#fff",
        "--font-sans": '"Figtree Variable", sans-serif',
        "--font-mono": "'JetBrains Mono'",
        "--radius": "0.5rem",
      }),
      "dark"
    )
    expect(theme).toMatchObject({
      mode: "dark",
      background: "#1e1e1e",
      surface: "#252526",
      muted: "rgb(40, 40, 40)",
      border: "oklch(1 0 0 / 10%)",
      accent: "#0078d4",
      accentForeground: "#fff",
      radius: "0.5rem",
    })
    expect(theme.font).toBe(
      '"Figtree Variable", sans-serif, system-ui, sans-serif'
    )
    expect(theme.mono.startsWith("'JetBrains Mono', ui-monospace")).toBe(true)
  })

  it("falls back for values that could break out of the stylesheet", () => {
    const fallback = fallbackVisualReplyTheme("light")
    const theme = readVisualReplyTheme(
      themeSource({
        "--background": "red;}</style><script>alert(1)</script>",
        "--foreground": "url(https://attacker.example/x)",
        "--font-sans": '"Unclosed, sans-serif',
        "--font-mono": "a{b}",
        "--radius": "calc(1px + 1px)",
      }),
      "light"
    )
    expect(theme.background).toBe(fallback.background)
    expect(theme.foreground).toBe(fallback.foreground)
    expect(theme.font).toBe(fallback.font)
    expect(theme.mono).toBe(fallback.mono)
    expect(theme.radius).toBe(fallback.radius)
    expect(theme.surface).toBe(fallback.surface)
  })

  it("keys equal themes equally", () => {
    const a = fallbackVisualReplyTheme("dark")
    expect(visualReplyThemeKey(a)).toBe(
      visualReplyThemeKey(fallbackVisualReplyTheme("dark"))
    )
    expect(visualReplyThemeKey(a)).not.toBe(
      visualReplyThemeKey(fallbackVisualReplyTheme("light"))
    )
  })
})

describe("frame messages and height", () => {
  it("accepts only well-formed messages from an opaque origin", () => {
    expect(
      parseVisualReplyFrameMessage("null", {
        type: VISUAL_REPLY_MESSAGE.height,
        height: 320,
      })
    ).toEqual({ type: "height", height: 320 })
    expect(
      parseVisualReplyFrameMessage("null", { type: VISUAL_REPLY_MESSAGE.ready })
    ).toEqual({ type: "ready" })
    expect(
      parseVisualReplyFrameMessage("null", {
        type: VISUAL_REPLY_MESSAGE.escape,
      })
    ).toEqual({ type: "escape" })
    expect(
      parseVisualReplyFrameMessage("file://", {
        type: VISUAL_REPLY_MESSAGE.ready,
      })
    ).toBeNull()
    for (const height of [Number.NaN, Infinity, -1, "320"]) {
      expect(
        parseVisualReplyFrameMessage("null", {
          type: VISUAL_REPLY_MESSAGE.height,
          height,
        })
      ).toBeNull()
    }
    expect(parseVisualReplyFrameMessage("null", "ready")).toBeNull()
    expect(parseVisualReplyFrameMessage("null", null)).toBeNull()
    expect(
      parseVisualReplyFrameMessage("null", {
        type: VISUAL_REPLY_MESSAGE.render,
      })
    ).toBeNull()
  })

  it("clamps the frame between 120 and 900 px", () => {
    expect(clampVisualReplyHeight(0)).toBe(VISUAL_REPLY_MIN_HEIGHT)
    expect(clampVisualReplyHeight(480.2)).toBe(481)
    expect(clampVisualReplyHeight(5000)).toBe(VISUAL_REPLY_MAX_HEIGHT)
    expect(clampVisualReplyHeight(Number.NaN)).toBe(VISUAL_REPLY_MIN_HEIGHT)
  })
})

describe("closedFenceBodies", () => {
  const languages = PREVIEWABLE_FENCE_LANGUAGES

  it("finds closed html-render and html fences, not an open one", () => {
    const markdown = [
      "Here is the chart:",
      "```html-render",
      "<p>Done</p>",
      "```",
      "And the code:",
      "```html",
      "<p>Still writing",
    ].join("\n")
    const bodies = closedFenceBodies(markdown, languages)
    expect([...bodies]).toEqual(["<p>Done</p>"])
    expect(bodies.has(normalizeFenceBody("<p>Done</p>\n"))).toBe(true)
  })

  it("follows CommonMark fence rules for markers, length and info strings", () => {
    const markdown = [
      "~~~~html-render title=x",
      "```",
      "inside",
      "~~~",
      "~~~~~",
      "````html",
      "<b>",
      "```",
      "````",
      "```ts",
      "const html = 1",
      "```",
    ].join("\r\n")
    expect([...closedFenceBodies(markdown, languages)]).toEqual([
      "```\ninside\n~~~",
      "<b>\n```",
    ])
  })

  it("strips a list item's indentation from the body", () => {
    const markdown = [
      "1. A page:",
      "   ```html-render",
      "   <div>",
      "     <p>x</p>",
      "   </div>",
      "   ```",
    ].join("\n")
    expect([...closedFenceBodies(markdown, languages)]).toEqual([
      "<div>\n  <p>x</p>\n</div>",
    ])
  })
})

describe("labels, files and keys", () => {
  it("reads the page title and makes a file name of it", () => {
    const html = "<html><head><title> Revenue &amp; costs, Q3 </title></head>"
    expect(visualReplyTitle(html)).toBe("Revenue & costs, Q3")
    expect(visualReplyFileName(html)).toBe("revenue-costs-q3.html")
    expect(visualReplyTitle("<p>no title</p>")).toBeNull()
    expect(visualReplyFileName("<p>no title</p>")).toBe("visual-reply.html")
    expect(visualReplyFileName("<title>Übersicht</title>")).toBe(
      "ubersicht.html"
    )
  })

  it("recognizes the visual reply fence by its class", () => {
    expect(isVisualReplyClassName("language-html-render")).toBe(true)
    expect(isVisualReplyClassName("hljs language-html-render")).toBe(true)
    expect(isVisualReplyClassName("language-html")).toBe(false)
    expect(isVisualReplyClassName("language-html-renderer")).toBe(false)
    expect(isVisualReplyClassName(undefined)).toBe(false)
  })

  it("hashes deterministically", () => {
    expect(hashVisualReply("<p>a</p>")).toBe(hashVisualReply("<p>a</p>"))
    expect(hashVisualReply("<p>a</p>")).not.toBe(hashVisualReply("<p>b</p>"))
  })
})

describe("agent instructions", () => {
  it("describe visual replies only when the setting is on", () => {
    const on = buildSystemInstruction(
      "agent",
      null,
      "bypass",
      null,
      undefined,
      undefined,
      null,
      undefined,
      null,
      "agent",
      null,
      null,
      { visualReplies: true }
    )
    expect(on).toContain(VISUAL_REPLIES_INSTRUCTIONS)
    expect(buildSystemInstruction("agent", null, "bypass")).not.toContain(
      "html-render"
    )
    for (const source of [
      "cdn.jsdelivr.net",
      "cdnjs.cloudflare.com",
      "unpkg.com",
      "fonts.googleapis.com",
      "fonts.gstatic.com",
    ]) {
      // The instruction promises only what the frame's policy allows.
      expect(VISUAL_REPLIES_INSTRUCTIONS).toContain(source)
      expect(VISUAL_REPLY_CSP).toContain(`https://${source}`)
    }
  })
})
