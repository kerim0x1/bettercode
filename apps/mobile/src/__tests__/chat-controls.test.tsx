import path from "node:path"
import { afterEach, describe, expect, it, jest } from "@jest/globals"
import { act, fireEvent, screen, waitFor } from "@testing-library/react-native"
import { renderRouter } from "expo-router/testing-library"
import { Alert, type AlertButton } from "react-native"
import {
  BYPASS_CONFIRM_BODY,
  BYPASS_CONFIRM_TITLE,
} from "@betterc0de/schema/chat-controls"
import ChatScreen from "@/app/chat/[id]"
import { useAppStore } from "@/store/app-store"
import { useComposerSettings } from "@/store/composer-settings-store"
import { useQueueStore } from "@/store/queue-store"
import { useSessionStore } from "@/store/session-store"
import { RemoteApiError } from "@/transport/live/http"
import type { ChatRequestBody } from "@/transport/types"
import { pairWithTestDesktop } from "./support/sessions"

const APP_DIRECTORY = path.resolve(__dirname, "..", "app")
const THREAD = "demo-release-notes"
/** Streaming is timer-driven; give it more than the default second. */
const STREAMED = { timeout: 10_000 }
const FLOW_TIMEOUT_MS = 60_000

afterEach(async () => {
  jest.restoreAllMocks()
  const session = useSessionStore.getState()
  if (session.mode === "demo") session.exitDemo()
  else await session.forget()
  useAppStore.getState().reset()
  useQueueStore.getState().discardAll()
  useComposerSettings.getState().forgetAll()
})

/** The whole app in the demo, on the chat the demo asks an approval in. */
async function openDemoChat() {
  await renderRouter(APP_DIRECTORY, { initialUrl: "/demo?speed=instant" })
  await fireEvent.press(await screen.findByTestId(`thread-row-${THREAD}`))
  return useSessionStore.getState().transport!.api
}

async function write(text: string) {
  await fireEvent.changeText(await screen.findByTestId("chat-input"), text)
}

/** Answers the next Alert by pressing the button with this style. */
function answerAlerts(style: AlertButton["style"]) {
  return jest
    .spyOn(Alert, "alert")
    .mockImplementation((_title, _message, buttons) => {
      buttons?.find((button) => button.style === style)?.onPress?.()
    })
}

describe("chat controls", () => {
  it(
    "queues a message while the agent works and sends it when the turn ends",
    async () => {
      const api = await openDemoChat()
      const sent = jest.spyOn(api, "sendMessage")
      await write("Draft the release notes")
      await fireEvent.press(screen.getByTestId("chat-send"))
      // The demo's agent now waits for an approval: the turn runs.
      expect(await screen.findByText("Run npm test", {}, STREAMED)).toBeTruthy()
      expect(screen.queryByTestId("chat-send")).toBeNull()

      await write("Also update the changelog")
      await fireEvent.press(screen.getByTestId("chat-queue"))
      expect(await screen.findByTestId("queued-messages")).toBeTruthy()
      expect(
        screen.getByText("1 queued · Send after the current turn")
      ).toBeTruthy()
      expect(screen.getByTestId("chat-input").props.value).toBe("")
      expect(sent).toHaveBeenCalledTimes(1)

      await fireEvent.press(screen.getByTestId("request-approve"))
      expect(await screen.findByText(/24 passed/, {}, STREAMED)).toBeTruthy()
      // The turn ended; the queue sends the next message by itself.
      await waitFor(() => expect(sent).toHaveBeenCalledTimes(2), STREAMED)
      expect(sent.mock.calls[1]![0]).toMatchObject({
        threadId: THREAD,
        message: "Also update the changelog",
      })
      expect(
        await screen.findByText("Also update the changelog", {}, STREAMED)
      ).toBeTruthy()
      await waitFor(
        () => expect(screen.queryByTestId("queued-messages")).toBeNull(),
        STREAMED
      )
      expect(useQueueStore.getState().messages).toEqual([])
    },
    FLOW_TIMEOUT_MS
  )

  it(
    "turns on Bypass only after the desktop's warning, and sends the preset and mode",
    async () => {
      const api = await openDemoChat()
      const sent = jest.spyOn(api, "sendMessage")

      // Declining the warning keeps the preset.
      let alert = answerAlerts("cancel")
      await fireEvent.press(await screen.findByTestId("composer-permissions"))
      await fireEvent.press(await screen.findByText("Bypass Permission"))
      expect(alert).toHaveBeenCalledWith(
        BYPASS_CONFIRM_TITLE,
        BYPASS_CONFIRM_BODY,
        expect.any(Array)
      )
      expect(screen.getByLabelText("Permissions: Ask first")).toBeTruthy()

      alert.mockRestore()
      alert = answerAlerts("destructive")
      await fireEvent.press(screen.getByTestId("composer-permissions"))
      await fireEvent.press(await screen.findByText("Bypass Permission"))
      expect(
        await screen.findByLabelText("Permissions: Bypass Permission")
      ).toBeTruthy()

      await fireEvent.press(screen.getByTestId("composer-mode"))
      await fireEvent.press(await screen.findByText("Plan"))
      expect(await screen.findByLabelText("Mode: Plan")).toBeTruthy()

      await write("Plan the release")
      await fireEvent.press(screen.getByTestId("chat-send"))
      await waitFor(() => expect(sent).toHaveBeenCalledTimes(1))
      expect(sent.mock.calls[0]![0]).toMatchObject({
        permissionLevel: "bypass",
        chatMode: "plan",
      })
      // Each chat keeps its own settings.
      expect(
        useComposerSettings.getState().settingsFor("demo-dark-mode")
      ).toEqual({ permissionLevel: "ask-on-edit", chatMode: "agent" })
    },
    FLOW_TIMEOUT_MS
  )
})

describe("always allow", () => {
  it(
    "stores the exact rule it shows, where the user chose",
    async () => {
      const api = await openDemoChat()
      const respond = jest.spyOn(api, "respondApproval")
      await write("Draft the release notes")
      await fireEvent.press(screen.getByTestId("chat-send"))
      expect(await screen.findByText("Run npm test", {}, STREAMED)).toBeTruthy()

      await fireEvent.press(screen.getByTestId("request-always-allow"))
      expect(await screen.findByText("This session")).toBeTruthy()
      expect(screen.getByText("All projects")).toBeTruthy()
      expect(screen.getAllByText("Bash(npm:*)")).toHaveLength(3)
      await fireEvent.press(screen.getByText("This project"))

      await waitFor(() => expect(respond).toHaveBeenCalledTimes(1))
      expect(respond.mock.calls[0]![0]).toMatchObject({
        requestId: expect.any(String),
        decision: "approve",
        updatedPermissions: [
          {
            type: "addRules",
            rules: [{ toolName: "Bash", ruleContent: "npm:*" }],
            behavior: "allow",
            destination: "localSettings",
          },
        ],
      })
      expect(await screen.findByText(/24 passed/, {}, STREAMED)).toBeTruthy()
    },
    FLOW_TIMEOUT_MS
  )

  it(
    "is not offered while the chat's preset is Read-only",
    async () => {
      await openDemoChat()
      await fireEvent.press(await screen.findByTestId("composer-permissions"))
      await fireEvent.press(await screen.findByText("Read-only"))
      expect(
        await screen.findByLabelText("Permissions: Read-only")
      ).toBeTruthy()
      await write("Draft the release notes")
      await fireEvent.press(screen.getByTestId("chat-send"))
      expect(await screen.findByText("Run npm test", {}, STREAMED)).toBeTruthy()
      expect(screen.getByTestId("request-approve")).toBeTruthy()
      expect(screen.queryByTestId("request-always-allow")).toBeNull()
    },
    FLOW_TIMEOUT_MS
  )
})

describe("chats that wait for an answer", () => {
  it(
    "are marked in the list, and in every other chat until answered",
    async () => {
      await openDemoChat()
      await write("Draft the release notes")
      await fireEvent.press(screen.getByTestId("chat-send"))
      expect(await screen.findByText("Run npm test", {}, STREAMED)).toBeTruthy()
      // The waiting chat itself shows the request, not the line.
      expect(screen.queryByTestId("other-chat-waiting")).toBeNull()

      await fireEvent.press(screen.getByLabelText("Back"))
      expect(
        await screen.findByTestId(`thread-attention-${THREAD}`)
      ).toBeTruthy()
      expect(screen.getByText("Waiting for you · 1 approval")).toBeTruthy()

      await fireEvent.press(screen.getByTestId("thread-row-demo-dark-mode"))
      expect(
        await screen.findByText(
          "Release notes for 1.4 waits for you · 1 approval"
        )
      ).toBeTruthy()
      await fireEvent.press(screen.getByTestId("other-chat-waiting"))
      await fireEvent.press(await screen.findByTestId("request-approve"))
      expect(await screen.findByText(/24 passed/, {}, STREAMED)).toBeTruthy()

      await fireEvent.press(screen.getByLabelText("Back"))
      await waitFor(() =>
        expect(screen.queryByTestId("other-chat-waiting")).toBeNull()
      )
    },
    FLOW_TIMEOUT_MS
  )
})

describe("a reply in progress", () => {
  it("shows the tool steps of its turn as the desktop records them", async () => {
    pairWithTestDesktop()
    useAppStore.setState({
      streamsByThread: {
        [THREAD]: {
          turnId: "turn-live",
          content: "",
          reasoning: "",
          running: true,
          error: null,
          startedAt: new Date().toISOString(),
        },
      },
    })
    await renderRouter(
      { "chat/[id]": ChatScreen },
      { initialUrl: `/chat/${THREAD}` }
    )
    await waitFor(() =>
      expect(useAppStore.getState().activitiesByThread[THREAD]).toBeDefined()
    )
    const tool = (kind: string, turnId: string, extra = {}) => ({
      channel: "thread.activity",
      data: {
        id: `${kind}-${turnId}`,
        threadId: THREAD,
        turnId,
        providerInstanceId: "demo-agent",
        kind,
        tone: "tool",
        summary: "Ran command",
        payload: {
          toolId: `tool-${turnId}`,
          toolName: "Bash",
          input: { command: "npm test" },
          ...extra,
        },
        sequence: 1,
        createdAt: new Date().toISOString(),
      },
    })
    await act(async () => {
      // Another turn's step is not this reply's.
      useAppStore.getState().applyFrame(tool("tool.started", "turn-old"))
      useAppStore.getState().applyFrame(tool("tool.started", "turn-live"))
    })
    expect(await screen.findByText("1 step")).toBeTruthy()
    await act(async () => {
      useAppStore
        .getState()
        .applyFrame(
          tool("tool.completed", "turn-live", { output: "24 passed" })
        )
    })
    expect(screen.getByText("1 step")).toBeTruthy()
  })
})

describe("a message the desktop did not take", () => {
  /** A paired desktop whose first answers to /chat/send are these errors. */
  function desktopFailing(...errors: Error[]) {
    const bodies: ChatRequestBody[] = []
    pairWithTestDesktop({
      api: (demo) => ({
        sendMessage: async (body: ChatRequestBody) => {
          bodies.push(body)
          const error = errors.shift()
          if (error) throw error
          return demo.sendMessage(body)
        },
      }),
    })
    return bodies
  }

  async function openChat() {
    await renderRouter(
      { "chat/[id]": ChatScreen },
      { initialUrl: `/chat/${THREAD}` }
    )
    await write("Draft the release notes")
    await waitFor(() =>
      expect(screen.getByTestId("chat-send").props.accessibilityState).toEqual({
        disabled: false,
      })
    )
    await fireEvent.press(screen.getByTestId("chat-send"))
  }

  it("keeps it with Retry, which sends it again under the same id", async () => {
    const bodies = desktopFailing(
      new RemoteApiError("The desktop did not answer in time.", 0, "timeout")
    )
    await openChat()
    expect(await screen.findByText("Failed to send")).toBeTruthy()
    expect(screen.getByText(/did not answer in time/)).toBeTruthy()

    await fireEvent.press(screen.getByTestId("send-retry"))
    await waitFor(() => expect(bodies).toHaveLength(2))
    expect(bodies[1]!.userMessageId).toBe(bodies[0]!.userMessageId)
    await waitFor(() => expect(screen.queryByText("Failed to send")).toBeNull())
    expect(screen.queryByTestId("send-failure")).toBeNull()
    expect(screen.getAllByText("Draft the release notes")).toHaveLength(1)
  })

  it("offers Send as new when the desktop will never take it, and Delete", async () => {
    desktopFailing(
      new RemoteApiError("rejected", 409, "dispatch_failed"),
      new RemoteApiError("rejected", 409, "dispatch_failed")
    )
    await openChat()
    expect(await screen.findByTestId("send-as-new")).toBeTruthy()
    expect(screen.queryByTestId("send-retry")).toBeNull()
    expect(screen.getByText(/could not start it/)).toBeTruthy()

    await fireEvent.press(screen.getByTestId("send-as-new"))
    // The second attempt fails too, as a new message: still one bubble.
    await waitFor(() =>
      expect(screen.getAllByText("Draft the release notes")).toHaveLength(1)
    )
    await fireEvent.press(await screen.findByTestId("send-delete"))
    await waitFor(() =>
      expect(screen.queryByText("Draft the release notes")).toBeNull()
    )
    expect(useAppStore.getState().outbox).toEqual({})
  })
})
