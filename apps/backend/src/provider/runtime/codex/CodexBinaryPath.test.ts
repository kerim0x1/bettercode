import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { codexBinaryPath, codexProcessEnvironment } from "./CodexBinaryPath"

afterEach(() => vi.unstubAllEnvs())

describe("Codex executable on macOS", () => {
  it("uses the shell-resolved executable unless a different path was configured", () => {
    vi.stubEnv("BETTERC0DE_CODEX_CLI_PATH", "/opt/homebrew/bin/codex")
    expect(codexBinaryPath(null)).toBe("/opt/homebrew/bin/codex")
    expect(codexBinaryPath("codex")).toBe("/opt/homebrew/bin/codex")
    expect(codexBinaryPath("/custom/codex")).toBe("/custom/codex")
  })

  it("keeps Node beside an npm Codex launcher visible to the child", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "betterc0de-codex-bin-"))
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!
    try {
      const binDir = path.join(root, "bin")
      fs.mkdirSync(binDir)
      const node = path.join(binDir, "node")
      fs.writeFileSync(node, "node")
      fs.chmodSync(node, 0o755)
      Object.defineProperty(process, "platform", {
        ...platform,
        value: "darwin",
      })
      vi.stubEnv("PATH", path.join(root, "system"))

      const env = codexProcessEnvironment(path.join(binDir, "codex"), {})
      expect(env.PATH?.split(path.delimiter)).toContain(binDir)
      expect(env.PATH?.split(path.delimiter)).toContain(
        path.join(root, "system")
      )
    } finally {
      Object.defineProperty(process, "platform", platform)
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
