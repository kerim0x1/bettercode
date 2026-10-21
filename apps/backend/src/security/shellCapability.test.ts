import { describe, expect, it } from "vitest"
import { ShellCapabilityIssuer } from "./shellCapability"

describe("ShellCapabilityIssuer launch binding", () => {
  const run = {
    operation: "run" as const,
    command: "npm test",
    cwd: "/repo",
  }

  it("binds the shell and environment a capability was minted with", () => {
    const issuer = new ShellCapabilityIssuer()
    const scope = {
      ...run,
      launch: { shell: "bash", env: { FEATURE: "on" } },
    }
    const token = issuer.issue(scope)

    expect(
      issuer.consume(token, {
        ...run,
        launch: { shell: "/tmp/evil", env: { FEATURE: "on" } },
      })
    ).toBe(false)
    expect(
      issuer.consume(token, {
        ...run,
        launch: { shell: "bash", env: { ZDOTDIR: "/tmp" } },
      })
    ).toBe(false)
    expect(issuer.consume(token, { ...run, launch: { shell: "bash" } })).toBe(
      false
    )
    expect(
      issuer.consume(token, {
        ...run,
        launch: { env: { FEATURE: "on" }, shell: "bash" },
      })
    ).toBe(true)
  })

  it("binds the PTY argument vector", () => {
    const issuer = new ShellCapabilityIssuer()
    const scope = {
      operation: "pty-open" as const,
      cwd: "/repo",
      command: "node",
      launch: { args: ["server.js"] },
    }
    const token = issuer.issue(scope)
    expect(
      issuer.consume(token, { ...scope, launch: { args: ["-e", "evil()"] } })
    ).toBe(false)
    expect(issuer.consume(token, scope)).toBe(true)
  })

  it("binds a capability minted without a launch to the default launch", () => {
    const issuer = new ShellCapabilityIssuer()
    const token = issuer.issue(run)
    // No unbound capabilities: another shell, argument vector or environment
    // than the default is refused, and the token stays unspent.
    expect(
      issuer.consume(token, { ...run, launch: { shell: "powershell" } })
    ).toBe(false)
    expect(issuer.consume(token, { ...run, launch: { env: { A: "1" } } })).toBe(
      false
    )
    expect(
      issuer.consume(token, {
        operation: "pty-open",
        cwd: run.cwd,
        command: run.command,
      })
    ).toBe(false)
    // The default launch, spelled out or not, matches.
    expect(
      issuer.consume(token, {
        ...run,
        launch: { shell: undefined, env: undefined },
      })
    ).toBe(true)
  })

  it("treats an empty environment and whitespace around the shell as the same launch", () => {
    const issuer = new ShellCapabilityIssuer()
    const token = issuer.issue({ ...run, launch: { shell: "bash", env: {} } })
    expect(issuer.consume(token, { ...run, launch: { shell: " bash " } })).toBe(
      true
    )
  })
})
