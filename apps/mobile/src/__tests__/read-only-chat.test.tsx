import { afterEach, describe, expect, it, jest } from "@jest/globals"
import { screen } from "@testing-library/react-native"
import { renderRouter } from "expo-router/testing-library"
import ChatScreen from "@/app/chat/[id]"
import { useAppStore } from "@/store/app-store"
import { useSessionStore } from "@/store/session-store"
import type { RemoteAccessLevel } from "@betterc0de/schema/remote-protocol"
import { pairWithTestDesktop } from "./support/sessions"

const THREAD = "demo-release-notes"

afterEach(async () => {
  await useSessionStore.getState().forget()
  useAppStore.getState().reset()
})

/** Opens the chat while the desktop's agent waits for an approval. */
async function openChatAwaitingApproval(accessLevel: RemoteAccessLevel) {
  const transport = pairWithTestDesktop({ accessLevel })
  jest.useFakeTimers()
  // Started on the desktop; the turn stops at "Run npm test".
  await transport.api.sendMessage({
    threadId: THREAD,
    userMessageId: "u1",
    message: "Draft the release notes",
  })
  await jest.runAllTimersAsync()
  await renderRouter(
    { "chat/[id]": ChatScreen },
    { initialUrl: `/chat/${THREAD}` }
  )
  expect(await screen.findByText("Run npm test")).toBeTruthy()
  expect(screen.getByText("Draft the release notes")).toBeTruthy()
}

describe("chat screen", () => {
  it("lets a read-only session watch, but not write or answer", async () => {
    await openChatAwaitingApproval("read_only")
    expect(screen.getByTestId("read-only-banner")).toBeTruthy()
    expect(screen.queryByTestId("chat-input")).toBeNull()
    expect(
      screen.getByText("This phone can only watch. Answer this on the desktop.")
    ).toBeTruthy()
    expect(screen.queryByTestId("request-approve")).toBeNull()
    expect(screen.queryByTestId("request-deny")).toBeNull()
  })

  it("gives a full session the composer and the approval buttons", async () => {
    await openChatAwaitingApproval("full")
    expect(screen.queryByTestId("read-only-banner")).toBeNull()
    expect(screen.getByTestId("chat-input")).toBeTruthy()
    expect(screen.getByTestId("request-approve")).toBeTruthy()
    expect(screen.getByTestId("request-deny")).toBeTruthy()
  })
})
