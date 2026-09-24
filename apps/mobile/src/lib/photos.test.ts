import { describe, expect, it } from "vitest"
import { CHAT_MESSAGE_MAX_CHARS } from "@betterc0de/schema/chat-attachment"
import { DEFAULT_MAX_REQUEST_BYTES } from "./compat"
import {
  MAX_PHOTOS_PER_MESSAGE,
  PHOTO_MAX_BYTES,
  PHOTO_MAX_EDGE,
  REQUEST_RESERVE_BYTES,
  base64Bytes,
  encodePhoto,
  encodingSteps,
  nextPhotoMaxBytes,
  photoAttachment,
  photoFilename,
  type PhotoCodec,
} from "./photos"

/** Base64 of exactly `bytes` bytes of data. */
function base64Of(bytes: number): string {
  return Buffer.alloc(bytes, 7).toString("base64")
}

/** A photo whose JPEG takes `bytesAt(width, height, quality)` bytes. */
function fakeCodec(
  width: number,
  height: number,
  bytesAt: (width: number, height: number, quality: number) => number
) {
  const calls: string[] = []
  const codec: PhotoCodec = {
    width,
    height,
    jpeg: async (w, h, quality) => {
      calls.push(`${w}x${h}@${quality}`)
      return base64Of(bytesAt(w, h, quality))
    },
  }
  return { codec, calls }
}

describe("encoding steps", () => {
  it("shrinks the long edge to the models' limit, keeping the proportions", () => {
    const [first] = encodingSteps(4032, 3024)
    expect(first).toEqual({ width: PHOTO_MAX_EDGE, height: 1176, quality: 0.8 })
    const [portrait] = encodingSteps(3024, 4032)
    expect(portrait).toEqual({
      width: 1176,
      height: PHOTO_MAX_EDGE,
      quality: 0.8,
    })
  })

  it("tries lower qualities, then smaller sizes, each three quarters of the last", () => {
    expect(
      encodingSteps(4032, 3024).map(
        (step) => `${step.width}x${step.height}@${step.quality}`
      )
    ).toEqual([
      "1568x1176@0.8",
      "1568x1176@0.65",
      "1568x1176@0.5",
      "1176x882@0.8",
      "1176x882@0.65",
      "1176x882@0.5",
      "882x662@0.8",
      "882x662@0.65",
      "882x662@0.5",
    ])
  })

  it("never enlarges a small photo", () => {
    const steps = encodingSteps(800, 600)
    expect(steps[0]).toEqual({ width: 800, height: 600, quality: 0.8 })
    expect(Math.max(...steps.map((step) => step.width))).toBe(800)
  })

  it("has nothing to try for a photo without a size", () => {
    expect(encodingSteps(0, 0)).toEqual([])
    expect(encodingSteps(Number.NaN, 10)).toEqual([])
  })
})

describe("encoding a photo", () => {
  it("takes the first step that fits", async () => {
    const { codec, calls } = fakeCodec(4032, 3024, (_w, _h, quality) =>
      quality === 0.8 ? 900_000 : 400_000
    )
    const photo = await encodePhoto(codec, PHOTO_MAX_BYTES)
    expect(calls).toEqual(["1568x1176@0.8", "1568x1176@0.65"])
    expect(photo).toMatchObject({ width: 1568, height: 1176 })
    expect(base64Bytes(photo!.base64)).toBe(400_000)
  })

  it("goes down in size when no quality is small enough", async () => {
    const { codec } = fakeCodec(4032, 3024, (width) =>
      width > 1200 ? 800_000 : 300_000
    )
    const photo = await encodePhoto(codec, PHOTO_MAX_BYTES)
    expect(photo).toMatchObject({ width: 1176, height: 882 })
  })

  it("gives up when even the smallest step is too large", async () => {
    const { codec, calls } = fakeCodec(4032, 3024, () => 50_000)
    expect(await encodePhoto(codec, 40_000)).toBeNull()
    expect(calls).toHaveLength(9)
  })

  it("does not encode at all when there is no room", async () => {
    const { codec, calls } = fakeCodec(4032, 3024, () => 1)
    expect(await encodePhoto(codec, 0)).toBeNull()
    expect(calls).toEqual([])
  })
})

describe("room for photos", () => {
  const photo = (bytes: number) => ({ base64: base64Of(bytes) })

  it("keeps each photo's data URL within the desktop's limit for one attachment", () => {
    const max = nextPhotoMaxBytes([], DEFAULT_MAX_REQUEST_BYTES)
    expect(max).toBe(PHOTO_MAX_BYTES)
    const url = photoAttachment({ base64: base64Of(max) }, 0).url
    expect(url.length).toBeLessThanOrEqual(CHAT_MESSAGE_MAX_CHARS)
  })

  it("gives the next photo what the ones before left, and keeps the reserve free", () => {
    const first = [photo(PHOTO_MAX_BYTES)]
    const next = nextPhotoMaxBytes(first, DEFAULT_MAX_REQUEST_BYTES)
    expect(next).toBeGreaterThan(500_000)
    expect(next).toBeLessThan(PHOTO_MAX_BYTES)
    // Data URLs and their JSON, as the request carries them.
    const used = [...first, photo(next)].reduce(
      (sum, entry) =>
        sum + JSON.stringify(photoAttachment(entry, 9)).length + 1,
      0
    )
    expect(used).toBeLessThanOrEqual(
      DEFAULT_MAX_REQUEST_BYTES - REQUEST_RESERVE_BYTES
    )
  })

  it("has no room once the request is full, or the message has its most photos", () => {
    const first = [photo(PHOTO_MAX_BYTES)]
    const full = [
      ...first,
      photo(nextPhotoMaxBytes(first, DEFAULT_MAX_REQUEST_BYTES)),
    ]
    expect(nextPhotoMaxBytes(full, DEFAULT_MAX_REQUEST_BYTES)).toBe(0)
    const many = Array.from({ length: MAX_PHOTOS_PER_MESSAGE }, () => photo(10))
    expect(nextPhotoMaxBytes(many, DEFAULT_MAX_REQUEST_BYTES)).toBe(0)
  })

  it("follows a desktop that accepts less", () => {
    expect(nextPhotoMaxBytes([], REQUEST_RESERVE_BYTES)).toBe(0)
    const small = nextPhotoMaxBytes([], REQUEST_RESERVE_BYTES + 300_000)
    expect(small).toBeGreaterThan(200_000)
    expect(small).toBeLessThan(300_000)
  })
})

describe("the attachment", () => {
  it("is a JPEG data URL named by its place in the message", () => {
    expect(photoFilename(0)).toBe("photo-1.jpg")
    expect(photoAttachment({ base64: "AAAA" }, 1)).toEqual({
      type: "file",
      filename: "photo-2.jpg",
      mediaType: "image/jpeg",
      url: "data:image/jpeg;base64,AAAA",
    })
  })

  it("counts the bytes a base64 string encodes", () => {
    for (const bytes of [0, 1, 2, 3, 4, 700 * 1024])
      expect(base64Bytes(base64Of(bytes))).toBe(bytes)
  })
})
