#!/usr/bin/env node

// Renders the mobile app's icons from the desktop logo
// (apps/ui/public/favicon.svg), so the phone, the desktop and the website
// share one mark.
//
//   node scripts/generate-mobile-icons.mjs          write apps/mobile/assets/*.png
//   node scripts/generate-mobile-icons.mjs --check  fail if a committed icon is stale
//
// The logo is four rounded rectangles, which this script rasterises itself
// (signed-distance anti-aliasing, sRGB compositing like a browser) and
// encodes with Node's zlib. No image library is needed, and the output is
// the same on every platform because only IEEE-exact arithmetic is used.
//
// Each icon centres the logo and scales the circle that encloses it to a
// fixed share of the canvas, which keeps it inside the platform masks:
//   - iOS masks a full-bleed, opaque 1024² square itself.
//   - Android adaptive icons show only a circle of 61–66 % of the canvas.
//   - Android status-bar icons are white on transparent.

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import zlib from "node:zlib"

const root = path.resolve(import.meta.dirname, "..")
const SOURCE = path.join(root, "apps", "ui", "public", "favicon.svg")
const OUTPUT_DIR = path.join(root, "apps", "mobile", "assets")
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** The desktop's --background, also the app canvas (apps/mobile/src/design/theme.ts). */
export const ICON_BACKGROUND = "#0A0A0A"

export const ICONS = [
  { file: "icon.png", size: 1024, background: ICON_BACKGROUND, diameter: 0.96 },
  { file: "adaptive-foreground.png", size: 1024, background: null, diameter: 0.6 },
  { file: "adaptive-monochrome.png", size: 1024, background: null, diameter: 0.6, color: "#FFFFFF" },
  { file: "splash-icon.png", size: 1024, background: null, diameter: 0.9 },
  { file: "notification-icon.png", size: 96, background: null, diameter: 0.84, color: "#FFFFFF" },
]

// ---------------------------------------------------------------------------
// Logo
// ---------------------------------------------------------------------------

function parseColor(value) {
  const match = /^#([0-9a-f]{6})$/i.exec(String(value ?? "").trim())
  if (!match) throw new Error(`Unsupported colour "${value}": use #rrggbb.`)
  const hex = match[1]
  return [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16))
}

function numberAttribute(attributes, name, fallback) {
  const match = new RegExp(`\\s${name}="([^"]*)"`).exec(attributes)
  if (!match) {
    if (fallback === undefined) throw new Error(`<rect> is missing ${name}.`)
    return fallback
  }
  const value = Number(match[1])
  if (!Number.isFinite(value)) throw new Error(`<rect> ${name}="${match[1]}" is not a number.`)
  return value
}

/** Reads the favicon's rounded rectangles; any other shape is an error. */
export function parseLogo(svgText) {
  const rects = []
  for (const [, name, attributes] of svgText.matchAll(/<([A-Za-z][\w:-]*)\b([^>]*)>/g)) {
    if (name === "svg") continue
    if (name !== "rect") {
      throw new Error(`The logo may only contain <rect> elements; found <${name}>. Extend this renderer first.`)
    }
    const fill = /\sfill="([^"]*)"/.exec(attributes)?.[1]
    rects.push({
      x: numberAttribute(attributes, "x", 0),
      y: numberAttribute(attributes, "y", 0),
      width: numberAttribute(attributes, "width"),
      height: numberAttribute(attributes, "height"),
      rx: numberAttribute(attributes, "rx", 0),
      fill: parseColor(fill),
      opacity: numberAttribute(attributes, "opacity", 1),
    })
  }
  if (rects.length === 0) throw new Error("The logo contains no <rect> elements.")
  return rects
}

/**
 * The circle around the logo's bounding-box centre that reaches its farthest
 * corner. Centring the bounding box (not the smallest enclosing circle, which
 * the logo's empty corners pull sideways) keeps the mark visually centred,
 * and the radius still guarantees it fits a circular launcher mask.
 */
export function logoCircle(rects) {
  const left = Math.min(...rects.map((rect) => rect.x))
  const top = Math.min(...rects.map((rect) => rect.y))
  const right = Math.max(...rects.map((rect) => rect.x + rect.width))
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height))
  const center = [(left + right) / 2, (top + bottom) / 2]
  let radius = 0
  for (const rect of rects) {
    for (const [x, y] of [
      [rect.x, rect.y],
      [rect.x + rect.width, rect.y],
      [rect.x, rect.y + rect.height],
      [rect.x + rect.width, rect.y + rect.height],
    ]) {
      const dx = x - center[0]
      const dy = y - center[1]
      radius = Math.max(radius, Math.sqrt(dx * dx + dy * dy))
    }
  }
  return { center, radius }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Signed distance from (x, y) to a rounded rectangle; negative inside. */
function roundedRectDistance(x, y, rect) {
  const halfWidth = rect.width / 2
  const halfHeight = rect.height / 2
  const radius = Math.min(rect.rx, halfWidth, halfHeight)
  const qx = Math.abs(x - (rect.x + halfWidth)) - (halfWidth - radius)
  const qy = Math.abs(y - (rect.y + halfHeight)) - (halfHeight - radius)
  const ox = Math.max(qx, 0)
  const oy = Math.max(qy, 0)
  return Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(qx, qy), 0) - radius
}

/**
 * Returns { width, height, channels, pixels } with 8-bit sRGB samples: RGB
 * when the icon has a background (opaque), RGBA otherwise.
 */
export function renderIcon(rects, { size, background, diameter, color }) {
  const circle = logoCircle(rects)
  const scale = (diameter * size) / (2 * circle.radius)
  const offsetX = size / 2 - circle.center[0] * scale
  const offsetY = size / 2 - circle.center[1] * scale
  const channels = background ? 3 : 4
  const base = background ? [...parseColor(background), 1] : [0, 0, 0, 0]
  const override = color ? parseColor(color) : null
  const pixels = Buffer.alloc(size * size * channels)

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let [r, g, b, a] = base
      const x = (px + 0.5 - offsetX) / scale
      const y = (py + 0.5 - offsetY) / scale
      for (const rect of rects) {
        const coverage = Math.min(Math.max(0.5 - roundedRectDistance(x, y, rect) * scale, 0), 1)
        if (coverage === 0) continue
        const [sr, sg, sb] = override ?? rect.fill
        const sa = coverage * rect.opacity
        const outA = sa + a * (1 - sa)
        const keep = a * (1 - sa)
        r = (sr * sa + r * keep) / outA
        g = (sg * sa + g * keep) / outA
        b = (sb * sa + b * keep) / outA
        a = outA
      }
      const offset = (py * size + px) * channels
      pixels[offset] = Math.round(r)
      pixels[offset + 1] = Math.round(g)
      pixels[offset + 2] = Math.round(b)
      if (channels === 4) pixels[offset + 3] = Math.round(a * 255)
    }
  }
  return { width: size, height: size, channels, pixels }
}

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(zlib.crc32(typeAndData))
  return Buffer.concat([length, typeAndData, crc])
}

export function encodePng({ width, height, channels, pixels }) {
  const stride = width * channels
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    // Filter type 0 (none) for every scanline; deflate does the rest.
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = channels === 4 ? 6 : 2 // RGBA or RGB
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft
  const toLeft = Math.abs(estimate - left)
  const toUp = Math.abs(estimate - up)
  const toUpLeft = Math.abs(estimate - upLeft)
  if (toLeft <= toUp && toLeft <= toUpLeft) return left
  return toUp <= toUpLeft ? up : upLeft
}

/** Decodes 8-bit, non-interlaced RGB/RGBA PNGs (any filter), e.g. after an optimiser ran. */
export function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("Not a PNG file.")
  let offset = 8
  let header = null
  const data = []
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString("ascii", offset + 4, offset + 8)
    const body = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === "IHDR") {
      header = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        bitDepth: body[8],
        colorType: body[9],
        interlace: body[12],
      }
    } else if (type === "IDAT") data.push(body)
    else if (type === "IEND") break
    offset += 12 + length
  }
  if (!header) throw new Error("PNG has no IHDR chunk.")
  if (header.bitDepth !== 8 || header.interlace !== 0 || ![2, 6].includes(header.colorType)) {
    throw new Error(
      `Unsupported PNG layout (bit depth ${header.bitDepth}, colour type ${header.colorType}, interlace ${header.interlace}).`
    )
  }
  const channels = header.colorType === 6 ? 4 : 3
  const stride = header.width * channels
  const raw = zlib.inflateSync(Buffer.concat(data))
  const pixels = Buffer.alloc(stride * header.height)
  for (let y = 0; y < header.height; y += 1) {
    const filter = raw[y * (stride + 1)]
    for (let x = 0; x < stride; x += 1) {
      const value = raw[y * (stride + 1) + 1 + x]
      const left = x >= channels ? pixels[y * stride + x - channels] : 0
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0
      const upLeft = y > 0 && x >= channels ? pixels[(y - 1) * stride + x - channels] : 0
      const predictor = [0, left, up, (left + up) >> 1, paeth(left, up, upLeft)][filter]
      if (predictor === undefined) throw new Error(`Unknown PNG filter ${filter} in row ${y}.`)
      pixels[y * stride + x] = (value + predictor) & 0xff
    }
  }
  return { width: header.width, height: header.height, channels, pixels }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function renderAll(svgText = fs.readFileSync(SOURCE, "utf8")) {
  const rects = parseLogo(svgText)
  return ICONS.map((icon) => ({ ...icon, image: renderIcon(rects, icon) }))
}

function main(argv) {
  const check = argv.includes("--check")
  const stale = []
  for (const { file, image } of renderAll()) {
    const target = path.join(OUTPUT_DIR, file)
    if (check) {
      const current = fs.existsSync(target) ? decodePng(fs.readFileSync(target)) : null
      const same =
        current &&
        current.width === image.width &&
        current.channels === image.channels &&
        current.pixels.equals(image.pixels)
      if (!same) stale.push(path.relative(root, target))
      continue
    }
    fs.mkdirSync(OUTPUT_DIR, { recursive: true })
    fs.writeFileSync(target, encodePng(image))
    process.stdout.write(`wrote ${path.relative(root, target)} (${image.width}×${image.height})\n`)
  }
  if (stale.length > 0) {
    process.stderr.write(
      `These icons do not match apps/ui/public/favicon.svg:\n  ${stale.join("\n  ")}\nRun: node scripts/generate-mobile-icons.mjs\n`
    )
    return 1
  }
  if (check) process.stdout.write("Mobile icons match the logo.\n")
  return 0
}

function isEntryPoint() {
  if (!process.argv[1]) return false
  const self = fileURLToPath(import.meta.url)
  const entry = path.resolve(process.argv[1])
  return process.platform === "win32" ? self.toLowerCase() === entry.toLowerCase() : self === entry
}

if (isEntryPoint()) {
  process.exitCode = main(process.argv.slice(2))
}
