/** Ctrl and Alt from the key bar: held for the next key, then let go. */
export interface Modifiers {
  readonly ctrl: boolean
  readonly alt: boolean
}

const ESCAPE = "\u001b"

/**
 * Input as a terminal gets it with the modifiers held: Ctrl with a letter
 * (or `@ [ \ ] ^ _`) is that control character, Ctrl with space NUL and with
 * `?` DEL; Alt puts Esc before the key. Ctrl applies to one typed
 * character; anything longer (a paste, a key's sequence) goes as it is,
 * with Alt's Esc before it.
 */
export function withModifiers(data: string, modifiers: Modifiers): string {
  let input = data
  if (modifiers.ctrl && [...data].length === 1) {
    const code = data.toUpperCase().charCodeAt(0)
    if (code >= 0x40 && code <= 0x5f) input = String.fromCharCode(code - 0x40)
    else if (data === " ") input = "\u0000"
    else if (data === "?") input = "\u007f"
  }
  return modifiers.alt ? `${ESCAPE}${input}` : input
}
