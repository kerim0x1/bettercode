import path from "node:path"
import { afterEach, describe, expect, it, jest } from "@jest/globals"
import { act, fireEvent, screen, waitFor } from "@testing-library/react-native"
import { renderRouter } from "expo-router/testing-library"
import { Alert, type AlertButton } from "react-native"
import { draftFor } from "@/lib/editor-drafts"
import { useAppStore } from "@/store/app-store"
import { useSessionStore } from "@/store/session-store"

// The editor against the demo desktop, through the app's real routes. The
// WebView cannot run here: a stand-in speaks the editor's protocol
// (src/editor/protocol.ts) the way the real page does.
const APP_DIRECTORY = path.resolve(__dirname, "..", "app")
const FLOW_TIMEOUT_MS = 60_000
const ROOT = "/Users/demo/code/weather-app"

type Send = (data: string) => void
interface MockWebViewProps {
  onMessage?: (event: { nativeEvent: { data: string } }) => void
  onRenderProcessGone?: () => void
}

const mockEditor = {
  text: "",
  loaded: "",
  /** Whether the page holds a text: not before a load, nor after it ended. */
  holding: false,
  commands: [] as Array<{ type: string; [key: string]: unknown }>,
  send: null as Send | null,
  webview: null as { current: MockWebViewProps } | null,
  emit(event: unknown) {
    this.send?.(JSON.stringify(event))
  },
  /** Someone types: the text changes and the page reports it. */
  type(text: string) {
    this.text = text
    this.emit({
      type: "changed",
      dirty: text !== this.loaded,
      canUndo: true,
      canRedo: false,
    })
  },
  receive(data: string) {
    const command = JSON.parse(data) as { type: string; [key: string]: unknown }
    this.commands.push(command)
    if (command.type === "load") {
      this.text = String(command.text)
      this.loaded = this.text
      this.holding = true
      this.emit({
        type: "changed",
        dirty: false,
        canUndo: false,
        canRedo: false,
      })
    } else if (command.type === "requestText") {
      this.emit({
        type: "text",
        requestId: command.requestId,
        text: this.holding ? this.text : null,
      })
    } else if (command.type === "markSaved") {
      this.loaded = String(command.text)
      this.emit({
        type: "changed",
        dirty: this.text !== this.loaded,
        canUndo: true,
        canRedo: false,
      })
    }
  },
  /** The system ends the page's process, and its text with it. */
  endProcess() {
    this.text = ""
    this.loaded = ""
    this.holding = false
    this.webview?.current.onRenderProcessGone?.()
  },
  reset() {
    this.text = ""
    this.loaded = ""
    this.holding = false
    this.commands = []
    this.send = null
    this.webview = null
  },
}

jest.mock("react-native-webview", () => {
  const React = jest.requireActual<typeof import("react")>("react")
  const { View } =
    jest.requireActual<typeof import("react-native")>("react-native")
  const WebView = React.forwardRef(function WebView(
    props: MockWebViewProps,
    ref: React.Ref<{ postMessage: (data: string) => void }>
  ) {
    const latest = React.useRef(props)
    latest.current = props
    React.useImperativeHandle(ref, () => ({
      postMessage: (data: string) => mockEditor.receive(data),
    }))
    React.useEffect(() => {
      mockEditor.webview = latest
      mockEditor.send = (data) =>
        latest.current.onMessage?.({ nativeEvent: { data } })
      // The page says ready once, when it has started, as the real one does.
      mockEditor.emit({ type: "ready" })
    }, [])
    return <View testID="webview" />
  })
  return { WebView }
})

afterEach(async () => {
  jest.restoreAllMocks()
  mockEditor.reset()
  const session = useSessionStore.getState()
  if (session.mode === "demo") session.exitDemo()
  else await session.forget()
  useAppStore.getState().reset()
})

/** Answers every Alert by pressing the button with this text. */
function answerAlerts(text: string) {
  return jest
    .spyOn(Alert, "alert")
    .mockImplementation((_title, _message, buttons?: AlertButton[]) => {
      buttons?.find((button) => button.text === text)?.onPress?.()
    })
}

const demoApi = () => useSessionStore.getState().transport!.api

async function openTheme() {
  await renderRouter(APP_DIRECTORY, { initialUrl: "/demo?speed=instant" })
  await fireEvent.press(await screen.findByTestId("thread-row-demo-dark-mode"))
  await fireEvent.press(await screen.findByTestId("chat-files"))
  await fireEvent.press(await screen.findByTestId("file-row-src"))
  await fireEvent.press(await screen.findByTestId("file-row-theme.ts"))
  await fireEvent.press(await screen.findByTestId("file-edit"))
  await waitFor(() => expect(mockEditor.loaded).toContain("export const dark"))
}

describe("the editor", () => {
  it(
    "saves an edit over the version it was made on, and the viewer shows it",
    async () => {
      await openTheme()
      expect(mockEditor.commands[0]).toMatchObject({
        type: "load",
        language: "typescript",
        readOnly: false,
      })
      expect(screen.getByTestId("editor-save")).toBeDisabled()

      const edited = `// Edited\n${mockEditor.loaded}`
      await act(async () => mockEditor.type(edited))
      expect(await screen.findByText(/UNSAVED/)).toBeTruthy()
      await fireEvent.press(screen.getByTestId("editor-save"))
      await waitFor(() => expect(screen.queryByText(/UNSAVED/)).toBeNull())
      expect(mockEditor.commands.at(-1)).toEqual({
        type: "markSaved",
        text: edited,
      })

      const saved = await demoApi().readFile(ROOT, `${ROOT}/src/theme.ts`)
      expect(saved.content.startsWith("// Edited\n")).toBe(true)

      await fireEvent.press(screen.getByLabelText("Back"))
      expect(await screen.findByText("// Edited")).toBeTruthy()
    },
    FLOW_TIMEOUT_MS
  )

  it(
    "compares, takes the desktop's version or overwrites it when the file changed meanwhile",
    async () => {
      await openTheme()
      await act(async () => mockEditor.type("mine\n"))
      await demoApi().writeFile(ROOT, "src/theme.ts", "theirs\n")

      await fireEvent.press(screen.getByTestId("editor-save"))
      expect(await screen.findByTestId("editor-conflict")).toBeTruthy()
      expect(screen.getByText("Changed on the desktop")).toBeTruthy()

      await fireEvent.press(screen.getByTestId("editor-compare"))
      expect(await screen.findByTestId("editor-comparison")).toBeTruthy()
      expect(screen.getByText(/theirs/)).toBeTruthy()
      await fireEvent.press(screen.getByTestId("editor-compare-close"))

      await fireEvent.press(screen.getByTestId("editor-overwrite"))
      await waitFor(() =>
        expect(screen.queryByTestId("editor-conflict")).toBeNull()
      )
      expect(
        (await demoApi().readFile(ROOT, `${ROOT}/src/theme.ts`)).content
      ).toBe("mine\n")

      // Changed again on the desktop: this time its version wins.
      await act(async () => mockEditor.type("mine again\n"))
      await demoApi().writeFile(ROOT, "src/theme.ts", "theirs again\n")
      await fireEvent.press(screen.getByTestId("editor-save"))
      await fireEvent.press(await screen.findByTestId("editor-take-theirs"))
      await waitFor(() => expect(mockEditor.loaded).toBe("theirs again\n"))
      expect(
        (await demoApi().readFile(ROOT, `${ROOT}/src/theme.ts`)).content
      ).toBe("theirs again\n")
    },
    FLOW_TIMEOUT_MS
  )

  it(
    "keeps what was typed while a save was on its way unsaved",
    async () => {
      await openTheme()
      await act(async () => mockEditor.type("first\n"))
      const api = demoApi()
      const write = api.writeFile.bind(api)
      jest.spyOn(api, "writeFile").mockImplementationOnce(async (...args) => {
        // Typed after the save took the text, before the desktop answered.
        mockEditor.type("first\nsecond\n")
        return write(...args)
      })

      await fireEvent.press(screen.getByTestId("editor-save"))
      await waitFor(() =>
        expect(mockEditor.commands.at(-1)).toEqual({
          type: "markSaved",
          text: "first\n",
        })
      )
      expect(screen.getByText(/UNSAVED/)).toBeTruthy()
      expect(screen.getByTestId("editor-save")).toBeEnabled()
      expect((await api.readFile(ROOT, `${ROOT}/src/theme.ts`)).content).toBe(
        "first\n"
      )
    },
    FLOW_TIMEOUT_MS
  )

  it(
    "does not overwrite a change made on the desktop right after a save",
    async () => {
      await openTheme()
      await act(async () => mockEditor.type("mine\n"))
      const api = demoApi()
      const write = api.writeFile.bind(api)
      jest.spyOn(api, "writeFile").mockImplementationOnce(async (...args) => {
        await write(...args)
        // The desktop changes the file the moment the phone's save is in.
        await write(ROOT, "src/theme.ts", "desktop\n")
      })
      await fireEvent.press(screen.getByTestId("editor-save"))
      await waitFor(() => expect(screen.queryByText(/UNSAVED/)).toBeNull())

      await act(async () => mockEditor.type("mine, again\n"))
      await fireEvent.press(screen.getByTestId("editor-save"))
      expect(await screen.findByTestId("editor-conflict")).toBeTruthy()
      expect((await api.readFile(ROOT, `${ROOT}/src/theme.ts`)).content).toBe(
        "desktop\n"
      )
    },
    FLOW_TIMEOUT_MS
  )

  it(
    "saves without asking when the desktop's file changed to the same text",
    async () => {
      await openTheme()
      await act(async () => mockEditor.type("same\n"))
      await demoApi().writeFile(ROOT, "src/theme.ts", "same\n")

      await fireEvent.press(screen.getByTestId("editor-save"))
      await waitFor(() => expect(screen.queryByText(/UNSAVED/)).toBeNull())
      expect(screen.queryByTestId("editor-conflict")).toBeNull()
      expect(mockEditor.commands.at(-1)).toEqual({
        type: "markSaved",
        text: "same\n",
      })
    },
    FLOW_TIMEOUT_MS
  )

  it(
    "keeps unsaved edits as a draft and offers them again",
    async () => {
      await openTheme()
      await act(async () => mockEditor.type("draft\n"))
      await fireEvent.press(screen.getByLabelText("Back"))

      expect(await screen.findByTestId("file-draft")).toBeTruthy()
      const alert = answerAlerts("Continue")
      await fireEvent.press(screen.getByText("Continue editing"))
      await waitFor(() => expect(mockEditor.loaded).toBe("draft\n"))
      expect(alert).toHaveBeenCalledWith(
        "Unsaved changes",
        expect.stringMatching(/You changed this file on this phone/),
        expect.any(Array)
      )
      // The draft's changes are unsaved, though the editor started with them.
      expect(screen.getByText(/UNSAVED/)).toBeTruthy()
      expect(screen.getByTestId("editor-save")).toBeEnabled()
    },
    FLOW_TIMEOUT_MS
  )

  it(
    "starts the editor again with the newest text when the system ends its page",
    async () => {
      await openTheme()
      await act(async () => mockEditor.type("drafted\n"))
      await waitFor(
        () => expect(draftFor(ROOT, "src/theme.ts")?.text).toBe("drafted\n"),
        { timeout: 5_000 }
      )

      await act(async () => mockEditor.endProcess())
      await waitFor(() => expect(mockEditor.loaded).toBe("drafted\n"))
      const loads = mockEditor.commands.filter(({ type }) => type === "load")
      expect(loads).toHaveLength(2)
      expect(loads[1]).toMatchObject({ type: "load", text: "drafted\n" })
      expect(screen.getByText(/UNSAVED/)).toBeTruthy()
      await fireEvent.press(screen.getByTestId("editor-save"))
      await waitFor(() => expect(screen.queryByText(/UNSAVED/)).toBeNull())
      expect(
        (await demoApi().readFile(ROOT, `${ROOT}/src/theme.ts`)).content
      ).toBe("drafted\n")
    },
    FLOW_TIMEOUT_MS
  )

  it(
    "never saves a text the editor does not hold",
    async () => {
      await openTheme()
      const original = mockEditor.loaded
      await act(async () => mockEditor.type("mine\n"))
      // The page lost its text and has not said ready again.
      mockEditor.holding = false
      const alert = jest
        .spyOn(Alert, "alert")
        .mockImplementation(() => undefined)

      await fireEvent.press(screen.getByTestId("editor-save"))
      await waitFor(() =>
        expect(alert).toHaveBeenCalledWith(
          "Something went wrong",
          "The editor has no text to hand over."
        )
      )
      expect(
        (await demoApi().readFile(ROOT, `${ROOT}/src/theme.ts`)).content
      ).toBe(original)
    },
    FLOW_TIMEOUT_MS
  )

  it(
    "is not offered for a file too large to edit on the phone",
    async () => {
      await renderRouter(APP_DIRECTORY, { initialUrl: "/demo?speed=instant" })
      await demoApi().writeFile(
        ROOT,
        "big.txt",
        `${"x".repeat(1024)}\n`.repeat(1100),
        null
      )
      await fireEvent.press(
        await screen.findByTestId("thread-row-demo-dark-mode")
      )
      await fireEvent.press(await screen.findByTestId("chat-files"))
      await fireEvent.press(await screen.findByTestId("file-row-big.txt"))
      expect(await screen.findByText(/READ ONLY/)).toBeTruthy()
      expect(screen.queryByTestId("file-edit")).toBeNull()
    },
    FLOW_TIMEOUT_MS
  )
})
