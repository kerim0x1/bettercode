import path from "node:path"
import { afterEach, describe, expect, it, jest } from "@jest/globals"
import { act, fireEvent, screen, waitFor } from "@testing-library/react-native"
import { renderRouter } from "expo-router/testing-library"
import { REMOTE_FEATURES } from "@betterc0de/schema/remote-protocol"
import { useAppStore } from "@/store/app-store"
import { useSessionStore } from "@/store/session-store"

// The terminal against the demo desktop's pretend shell, through the app's
// real routes. The WebView cannot run here: a stand-in speaks the terminal
// page's protocol (src/terminal/page-protocol.ts) the way the page does.
const APP_DIRECTORY = path.resolve(__dirname, "..", "app")
const FLOW_TIMEOUT_MS = 60_000

interface MockPageProps {
  onMessage?: (event: { nativeEvent: { data: string } }) => void
}

const mockPage = {
  /** Everything the terminal showed since the page started. */
  shown: "",
  commands: [] as Array<{ type: string; [key: string]: unknown }>,
  page: null as { current: MockPageProps } | null,
  emit(event: unknown) {
    this.page?.current.onMessage?.({
      nativeEvent: { data: JSON.stringify(event) },
    })
  },
  /** Someone types on the phone's keyboard. */
  type(data: string) {
    this.emit({ type: "input", data })
  },
  receive(data: string) {
    const command = JSON.parse(data) as { type: string; [key: string]: unknown }
    this.commands.push(command)
    if (command.type === "output") this.shown += String(command.data)
    else if (command.type === "reset") this.shown = ""
    else if (command.type === "key") {
      const keys: Record<string, string> = { escape: "\u001b", tab: "\t" }
      this.type(keys[String(command.key)] ?? "")
    }
  },
  reset() {
    this.shown = ""
    this.commands = []
    this.page = null
  },
}

jest.mock("react-native-webview", () => {
  const React = jest.requireActual<typeof import("react")>("react")
  const { View } =
    jest.requireActual<typeof import("react-native")>("react-native")
  const WebView = React.forwardRef(function WebView(
    props: MockPageProps,
    ref: React.Ref<{ postMessage: (data: string) => void }>
  ) {
    const latest = React.useRef(props)
    latest.current = props
    React.useImperativeHandle(ref, () => ({
      postMessage: (data: string) => mockPage.receive(data),
    }))
    React.useEffect(() => {
      mockPage.page = latest
      // The page says ready once, with its size, as the real one does.
      mockPage.emit({ type: "ready", cols: 80, rows: 24 })
    }, [])
    return <View testID="webview" />
  })
  return { WebView }
})

afterEach(async () => {
  mockPage.reset()
  const session = useSessionStore.getState()
  if (session.mode === "demo") session.exitDemo()
  else await session.forget()
  useAppStore.getState().reset()
})

async function openTerminal() {
  await renderRouter(APP_DIRECTORY, { initialUrl: "/demo?speed=instant" })
  await fireEvent.press(await screen.findByTestId("thread-row-demo-dark-mode"))
  await fireEvent.press(await screen.findByTestId("chat-actions"))
  await fireEvent.press(await screen.findByTestId("chat-terminal"))
  await waitFor(() => expect(mockPage.shown).toMatch(/weather-app.* % $/))
}

/** Types, and lets the demo's answer come back. */
async function typeAndWait(data: string, answer: RegExp) {
  await act(async () => mockPage.type(data))
  await waitFor(() => expect(mockPage.shown).toMatch(answer))
}

describe("the terminal", () => {
  it(
    "opens in the chat's folder, and runs what is typed",
    async () => {
      await openTerminal()
      expect(mockPage.shown).toContain("it runs nothing")
      await typeAndWait("echo $((6*7))\r", /\r\n42\r\n/)
      await typeAndWait("pwd\r", /\/Users\/demo\/code\/weather-app\r\n/)
      expect(screen.getByTestId("terminal-keys")).toBeTruthy()
    },
    FLOW_TIMEOUT_MS
  )

  it(
    "holds Ctrl from the key bar for the next key only",
    async () => {
      await openTerminal()
      await act(async () => mockPage.type("whoam"))
      await fireEvent.press(screen.getByTestId("terminal-key-ctrl"))
      expect(screen.getByTestId("terminal-key-ctrl")).toBeSelected()
      await typeAndWait("c", /whoam\^C\r\n/)
      expect(screen.getByTestId("terminal-key-ctrl")).not.toBeSelected()
      // Let go: the next c is a c.
      await typeAndWait("echo c\r", /\r\nc\r\n/)
    },
    FLOW_TIMEOUT_MS
  )

  it(
    "keeps running when the phone goes back, and shows what it had when it comes back",
    async () => {
      await openTerminal()
      await typeAndWait("whoami\r", /\r\ndemo\r\n/)
      const opened = mockPage.commands.length
      await fireEvent.press(screen.getByLabelText("Back"))
      await fireEvent.press(await screen.findByTestId("chat-actions"))
      await fireEvent.press(await screen.findByTestId("chat-terminal"))

      // The same terminal: its earlier output again, not a new greeting.
      await waitFor(() => expect(mockPage.shown).toContain("\r\ndemo\r\n"))
      expect(mockPage.shown.match(/it runs nothing/g)).toHaveLength(1)
      expect(mockPage.commands.length).toBeGreaterThan(opened)
    },
    FLOW_TIMEOUT_MS
  )

  it(
    "ends with End, and opens a new one on request",
    async () => {
      await openTerminal()
      await fireEvent.press(screen.getByTestId("terminal-end"))
      expect(await screen.findByText("The terminal was closed.")).toBeTruthy()
      expect(screen.queryByTestId("terminal-keys")).toBeNull()

      await fireEvent.press(screen.getByTestId("terminal-new"))
      await waitFor(() => expect(mockPage.shown).toContain("it runs nothing"))
      expect(screen.queryByTestId("terminal-ended")).toBeNull()
      await typeAndWait("exit\r", /The program ended with 0\./)
      expect(screen.getByTestId("terminal-new")).toBeTruthy()
    },
    FLOW_TIMEOUT_MS
  )

  it(
    "goes on after the connection comes back, without losing what was typed",
    async () => {
      await openTerminal()
      await act(async () =>
        useSessionStore.getState().setSocketState("reconnecting")
      )
      expect(await screen.findByText(/RECONNECTING/)).toBeTruthy()
      // Typed while away: held until the terminal is taken up again.
      await act(async () => mockPage.type("echo back\r"))
      await act(async () => {
        jest.advanceTimersByTime(2_000)
      })
      expect(mockPage.shown).not.toContain("echo back")

      await act(async () => useSessionStore.getState().setSocketState("live"))
      await waitFor(() => expect(mockPage.shown).toMatch(/\r\nback\r\n/))
      expect(mockPage.shown.match(/echo back/g)).toHaveLength(1)
    },
    FLOW_TIMEOUT_MS
  )

  it(
    "says why there is none when the desktop does not allow it",
    async () => {
      await renderRouter(APP_DIRECTORY, { initialUrl: "/demo?speed=instant" })
      await fireEvent.press(
        await screen.findByTestId("thread-row-demo-dark-mode")
      )
      const session = useSessionStore.getState()
      await act(async () =>
        session.setProtocol({
          ...session.protocol!,
          capabilities: {
            ...session.protocol!.capabilities!,
            terminalGranted: false,
          },
        })
      )
      await fireEvent.press(await screen.findByTestId("chat-actions"))
      await fireEvent.press(await screen.findByTestId("chat-terminal"))
      expect(
        await screen.findByText(/does not allow terminals from paired devices/)
      ).toBeTruthy()
      expect(screen.queryByTestId("terminal-view")).toBeNull()

      // A desktop without the terminal offers none.
      await fireEvent.press(screen.getByLabelText("Back"))
      await act(async () =>
        session.setProtocol({
          ...session.protocol!,
          capabilities: {
            ...session.protocol!.capabilities!,
            features: session.protocol!.capabilities!.features.filter(
              (feature) => feature !== REMOTE_FEATURES.terminal
            ),
          },
        })
      )
      await fireEvent.press(await screen.findByTestId("chat-actions"))
      expect(screen.queryByTestId("chat-terminal")).toBeNull()
    },
    FLOW_TIMEOUT_MS
  )
})
