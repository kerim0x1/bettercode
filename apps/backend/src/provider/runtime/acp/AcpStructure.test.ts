import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

/**
 * The ACP base modules must stay vendor-neutral: every Cursor- or Grok-
 * specific decision belongs in the profile the thin adapter files declare.
 * This test keeps the split honest so the two adapters cannot quietly drift
 * back into forks.
 */

const runtimeDir = path.resolve(__dirname, "..")

function read(relative: string): string {
  return fs.readFileSync(path.join(runtimeDir, relative), "utf8")
}

function lineCount(relative: string): number {
  return read(relative).split(/\r?\n/).length
}

/**
 * Code only: comments and import declarations are stripped; what must not
 * appear is vendor knowledge in the logic itself. The vendor-folder imports
 * are checked separately below.
 */
function logicOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1")
    .replace(/^import[\s\S]*?from\s+["'][^"']+["']\s*$/gm, "")
    .replace(/^import\s+["'][^"']+["']\s*$/gm, "")
}

/** The provider-neutral ACP modules: the bases and the protocol helpers. */
const GENERIC_ACP_MODULES = [
  "acp/AcpAdapterBase.ts",
  "acp/AcpRuntimeBase.ts",
  "acp/AcpJsonRpcClient.ts",
  "acp/AcpMcpServers.ts",
  "acp/AcpSessionConfig.ts",
]

function importSpecifiers(source: string): string[] {
  return [...source.matchAll(/^import[\s\S]*?from\s+["']([^"']+)["']/gm)].map(
    (match) => match[1]!
  )
}

describe("ACP base structure", () => {
  it.each(GENERIC_ACP_MODULES)(
    "%s carries no vendor knowledge outside comments and imports",
    (file) => {
      const logic = logicOnly(read(file))
      const hits = (
        logic.match(/\b\w*(cursor|grok|opencode)\w*\b/gi) ?? []
      ).filter(
        // `ProviderSession.resumeCursor` is the contract's name for a resume
        // position; it has nothing to do with the vendor.
        (hit) => hit !== "resumeCursor"
      )
      expect(hits).toEqual([])
    }
  )

  it.each(GENERIC_ACP_MODULES)(
    "%s never imports from a provider folder",
    (file) => {
      // A vendor module under a generic one inverts the dependency: a
      // Cursor-only change could then break Grok and the API MCP path.
      const vendorImports = importSpecifiers(read(file)).filter((specifier) =>
        /(^|\/)(cursor|grok-cli|opencode)\//.test(specifier)
      )
      expect(vendorImports).toEqual([])
    }
  )

  it("keeps the generic ACP helpers out of the provider folders", () => {
    for (const moved of [
      "cursor/AcpJsonRpcClient.ts",
      "cursor/AcpMcpServers.ts",
    ]) {
      expect(fs.existsSync(path.join(runtimeDir, moved)), moved).toBe(false)
    }
  })

  it.each([
    "cursor/CursorAcpAdapter.ts",
    "grok-cli/GrokAcpAdapter.ts",
    "opencode/OpenCodeAcpAdapter.ts",
    "cursor/CursorAcpRuntime.ts",
    "grok-cli/GrokAcpRuntime.ts",
    "opencode/OpenCodeAcpRuntime.ts",
  ])("%s stays a thin profile file (under 250 lines)", (file) => {
    expect(lineCount(file)).toBeLessThan(250)
  })

  it("the thin adapters build on the shared base rather than re-implementing it", () => {
    for (const file of [
      "cursor/CursorAcpAdapter.ts",
      "grok-cli/GrokAcpAdapter.ts",
      "opencode/OpenCodeAcpAdapter.ts",
    ]) {
      const source = read(file)
      expect(source).toMatch(/extends AcpAdapterBase</)
      // The session/turn machinery must not have been copied back in.
      expect(source).not.toMatch(/startSessionWithAdmission|handleRuntimeExit/)
    }
    for (const file of [
      "cursor/CursorAcpRuntime.ts",
      "grok-cli/GrokAcpRuntime.ts",
      "opencode/OpenCodeAcpRuntime.ts",
    ]) {
      const source = read(file)
      expect(source).toMatch(/createAcpRuntime\(/)
      expect(source).not.toMatch(/new AcpJsonRpcClient|handleSessionUpdate/)
    }
  })
})
