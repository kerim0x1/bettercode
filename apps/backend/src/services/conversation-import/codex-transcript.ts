import {
  IMPORT_LIMITS,
  type ImportedTranscript,
  type ParserOptions,
  type TranscriptParser,
} from "./types"
import {
  TranscriptBuilder,
  clampText,
  parseJsonRecord,
  record,
  stringOf,
} from "./transcript-builder"

/**
 * Reads a Codex rollout (`<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl`,
 * or `archived_sessions/`).
 *
 * Every row is an envelope `{ timestamp, type, payload }`: `session_meta`
 * names the session (its id is the thread id Codex resumes) and folder,
 * `turn_context` the model, and `response_item` the conversation itself:
 * messages, reasoning summaries, tool calls and their output. `event_msg`
 * rows repeat the same items for the terminal UI and are skipped. Early
 * rollouts wrote the items without the envelope; both are read.
 *
 * Messages Codex injects as the user (environment, AGENTS.md, permissions,
 * an aborted turn) and `developer` messages are left out, as is encrypted
 * reasoning: only the summary Codex shows is kept.
 */

const RESPONSE_ITEM_TYPES = new Set([
  "message",
  "reasoning",
  "function_call",
  "function_call_output",
  "custom_tool_call",
  "custom_tool_call_output",
  "local_shell_call",
  "local_shell_call_output",
  "web_search_call",
])

const SHELL_FLAGS = new Set(["-c", "-lc", "-Command", "/c"])

/**
 * Whether a user text block is context Codex added rather than something the
 * user typed: AGENTS.md instructions, or one whole block in a Codex tag
 * (`<environment_context>`, `<user_instructions>`, `<turn_aborted>`,
 * `<permissions instructions>`, image wrappers). Tags without `_` or a
 * space, like `<div>`, can be the user's own text and are kept.
 */
export function isInjectedCodexText(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return true
  if (trimmed.startsWith("# AGENTS.md instructions for ")) return true
  if (/^<\/?image\b[^>]*>$/i.test(trimmed)) return true
  const tag = /^<([a-z][a-z_ ]*[a-z])>/i.exec(trimmed)?.[1]
  if (!tag || !/[_ ]/.test(tag)) return false
  return trimmed.endsWith(`</${tag}>`)
}

/** An assistant message's text: its `output_text` blocks. */
function assistantText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  const parts: string[] = []
  for (const item of content) {
    const block = record(item)
    if (block?.type === "output_text" && typeof block.text === "string") {
      parts.push(block.text)
    }
  }
  return parts.join("\n\n")
}

/** A tool call's output, which Codex writes as text, JSON text or blocks. */
function toolOutput(value: unknown): { text: string; failed: boolean } {
  if (typeof value === "string") {
    // Older shell calls wrapped the output: `{"output": …, "metadata": {…}}`.
    if (value.startsWith("{")) {
      const parsed = parseJsonRecord(value)
      if (parsed && typeof parsed.output === "string") {
        const exitCode = record(parsed.metadata)?.exit_code
        return {
          text: parsed.output,
          failed: typeof exitCode === "number" && exitCode !== 0,
        }
      }
    }
    return { text: value, failed: false }
  }
  if (Array.isArray(value)) {
    const parts: string[] = []
    for (const item of value) {
      const block = record(item)
      if (!block) continue
      if (typeof block.text === "string") parts.push(block.text)
      else if (block.type === "input_image") parts.push("[Image]")
    }
    return { text: parts.join("\n"), failed: false }
  }
  const object = record(value)
  if (object) {
    if (typeof object.content === "string")
      return { text: object.content, failed: object.success === false }
    if (Array.isArray(object.content))
      return {
        text: toolOutput(object.content).text,
        failed: object.success === false,
      }
  }
  return { text: "", failed: false }
}

/** `["bash", "-lc", "ls"]` reads as `ls`; other command lists are joined. */
function shellCommand(value: unknown): string | null {
  if (typeof value === "string") return value
  if (!Array.isArray(value)) return null
  const parts = value.filter((part): part is string => typeof part === "string")
  if (parts.length === 0) return null
  if (parts.length >= 3 && SHELL_FLAGS.has(parts[1] ?? "")) {
    return parts[parts.length - 1] ?? null
  }
  return parts.join(" ")
}

/** A function call's arguments, which Codex stores as JSON text. */
function callArguments(value: unknown): unknown {
  if (typeof value !== "string") return value ?? null
  const parsed = parseJsonRecord(value)
  if (!parsed) return { arguments: value }
  const command = shellCommand(parsed.command)
  return command !== null ? { ...parsed, command } : parsed
}

export class CodexTranscriptParser implements TranscriptParser {
  private readonly builder: TranscriptBuilder
  private sessionId: string | null = null
  private cwd: string | null = null
  private model: string | null = null
  private internal = false
  private lines = 0

  constructor(private readonly options: ParserOptions) {
    this.builder = new TranscriptBuilder(options)
  }

  pushLine(line: string): void {
    this.lines += 1
    // A listing only counts: tool output, terminal events and encrypted
    // reasoning never change the count, and they are the long lines.
    if (
      !this.options.keepMessages &&
      line.length > 8_192 &&
      (line.includes('_output"') ||
        line.includes('"event_msg"') ||
        line.includes('"encrypted_content"'))
    ) {
      return
    }
    const row = parseJsonRecord(line)
    if (row) this.read(row)
  }

  finish(): ImportedTranscript {
    const built = this.builder.finish()
    return {
      provider: "codex",
      sessionId: this.sessionId,
      cwd: this.cwd,
      title: built.title,
      startedAt: built.startedAt,
      endedAt: built.endedAt,
      messages: built.messages,
      messageCount: built.messageCount,
      omittedMessages: built.omittedMessages,
      internal: this.internal,
    }
  }

  private read(row: Record<string, unknown>): void {
    const type = stringOf(row.type)
    const payload = record(row.payload)
    if (payload) {
      if (type === "session_meta") {
        this.readMeta(payload)
      } else if (type === "turn_context") {
        this.cwd ??= stringOf(payload.cwd)
        this.model = stringOf(payload.model) ?? this.model
      } else if (type === "response_item") {
        this.readItem(payload, this.builder.stamp(row.timestamp))
      }
      return
    }
    // Early rollouts: a first line `{ id, timestamp, … }`, then bare items.
    if (type && RESPONSE_ITEM_TYPES.has(type)) {
      this.readItem(row, this.builder.stamp(row.timestamp))
    } else if (!type && this.lines === 1 && stringOf(row.id)) {
      this.readMeta(row)
    }
  }

  private readMeta(meta: Record<string, unknown>): void {
    this.sessionId ??= stringOf(meta.id) ?? stringOf(meta.session_id)
    this.cwd ??= stringOf(meta.cwd)
    this.builder.stamp(meta.timestamp)
    // Sub-agents Codex spawned for itself are not the user's conversations,
    // and neither are the sessions BetterC0de's own chats ran: Codex names
    // the app-server client (`clientInfo.name`, bootstrap/providers.ts) as
    // their originator.
    const source = meta.source
    if (record(source)?.subagent !== undefined) this.internal = true
    if (typeof source === "string" && source.startsWith("subagent")) {
      this.internal = true
    }
    if (/betterc0de/i.test(stringOf(meta.originator) ?? "")) {
      this.internal = true
    }
  }

  private readItem(item: Record<string, unknown>, at: string): void {
    switch (item.type) {
      case "message": {
        if (item.role === "user") {
          this.readUserMessage(item.content, at)
        } else if (item.role === "assistant") {
          this.builder.assistantText(
            assistantText(item.content),
            at,
            this.model
          )
        }
        return
      }
      case "reasoning": {
        // Only the summary Codex shows; `encrypted_content` stays hidden.
        const parts: string[] = []
        if (Array.isArray(item.summary)) {
          for (const entry of item.summary) {
            const text = record(entry)?.text
            if (typeof text === "string" && text.trim()) parts.push(text)
          }
        }
        if (parts.length > 0)
          this.builder.reasoning(parts.join("\n\n"), at, this.model)
        return
      }
      case "function_call":
        this.builder.toolCall(
          {
            id: stringOf(item.call_id) ?? stringOf(item.id),
            name: stringOf(item.name) ?? "tool",
            input: this.options.keepMessages
              ? callArguments(item.arguments)
              : null,
          },
          at,
          this.model
        )
        return
      case "custom_tool_call":
        this.builder.toolCall(
          {
            id: stringOf(item.call_id) ?? stringOf(item.id),
            name: stringOf(item.name) ?? "tool",
            input:
              typeof item.input === "string" ? { input: item.input } : null,
          },
          at,
          this.model
        )
        return
      case "local_shell_call": {
        const action = record(item.action)
        this.builder.toolCall(
          {
            id: stringOf(item.call_id) ?? stringOf(item.id),
            name: "shell",
            input: { command: shellCommand(action?.command) ?? "" },
          },
          at,
          this.model
        )
        return
      }
      case "web_search_call": {
        const action = record(item.action)
        this.builder.toolCall(
          {
            id: stringOf(item.call_id) ?? stringOf(item.id),
            name: "web_search",
            input: { query: stringOf(action?.query) ?? "" },
          },
          at,
          this.model
        )
        return
      }
      case "function_call_output":
      case "custom_tool_call_output":
      case "local_shell_call_output": {
        if (!this.options.keepMessages) return
        const output = toolOutput(item.output)
        this.builder.toolResult(
          stringOf(item.call_id),
          clampText(output.text, IMPORT_LIMITS.maxToolOutputChars).text,
          output.failed
        )
        return
      }
      default:
        return
    }
  }

  /** A user message: the blocks the user typed, without injected context. */
  private readUserMessage(content: unknown, at: string): void {
    if (typeof content === "string") {
      if (!isInjectedCodexText(content)) this.builder.user(content, at)
      return
    }
    if (!Array.isArray(content)) return
    const typed: string[] = []
    let images = 0
    for (const item of content) {
      const block = record(item)
      if (!block) continue
      if (block.type === "input_text" && typeof block.text === "string") {
        if (!isInjectedCodexText(block.text)) typed.push(block.text.trim())
      } else if (block.type === "input_image") {
        images += 1
      }
    }
    const text = typed.join("\n\n")
    if (text) this.builder.user(text, at)
    else if (images > 0) this.builder.user("[Image]", at)
  }
}
