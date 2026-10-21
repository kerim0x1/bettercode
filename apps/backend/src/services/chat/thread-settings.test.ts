import { afterEach, describe, expect, it } from "vitest"
import {
  forgetSessionPermission,
  setSessionPermission,
} from "../../provider/permissions"
import {
  assertThreadSettingsPatchAllowed,
  currentThreadPermissionLevel,
  withThreadPermissionLevel,
} from "./thread-settings"

const DESKTOP = { remote: false, mayBypass: true }
const PHONE = { remote: true, mayBypass: false }
const PHONE_WITH_TERMINAL = { remote: true, mayBypass: true }

/** A thread store that keeps `level` with "thread-1" (none when undefined). */
function stateWith(level?: string) {
  return {
    threads: {
      getThreadSettings: (threadId: string) =>
        threadId === "thread-1" && level ? { permissionLevel: level } : null,
    },
  }
}

afterEach(() => {
  forgetSessionPermission("thread-1")
})

/** The error `run` throws, or null. */
function refusalOf(run: () => void): unknown {
  try {
    run()
    return null
  } catch (error) {
    return error
  }
}

describe("the permission level kept with a chat", () => {
  it("fills in for a turn that names none, and only then", () => {
    const state = stateWith("allow-edits")
    expect(
      withThreadPermissionLevel(state, {
        thread_id: "thread-1",
        permission_level: null,
      }).permission_level
    ).toBe("allow-edits")
    expect(
      withThreadPermissionLevel(state, {
        thread_id: "thread-1",
        permission_level: "  ",
      }).permission_level
    ).toBe("allow-edits")
    expect(
      withThreadPermissionLevel(state, {
        thread_id: "thread-1",
        permission_level: "read-only",
      }).permission_level
    ).toBe("read-only")
    const body = { thread_id: "thread-2", permission_level: null }
    expect(withThreadPermissionLevel(state, body)).toBe(body)
  })

  it("is the thread's level after a restart, until a turn sets one", () => {
    const state = stateWith("allow-edits")
    expect(currentThreadPermissionLevel(state, "thread-1")).toBe("allow-edits")
    setSessionPermission("thread-1", "read-only")
    expect(currentThreadPermissionLevel(state, "thread-1")).toBe("read-only")
    expect(currentThreadPermissionLevel(stateWith(), "thread-2")).toBe(
      "ask-on-edit"
    )
  })
})

describe("what a client may keep with a chat", () => {
  it("lets the desktop keep any level and orchestration", () => {
    expect(() =>
      assertThreadSettingsPatchAllowed(
        {
          permissionLevel: "bypass",
          orchestration: { enabled: true, providers: ["codex"] },
        },
        DESKTOP
      )
    ).not.toThrow()
  })

  it("keeps bypass from a paired device without the terminal grant", () => {
    expect(
      refusalOf(() =>
        assertThreadSettingsPatchAllowed({ permissionLevel: "bypass" }, PHONE)
      )
    ).toMatchObject({ statusCode: 403, code: "remote_bypass_disabled" })
    expect(() =>
      assertThreadSettingsPatchAllowed(
        { permissionLevel: "bypass" },
        PHONE_WITH_TERMINAL
      )
    ).not.toThrow()
    expect(() =>
      assertThreadSettingsPatchAllowed(
        { permissionLevel: "allow-edits", selectedModel: "gpt-5.5" },
        PHONE
      )
    ).not.toThrow()
  })

  it("keeps orchestration with the desktop, though a device may turn it off", () => {
    expect(
      refusalOf(() =>
        assertThreadSettingsPatchAllowed(
          { orchestration: { enabled: true, providers: ["claude"] } },
          PHONE_WITH_TERMINAL
        )
      )
    ).toMatchObject({ statusCode: 403 })
    expect(() =>
      assertThreadSettingsPatchAllowed(
        { orchestration: { enabled: false } },
        PHONE
      )
    ).not.toThrow()
  })
})
