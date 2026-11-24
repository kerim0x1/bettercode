/** Shared outer width. Transcript and composer each own the same 16px gutter. */
export function chatContentWidth(minimal: boolean): string {
  return minimal ? "max-w-[1080px]" : "max-w-[var(--chat-max-width)]"
}
