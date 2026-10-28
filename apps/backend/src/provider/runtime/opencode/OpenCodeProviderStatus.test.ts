import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { detectOpenCodeAuth } from "./OpenCodeProviderStatus"

let home: string
let dataHome: string

function authFile(): string {
  return path.join(dataHome, "opencode", "auth.json")
}

beforeEach(() => {
  home = fs.mkdtempSync(
    path.join(os.tmpdir(), "betterc0de-opencode-status-home-")
  )
  dataHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "betterc0de-opencode-status-data-")
  )
  vi.spyOn(os, "homedir").mockReturnValue(home)
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(dataHome, { recursive: true, force: true })
})

describe("detectOpenCodeAuth", () => {
  it("reads the CLI login from XDG_DATA_HOME/opencode/auth.json", () => {
    fs.mkdirSync(path.dirname(authFile()), { recursive: true })
    fs.writeFileSync(
      authFile(),
      JSON.stringify({ anthropic: { type: "api", key: "test" } })
    )

    expect(detectOpenCodeAuth({ XDG_DATA_HOME: dataHome })).toEqual({
      status: "authenticated",
      type: "cli",
      label: "opencode auth login",
    })
  })

  it("ignores an empty auth file and falls back to a provider key", () => {
    fs.mkdirSync(path.dirname(authFile()), { recursive: true })
    fs.writeFileSync(authFile(), "")

    expect(
      detectOpenCodeAuth({
        XDG_DATA_HOME: dataHome,
        OPENCODE_API_KEY: "sk-opencode",
      })
    ).toEqual({
      status: "authenticated",
      type: "api-key",
      label: "OPENCODE_API_KEY",
    })
  })

  it.each([
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
    "OPENROUTER_API_KEY",
    "XAI_API_KEY",
  ])("falls back to the %s provider environment key", (key) => {
    expect(
      detectOpenCodeAuth({ XDG_DATA_HOME: dataHome, [key]: "configured" })
    ).toEqual({
      status: "authenticated",
      type: "api-key",
      label: key,
    })
  })

  it("reports unauthenticated when no login or provider key exists", () => {
    expect(
      detectOpenCodeAuth({
        XDG_DATA_HOME: dataHome,
        OPENAI_API_KEY: "   ",
      })
    ).toEqual({ status: "unauthenticated" })
  })
})
