import { z } from "zod"

/**
 * How the app and its terminal page talk. The page is xterm.js in a
 * WebView (apps/mobile/terminal, bundled into terminal-html.ts): the app
 * sends commands as JSON messages, the page answers with events, and the
 * app checks every event before it acts on one.
 */

/**
 * Keys the key bar sends by name. The page turns them into what the
 * terminal expects in its current mode (cursor keys differ in full-screen
 * programs), and sends that back as input.
 */
export const TERMINAL_KEYS = [
  "escape",
  "tab",
  "up",
  "down",
  "left",
  "right",
  "home",
  "end",
  "pageUp",
  "pageDown",
] as const
export type TerminalKey = (typeof TERMINAL_KEYS)[number]

/** From the app to the page. */
export type TerminalPageCommand =
  /** Output from the desktop (or the app's own notes), shown as a terminal would. */
  | { type: "output"; data: string }
  | { type: "key"; key: TerminalKey }
  | { type: "focus" }
  | { type: "reset" }

const size = z.number().int().min(1).max(1_000)

/** From the page to the app. */
export const terminalPageEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready"), cols: size, rows: size }),
  /** What was typed or pasted, or a key bar key's sequence. */
  z.object({
    type: z.literal("input"),
    data: z
      .string()
      .min(1)
      .max(256 * 1024),
  }),
  z.object({ type: z.literal("resize"), cols: size, rows: size }),
  z.object({ type: z.literal("error"), message: z.string().max(2_000) }),
])
export type TerminalPageEvent = z.infer<typeof terminalPageEventSchema>

/** An event from the page, or null for anything that is not one. */
export function parseTerminalPageEvent(data: string): TerminalPageEvent | null {
  try {
    const parsed = terminalPageEventSchema.safeParse(JSON.parse(data))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}
