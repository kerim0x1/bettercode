/**
 * Opening find in chat. Ctrl/Cmd+F (`use-global-shortcuts`) and the command
 * palette ask with a window event; the transcript it names, or the one
 * showing the active chat, opens its find bar (`chat/chat-find-bar.tsx`).
 *
 * Ctrl/Cmd+F belongs to the chat only while the chat is where the user is:
 * focus in its transcript or its composer, or nothing focused after a click
 * in it. The editor, terminals and the browser preview keep their own find.
 */

export const CHAT_FIND_OPEN_EVENT = "betterc0de:chat-find-open"

/** On the transcript element find searches (ChatTranscript's `Conversation`). */
export const CHAT_FIND_SCOPE_ATTRIBUTE = "data-betterc0de-chat-find-scope"
/** The chat a transcript shows; empty for a chat not started yet. */
export const CHAT_FIND_THREAD_ATTRIBUTE = "data-betterc0de-chat-find-thread"

/** Set by `ChatInputArea` on its root: the chat the composer writes to. */
const COMPOSER_THREAD_ATTRIBUTE = "data-composer-thread"

/** Surfaces with a find of their own, which Ctrl/Cmd+F must reach. */
const OWN_FIND_SURFACES = [
  ".monaco-editor",
  ".betterc0de-terminal",
  ".xterm",
  "[data-betterc0de-preview]",
  "webview",
  "iframe",
].join(", ")

export interface ChatFindOpenRequest {
  /** The transcript to open in (its element id); unset: the active chat's. */
  scopeId?: string
  /** Set by the transcript that opened, so no other one does. */
  handled?: boolean
}

/** Asks a transcript to open its find bar; true when one did. */
export function requestChatFind(scopeId?: string): boolean {
  if (typeof window === "undefined") return false
  const detail: ChatFindOpenRequest = scopeId === undefined ? {} : { scopeId }
  window.dispatchEvent(
    new CustomEvent<ChatFindOpenRequest>(CHAT_FIND_OPEN_EVENT, { detail })
  )
  return detail.handled === true
}

/**
 * The transcript whose chat `element` belongs to: the transcript itself, or
 * the transcript beside a composer (the nearest one around it, for the same
 * chat). Null for anything else, a chat not started yet, and the surfaces
 * that have their own find.
 */
export function chatFindScopeFor(element: Element | null): HTMLElement | null {
  if (!element || element.closest(OWN_FIND_SURFACES)) return null
  let scope = element.closest<HTMLElement>(`[${CHAT_FIND_SCOPE_ATTRIBUTE}]`)
  if (!scope) {
    const composer = element.closest(`[${COMPOSER_THREAD_ATTRIBUTE}]`)
    if (!composer) return null
    for (let node = composer.parentElement; node; node = node.parentElement) {
      scope = node.querySelector<HTMLElement>(`[${CHAT_FIND_SCOPE_ATTRIBUTE}]`)
      if (scope) break
    }
    if (
      !scope ||
      scope.getAttribute(CHAT_FIND_THREAD_ATTRIBUTE) !==
        composer.getAttribute(COMPOSER_THREAD_ATTRIBUTE)
    ) {
      return null
    }
  }
  return scope.getAttribute(CHAT_FIND_THREAD_ATTRIBUTE) ? scope : null
}

let lastPointerTarget: WeakRef<Element> | null = null
let trackingPointer = false

/**
 * Remembers where the user last pressed. A click on transcript text moves
 * focus to the document body, so a key pressed after it is read against
 * the place that was clicked.
 */
export function noteChatFindPointer(target: EventTarget | null): void {
  lastPointerTarget =
    typeof Element !== "undefined" && target instanceof Element
      ? new WeakRef(target)
      : null
}

/** Starts remembering presses for `resolveChatFindScope`; once per window. */
export function trackChatFindPointer(): void {
  if (trackingPointer || typeof window === "undefined") return
  trackingPointer = true
  window.addEventListener(
    "pointerdown",
    (event) => noteChatFindPointer(event.target),
    true
  )
}

/**
 * The transcript a key event is for, or null when the chat is not where
 * the user is. With nothing focused, the last click decides; without one,
 * Agent mode (where the chat is the main view) falls back to the active
 * pane's chat.
 */
export function resolveChatFindScope(
  target: EventTarget | null,
  options: { fallbackToActiveChat?: boolean } = {}
): HTMLElement | null {
  if (typeof document === "undefined") return null
  let element =
    typeof Element !== "undefined" && target instanceof Element ? target : null
  if (
    !element ||
    element === document.body ||
    element === document.documentElement
  ) {
    const pointer = lastPointerTarget?.deref()
    element = pointer?.isConnected ? pointer : null
    if (!element && options.fallbackToActiveChat) {
      element = document.querySelector('[data-composer-active="true"]')
    }
  }
  return chatFindScopeFor(element)
}
