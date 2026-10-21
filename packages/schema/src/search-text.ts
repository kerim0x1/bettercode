/**
 * Whole-word semantics for text search. The editor's find, find-references,
 * workspace replace and the backend workspace search must agree on them, or
 * "match whole word" finds different hits in an open file than on disk.
 */

/** Characters that continue an identifier-like word (`$` and `-` included). */
export function isSearchWordChar(value: string | undefined): boolean {
  return Boolean(value && /[A-Za-z0-9_$-]/.test(value))
}

/** Whether `text[index, index + length)` is not glued to a word on either side. */
export function isWholeWordMatch(
  text: string,
  index: number,
  length: number
): boolean {
  return (
    !isSearchWordChar(text[index - 1]) &&
    !isSearchWordChar(text[index + length])
  )
}
