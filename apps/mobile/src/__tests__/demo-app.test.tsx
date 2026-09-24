import path from "node:path"
import { afterEach, describe, expect, it, jest } from "@jest/globals"
import { act, fireEvent, screen } from "@testing-library/react-native"
import { renderRouter } from "expo-router/testing-library"
import { useAppStore } from "@/store/app-store"
import { useSessionStore } from "@/store/session-store"

// The whole app, with its real routes and guards, against the demo desktop:
// what App Review sees, and what the device flows tap through.
const APP_DIRECTORY = path.resolve(__dirname, "..", "app")

/** Streaming is timer-driven; give it more than the default second. */
const STREAMED = { timeout: 10_000 }

// The stores outlive a render: each test starts signed out, whatever the
// previous one left behind.
afterEach(async () => {
  const session = useSessionStore.getState()
  if (session.mode === "demo") session.exitDemo()
  else await session.forget()
  useAppStore.getState().reset()
})

describe("demo mode", () => {
  // Three streamed waits of up to 10 s each, on top of the first render.
  const FLOW_TIMEOUT_MS = 60_000

  it(
    "chats with the demo desktop from the pairing screen to Exit demo",
    async () => {
      const app = renderRouter(APP_DIRECTORY, { initialUrl: "/" })
      await app
      await fireEvent.press(await screen.findByTestId("pair-demo"))

      expect(await screen.findByTestId("chats-screen")).toBeTruthy()
      expect(screen.getByTestId("connection-demo")).toBeTruthy()
      await fireEvent.press(
        await screen.findByTestId("thread-row-demo-release-notes")
      )
      expect(app.getPathname()).toBe("/chat/demo-release-notes")

      await fireEvent.changeText(
        await screen.findByTestId("chat-input"),
        "Draft the release notes"
      )
      await fireEvent.press(screen.getByTestId("chat-send"))
      expect(await screen.findByText("Draft the release notes")).toBeTruthy()

      // The demo asks once per chat before it runs the tests.
      expect(await screen.findByText("Run npm test", {}, STREAMED)).toBeTruthy()
      expect(screen.getByTestId("chat-stop")).toBeTruthy()
      await fireEvent.press(screen.getByTestId("request-approve"))
      expect(await screen.findByText(/24 passed/, {}, STREAMED)).toBeTruthy()
      expect(await screen.findByTestId("chat-send", {}, STREAMED)).toBeTruthy()
      expect(screen.queryByTestId("request-approve")).toBeNull()

      await fireEvent.press(screen.getByLabelText("Back"))
      await fireEvent.press(await screen.findByText("Host"))
      expect(await screen.findByTestId("demo-host-card")).toBeTruthy()
      await fireEvent.press(screen.getByTestId("exit-demo"))

      expect(await screen.findByTestId("pair-screen")).toBeTruthy()
      expect(useSessionStore.getState()).toMatchObject({
        mode: null,
        profile: null,
        transport: null,
      })
      // The demo never reaches for the network (jest.setup.cjs makes both fail).
      expect(jest.mocked(fetch)).not.toHaveBeenCalled()
      expect(jest.mocked(WebSocket)).not.toHaveBeenCalled()
    },
    FLOW_TIMEOUT_MS
  )

  it("opens from the demo link, which the device flows use", async () => {
    await renderRouter(APP_DIRECTORY, { initialUrl: "/demo?speed=instant" })
    expect(await screen.findByTestId("chats-screen")).toBeTruthy()
    expect(useSessionStore.getState().mode).toBe("demo")
    await act(async () => {
      useSessionStore.getState().exitDemo()
    })
    expect(await screen.findByTestId("pair-screen")).toBeTruthy()
  })
})
