import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"

import { ICONS, decodePng, encodePng, parseLogo, renderAll } from "./generate-mobile-icons.mjs"

const assetsDir = path.join(import.meta.dirname, "..", "apps", "mobile", "assets")
const committed = Object.fromEntries(
  ICONS.map(({ file }) => [file, decodePng(fs.readFileSync(path.join(assetsDir, file)))])
)

test("the committed icons are rendered from the current logo", () => {
  for (const { file, image } of renderAll()) {
    const current = committed[file]
    assert.equal(current.width, image.width, file)
    assert.equal(current.channels, image.channels, file)
    assert.ok(current.pixels.equals(image.pixels), `${file} is stale: run npm run mobile:icons`)
  }
})

test("the App Store icon is a 1024 px square without transparency", () => {
  const icon = committed["icon.png"]
  assert.equal(icon.width, 1024)
  assert.equal(icon.height, 1024)
  assert.equal(icon.channels, 3, "App Store Connect rejects icons with an alpha channel")
})

test("the Android adaptive icon layers keep the logo inside the launcher's safe zone", () => {
  for (const file of ["adaptive-foreground.png", "adaptive-monochrome.png"]) {
    const { width, pixels, channels } = committed[file]
    assert.equal(channels, 4, file)
    // Launchers may mask everything outside the central 66/108 dp circle.
    const safeRadius = (width * 66) / 108 / 2
    let outside = 0
    for (let index = 0; index < width * width; index += 1) {
      if (pixels[index * 4 + 3] === 0) continue
      const x = (index % width) + 0.5 - width / 2
      const y = Math.floor(index / width) + 0.5 - width / 2
      if (Math.sqrt(x * x + y * y) > safeRadius) outside += 1
    }
    assert.equal(outside, 0, `${file}: ${outside} visible pixels outside the safe zone`)
  }
})

test("the notification icon is white on transparent, as Android requires", () => {
  const { width, pixels, channels } = committed["notification-icon.png"]
  assert.equal(width, 96)
  assert.equal(channels, 4)
  let visible = 0
  for (let offset = 0; offset < pixels.length; offset += 4) {
    if (pixels[offset + 3] === 0) continue
    visible += 1
    assert.deepEqual([...pixels.subarray(offset, offset + 3)], [255, 255, 255])
  }
  assert.ok(visible > 0)
})

test("PNG encoding round-trips and only the logo's rectangles are accepted", () => {
  const image = { width: 3, height: 2, channels: 4, pixels: Buffer.from([...Array(24).keys()].map((value) => value * 10)) }
  assert.deepEqual(decodePng(encodePng(image)), image)
  assert.throws(() => parseLogo('<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>'), /only contain <rect>/)
  assert.throws(() => parseLogo('<svg viewBox="0 0 10 10"><rect width="4" height="4" fill="red"/></svg>'), /colour/)
})
