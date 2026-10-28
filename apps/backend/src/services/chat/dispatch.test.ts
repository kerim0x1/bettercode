import { describe, expect, it } from "vitest"
import { asHubProviderKind } from "./dispatch"

describe("asHubProviderKind", () => {
  it("accepts the canonical hub kinds", () => {
    expect(asHubProviderKind("codex")).toBe("codex")
    expect(asHubProviderKind("claude")).toBe("claude")
    expect(asHubProviderKind("cursor")).toBe("cursor")
    expect(asHubProviderKind("grok_cli")).toBe("grok_cli")
    expect(asHubProviderKind("opencode_cli")).toBe("opencode_cli")
  })

  it("folds the settings-driver spelling of non-default instances", () => {
    // Settings instances report their driver (`opencode-cli`), not the kind.
    expect(asHubProviderKind("opencode-cli")).toBe("opencode_cli")
    expect(asHubProviderKind("OpenCode-CLI")).toBe("opencode_cli")
    expect(asHubProviderKind("grok-cli")).toBe("grok_cli")
  })

  it("keeps the legacy compatibility spelling and rejects unknown kinds", () => {
    expect(asHubProviderKind("opencode")).toBe("betterc0de")
    expect(asHubProviderKind("betterc0de")).toBe("betterc0de")
    expect(asHubProviderKind("anthropic")).toBeNull()
    expect(asHubProviderKind("not-a-provider")).toBeNull()
  })
})
