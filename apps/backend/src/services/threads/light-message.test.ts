import { BROWSER_ELEMENT_ATTACHMENT_TYPE } from "@betterc0de/schema"
import { describe, expect, it } from "vitest"
import {
  hasOmittedPayloads,
  omittedDataUrl,
  restoreOmittedPayloads,
  toLightMessage,
} from "./light-message"

describe("light transcript messages", () => {
  it("drops diff text but keeps the counts the file change cards show", () => {
    const light = toLightMessage({
      id: "m-1",
      diffs: [
        {
          path: "src/a.ts",
          additions: 3,
          deletions: 1,
          oldText: "old",
          newText: "new",
          isNew: false,
        },
        {
          path: "src/empty.ts",
          additions: 0,
          deletions: 0,
          oldText: "",
          newText: "",
          isNew: true,
        },
      ],
    })
    expect(light.diffs).toEqual([
      {
        path: "src/a.ts",
        additions: 3,
        deletions: 1,
        oldText: "",
        newText: "",
        isNew: false,
        textOmitted: true,
      },
      // Nothing to omit, so nothing to fetch later.
      {
        path: "src/empty.ts",
        additions: 0,
        deletions: 0,
        oldText: "",
        newText: "",
        isNew: true,
      },
    ])
  })

  it("replaces large inline data URLs and keeps every other attachment", () => {
    const light = toLightMessage({
      id: "m-1",
      attachments: [
        {
          type: "image",
          filename: "shot.png",
          mediaType: "image/png",
          url: `data:image/png;base64,${"A".repeat(4096)}`,
        },
        {
          type: "file",
          filename: "notes.txt",
          url: `DATA:text/plain;base64,${"B".repeat(4096)}`,
        },
        { type: "file", filename: "tiny.txt", url: "data:text/plain,hi" },
        {
          type: BROWSER_ELEMENT_ATTACHMENT_TYPE,
          url: `data:application/vnd.betterc0de.browser-element+json,${"%7B".repeat(2048)}`,
        },
        {
          type: "image",
          filename: "remote.png",
          mediaType: "image/png",
          url: "https://example.com/remote.png",
        },
      ],
    })
    expect(light.attachments).toEqual([
      {
        type: "image",
        filename: "shot.png",
        mediaType: "image/png",
        url: "data:image/png;base64,",
        dataOmitted: true,
      },
      {
        type: "file",
        filename: "notes.txt",
        url: "data:text/plain;base64,",
        dataOmitted: true,
      },
      // Too small to be worth a round trip.
      { type: "file", filename: "tiny.txt", url: "data:text/plain,hi" },
      // Message text renders its mention chips from this.
      {
        type: BROWSER_ELEMENT_ATTACHMENT_TYPE,
        url: `data:application/vnd.betterc0de.browser-element+json,${"%7B".repeat(2048)}`,
      },
      {
        type: "image",
        filename: "remote.png",
        mediaType: "image/png",
        url: "https://example.com/remote.png",
      },
    ])
  })

  it("returns the same object when there is nothing to omit", () => {
    const message = {
      id: "m-1",
      content: "plain",
      attachments: [{ type: "file", url: "https://example.com/a.txt" }],
    }
    expect(toLightMessage(message)).toBe(message)
  })

  it("falls back to a generic media type for an unlabelled payload", () => {
    expect(omittedDataUrl("data:;base64,AAAA", null)).toBe(
      "data:application/octet-stream;base64,"
    )
    expect(omittedDataUrl("data:image/webp;base64,AAAA", " ")).toBe(
      "data:image/webp;base64,"
    )
    expect(omittedDataUrl("data:x,y", "bad;type")).toBe("data:x;base64,")
  })

  it("restores placeholders from the stored copy, matching by file", () => {
    const stored = {
      diffs: [
        { path: "a.ts", oldText: "a0", newText: "a1" },
        { path: "b.ts", oldText: "b0", newText: "b1" },
      ],
      attachments: [
        { type: "image", filename: "x.png", url: "data:image/png;base64,QQ==" },
      ],
    }
    const incoming = {
      reasoning: "kept",
      diffs: [
        // Reordered: matched by path, not by position.
        { path: "b.ts", oldText: "", newText: "", textOmitted: true },
        { path: "a.ts", oldText: "", newText: "", textOmitted: true },
        { path: "gone.ts", oldText: "", newText: "", textOmitted: true },
      ],
      attachments: [
        {
          type: "image",
          filename: "x.png",
          url: "data:image/png;base64,",
          dataOmitted: true,
        },
      ],
    }
    expect(hasOmittedPayloads(incoming)).toBe(true)
    const restored = restoreOmittedPayloads(incoming, stored)
    expect(restored).toEqual({
      reasoning: "kept",
      diffs: [
        { path: "b.ts", oldText: "b0", newText: "b1" },
        { path: "a.ts", oldText: "a0", newText: "a1" },
        // Nothing stored for it: the flag stays so readers know.
        { path: "gone.ts", oldText: "", newText: "", textOmitted: true },
      ],
      attachments: [
        { type: "image", filename: "x.png", url: "data:image/png;base64,QQ==" },
      ],
    })
    const plain = { diffs: [{ path: "a.ts", oldText: "x", newText: "y" }] }
    expect(restoreOmittedPayloads(plain, stored)).toBe(plain)
  })
})
