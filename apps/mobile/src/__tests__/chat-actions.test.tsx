import path from "node:path"
import { afterEach, describe, expect, it, jest } from "@jest/globals"
import { fireEvent, screen, waitFor } from "@testing-library/react-native"
import { renderRouter } from "expo-router/testing-library"
import { Alert, type AlertButton } from "react-native"
import { REMOTE_FEATURES } from "@betterc0de/schema/remote-protocol"
import ChatScreen from "@/app/chat/[id]"
import { useAppStore } from "@/store/app-store"
import { useSessionStore } from "@/store/session-store"
import { pairWithTestDesktop } from "./support/sessions"

const APP_DIRECTORY = path.resolve(__dirname, "..", "app")
const FLOW_TIMEOUT_MS = 60_000

afterEach(async () => {
  jest.restoreAllMocks()
  const session = useSessionStore.getState()
  if (session.mode === "demo") session.exitDemo()
  else await session.forget()
  useAppStore.getState().reset()
})

/** Answers the next Alert by pressing the button with this style. */
function answerAlerts(style: AlertButton["style"]) {
  return jest
    .spyOn(Alert, "alert")
    .mockImplementation((_title, _message, buttons) => {
      buttons?.find((button) => button.style === style)?.onPress?.()
    })
}

describe("chat actions", () => {
  it(
    "renames a chat, and deletes it after the desktop's question",
    async () => {
      await renderRouter(APP_DIRECTORY, { initialUrl: "/demo?speed=instant" })
      await fireEvent.press(
        await screen.findByTestId("thread-row-demo-dark-mode")
      )
      await fireEvent.press(await screen.findByTestId("chat-actions"))
      await fireEvent.press(await screen.findByText("Rename"))
      await fireEvent.changeText(
        await screen.findByTestId("rename-input"),
        "Dark theme"
      )
      await fireEvent.press(screen.getByTestId("rename-save"))
      await waitFor(() =>
        expect(screen.queryByTestId("rename-input")).toBeNull()
      )
      expect(screen.getByText("Dark theme")).toBeTruthy()

      const alert = answerAlerts("destructive")
      await fireEvent.press(screen.getByTestId("chat-actions"))
      await fireEvent.press(await screen.findByText("Delete chat"))
      expect(alert).toHaveBeenCalledWith(
        "Delete chat?",
        '"Dark theme" will be permanently deleted.',
        expect.any(Array)
      )
      expect(await screen.findByTestId("chats-screen")).toBeTruthy()
      await waitFor(() =>
        expect(screen.queryByTestId("thread-row-demo-dark-mode")).toBeNull()
      )
    },
    FLOW_TIMEOUT_MS
  )

  it("says that deleting a worktree chat removes its worktree", async () => {
    const transport = pairWithTestDesktop()
    const thread = await transport.api.getThread("demo-dark-mode")
    useAppStore.setState({
      threads: [
        { ...thread!, worktreePath: "/Users/demo/.worktrees/dark-mode" },
      ],
    })
    const alert = answerAlerts("cancel")
    await renderRouter(
      { "chat/[id]": ChatScreen },
      { initialUrl: "/chat/demo-dark-mode" }
    )
    await fireEvent.press(await screen.findByTestId("chat-actions"))
    await fireEvent.press(await screen.findByText("Delete chat"))
    expect(alert.mock.calls[0]?.[1]).toContain(
      "Its worktree at /Users/demo/.worktrees/dark-mode is removed too, with any changes there that are not committed."
    )
    // Cancelled: the chat stays.
    expect(useAppStore.getState().threads.map((item) => item.id)).toContain(
      "demo-dark-mode"
    )
  })

  it("offers no rename where the desktop could not keep it", async () => {
    pairWithTestDesktop()
    useSessionStore.setState((state) => ({
      protocol: state.protocol && {
        ...state.protocol,
        capabilities: {
          ...state.protocol.capabilities!,
          features: [REMOTE_FEATURES.threadsGet],
        },
      },
    }))
    await renderRouter(
      { "chat/[id]": ChatScreen },
      { initialUrl: "/chat/demo-dark-mode" }
    )
    await fireEvent.press(await screen.findByTestId("chat-actions"))
    expect(await screen.findByText("Delete chat")).toBeTruthy()
    expect(screen.queryByText("Rename")).toBeNull()
  })

  it("offers no actions to a phone that can only watch", async () => {
    pairWithTestDesktop({ accessLevel: "read_only" })
    await renderRouter(
      { "chat/[id]": ChatScreen },
      { initialUrl: "/chat/demo-dark-mode" }
    )
    expect(await screen.findByTestId("read-only-banner")).toBeTruthy()
    expect(screen.queryByTestId("chat-actions")).toBeNull()
  })
})
