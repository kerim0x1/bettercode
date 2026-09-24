import { TERMINAL_CHANNELS } from "@betterc0de/schema/remote-terminal"
import { isRecord } from "@betterc0de/schema/json-read"
import { RemoteCallError } from "@/transport/live/socket"
import type { RemoteChannel } from "@/transport/types"

/**
 * The desktop's stream as the terminal screen uses it: AppRuntime hands
 * over its channel for calls, and passes each terminal frame here instead
 * of to the chats. A frame no open terminal claims is dropped: it belongs
 * to a terminal the phone has left, which the desktop keeps.
 */

type FrameListener = (frame: unknown) => boolean

let channel: RemoteChannel | null = null
const listeners = new Set<FrameListener>()
/** Workspace → the terminal the phone left running there. */
const leftRunning = new Map<string, string>()

const TERMINAL_FRAME_CHANNELS = new Set<unknown>(
  Object.values(TERMINAL_CHANNELS)
)

/** The connection's channel; a new connection starts with no terminals. */
export function setTerminalChannel(next: RemoteChannel | null): void {
  channel = next
  leftRunning.clear()
}

/**
 * The terminal the phone has in a workspace, to take it up again when the
 * screen opens there next (the desktop names the folder its own way, so
 * the folder alone does not find it).
 */
export function rememberTerminal(
  root: string,
  terminalId: string | null
): void {
  if (terminalId) leftRunning.set(root, terminalId)
  else leftRunning.delete(root)
}

export function rememberedTerminal(root: string): string | undefined {
  return leftRunning.get(root)
}

export function terminalCall(
  method: string,
  params: unknown
): Promise<unknown> {
  if (!channel) {
    return Promise.reject(
      new RemoteCallError("Not connected to the desktop.", "connection_lost")
    )
  }
  return channel.call(method, params)
}

/** Whether `frame` is a terminal's; if so, the open terminal gets it. */
export function deliverTerminalFrame(frame: unknown): boolean {
  if (!isRecord(frame) || !TERMINAL_FRAME_CHANNELS.has(frame.channel))
    return false
  for (const listener of [...listeners]) {
    if (listener(frame)) break
  }
  return true
}

export function onTerminalFrame(listener: FrameListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
