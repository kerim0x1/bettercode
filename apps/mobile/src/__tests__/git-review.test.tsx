import path from "node:path"
import { afterEach, describe, expect, it, jest } from "@jest/globals"
import { fireEvent, screen, waitFor } from "@testing-library/react-native"
import { renderRouter } from "expo-router/testing-library"
import { Alert, type AlertButton } from "react-native"
import GitReviewScreen from "@/app/git"
import { useAppStore } from "@/store/app-store"
import { useSessionStore } from "@/store/session-store"
import { pairWithTestDesktop } from "./support/sessions"

// Source control against the demo desktop, through the app's real routes:
// the entry points, the review, a hunk, a generated message, commit, push.
const APP_DIRECTORY = path.resolve(__dirname, "..", "app")
const ROOT = "/Users/demo/code/weather-app"
const FLOW_TIMEOUT_MS = 60_000

afterEach(async () => {
  jest.restoreAllMocks()
  const session = useSessionStore.getState()
  if (session.mode === "demo") session.exitDemo()
  else await session.forget()
  useAppStore.getState().reset()
})

/** Answers every Alert by pressing the button with this style. */
function answerAlerts(style: AlertButton["style"]) {
  return jest
    .spyOn(Alert, "alert")
    .mockImplementation((_title, _message, buttons) => {
      buttons?.find((button) => button.style === style)?.onPress?.()
    })
}

async function openFromProjects() {
  const app = renderRouter(APP_DIRECTORY, { initialUrl: "/demo?speed=instant" })
  await app
  await fireEvent.press(await screen.findByText("Projects"))
  await fireEvent.press(await screen.findByText("weather-app"))
  await fireEvent.press(await screen.findByTestId("source-control-weather-app"))
  expect(await screen.findByTestId("git-screen")).toBeTruthy()
  // Wrapped: an async function would resolve the thenable result itself.
  return { app }
}

describe("source control", () => {
  it(
    "stages a file and a hunk, commits with a generated message, and pushes",
    async () => {
      const { app } = await openFromProjects()
      expect(app.getPathname()).toBe("/git")
      expect(screen.getByText("Staged Changes")).toBeTruthy()
      expect(screen.getByText("Changes")).toBeTruthy()
      expect(screen.getByText("Untracked")).toBeTruthy()
      expect(screen.getByText("origin/main")).toBeTruthy()
      expect(screen.getByText("↑1")).toBeTruthy()

      await fireEvent.press(screen.getByTestId("git-stage-src/theme.ts"))
      expect(await screen.findByTestId("git-unstage-src/theme.ts")).toBeTruthy()

      // The README has two separate changes; stage only the first.
      await fireEvent.press(screen.getByTestId("git-file-README.md"))
      expect(await screen.findByTestId("git-diff")).toBeTruthy()
      expect(screen.getByTestId("diff-hunk-1")).toBeTruthy()
      await fireEvent.press(screen.getByTestId("git-hunk-stage-0"))
      await waitFor(() =>
        expect(screen.queryByTestId("diff-hunk-1")).toBeNull()
      )
      expect(screen.getByTestId("diff-hunk-0")).toBeTruthy()
      await fireEvent.press(screen.getByLabelText("Back"))

      // Now in both lists: staged in part, changed in part.
      expect(await screen.findByTestId("git-unstage-README.md")).toBeTruthy()
      expect(screen.getByTestId("git-discard-README.md")).toBeTruthy()

      await fireEvent.press(screen.getByTestId("git-generate"))
      await waitFor(() =>
        expect(screen.getByTestId("git-commit-message").props.value).toBe(
          "Update 3 files\n\n- README.md\n- package.json\n- src/theme.ts"
        )
      )
      await fireEvent.press(screen.getByTestId("git-commit"))
      expect(await screen.findByText("↑2")).toBeTruthy()
      expect(screen.queryByText("Staged Changes")).toBeNull()
      expect(screen.getByTestId("git-commit-message").props.value).toBe("")

      const alert = answerAlerts("default")
      await fireEvent.press(screen.getByTestId("git-push"))
      expect(alert).toHaveBeenCalledWith(
        "Push to remote?",
        'Push 2 commits on "main" to origin/main.',
        expect.any(Array)
      )
      await waitFor(() => expect(screen.queryByText("↑2")).toBeNull())

      await fireEvent.press(screen.getByTestId("git-history"))
      expect(await screen.findByText("Update 3 files")).toBeTruthy()
      expect(
        screen.getByText("Show the humidity on the forecast screen")
      ).toBeTruthy()
    },
    FLOW_TIMEOUT_MS
  )

  it(
    "asks before discarding a file, and keeps it when told no",
    async () => {
      await openFromProjects()
      let alert = answerAlerts("cancel")
      await fireEvent.press(screen.getByTestId("git-discard-src/theme.ts"))
      expect(alert).toHaveBeenCalledWith(
        "Discard changes?",
        'All changes to "src/theme.ts" will be permanently lost. This cannot be undone.',
        expect.any(Array)
      )
      expect(screen.getByTestId("git-discard-src/theme.ts")).toBeTruthy()

      alert.mockRestore()
      alert = answerAlerts("destructive")
      await fireEvent.press(screen.getByTestId("git-discard-src/theme.ts"))
      await waitFor(() =>
        expect(screen.queryByTestId("git-discard-src/theme.ts")).toBeNull()
      )

      // A single hunk too: the phone asks where the desktop does not.
      await fireEvent.press(screen.getByTestId("git-file-README.md"))
      await fireEvent.press(await screen.findByTestId("git-hunk-discard-1"))
      expect(alert).toHaveBeenLastCalledWith(
        "Discard this change?",
        'These lines of "README.md" go back to how they were. This cannot be undone.',
        expect.any(Array)
      )
      await waitFor(() =>
        expect(screen.queryByTestId("diff-hunk-1")).toBeNull()
      )
      expect(screen.getByTestId("diff-hunk-0")).toBeTruthy()
    },
    FLOW_TIMEOUT_MS
  )

  it(
    "switches branch after asking, and publishes a new branch",
    async () => {
      await openFromProjects()
      answerAlerts("default")
      await fireEvent.press(screen.getByTestId("git-branch"))
      await fireEvent.press(await screen.findByText("release/1.4"))
      expect(await screen.findByText("origin/release/1.4")).toBeTruthy()

      await fireEvent.press(screen.getByTestId("git-branch"))
      await fireEvent.changeText(
        await screen.findByTestId("git-new-branch"),
        "radar"
      )
      await fireEvent.press(screen.getByTestId("git-create-branch"))
      expect(await screen.findByText("No upstream yet")).toBeTruthy()
      expect(screen.getByText("Publish")).toBeTruthy()
      await fireEvent.press(screen.getByTestId("git-push"))
      expect(await screen.findByText("origin/radar")).toBeTruthy()
    },
    FLOW_TIMEOUT_MS
  )

  it(
    "opens from a chat, for the chat's project",
    async () => {
      const app = renderRouter(APP_DIRECTORY, {
        initialUrl: "/demo?speed=instant",
      })
      await app
      await fireEvent.press(
        await screen.findByTestId("thread-row-demo-dark-mode")
      )
      await fireEvent.press(await screen.findByTestId("chat-source-control"))
      expect(await screen.findByTestId("git-screen")).toBeTruthy()
      expect(app.getSearchParams()).toMatchObject({ root: ROOT })
    },
    FLOW_TIMEOUT_MS
  )

  it("tells a phone that can only watch why there is no source control", async () => {
    pairWithTestDesktop({ accessLevel: "read_only" })
    await renderRouter(
      { "git/index": GitReviewScreen },
      { initialUrl: `/git?root=${encodeURIComponent(ROOT)}` }
    )
    expect(await screen.findByText("This phone can only watch")).toBeTruthy()
    expect(screen.queryByTestId("git-commit")).toBeNull()
  })
})

describe("a chat's changes", () => {
  it(
    "open a file's diff in full",
    async () => {
      await renderRouter(APP_DIRECTORY, { initialUrl: "/demo?speed=instant" })
      await fireEvent.press(
        await screen.findByTestId("thread-row-demo-dark-mode")
      )
      await fireEvent.press(await screen.findByLabelText("Show changes"))
      await fireEvent.press(await screen.findByText("Turn 0"))
      await fireEvent.press(
        await screen.findByTestId("change-file-src/theme.ts")
      )
      expect(await screen.findByTestId("change-diff")).toBeTruthy()
      expect(
        screen.getByText(
          /export type ThemeMode = "system" \| "light" \| "dark"/
        )
      ).toBeTruthy()
    },
    FLOW_TIMEOUT_MS
  )
})
