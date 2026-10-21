import { describe, expect, it } from "vitest"
import {
  matchSettingsTabs,
  settingsTabGroups,
  settingsTabs,
} from "@/components/settings/settings-tabs"

describe("settings rail", () => {
  it("puts every tab in a known group", () => {
    for (const tab of settingsTabs) {
      expect(settingsTabGroups).toContain(tab.group)
    }
  })

  it("finds tabs by name, description and keywords", () => {
    expect(matchSettingsTabs("").length).toBe(settingsTabs.length)
    expect(matchSettingsTabs("api key").map((tab) => tab.id)).toEqual([
      "models",
    ])
    expect(matchSettingsTabs("mcp").map((tab) => tab.id)).toContain("tools")
    expect(matchSettingsTabs("font size").map((tab) => tab.id)).toContain(
      "chat"
    )
    expect(matchSettingsTabs("nothing like this")).toEqual([])
  })
})
