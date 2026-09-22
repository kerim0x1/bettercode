import { describe, expect, it } from "vitest"
import {
  asLocalPath,
  basename,
  canvasDropSpecs,
  classifyCanvasText,
  describeUrl,
  isImageFile,
  isLocalHost,
  preferHttps,
  relativeToProject,
} from "@/lib/canvas-paste"

function file(name: string, type = ""): File {
  return { name, type } as File
}

describe("isImageFile", () => {
  it("trusts the media type first", () => {
    expect(isImageFile({ type: "image/png", name: "clipboard" })).toBe(true)
  })

  it("falls back to the extension when the type is missing", () => {
    expect(isImageFile({ name: "shot.WEBP" })).toBe(true)
    expect(isImageFile({ name: "notes.txt" })).toBe(false)
  })
})

describe("asLocalPath", () => {
  it("reads Windows, UNC and file:// paths", () => {
    expect(asLocalPath("C:\\repo\\index.html")).toBe("C:\\repo\\index.html")
    expect(asLocalPath("\\\\share\\team\\a.html")).toBe(
      "\\\\share\\team\\a.html"
    )
    expect(asLocalPath("file:///C:/repo/a%20b.html")).toBe("C:/repo/a b.html")
    expect(asLocalPath("file:///home/me/a.html")).toBe("/home/me/a.html")
  })

  it("unwraps the quotes Explorer puts around a copied path", () => {
    expect(asLocalPath('"C:\\repo\\a.html"')).toBe("C:\\repo\\a.html")
  })

  it("takes a POSIX path only when it names a file", () => {
    expect(asLocalPath("/srv/site/index.html")).toBe("/srv/site/index.html")
    expect(asLocalPath("/just some prose")).toBeNull()
  })

  it("is not fooled by prose or several lines", () => {
    expect(asLocalPath("just words")).toBeNull()
    expect(asLocalPath("C:\\a.html\nC:\\b.html")).toBeNull()
  })
})

describe("isLocalHost", () => {
  it("knows this machine and the local network", () => {
    for (const host of [
      "localhost",
      "LOCALHOST",
      "127.0.0.1",
      "[::1]",
      "app.localhost",
      "printer.local",
      "192.168.1.20",
      "10.0.0.5",
      "172.20.3.4",
    ])
      expect(isLocalHost(host), host).toBe(true)
  })

  it("does not mistake a public host for a local one", () => {
    for (const host of ["vercel.com", "localhost.evil.com", "172.32.0.1"])
      expect(isLocalHost(host), host).toBe(false)
  })
})

describe("preferHttps", () => {
  it("takes an external address to https", () => {
    expect(preferHttps("http://vercel.com/docs?a=1#x")).toBe(
      "https://vercel.com/docs?a=1#x"
    )
  })

  it("leaves this machine on http, port and all", () => {
    expect(preferHttps("http://localhost:3000/preview")).toBe(
      "http://localhost:3000/preview"
    )
    expect(preferHttps("http://127.0.0.1:5173/")).toBe("http://127.0.0.1:5173/")
    expect(preferHttps("http://192.168.1.20:8080/")).toBe(
      "http://192.168.1.20:8080/"
    )
  })

  it("leaves anything that is already https, or not a url, alone", () => {
    expect(preferHttps("https://vercel.com")).toBe("https://vercel.com")
    expect(preferHttps("not a url")).toBe("not a url")
  })
})

describe("classifyCanvasText", () => {
  it("upgrades a pasted http link on its way to an embed", () => {
    expect(classifyCanvasText("http://vercel.com/docs")).toEqual({
      kind: "embed-web",
      url: "https://vercel.com/docs",
    })
    expect(classifyCanvasText("http://a.dev/logo.png")).toEqual({
      kind: "image-url",
      url: "https://a.dev/logo.png",
    })
  })

  it("keeps a local dev server on http", () => {
    expect(classifyCanvasText("http://localhost:3000")).toEqual({
      kind: "embed-web",
      url: "http://localhost:3000/",
    })
  })

  it("makes a picture out of an image address", () => {
    expect(classifyCanvasText("https://x.dev/a/logo.PNG?v=2")).toEqual({
      kind: "image-url",
      url: "https://x.dev/a/logo.PNG?v=2",
    })
    expect(classifyCanvasText("data:image/png;base64,AAA")).toMatchObject({
      kind: "image-url",
    })
  })

  it("embeds any other page", () => {
    expect(classifyCanvasText("https://vercel.com/docs")).toEqual({
      kind: "embed-web",
      url: "https://vercel.com/docs",
    })
  })

  it("embeds a local html file and flags anything else local", () => {
    expect(classifyCanvasText("C:\\repo\\dist\\index.html")).toEqual({
      kind: "embed-local",
      path: "C:\\repo\\dist\\index.html",
    })
    expect(classifyCanvasText("C:\\repo\\logo.png")).toEqual({
      kind: "local-file",
      path: "C:\\repo\\logo.png",
    })
  })

  it("keeps everything else as words", () => {
    expect(classifyCanvasText("Backend Error Catch")).toEqual({
      kind: "text",
      text: "Backend Error Catch",
    })
    // A bare host is prose until it carries a scheme.
    expect(classifyCanvasText("vercel.com")).toMatchObject({ kind: "text" })
  })

  it("keeps the original spacing of pasted words", () => {
    expect(classifyCanvasText("  two  spaces  ")).toEqual({
      kind: "text",
      text: "  two  spaces  ",
    })
  })
})

describe("canvasDropSpecs", () => {
  it("prefers the bytes when a file and its name both arrive", () => {
    expect(
      canvasDropSpecs({
        files: [file("shot.png", "image/png")],
        text: "shot.png",
      })
    ).toEqual([{ kind: "image-file", file: file("shot.png", "image/png") }])
  })

  it("takes every picture in a multi-file drop", () => {
    const specs = canvasDropSpecs({
      files: [file("a.png", "image/png"), file("b.jpg", "image/jpeg")],
    })
    expect(specs.map((spec) => spec.kind)).toEqual(["image-file", "image-file"])
  })

  it("reads the uri list a dragged link carries", () => {
    expect(
      canvasDropSpecs({
        files: [],
        uriList: "# comment\nhttps://a.dev/x.png\nhttps://a.dev/page",
        text: "ignored while a uri list is present",
      })
    ).toEqual([
      { kind: "image-url", url: "https://a.dev/x.png" },
      { kind: "embed-web", url: "https://a.dev/page" },
    ])
  })

  it("returns nothing for an empty paste", () => {
    expect(canvasDropSpecs({ files: [], text: "   " })).toEqual([])
  })
})

describe("describeUrl and basename", () => {
  it("shortens an address to something readable", () => {
    expect(describeUrl("https://vercel.com/docs/functions")).toBe(
      "vercel.com/functions"
    )
    expect(describeUrl("https://vercel.com/")).toBe("vercel.com")
    expect(describeUrl("not a url")).toBe("not a url")
  })

  it("takes the file name off a path of either slash", () => {
    expect(basename("C:\\repo\\dist\\index.html")).toBe("index.html")
    expect(basename("/srv/site/index.html")).toBe("index.html")
  })
})

describe("relativeToProject", () => {
  it("relativises a file inside the project, whatever the slashes", () => {
    expect(
      relativeToProject("C:\\repo\\site", "C:/repo/site/dist/index.html")
    ).toBe("dist/index.html")
  })

  it("ignores case, because Windows does", () => {
    expect(relativeToProject("C:\\Repo", "c:\\repo\\a.html")).toBe("a.html")
  })

  it("refuses a file outside the project", () => {
    expect(relativeToProject("C:\\repo", "C:\\other\\a.html")).toBeNull()
    expect(relativeToProject("C:\\repo", "C:\\repository\\a.html")).toBeNull()
  })
})
