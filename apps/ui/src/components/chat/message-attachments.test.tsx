import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import {
  MessageAttachments,
  formatAttachmentSize,
  isPreviewableImage,
} from "./message-attachments"

const png = {
  type: "file",
  url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  mediaType: "image/png",
  filename: "image.png",
}
const pdf = {
  type: "file",
  url: "data:application/pdf;base64,JVBERi0xLjQK",
  mediaType: "application/pdf",
  filename: "spec.pdf",
}

describe("message attachments", () => {
  it("opens images in the preview and other files as links", () => {
    const html = renderToStaticMarkup(
      <MessageAttachments attachments={[png, pdf]} />
    )
    expect(html).toMatch(/<button[^>]*aria-label="Preview image.png"/)
    expect(html).not.toMatch(/<a[^>]*image\/png[^>]*target="_blank"/)
    expect(html).toMatch(
      /<a[^>]*href="data:application\/pdf[^"]*"[^>]*target="_blank"/
    )
    expect(html).toContain("image/png · 70 B")
  })

  it("shows an inert chip while a light page's attachment data loads", () => {
    const omitted = {
      ...png,
      url: "data:image/png;base64,",
      dataOmitted: true as const,
    }
    const html = renderToStaticMarkup(
      <MessageAttachments
        attachments={[omitted, pdf]}
        source={{ threadId: "t", messageId: "m" }}
      />
    )
    // No preview of an empty image, no size, nothing to click yet.
    expect(html).not.toMatch(/aria-label="Preview image.png"/)
    expect(html).not.toContain("<img")
    expect(html).toContain("image/png</span>")
    expect(html).toContain("Loading attachment")
    // The other attachment is untouched.
    expect(html).toMatch(/<a[^>]*href="data:application\/pdf[^"]*"/)
  })

  it("says so when there is no saved message to read the data from", () => {
    const omitted = {
      ...pdf,
      url: "data:application/pdf;base64,",
      dataOmitted: true as const,
    }
    const html = renderToStaticMarkup(
      <MessageAttachments attachments={[omitted]} />
    )
    expect(html).toContain("This attachment is no longer stored.")
    expect(html).not.toContain("<a")
  })

  it("renders nothing for an empty list", () => {
    expect(renderToStaticMarkup(<MessageAttachments attachments={[]} />)).toBe(
      ""
    )
  })

  it("previews every image type and nothing else", () => {
    expect(isPreviewableImage({ mediaType: "image/png" })).toBe(true)
    expect(isPreviewableImage({ mediaType: " IMAGE/webp " })).toBe(true)
    expect(isPreviewableImage({ mediaType: "application/pdf" })).toBe(false)
    expect(isPreviewableImage({})).toBe(false)
  })

  it("reports the decoded size of a data url", () => {
    expect(formatAttachmentSize(png)).toBe("70 B")
    expect(
      formatAttachmentSize({ url: "https://example.com/a.png" })
    ).toBeNull()
  })
})
