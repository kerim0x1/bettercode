import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, expect, it } from "vitest"
import { CliModelSnapshot, cliAccountIdentity } from "./CliModelSnapshot"

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true })
})

it("restores only the current CLI account's model list without saving credentials", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "betterc0de-cli-models-")
  )
  directories.push(directory)
  const home = path.join(directory, "home")
  fs.mkdirSync(home)
  fs.writeFileSync(path.join(home, "auth.json"), '{"token":"secret-a"}')
  const first = cliAccountIdentity("codex", home)
  const store = new CliModelSnapshot(path.join(directory, "snapshots"))
  store.write("codex", "codex", first, [{ slug: "gpt-7", name: "GPT 7" }])
  expect(
    new CliModelSnapshot(path.join(directory, "snapshots")).read(
      "codex",
      "codex",
      first
    )?.[0]?.slug
  ).toBe("gpt-7")
  fs.writeFileSync(path.join(home, "auth.json"), '{"token":"secret-b"}')
  const second = cliAccountIdentity("codex", home)
  expect(store.read("codex", "codex", second)).toBeNull()
  const persisted = fs
    .readdirSync(path.join(directory, "snapshots"))
    .map((file) =>
      fs.readFileSync(path.join(directory, "snapshots", file), "utf8")
    )
    .join(" ")
  expect(persisted).not.toContain("secret-a")
  expect(persisted).not.toContain("secret-b")
})
