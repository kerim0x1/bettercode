import { create } from "zustand"
import { detectSlashCommandTrigger } from "@/lib/slash-command-query"

export type SlashTrigger = "/" | "$"

export interface SlashRange {
  start: number
  end: number
}

/**
 * The composer's `/` (or `$`) and `@` autocomplete state.
 *
 * The composer re-checks its text on every keystroke. This used to be
 * `useState` in the app-shell hook, so each keystroke after `/` or `@`
 * re-rendered the whole shell. As a store, only the focused composer's menus
 * subscribe; the shell and the submit handler use the stable actions.
 *
 * One menu state is shared by every composer: only the focused composer's
 * input updates it, and only the active column shows the menus.
 */
export interface ComposerMenuState {
  slashActive: boolean
  slashQuery: string
  slashTrigger: SlashTrigger
  /** Range of the trigger the menu was opened for, when known. */
  slashRange: SlashRange | null
  mentionActive: boolean
  mentionQuery: string
  /** Opens, updates or closes the slash menu for the text at `cursor`. */
  checkSlash: (text: string, cursor?: number) => void
  closeSlash: () => void
  /** Opens, updates or closes the `@` file menu for the text. */
  checkMention: (text: string) => void
  closeMention: () => void
}

const CLOSED_SLASH = {
  slashActive: false,
  slashQuery: "",
  slashTrigger: "/",
  slashRange: null,
} satisfies Partial<ComposerMenuState>

/** The `@` token being typed at the end of `text`, or null when there is none. */
export function detectMentionQuery(text: string): string | null {
  const atIdx = text.lastIndexOf("@")
  if (atIdx < 0) return null
  const query = text.slice(atIdx + 1)
  return query.includes(" ") ? null : query
}

export const useComposerMenuStore = create<ComposerMenuState>()((set, get) => ({
  ...CLOSED_SLASH,
  mentionActive: false,
  mentionQuery: "",

  checkSlash: (text, cursor = text.length) => {
    const trigger = detectSlashCommandTrigger(text, cursor)
    const current = get()
    if (!trigger) {
      // Keeps the last trigger character, like closing by typing on.
      if (!current.slashActive && current.slashRange === null) return
      set({ slashActive: false, slashQuery: "", slashRange: null })
      return
    }
    if (
      current.slashActive &&
      current.slashTrigger === trigger.trigger &&
      current.slashQuery === trigger.query &&
      current.slashRange?.start === trigger.rangeStart &&
      current.slashRange?.end === trigger.rangeEnd
    )
      return
    set({
      slashActive: true,
      slashTrigger: trigger.trigger,
      slashQuery: trigger.query,
      slashRange: { start: trigger.rangeStart, end: trigger.rangeEnd },
    })
  },

  closeSlash: () => {
    const current = get()
    if (
      !current.slashActive &&
      current.slashQuery === "" &&
      current.slashTrigger === "/" &&
      current.slashRange === null
    )
      return
    set(CLOSED_SLASH)
  },

  checkMention: (text) => {
    const query = detectMentionQuery(text)
    const current = get()
    const active = query !== null
    const nextQuery = query ?? ""
    if (current.mentionActive === active && current.mentionQuery === nextQuery)
      return
    set({ mentionActive: active, mentionQuery: nextQuery })
  },

  closeMention: () => {
    const current = get()
    if (!current.mentionActive && current.mentionQuery === "") return
    set({ mentionActive: false, mentionQuery: "" })
  },
}))

/**
 * The store's actions. They never change identity, so passing them down
 * (or calling them from a submit handler) does not subscribe to the menus.
 */
export function composerMenuActions(): Pick<
  ComposerMenuState,
  "checkSlash" | "closeSlash" | "checkMention" | "closeMention"
> {
  return useComposerMenuStore.getState()
}
