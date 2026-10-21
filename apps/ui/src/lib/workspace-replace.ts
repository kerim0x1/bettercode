import { isWholeWordMatch } from "@betterc0de/schema/search-text"

export interface WorkspaceReplaceTextResult {
  content: string
  count: number
}

export function replaceLiteralInContent(
  content: string,
  query: string,
  replacement: string,
  options: {
    caseSensitive?: boolean
    wholeWord?: boolean
    regex?: boolean
    preserveCase?: boolean
  } = {}
): WorkspaceReplaceTextResult {
  const needle = query
  if (!needle) return { content, count: 0 }
  if (options.regex === true) {
    return replaceRegexInContent(content, needle, replacement, {
      caseSensitive: options.caseSensitive === true,
      wholeWord: options.wholeWord === true,
      preserveCase: options.preserveCase === true,
    })
  }

  const haystack = options.caseSensitive ? content : content.toLowerCase()
  const searchNeedle = options.caseSensitive ? needle : needle.toLowerCase()
  let count = 0
  let searchCursor = 0
  let outputCursor = 0
  let next = ""

  while (searchCursor < content.length) {
    const index = haystack.indexOf(searchNeedle, searchCursor)
    if (index < 0) break
    if (
      options.wholeWord === true &&
      !isWholeWordMatch(content, index, needle.length)
    ) {
      searchCursor = index + needle.length
      continue
    }
    next += content.slice(outputCursor, index)
    next += replacementForMatch(
      replacement,
      content.slice(index, index + needle.length),
      options.preserveCase === true
    )
    searchCursor = index + needle.length
    outputCursor = searchCursor
    count += 1
  }

  if (count === 0) return { content, count }
  next += content.slice(outputCursor)
  return { content: next, count }
}

function replaceRegexInContent(
  content: string,
  query: string,
  replacement: string,
  options: { caseSensitive: boolean; wholeWord: boolean; preserveCase: boolean }
): WorkspaceReplaceTextResult {
  const countRegex = compileReplaceRegex(query, options.caseSensitive)
  const replaceRegex = compileReplaceRegex(query, options.caseSensitive)
  if (!options.wholeWord && !options.preserveCase) {
    const count = countRegexMatches(content, countRegex)
    if (count === 0) return { content, count }
    return {
      content: content.replace(replaceRegex, replacement),
      count,
    }
  }

  let count = 0
  const next = content.replace(replaceRegex, (...args) => {
    const match = String(args[0] ?? "")
    const offset = regexReplacementOffset(args)
    if (options.wholeWord && !isWholeWordMatch(content, offset, match.length))
      return match
    count += 1
    return replacementForMatch(
      expandRegexReplacement(replacement, args),
      match,
      options.preserveCase
    )
  })

  return count === 0 ? { content, count } : { content: next, count }
}

function replacementForMatch(
  replacement: string,
  match: string,
  preserveCase: boolean
): string {
  if (!preserveCase || !replacement || !match) return replacement
  if (!/[A-Z]/i.test(match)) return replacement
  if (match.toUpperCase() === match) {
    return replacement.toUpperCase()
  }
  if (match.toLowerCase() === match) {
    return replacement.toLowerCase()
  }
  if (
    match[0]?.toUpperCase() === match[0] &&
    match.slice(1).toLowerCase() === match.slice(1)
  ) {
    return `${replacement[0]?.toUpperCase() ?? ""}${replacement
      .slice(1)
      .toLowerCase()}`
  }
  return replacement
}

function countRegexMatches(content: string, regex: RegExp): number {
  let count = 0
  let match: RegExpExecArray | null
  while ((match = regex.exec(content)) !== null) {
    count += 1
    if ((match[0] ?? "").length === 0) regex.lastIndex = match.index + 1
  }
  return count
}

function compileReplaceRegex(query: string, caseSensitive: boolean): RegExp {
  try {
    return new RegExp(query, caseSensitive ? "g" : "gi")
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`Invalid replace regex: ${message}`)
  }
}

function expandRegexReplacement(replacement: string, args: unknown[]): string {
  const match = String(args[0] ?? "")
  const captureEnd = regexReplacementOffsetIndex(args)
  const captures = args.slice(1, captureEnd)
  return replacement.replace(/\$([$&]|\d{1,2})/g, (token, key: string) => {
    if (key === "$") return "$"
    if (key === "&") return match
    const index = Number(key)
    if (!Number.isFinite(index) || index <= 0) return token
    const value = captures[index - 1]
    return typeof value === "string" ? value : ""
  })
}

function regexReplacementOffset(args: unknown[]): number {
  const offset = args[regexReplacementOffsetIndex(args)]
  return typeof offset === "number" ? offset : 0
}

function regexReplacementOffsetIndex(args: unknown[]): number {
  const hasGroups =
    args.length > 0 &&
    typeof args[args.length - 1] === "object" &&
    args[args.length - 1] !== null
  return hasGroups ? args.length - 3 : args.length - 2
}
