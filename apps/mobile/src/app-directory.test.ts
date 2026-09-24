import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

// Expo Router makes every script in src/app a route and bundles it into the
// app, tests included. Screen tests and their helpers live in src/__tests__.
const APP_DIRECTORY = path.resolve(import.meta.dirname, "app")

function files(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name)
    return entry.isDirectory()
      ? files(full)
      : [path.relative(APP_DIRECTORY, full)]
  })
}

describe("route directory", () => {
  it("holds only routes and layouts", () => {
    const all = files(APP_DIRECTORY)
    expect(all).toContain("_layout.tsx")
    const misplaced = all.filter(
      (file) =>
        /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file) ||
        file.split(path.sep).includes("__tests__")
    )
    expect(misplaced).toEqual([])
  })
})
