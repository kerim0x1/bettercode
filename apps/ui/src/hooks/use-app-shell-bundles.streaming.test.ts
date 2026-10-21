import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { fileURLToPath } from "node:url"

describe("app-shell orchestrator streaming subscriptions", () => {
  it("does not subscribe to streaming text at the shell orchestrator", () => {
    const sourcePath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "use-app-shell-bundles.tsx"
    )
    const source = fs.readFileSync(sourcePath, "utf8")
    expect(source).not.toMatch(/useChatStreamingState\s*\(/)
    expect(source).not.toMatch(/streamingText\s*,/)
    expect(source).not.toMatch(/streamingText:/)
  })

  it("does not subscribe to the transcript, activities or plan text at the shell", () => {
    // Each of these changes on every provider event; subscribing here
    // re-rendered the title bar, both sidebars and every pane per event.
    const sourcePath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "use-app-shell-bundles.tsx"
    )
    const source = fs.readFileSync(sourcePath, "utf8")
    expect(source).not.toMatch(/useActiveMessages\s*\(/)
    expect(source).not.toMatch(/useThreadActivities\s*\(/)
    expect(source).not.toMatch(/useThreadMessages\s*\(/)
    expect(source).not.toMatch(/streamingPlanText/)
  })

  it("keeps per-keystroke, per-log and dialog state out of the shell", () => {
    // Typing after "/" or "@", a flushed console batch, and opening or typing
    // into a dialog used to update state here and re-render every pane.
    const sourcePath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "use-app-shell-bundles.tsx"
    )
    const source = fs.readFileSync(sourcePath, "utf8")
    expect(source).not.toMatch(/useSlashCommands\s*\(/)
    expect(source).not.toMatch(/useFileMentions\s*\(/)
    expect(source).not.toMatch(/\b(slashQuery|mentionQuery|slashActive)\b/)
    expect(source).not.toMatch(/\bconsoleLogs\b/)
    expect(source).not.toMatch(/useState\s*[<(]/)
    // Setters only: no selector subscribes the shell to a store value.
    expect(source).not.toMatch(/useAppUiStore\s*\(/)
    expect(source).not.toMatch(/useComposerMenuStore\s*\(/)
    expect(source).not.toMatch(/useConsoleLogStore\s*\(/)
  })
})
