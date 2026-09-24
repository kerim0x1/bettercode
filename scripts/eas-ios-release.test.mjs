import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"

import { EAS_CLI, WHAT_TO_TEST_LIMIT, configurationProblems, planTestFlight, whatToTest } from "./eas-ios-release.mjs"

const root = path.resolve(import.meta.dirname, "..")
const PROJECT_ID = "0d9bd8a4-6a39-4a2c-9f3f-0a8a1e1f2b3c"
const configured = {
  appConfigSource: `const PUBLISHED_EAS_PROJECT_ID: string | null = "${PROJECT_ID}"\n`,
  easJson: { submit: { production: { ios: { ascAppId: "6700000000" } } } },
  env: { EXPO_TOKEN: "token" },
}

test("a TestFlight build needs the EAS token, project and App Store Connect app", () => {
  assert.deepEqual(configurationProblems(configured), [])
  const problems = configurationProblems({
    appConfigSource: "const PUBLISHED_EAS_PROJECT_ID: string | null = null\n",
    easJson: { submit: { production: {} } },
    env: {},
  })
  assert.equal(problems.length, 3)
  assert.match(problems[0], /EXPO_TOKEN/)
  assert.match(problems[1], /eas init/)
  assert.match(problems[2], /ascAppId/)
  // A fork names its own project in the environment.
  assert.deepEqual(
    configurationProblems({
      ...configured,
      appConfigSource: "const PUBLISHED_EAS_PROJECT_ID: string | null = null\n",
      env: { EXPO_TOKEN: "token", BETTERC0DE_EAS_PROJECT_ID: PROJECT_ID },
    }),
    []
  )
})

test("the repository's EAS settings are what the release job expects", () => {
  const easJson = JSON.parse(fs.readFileSync(path.join(root, "apps", "mobile", "eas.json"), "utf8"))
  assert.equal(easJson.cli.appVersionSource, "remote")
  assert.equal(easJson.build.production.autoIncrement, true)
  const minimum = /^>= (\d+\.\d+\.\d+)$/.exec(easJson.cli.version)?.[1]
  const pinned = /^eas-cli@(\d+\.\d+\.\d+)$/.exec(EAS_CLI)?.[1]
  assert.ok(minimum && pinned, "eas.json names a minimum CLI and the script pins one")
  const [a, b] = [minimum, pinned].map((version) => version.split(".").map(Number))
  assert.ok(b[0] > a[0] || (b[0] === a[0] && (b[1] > a[1] || (b[1] === a[1] && b[2] >= a[2]))), `${pinned} satisfies >= ${minimum}`)
})

test("builds each commit at most once", () => {
  const commit = "a".repeat(40)
  const other = "b".repeat(40)
  assert.deepEqual(planTestFlight([], commit), { action: "build" })
  assert.deepEqual(planTestFlight([{ id: "1", status: "ERRORED", gitCommitHash: commit }], commit), { action: "build" })
  assert.equal(planTestFlight([{ id: "2", status: "in_queue", gitCommitHash: commit }], commit).action, "running")
  assert.equal(
    planTestFlight(
      [
        { id: "3", status: "ERRORED", gitCommitHash: commit },
        { id: "4", status: "FINISHED", gitCommitHash: commit },
      ],
      commit
    ).build.id,
    "4"
  )
  assert.deepEqual(planTestFlight([{ id: "5", status: "FINISHED", gitCommitHash: other }], commit), { action: "build" })
})

test("tells testers what changed in the app, in plain text", () => {
  const notes = [
    "### Fixed",
    "",
    "- **Phone app: all chats.** The chat list stopped at the newest 100 chats.",
    "- **macOS downloads.** The arm64 files contain an Apple Silicon build.",
    "- The phone app's interface is in English; see [the docs](docs/development/mobile.md) and `npm run mobile:apk`.",
  ].join("\n")
  const text = whatToTest("v0.1.0-beta.3", notes)
  assert.equal(
    text,
    [
      "BetterC0de Remote for BetterC0de v0.1.0-beta.3.",
      "",
      "- Phone app: all chats. The chat list stopped at the newest 100 chats.",
      "- The phone app's interface is in English; see the docs and npm run mobile:apk.",
      "",
      "All changes: https://github.com/kerim0x1/bettercode/releases/tag/v0.1.0-beta.3",
    ].join("\n")
  )
  assert.match(whatToTest("v0.1.0", "- **macOS downloads.** Fixed."), /No changes to the app itself/)
  const long = whatToTest("v1.0.0", Array.from({ length: 200 }, (_, index) => `- Phone app change ${index} ${"x".repeat(40)}`).join("\n"))
  assert.ok(long.length <= WHAT_TO_TEST_LIMIT, `${long.length} characters`)
  assert.match(long, /…\n\nAll changes: /)
})
