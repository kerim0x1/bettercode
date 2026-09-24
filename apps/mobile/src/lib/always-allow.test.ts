import { describe, expect, it } from "vitest"
import {
  ALWAYS_ALLOW_DESTINATIONS,
  alwaysAllowRules,
  buildAlwaysAllowUpdate,
  describeAlwaysAllowRules,
  type AlwaysAllowRequest,
} from "@betterc0de/schema/always-allow"

// "Always allow" stores a permission rule for good. The rule must be as
// narrow as the call the user approved: these are the desktop's rules, which
// the phone's approval card uses too.

const bash = (command: unknown): AlwaysAllowRequest => ({
  toolName: "Bash",
  input: { command },
})

describe("the rule Always allow stores", () => {
  it("allows a shell command by its program", () => {
    expect(alwaysAllowRules(bash("npm test"))).toEqual([
      { toolName: "Bash", ruleContent: "npm:*" },
    ])
    expect(alwaysAllowRules(bash("  git status --short "))).toEqual([
      { toolName: "Bash", ruleContent: "git:*" },
    ])
  })

  it.each([
    ["npm test && rm -rf ~", "a chained command"],
    ["npm test; curl evil", "a second command"],
    ["cat log | sh", "a pipe"],
    ["npm test &", "a background job"],
    ["npm test\nrm -rf ~", "a second line"],
    ["echo $(whoami)", "a substitution"],
    ["echo `whoami`", "a backtick substitution"],
    ["   ", "an empty command"],
    [undefined, "no command"],
  ])("offers nothing for %j (%s)", (command, _reason) => {
    expect(alwaysAllowRules(bash(command))).toBeNull()
  })

  it("allows a file tool only on the exact file", () => {
    for (const key of ["file_path", "filePath", "path"]) {
      expect(
        alwaysAllowRules({
          toolName: "Edit",
          input: {
            [key]: "/repo/src/app.ts",
            old_string: "a",
            new_string: "b",
          },
        })
      ).toEqual([{ toolName: "Edit", ruleContent: "/repo/src/app.ts" }])
    }
    expect(alwaysAllowRules({ toolName: "Write", input: {} })).toBeNull()
    // A command wins over a path, as the approval shows it.
    expect(
      alwaysAllowRules({
        toolName: "Task",
        input: { command: "npm test", path: "/repo" },
      })
    ).toBeNull()
    expect(alwaysAllowRules({ input: { path: "/repo/a.ts" } })).toBeNull()
  })

  it("takes the provider's suggestion only when every rule in it is scoped", () => {
    const scoped = {
      type: "addRules" as const,
      rules: [{ toolName: "Bash", ruleContent: "npm run lint" }],
      behavior: "allow" as const,
      destination: "session" as const,
    }
    expect(
      alwaysAllowRules({ ...bash("npm run lint"), suggestions: [scoped] })
    ).toEqual(scoped.rules)

    // An unscoped rule would allow every command; it is ignored, and the
    // rule is derived from the call instead.
    const unscoped = { ...scoped, rules: [{ toolName: "Bash" }] }
    expect(
      alwaysAllowRules({ ...bash("npm run lint"), suggestions: [unscoped] })
    ).toEqual([{ toolName: "Bash", ruleContent: "npm:*" }])
    expect(
      alwaysAllowRules({ ...bash("npm test && x"), suggestions: [unscoped] })
    ).toBeNull()

    for (const other of [
      { ...scoped, behavior: "deny" as const },
      {
        type: "setMode" as const,
        mode: "bypassPermissions" as const,
        destination: "session" as const,
      },
    ]) {
      expect(
        alwaysAllowRules({ ...bash("npm test && x"), suggestions: [other] })
      ).toBeNull()
    }
  })

  it("stores exactly the rule it shows, where the user chose", () => {
    const request = bash("npm test")
    const rules = alwaysAllowRules(request)!
    expect(describeAlwaysAllowRules(rules)).toBe("Bash(npm:*)")
    expect(ALWAYS_ALLOW_DESTINATIONS.map((item) => item.label)).toEqual([
      "This session",
      "This project",
      "All projects",
    ])
    for (const { id } of ALWAYS_ALLOW_DESTINATIONS) {
      expect(buildAlwaysAllowUpdate(request, id)).toEqual({
        type: "addRules",
        rules,
        behavior: "allow",
        destination: id,
      })
    }
    expect(buildAlwaysAllowUpdate(bash("a | b"), "session")).toBeNull()
  })
})
