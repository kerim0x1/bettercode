import { describe, expect, it } from "vitest"
import { providerSkillSlashPrompt } from "./input-context"

const provider = {
  skills: [
    { name: "seo-audit", enabled: true, path: "/skills/seo-audit/SKILL.md" },
    { name: "plugin:review", enabled: true, path: "/skills/review/SKILL.md" },
    { name: "disabled", enabled: false, path: "/skills/disabled/SKILL.md" },
    { name: "plan", enabled: true, path: "/skills/plan/SKILL.md" },
    { name: "doctor", enabled: true, path: "/skills/doctor/SKILL.md" },
  ],
  slashCommands: [{ name: "doctor" }],
}

describe("provider skill slash aliases", () => {
  it("uses only enabled skills from the selected provider and preserves arguments", () => {
    expect(providerSkillSlashPrompt("/seo-audit", provider)).toBe("$seo-audit")
    expect(
      providerSkillSlashPrompt(" /SEO-audit  this page\nand the next", provider)
    ).toBe("$seo-audit  this page\nand the next")
    expect(providerSkillSlashPrompt("/plugin:review changes", provider)).toBe(
      "$plugin:review changes"
    )
    expect(providerSkillSlashPrompt("/disabled changes", provider)).toBeNull()
    expect(providerSkillSlashPrompt("/seo-audit", undefined)).toBeNull()
  })

  it("preserves built-in and native commands, paths, and ordinary text", () => {
    for (const text of [
      "/plan",
      "/doctor",
      "/unknown",
      "/seo-audit/file.ts",
      "Use /seo-audit",
      "$seo-audit",
    ])
      expect(providerSkillSlashPrompt(text, provider)).toBeNull()
  })
})
