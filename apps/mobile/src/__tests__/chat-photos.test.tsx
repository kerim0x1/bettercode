import path from "node:path"
import { afterEach, describe, expect, it, jest } from "@jest/globals"
import { fireEvent, screen, waitFor } from "@testing-library/react-native"
import { renderRouter } from "expo-router/testing-library"
import { ATTACHMENTS_ONLY_MESSAGE } from "@betterc0de/schema/chat-attachment"
import { NO_ROOM_FOR_PHOTO, pickPhotos } from "@/lib/photo-picker"
import { PHOTO_MAX_BYTES, type PreparedPhoto } from "@/lib/photos"
import { useAppStore } from "@/store/app-store"
import { useComposerSettings } from "@/store/composer-settings-store"
import { useQueueStore } from "@/store/queue-store"
import { useSessionStore } from "@/store/session-store"

// The system's photo picker and camera cannot run in a component test; the
// chat gets the photos they would have prepared.
jest.mock("@/lib/photo-picker", () => ({
  ...jest.requireActual<typeof import("@/lib/photo-picker")>(
    "@/lib/photo-picker"
  ),
  pickPhotos: jest.fn(),
}))

const APP_DIRECTORY = path.resolve(__dirname, "..", "app")
const THREAD = "demo-release-notes"
const STREAMED = { timeout: 10_000 }
const FLOW_TIMEOUT_MS = 60_000

const pick = jest.mocked(pickPhotos)
const photo = (id: string, base64: string): PreparedPhoto => ({
  id,
  width: 4,
  height: 3,
  base64,
})
const attachment = (index: number, base64: string) => ({
  type: "file",
  filename: `photo-${index + 1}.jpg`,
  mediaType: "image/jpeg",
  url: `data:image/jpeg;base64,${base64}`,
})

afterEach(async () => {
  jest.restoreAllMocks()
  pick.mockReset()
  const session = useSessionStore.getState()
  if (session.mode === "demo") session.exitDemo()
  else await session.forget()
  useAppStore.getState().reset()
  useQueueStore.getState().discardAll()
  useComposerSettings.getState().forgetAll()
})

async function openDemoChat() {
  await renderRouter(APP_DIRECTORY, { initialUrl: "/demo?speed=instant" })
  await fireEvent.press(await screen.findByTestId(`thread-row-${THREAD}`))
  return useSessionStore.getState().transport!.api
}

async function write(text: string) {
  await fireEvent.changeText(await screen.findByTestId("chat-input"), text)
}

describe("photos in a message", () => {
  it(
    "sends the photos with the message, shows them in the chat, and the reply names them",
    async () => {
      pick.mockResolvedValueOnce({
        photos: [photo("p1", "AAAA"), photo("p2", "BBBB")],
        problem: null,
      })
      const api = await openDemoChat()
      const sent = jest.spyOn(api, "sendMessage")

      await fireEvent.press(await screen.findByTestId("composer-attach"))
      expect(pick).toHaveBeenCalledWith("library", [], expect.any(Function))
      // Photos may be as large as the desktop's request limit allows.
      expect(pick.mock.calls[0]![2]([])).toBe(PHOTO_MAX_BYTES)
      expect(await screen.findByTestId("composer-photos")).toBeTruthy()
      await fireEvent.press(screen.getByTestId("composer-photo-remove-1"))

      await write("What is wrong here?")
      await fireEvent.press(screen.getByTestId("chat-send"))
      await waitFor(() => expect(sent).toHaveBeenCalledTimes(1))
      expect(sent.mock.calls[0]![0]).toMatchObject({
        message: "What is wrong here?",
        attachments: [attachment(0, "AAAA")],
      })
      expect(screen.queryByTestId("composer-photos")).toBeNull()
      expect(await screen.findByTestId("message-photos")).toBeTruthy()

      await fireEvent.press(
        await screen.findByTestId("request-approve", {}, STREAMED)
      )
      expect(
        await screen.findByText(
          /I received 1 attachment: photo-1\.jpg/,
          {},
          STREAMED
        )
      ).toBeTruthy()
    },
    FLOW_TIMEOUT_MS
  )

  it(
    "sends photos alone with the desktop's words, and takes one with the camera",
    async () => {
      pick.mockResolvedValueOnce({
        photos: [photo("p1", "CCCC")],
        problem: null,
      })
      const api = await openDemoChat()
      const sent = jest.spyOn(api, "sendMessage")
      await fireEvent.press(await screen.findByTestId("composer-camera"))
      expect(pick).toHaveBeenCalledWith("camera", [], expect.any(Function))
      await screen.findByTestId("composer-photos")
      await fireEvent.press(screen.getByTestId("chat-send"))
      await waitFor(() => expect(sent).toHaveBeenCalledTimes(1))
      expect(sent.mock.calls[0]![0]).toMatchObject({
        message: ATTACHMENTS_ONLY_MESSAGE,
        attachments: [attachment(0, "CCCC")],
      })
    },
    FLOW_TIMEOUT_MS
  )

  it(
    "says why a photo was not added",
    async () => {
      pick.mockResolvedValueOnce({ photos: [], problem: NO_ROOM_FOR_PHOTO })
      await openDemoChat()
      await fireEvent.press(await screen.findByTestId("composer-attach"))
      expect(
        (await screen.findByTestId("composer-photo-problem")).props.children
      ).toBe(NO_ROOM_FOR_PHOTO)
      expect(screen.queryByTestId("composer-photos")).toBeNull()
    },
    FLOW_TIMEOUT_MS
  )

  it(
    "queues a message with its photos while the agent works",
    async () => {
      const api = await openDemoChat()
      const sent = jest.spyOn(api, "sendMessage")
      await write("Draft the release notes")
      await fireEvent.press(screen.getByTestId("chat-send"))
      expect(await screen.findByText("Run npm test", {}, STREAMED)).toBeTruthy()

      pick.mockResolvedValueOnce({
        photos: [photo("p1", "DDDD")],
        problem: null,
      })
      await fireEvent.press(screen.getByTestId("composer-attach"))
      await screen.findByTestId("composer-photos")
      await write("And this screen")
      await fireEvent.press(screen.getByTestId("chat-queue"))
      expect(await screen.findByText("1 photo")).toBeTruthy()
      expect(screen.queryByTestId("composer-photos")).toBeNull()

      await fireEvent.press(screen.getByTestId("request-approve"))
      await waitFor(() => expect(sent).toHaveBeenCalledTimes(2), STREAMED)
      expect(sent.mock.calls[1]![0]).toMatchObject({
        message: "And this screen",
        attachments: [attachment(0, "DDDD")],
      })
    },
    FLOW_TIMEOUT_MS
  )
})
