import { displayCommand } from "./command-display"
import { recordOrUndefined } from "./json-read"

export type ToolLifecycleItemType =
  | "command_execution"
  | "dynamic_tool_call"
  | "file_change"
  | "web_search"
  | (string & {})

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

export const normalizeProviderToolCommandValue = displayCommand

function stripTrailingExitCode(value: string | undefined): string | undefined {
  return (
    value
      ?.trim()
      .replace(/\s*<exited with exit code \d+>$/u, "")
      .trim() || undefined
  )
}

function extractCommandFromTitle(
  title: string | undefined
): string | undefined {
  if (title === undefined) return
  for (
    let opening = title.indexOf(String.fromCharCode(96));
    opening >= 0;
    opening = title.indexOf(String.fromCharCode(96), opening + 1)
  ) {
    const closing = title.indexOf(String.fromCharCode(96), opening + 1)
    if (closing > opening + 1)
      return title.substring(opening + 1, closing).trim() || undefined
  }
}

function extractToolCommand(
  data: Record<string, unknown> | undefined,
  title: string | undefined
) {
  const item = recordOrUndefined(data?.item)
  const raw = recordOrUndefined(data?.rawInput)
  for (const source of [
    item,
    recordOrUndefined(item?.input),
    recordOrUndefined(item?.result),
    data,
    raw,
  ]) {
    const command = normalizeProviderToolCommandValue(source?.command)
    if (command) return command
  }
  const program = asTrimmedString(raw?.executable)
  if (!program) return extractCommandFromTitle(title)
  if (Array.isArray(raw?.args)) return displayCommand([program, ...raw.args])
  const argumentsText = asTrimmedString(raw?.args)
  return argumentsText
    ? displayCommand([program, argumentsText].join(" "))
    : program
}

function maybePathLike(value: string | undefined): string | undefined {
  return value && /[/\\]|^\.|\.[a-z0-9]{1,12}$/i.test(value) ? value : undefined
}

// `target_file` / `target_directory` are what Grok's ACP tools send; `absolute_path`
// is what its results echo back. Without them a Grok read had no file to show.
const pathFields = [
  "path",
  "filePath",
  "file_path",
  "target_file",
  "relativePath",
  "relative_path",
  "filename",
  "target_directory",
  "directory",
  "newPath",
  "new_path",
  "oldPath",
  "old_path",
  "absolute_path",
] as const
const pathContainers = [
  "locations",
  "item",
  "input",
  "result",
  "rawInput",
  "data",
  "changes",
] as const

function* nestedPathValues(value: unknown): Generator<unknown> {
  if (Array.isArray(value)) yield* value
  else {
    const record = recordOrUndefined(value)
    if (record) for (const key of pathContainers) yield record[key]
  }
}

function extractPrimaryPath(
  data: Record<string, unknown> | undefined
): string | undefined {
  const stack: Array<{ entries: Iterator<unknown>; depth: number }> = [
    { entries: [data].values(), depth: 0 },
  ]
  while (stack.length) {
    const frame = stack[stack.length - 1]!
    const next = frame.entries.next()
    if (next.done) {
      stack.pop()
      continue
    }
    const record = recordOrUndefined(next.value)
    if (record) {
      for (const field of pathFields) {
        const path = maybePathLike(asTrimmedString(record[field]))
        if (path) return path
      }
    }
    // Lazy iterators bound memory by nesting depth even for large location arrays.
    if (frame.depth < 4)
      stack.push({
        entries: nestedPathValues(next.value),
        depth: frame.depth + 1,
      })
  }
}

function normalizeEquivalentValue(
  value: string | undefined
): string | undefined {
  if (!value?.trim()) return
  const words = value.trim().split(/\s+/u)
  if (words.length > 1 && /^(complete|completed|started)$/i.test(words.at(-1)!))
    words.pop()
  return words.join(" ")
}

function isEquivalent(
  left: string | undefined,
  right: string | undefined
): boolean {
  const normalizedLeft = normalizeEquivalentValue(left)?.toLowerCase()
  const normalizedRight = normalizeEquivalentValue(right)?.toLowerCase()
  return normalizedLeft !== undefined && normalizedLeft === normalizedRight
}

function normalizeInlinePreview(value: string): string {
  return value.replace(/\s+/gu, " ").trim()
}

function truncateInlinePreview(value: string, maxLength = 84): string {
  if (value.length <= maxLength) return value
  return `${value.slice(0, maxLength - 3).trimEnd()}...`
}

function summarizeToolTextOutput(value: string): string | undefined {
  const lines = value
    .split(/\r?\n/u)
    .map((line) => normalizeInlinePreview(line))
    .filter((line) => line.length > 0)
  const firstLine = lines.find((line) => line !== "```")
  if (firstLine) return truncateInlinePreview(firstLine)
  if (lines.length > 1) return `${lines.length.toLocaleString()} lines`
  return undefined
}

function summarizeToolRawOutput(
  data: Record<string, unknown> | undefined
): string | undefined {
  const output = recordOrUndefined(data?.rawOutput)
  const count = output?.totalFiles
  if (typeof count === "number" && Number.isFinite(count)) {
    return [
      count.toLocaleString(),
      count === 1 ? " file" : " files",
      output?.truncated === true ? "+" : "",
    ].join("")
  }
  const text =
    asTrimmedString(output?.content) ?? asTrimmedString(output?.stdout)
  return text ? summarizeToolTextOutput(text) : undefined
}

export type ToolAction =
  | "command"
  | "read"
  | "file_change"
  | "search"
  | "list"
  | "other"

const activityKinds: ReadonlyArray<{
  action: ToolAction
  items: readonly string[]
  kinds: readonly string[]
  titles: readonly string[]
}> = [
  {
    action: "command",
    items: ["command_execution"],
    kinds: ["execute"],
    titles: ["terminal", "execute", "bash", "shell", "exec", "run command"],
  },
  {
    action: "read",
    items: [],
    kinds: ["read"],
    titles: ["read file", "read", "readfile", "cat", "view", "view file"],
  },
  {
    action: "file_change",
    items: ["file_change"],
    kinds: ["edit", "move", "delete", "write"],
    titles: [
      "write",
      "write file",
      "edit",
      "edit file",
      "multiedit",
      "apply patch",
      "patch",
      "create file",
    ],
  },
  {
    action: "search",
    items: ["web_search"],
    kinds: ["search"],
    titles: ["find", "grep", "glob", "search", "search files", "rg"],
  },
  {
    action: "list",
    items: [],
    kinds: ["list"],
    titles: ["list", "ls", "list dir", "list directory", "listdir"],
  },
]

/**
 * The words of a title before any backticked argument, normalised for
 * matching: "Read `C:\\repo\\slash-command-runtime.ts`" → "read",
 * "read_file" → "read file". Matching the whole title instead would let the
 * *argument* decide the action — that path contains "command", so a read
 * scoped to it used to render as "Ran command".
 */
function titleHead(title: string | undefined): string {
  if (!title) return ""
  const head = title.split(String.fromCharCode(96))[0] ?? ""
  return head.replace(/[_-]+/gu, " ").replace(/\s+/gu, " ").trim().toLowerCase()
}

function classifyToolAction(input: {
  readonly itemType?: ToolLifecycleItemType | null | undefined
  readonly title?: string | undefined
  readonly data?: Record<string, unknown> | undefined
}): ToolAction {
  const evidence = {
    items: input.itemType ?? "",
    kinds: asTrimmedString(input.data?.kind)?.toLowerCase() ?? "",
    titles: titleHead(input.title),
  }
  // Stronger evidence first, across every rule: a provider-classified search
  // whose title happens to read "readFile" is still a search.
  for (const key of ["items", "kinds", "titles"] as const) {
    const match = activityKinds.find((rule) =>
      rule[key].includes(evidence[key])
    )
    if (match) return match.action
  }
  return "other"
}

/**
 * Kinds that carry no classification of their own: what a provider reports
 * when it has not classified the call, plus lifecycle item types that legacy
 * payloads hand over in the `kind` slot (those are read from `itemType`).
 */
const GENERIC_TOOL_KINDS = new Set([
  "other",
  "unknown",
  "tool",
  "dynamic_tool_call",
  "command_execution",
  "file_change",
  "web_search",
])

function explicitToolKind(kind: string | null | undefined): string | undefined {
  const normalized = asTrimmedString(kind)?.toLowerCase()
  return normalized && !GENERIC_TOOL_KINDS.has(normalized)
    ? normalized
    : undefined
}

/** Names that stand in for a tool until the provider says which one it is. */
const GENERIC_TOOL_NAMES = new Set([
  "",
  "tool",
  "unknown",
  "function",
  "tool_call",
  "dynamic_tool_call",
  "command_execution",
  "file_change",
  "web_search",
])

/**
 * True for a placeholder name a lifecycle event carries before the provider
 * names the tool. Consumers keep the first *real* name and let later events
 * update only the title: ACP titles change per event and, for a search, the
 * title is the pattern itself — no basis for classifying anything.
 */
export function isGenericToolName(name: string | null | undefined): boolean {
  return GENERIC_TOOL_NAMES.has(name?.trim().toLowerCase() ?? "")
}

/** Grok's ACP names the concrete tool in `rawInput.variant` before `kind` arrives. */
function kindFromInputVariant(
  rawInput: Record<string, unknown> | undefined
): string | undefined {
  const variant = asTrimmedString(rawInput?.variant)
    ?.toLowerCase()
    .replace(/[\s_-]+/gu, "")
  if (!variant) return undefined
  if (variant === "readfile" || variant === "read") return "read"
  if (
    /^(?:grep|glob|search|grepsearch|globsearch|memorysearch|websearch|find)$/u.test(
      variant
    )
  )
    return "search"
  if (variant === "listdir" || variant === "ls" || variant === "list")
    return "list"
  if (
    /^(?:write|edit|multiedit|searchreplace|strreplace|applypatch|patch|createfile|delete|move|rename)$/u.test(
      variant
    )
  )
    return "edit"
  if (/^(?:bash|shell|execute|exec|powershell|cmd|terminal)$/u.test(variant))
    return "execute"
  if (variant === "todowrite" || variant === "todo") return "think"
  return undefined
}

const pathInputKeys = [
  "path",
  "filePath",
  "file_path",
  "target_file",
  "filename",
  "notebook_path",
] as const
const contentInputKeys = [
  "content",
  "contents",
  "new_content",
  "file_text",
] as const

/** What the input fields say the call does, independent of any title. */
function kindFromInputShape(
  rawInput: Record<string, unknown> | undefined
): string | undefined {
  if (!rawInput) return undefined
  if (
    normalizeProviderToolCommandValue(rawInput.command) ||
    asTrimmedString(rawInput.executable)
  )
    return "execute"
  if (
    ["old_string", "new_string", "edits", "patch", "diff", "new_source"].some(
      (key) => rawInput[key] !== undefined
    )
  )
    return "edit"
  const hasPath = pathInputKeys.some((key) => asTrimmedString(rawInput[key]))
  if (
    hasPath &&
    contentInputKeys.some((key) => typeof rawInput[key] === "string")
  )
    return "edit"
  if (
    ["pattern", "query", "regex", "searchTerm", "search_term"].some((key) =>
      asTrimmedString(rawInput[key])
    )
  )
    return "search"
  if (
    ["target_directory", "directory", "dir"].some((key) =>
      asTrimmedString(rawInput[key])
    )
  )
    return "list"
  return undefined
}

/** What a tool name or title head says the call does. */
function kindFromLabel(label: string | undefined): string | undefined {
  const head = titleHead(label)
  if (!head) return undefined
  if (/todo/u.test(head)) return "think"
  if (/(?:bash|shell|exec|command|terminal)/u.test(head)) return "execute"
  if (/(?:write|edit|patch|apply patch|file change|move|delete)/u.test(head))
    return "edit"
  if (/(?:grep|search|glob|find|rg|ripgrep)/u.test(head)) return "search"
  if (/(?:^|\s)(?:ls|list(?: ?dir(?:ectory)?)?)(?:$|\s)/u.test(head))
    return "list"
  if (/(?:read|cat|view|open)/u.test(head)) return "read"
  return undefined
}

/**
 * Evidence order: what the provider classified → what the input names the
 * tool → what the input's fields imply → the tool name → the title head →
 * a lone path. Later evidence never overrides earlier evidence.
 */
function inferToolKind(
  name: string | undefined,
  title: string | undefined,
  rawInput: Record<string, unknown> | undefined
): string | undefined {
  const rawKind = asTrimmedString(rawInput?.kind)?.toLowerCase()
  if (rawKind && !GENERIC_TOOL_KINDS.has(rawKind)) return rawKind
  // A placeholder name ("command_execution", "tool") is not evidence.
  const inferred =
    kindFromInputVariant(rawInput) ??
    kindFromInputShape(rawInput) ??
    (isGenericToolName(name) ? undefined : kindFromLabel(name)) ??
    (title !== name ? kindFromLabel(title) : undefined)
  if (inferred) return inferred
  if (pathInputKeys.some((key) => asTrimmedString(rawInput?.[key])))
    return "read"
  return rawKind
}

function inferToolItemType(input: {
  readonly itemType?: ToolLifecycleItemType | null | undefined
  readonly kind?: string | undefined
}): ToolLifecycleItemType | undefined {
  if (input.itemType) {
    return input.itemType
  }
  switch (input.kind?.toLowerCase()) {
    case "execute":
      return "command_execution"
    case "edit":
    case "write":
    case "move":
    case "delete":
      return "file_change"
    case "search":
      return "web_search"
    case "read":
      return "dynamic_tool_call"
    default:
      return undefined
  }
}

export interface ToolActivityPresentationInput {
  readonly itemType?: ToolLifecycleItemType | null | undefined
  readonly title?: string | null | undefined
  readonly detail?: string | null | undefined
  readonly data?: unknown
  readonly fallbackSummary?: string | null | undefined
}

export interface ToolActivityPresentation {
  readonly summary: string
  readonly detail?: string | undefined
}

/**
 * Everything a row needs to say what a tool call did: the action, its label,
 * the one detail that distinguishes it, and the typed pieces (file, pattern,
 * scope, command) so a renderer can decide what to link and what to fold.
 */
export interface ToolActivityDescription extends ToolActivityPresentation {
  readonly action: ToolAction
  /** File or directory the call targets (read, list, file_change). */
  readonly path?: string | undefined
  /** Search pattern or query (search). */
  readonly pattern?: string | undefined
  /** Where a search was scoped: a directory, file or glob (search). */
  readonly scope?: string | undefined
  /** The command as the user would type it (command). */
  readonly command?: string | undefined
}

export interface ProviderToolActivityPresentationInput {
  readonly toolName?: string | null | undefined
  readonly title?: string | null | undefined
  readonly detail?: string | null | undefined
  readonly input?: unknown
  readonly output?: unknown
  readonly rawInput?: unknown
  readonly rawOutput?: unknown
  readonly kind?: string | null | undefined
  readonly itemType?: ToolLifecycleItemType | null | undefined
  readonly data?: unknown
  readonly fallbackSummary?: string | null | undefined
}

const MCP_TOOL_TITLE_RE = /^mcp__(.+?)__(.+)$/

/** `mcp__betterc0de__generate_image` → "Generate image". MCP tool names are
 *  transport identifiers, not display strings — never show them raw. */
function humanizeMcpToolTitle(title: string | undefined): string | undefined {
  const match = title?.match(MCP_TOOL_TITLE_RE)
  if (!match) return undefined
  const toolPart = match[2]!.replace(/[_-]+/g, " ").trim()
  if (!toolPart) return undefined
  return toolPart.charAt(0).toUpperCase() + toolPart.slice(1)
}

function presentationOf(
  description: ToolActivityDescription
): ToolActivityPresentation {
  return description.detail
    ? { summary: description.summary, detail: description.detail }
    : { summary: description.summary }
}

const searchPatternKeys = [
  "query",
  "pattern",
  "searchTerm",
  "search_term",
  "regex",
] as const
const searchScopeKeys = [
  "path",
  "directory",
  "target_directory",
  "include",
  "glob",
] as const

function describeToolActivity(
  input: ToolActivityPresentationInput
): ToolActivityDescription {
  const title = asTrimmedString(input.title)
  const fallback = asTrimmedString(input.fallbackSummary) ?? "Tool"
  const data = recordOrUndefined(input.data)
  const raw = recordOrUndefined(data?.rawInput)
  const output = summarizeToolRawOutput(data)
  const detail = stripTrailingExitCode(asTrimmedString(input.detail))
  const action = classifyToolAction({ itemType: input.itemType, title, data })

  switch (action) {
    case "command": {
      const command = extractToolCommand(data, title)
      return {
        action,
        summary: "Ran command",
        ...(command ? { detail: command, command } : {}),
      }
    }
    case "read":
    case "file_change":
    case "list": {
      const summary =
        action === "read"
          ? "Read file"
          : action === "list"
            ? "Listed directory"
            : "Changed files"
      const path = extractPrimaryPath(data)
      const selected = path ?? output
      return {
        action,
        summary,
        ...(selected ? { detail: selected } : {}),
        ...(path ? { path } : {}),
      }
    }
    case "search": {
      const pattern = searchPatternKeys
        .map((key) => asTrimmedString(raw?.[key]))
        .find(Boolean)
      const scope = searchScopeKeys
        .map((key) => asTrimmedString(raw?.[key]))
        .find(Boolean)
      const selected = pattern ?? output
      return {
        action,
        summary: "Searched files",
        ...(selected ? { detail: selected } : {}),
        ...(pattern ? { pattern } : {}),
        ...(scope && scope !== pattern ? { scope } : {}),
      }
    }
    default: {
      const mcp = humanizeMcpToolTitle(title)
      const summary = mcp ?? title ?? fallback
      const path = extractPrimaryPath(data)
      const selected = mcp
        ? (detail ??
          asTrimmedString(raw?.save_path) ??
          asTrimmedString(raw?.path) ??
          asTrimmedString(raw?.prompt) ??
          output)
        : [detail, path, output].find(
            (candidate) =>
              candidate &&
              !isEquivalent(candidate, title) &&
              !isEquivalent(candidate, fallback)
          )
      return {
        action,
        summary,
        ...(selected ? { detail: selected } : {}),
        ...(path ? { path } : {}),
      }
    }
  }
}

export function describeProviderToolActivity(
  input: ProviderToolActivityPresentationInput
): ToolActivityDescription {
  const name = asTrimmedString(input.toolName)
  const title = asTrimmedString(input.title) ?? name
  const rawInputValue = input.rawInput ?? input.input
  const rawInput = recordOrUndefined(rawInputValue)
  // A provider's own classification wins, unless it only says "other".
  const kind =
    explicitToolKind(input.kind) ??
    inferToolKind(name, title, rawInput) ??
    asTrimmedString(input.kind)?.toLowerCase()
  const itemType = inferToolItemType({ itemType: input.itemType, kind })
  const command = extractToolCommand({ rawInput: rawInputValue }, title)
  const data: Record<string, unknown> = {
    ...(recordOrUndefined(input.data) ?? {}),
  }

  if (kind) {
    data.kind = kind
  }
  if (command) {
    data.command = command
  }
  if (rawInputValue !== undefined) {
    data.rawInput = rawInputValue
  }
  if (input.rawOutput !== undefined) {
    data.rawOutput = input.rawOutput
  } else if (input.output !== undefined) {
    data.rawOutput = input.output
  }
  data.item = {
    ...(recordOrUndefined(data.item) ?? {}),
    ...(rawInputValue !== undefined ? { input: rawInputValue } : {}),
    ...(input.output !== undefined ? { result: input.output } : {}),
    ...(command ? { command } : {}),
  }

  return describeToolActivity({
    itemType,
    title,
    detail: input.detail,
    data,
    fallbackSummary: input.fallbackSummary ?? title ?? "Tool",
  })
}

export function deriveProviderToolActivityPresentation(
  input: ProviderToolActivityPresentationInput
): ToolActivityPresentation {
  return presentationOf(describeProviderToolActivity(input))
}

// Keys that hold a tool result's human-readable text, most specific first.
// `content` covers ACP content blocks and Grok's `FileContent.content`;
// `output_for_prompt` is Grok's shell transcript; the wrapper keys at the end
// are Grok result envelopes whose payload sits one level down.
const outputTextKeys = [
  "content",
  "text",
  "output_for_prompt",
  "output",
  "result",
  "rawOutput",
  "FileContent",
  "Content",
  "message",
  "value",
  "newText",
  "MultiResult",
  "TodosUpdated",
  "summary_for_prompt",
  "summary",
] as const

function outputTextOf(value: unknown, depth: number): string | undefined {
  if (typeof value === "string") return value.trim() ? value : undefined
  if (depth > 4 || value === null || value === undefined) return undefined
  if (Array.isArray(value)) {
    // Grok serialises raw stdout as a byte array; that is not text to show.
    if (value.every((entry) => typeof entry === "number")) return undefined
    const parts = value
      .map((entry) => outputTextOf(entry, depth + 1))
      .filter((part): part is string => Boolean(part))
    return parts.length > 0 ? parts.join("\n") : undefined
  }
  const record = recordOrUndefined(value)
  if (!record) return undefined
  if (typeof record.stdout === "string") {
    const stderr = asTrimmedString(record.stderr)
    const stdout = record.stdout
    if (stderr)
      return `${stdout}${stdout && !stdout.endsWith("\n") ? "\n" : ""}${stderr}`
    return stdout.trim() ? stdout : undefined
  }
  for (const key of outputTextKeys) {
    const text = outputTextOf(record[key], depth + 1)
    if (text) return text
  }
  return undefined
}

/**
 * The text a tool result is really about, dug out of whatever envelope the
 * provider wrapped it in — a file's lines, a command's stdout, a search's
 * matches. `undefined` when the result carries no text, so the caller can
 * fall back to a JSON dump instead of showing an empty box.
 */
export function extractToolOutputText(output: unknown): string | undefined {
  return outputTextOf(output, 0)
}

export function formatToolActivityPresentation(
  presentation: ToolActivityPresentation,
  suffix?: string | null | undefined
): string {
  const suffixText = asTrimmedString(suffix)
  const summary = suffixText
    ? `${presentation.summary} ${suffixText}`
    : presentation.summary
  if (presentation.detail && !isEquivalent(summary, presentation.detail)) {
    return `${summary}: ${presentation.detail}`
  }
  return summary
}
