import { describe, expect, it } from "vitest"
import {
  cliVersionAtLeast,
  compareCliVersions,
  normalizeCliVersion,
} from "./versions"

describe("CLI versions", () => {
  it("reads the first version out of CLI output", () => {
    expect(normalizeCliVersion("2.1.111 (Claude Code)")).toBe("2.1.111")
    expect(normalizeCliVersion("codex-cli 0.50.0")).toBe("0.50.0")
    expect(normalizeCliVersion("codex_cli_rs/0.141.0 (Windows)")).toBe(
      "0.141.0"
    )
    expect(normalizeCliVersion("v1.14.19")).toBe("1.14.19")
    expect(normalizeCliVersion("grok 1.2")).toBe("1.2.0")
    expect(normalizeCliVersion("0.140.0-alpha.2")).toBe("0.140.0-alpha.2")
    expect(normalizeCliVersion("betterc0de 01.002.3")).toBe("1.2.3")
  })

  it("finds no version in text without one", () => {
    expect(normalizeCliVersion("betterc0de")).toBeNull()
    expect(normalizeCliVersion("nightly")).toBeNull()
    expect(normalizeCliVersion("")).toBeNull()
    expect(normalizeCliVersion(null)).toBeNull()
  })

  it("orders versions numerically with prereleases before their release", () => {
    const ordered = [
      "0.9.0",
      "0.10.0-alpha.1",
      "0.10.0-alpha.10",
      "0.10.0-beta",
      "0.10.0",
      "0.10.1",
      "1.0.0",
    ]
    for (let index = 1; index < ordered.length; index += 1) {
      expect(compareCliVersions(ordered[index - 1], ordered[index])).toBe(-1)
      expect(compareCliVersions(ordered[index], ordered[index - 1])).toBe(1)
    }
    expect(compareCliVersions("v2.1.111", "2.1.111 (Claude Code)")).toBe(0)
    expect(compareCliVersions("1.2", "1.2.0")).toBe(0)
  })

  it("leaves an unreadable version to the caller", () => {
    expect(compareCliVersions("nightly", "1.0.0")).toBeNull()
    expect(compareCliVersions("1.0.0", null)).toBeNull()
  })

  it("falls back to the release when a prerelease tag is not semver", () => {
    expect(compareCliVersions("1.2.3-01", "1.2.3")).toBe(0)
    expect(compareCliVersions("1.2.4-01", "1.2.3")).toBe(1)
  })

  it("checks a minimum, optionally counting a prerelease as its release", () => {
    expect(cliVersionAtLeast("0.140.0", "0.140.0")).toBe(true)
    expect(cliVersionAtLeast("0.141.2", "0.140.0")).toBe(true)
    expect(cliVersionAtLeast("0.139.9", "0.140.0")).toBe(false)
    expect(cliVersionAtLeast("0.140.0-alpha.2", "0.140.0")).toBe(false)
    expect(
      cliVersionAtLeast("0.140.0-alpha.2", "0.140.0", {
        prereleaseMeetsRelease: true,
      })
    ).toBe(true)
    expect(
      cliVersionAtLeast("0.139.0-alpha.2", "0.140.0", {
        prereleaseMeetsRelease: true,
      })
    ).toBe(false)
    expect(cliVersionAtLeast(null, "0.140.0")).toBe(false)
    expect(cliVersionAtLeast("unknown", "0.140.0")).toBe(false)
  })
})
