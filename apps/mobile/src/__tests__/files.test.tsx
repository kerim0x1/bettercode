import path from "node:path"
import { afterEach, describe, expect, it, jest } from "@jest/globals"
import { fireEvent, screen, waitFor } from "@testing-library/react-native"
import { renderRouter } from "expo-router/testing-library"
import { Alert, type AlertButton } from "react-native"
import FilesScreen from "@/app/chat/[id]/files"
import { useAppStore } from "@/store/app-store"
import { useSessionStore } from "@/store/session-store"
import { pairWithTestDesktop } from "./support/sessions"

// The chat's files against the demo desktop, through the app's real routes:
// new files and folders, renaming, deleting, and searching file contents.
const APP_DIRECTORY = path.resolve(__dirname, "..", "app")
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

async function openFiles() {
  await renderRouter(APP_DIRECTORY, { initialUrl: "/demo?speed=instant" })
  await fireEvent.press(await screen.findByTestId("thread-row-demo-dark-mode"))
  await fireEvent.press(await screen.findByLabelText("Show files"))
  expect(await screen.findByTestId("file-row-src")).toBeTruthy()
}

async function name(kind: "New file" | "New folder", value: string) {
  await fireEvent.press(screen.getByTestId("files-new"))
  await fireEvent.press(await screen.findByText(kind))
  await fireEvent.changeText(await screen.findByTestId("rename-input"), value)
  await fireEvent.press(screen.getByTestId("rename-save"))
}

describe("a chat's files", () => {
  it(
    "makes a new file and folder, and never takes a name that exists",
    async () => {
      await openFiles()
      await name("New file", "Map.tsx")
      expect(await screen.findByTestId("file-row-Map.tsx")).toBeTruthy()
      await name("New folder", "docs")
      expect(await screen.findByTestId("file-row-docs")).toBeTruthy()

      const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {})
      await name("New file", "README.md")
      await waitFor(() =>
        expect(alert).toHaveBeenCalledWith(
          "Name already taken",
          "A file or folder with this name already exists here."
        )
      )
      // The sheet stays open to try another name.
      expect(screen.getByTestId("rename-input")).toBeTruthy()
      await fireEvent.press(screen.getByText("Cancel"))
      await waitFor(() =>
        expect(screen.queryByTestId("rename-input")).toBeNull()
      )
    },
    FLOW_TIMEOUT_MS
  )

  it(
    "renames a file, and deletes a folder after the desktop's question",
    async () => {
      await openFiles()
      await fireEvent.press(screen.getByTestId("file-more-package.json"))
      await fireEvent.press(await screen.findByText("Rename"))
      await fireEvent.changeText(
        await screen.findByTestId("rename-input"),
        "manifest.json"
      )
      await fireEvent.press(screen.getByTestId("rename-save"))
      expect(await screen.findByTestId("file-row-manifest.json")).toBeTruthy()
      expect(screen.queryByTestId("file-row-package.json")).toBeNull()

      let alert = answerAlerts("cancel")
      await fireEvent.press(screen.getByTestId("file-more-src"))
      await fireEvent.press(await screen.findByText("Delete"))
      expect(alert).toHaveBeenCalledWith(
        "Delete folder?",
        '"src" will be permanently deleted.',
        expect.any(Array)
      )
      expect(screen.getByTestId("file-row-src")).toBeTruthy()

      alert.mockRestore()
      alert = answerAlerts("destructive")
      await fireEvent.press(screen.getByTestId("file-more-src"))
      await fireEvent.press(await screen.findByText("Delete"))
      await waitFor(() =>
        expect(screen.queryByTestId("file-row-src")).toBeNull()
      )
    },
    FLOW_TIMEOUT_MS
  )

  it(
    "searches the text of the files and opens a match at its line",
    async () => {
      await openFiles()
      await fireEvent.press(screen.getByTestId("files-mode-contents"))
      await fireEvent.press(screen.getByTestId("search-case"))
      const search = screen.getByTestId("files-search")
      await fireEvent.changeText(search, "background")
      await fireEvent(search, "submitEditing")
      expect(await screen.findByText(/2 matches in 1 file/)).toBeTruthy()
      await fireEvent.press(screen.getByTestId("search-match-src/theme.ts-2"))

      const line = await screen.findByTestId("file-target-line")
      expect(line).toHaveTextContent(/#0a0a0a/)
    },
    FLOW_TIMEOUT_MS
  )

  it("offers nothing to change to a phone that can only watch", async () => {
    const transport = pairWithTestDesktop({ accessLevel: "read_only" })
    await useAppStore.getState().refreshThreads(transport.api)
    await renderRouter(
      { "chat/[id]/files": FilesScreen },
      { initialUrl: "/chat/demo-dark-mode/files" }
    )
    expect(await screen.findByTestId("file-row-src")).toBeTruthy()
    expect(screen.queryByTestId("files-new")).toBeNull()
    expect(screen.queryByTestId("file-more-src")).toBeNull()
  })
})
