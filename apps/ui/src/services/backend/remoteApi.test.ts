import { describe, expect, it } from "vitest"
import { describeRemoteClient, describeRemoteTerminals } from "./remoteApi"

describe("describeRemoteTerminals", () => {
  it("counts a device's open terminals, and says nothing when it has none", () => {
    expect(describeRemoteTerminals(1)).toBe("1 terminal open")
    expect(describeRemoteTerminals(3)).toBe("3 terminals open")
    expect(describeRemoteTerminals(0)).toBeNull()
    // A backend that predates the count sends none.
    expect(describeRemoteTerminals(undefined)).toBeNull()
  })
})

describe("describeRemoteClient", () => {
  it("names the phone app, its version and platform for the device list", () => {
    expect(
      describeRemoteClient({
        name: "betterc0de-remote",
        version: "0.1.0-beta.3",
        platform: "android",
      })
    ).toBe("BetterC0de Remote 0.1.0-beta.3 on Android")
    expect(
      describeRemoteClient({
        name: "betterc0de-remote",
        version: "1.0.0",
        platform: "ios",
      })
    ).toBe("BetterC0de Remote 1.0.0 on iOS")
  })

  it("shows unknown apps and platforms as reported, and nothing for browsers", () => {
    expect(
      describeRemoteClient({
        name: "other-app",
        version: "2.0.0",
        platform: null,
      })
    ).toBe("other-app 2.0.0")
    expect(
      describeRemoteClient({
        name: "betterc0de-remote",
        version: "1.0.0",
        platform: "harmony",
      })
    ).toBe("BetterC0de Remote 1.0.0 on harmony")
    expect(describeRemoteClient(null)).toBeNull()
    expect(describeRemoteClient(undefined)).toBeNull()
  })
})
