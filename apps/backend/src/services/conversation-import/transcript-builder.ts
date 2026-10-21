import {
  IMPORT_LIMITS,
  type ImportedMessage,
  type ImportedToolCall,
} from "./types"

/**
 * Turns a CLI session's rows into BetterC0de messages: one message per user
 * prompt and one assistant message per reply, which holds the reply's text,
 * the reasoning the CLI showed and its tool calls in compact form. The
 * Claude Code and Codex parsers only decide what a row is; the shape of the
 * chat and every bound is decided here.
 */

export function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function stringOf(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

/**
 * One JSONL row as an object, or null. A parse error is never logged or
 * rethrown: its message quotes the line, which is the user's conversation.
 */
export function parseJsonRecord(line: string): Record<string, unknown> | null {
  try {
    return record(JSON.parse(line))
  } catch {
    return null
  }
}

/** An ISO timestamp from a string or epoch value; null when it is not a time. */
export function isoTimestamp(value: unknown): string | null {
  let ms: number
  if (typeof value === "string" && value.trim()) ms = Date.parse(value)
  else if (typeof value === "number" && Number.isFinite(value))
    ms = value > 1e12 ? value : value * 1000
  else return null
  if (!Number.isFinite(ms)) return null
  const date = new Date(ms)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

/** `text` cut to `max` characters, marked with an ellipsis when cut. */
export function clampText(
  text: string,
  max: number
): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false }
  return { text: `${text.slice(0, max).trimEnd()}…`, truncated: true }
}

/** A chat title from a prompt: one line, whitespace collapsed, cut short. */
export function titleFromPrompt(prompt: string): string {
  const line = prompt.replace(/\s+/g, " ").trim()
  return clampText(line, IMPORT_LIMITS.titleChars).text
}

/**
 * A tool call's arguments, small enough to show: strings cut short, long
 * lists and objects shortened, deep values summarised. File contents and
 * patches in arguments are the bulk of a session file and stay behind.
 */
export function compactToolInput(value: unknown, depth = 0): unknown {
  if (typeof value === "string")
    return clampText(value, IMPORT_LIMITS.maxToolInputChars).text
  if (typeof value === "number" || typeof value === "boolean") return value
  if (value === null || typeof value !== "object") return null
  if (Array.isArray(value)) {
    if (depth >= 3) return `[${value.length} items]`
    const items = value
      .slice(0, 10)
      .map((item) => compactToolInput(item, depth + 1))
    if (value.length > 10) items.push(`… ${value.length - 10} more`)
    return items
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (depth >= 3) return `{${entries.length} fields}`
  const out: Record<string, unknown> = {}
  for (const [key, entry] of entries.slice(0, 20)) {
    out[key] = compactToolInput(entry, depth + 1)
  }
  if (entries.length > 20) out["…"] = `${entries.length - 20} more fields`
  return out
}

/** Removes `<tag>…</tag>` blocks the CLI injected into a user message. */
export function stripTagBlocks(text: string, tag: string): string {
  if (!text.includes(`<${tag}`)) return text
  const pattern = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, "g")
  return text.replace(pattern, "")
}

interface PendingReply {
  texts: string[]
  reasoning: string[]
  tools: ImportedToolCall[]
  /** It has text or a tool call, so it shows as a message. */
  visible: boolean
  createdAt: string
  modelId?: string
}

export interface BuiltTranscript {
  messages: ImportedMessage[]
  messageCount: number
  omittedMessages: number
  title: string | null
  startedAt: string | null
  endedAt: string | null
}

export class TranscriptBuilder {
  private readonly kept: ImportedMessage[] = []
  private readonly openTools = new Map<string, ImportedToolCall>()
  private reply: PendingReply | null = null
  private count = 0
  private firstPrompt: string | null = null
  private fallbackPrompt: string | null = null
  private firstAt: string | null = null
  private lastAt: string | null = null

  constructor(
    private readonly options: {
      readonly keepMessages: boolean
      readonly fallbackAt?: string
    }
  ) {}

  /**
   * The time of a row: its own timestamp, else the last one seen, else the
   * file's time. Every valid timestamp also widens the session's span.
   */
  stamp(value: unknown): string {
    const at = isoTimestamp(value)
    if (at) {
      if (!this.firstAt || at < this.firstAt) this.firstAt = at
      if (!this.lastAt || at > this.lastAt) this.lastAt = at
      return at
    }
    return this.lastAt ?? this.options.fallbackAt ?? new Date(0).toISOString()
  }

  /**
   * A user prompt; it ends the reply before it. `title: false` for prompts
   * that are commands rather than a request (they title a chat only when
   * nothing else does).
   */
  user(text: string, at: string, options: { title?: boolean } = {}): void {
    const trimmed = text.trim()
    if (!trimmed) return
    this.flushReply()
    if (options.title === false) this.fallbackPrompt ??= trimmed
    else this.firstPrompt ??= trimmed
    this.count += 1
    if (!this.options.keepMessages) return
    this.push({
      role: "user",
      text: clampText(trimmed, IMPORT_LIMITS.maxMessageChars).text,
      createdAt: at,
    })
  }

  assistantText(text: string, at: string, modelId?: string | null): void {
    if (!text.trim()) return
    const reply = this.openReply(at, modelId)
    reply.visible = true
    if (this.options.keepMessages) reply.texts.push(text.trim())
  }

  /** Reasoning the CLI displayed; hidden or encrypted reasoning never comes here. */
  reasoning(text: string, at: string, modelId?: string | null): void {
    if (!text.trim()) return
    const reply = this.openReply(at, modelId)
    if (this.options.keepMessages) reply.reasoning.push(text.trim())
  }

  toolCall(
    call: { id: string | null; name: string; input: unknown },
    at: string,
    modelId?: string | null
  ): void {
    const reply = this.openReply(at, modelId)
    reply.visible = true
    if (!this.options.keepMessages) return
    if (reply.tools.length >= IMPORT_LIMITS.maxToolCallsPerMessage) return
    const tool: ImportedToolCall = {
      id: call.id ?? `imported-tool-${reply.tools.length + 1}`,
      name: call.name,
      input: compactToolInput(call.input),
    }
    reply.tools.push(tool)
    if (call.id) this.openTools.set(call.id, tool)
  }

  /** The result of an earlier call in the same reply; others are dropped. */
  toolResult(id: string | null, output: string, failed: boolean): void {
    if (!id || !this.options.keepMessages) return
    const tool = this.openTools.get(id)
    if (!tool) return
    this.openTools.delete(id)
    const clamped = clampText(output, IMPORT_LIMITS.maxToolOutputChars)
    tool.output = clamped.text
    if (clamped.truncated) tool.outputTruncated = true
    if (failed) tool.failed = true
  }

  finish(): BuiltTranscript {
    this.flushReply()
    const messageCount = Math.min(this.count, IMPORT_LIMITS.maxMessages)
    if (this.kept.length > IMPORT_LIMITS.maxMessages) {
      this.kept.splice(0, this.kept.length - IMPORT_LIMITS.maxMessages)
    }
    const prompt = this.firstPrompt ?? this.fallbackPrompt
    return {
      messages: this.kept,
      messageCount,
      omittedMessages: this.count - messageCount,
      title: prompt ? titleFromPrompt(prompt) : null,
      startedAt: this.firstAt,
      endedAt: this.lastAt,
    }
  }

  private openReply(at: string, modelId?: string | null): PendingReply {
    if (!this.reply) {
      this.reply = {
        texts: [],
        reasoning: [],
        tools: [],
        visible: false,
        createdAt: at,
      }
    }
    if (modelId) this.reply.modelId = modelId
    return this.reply
  }

  /** Ends the current reply. A reply with only reasoning shows nothing and is dropped. */
  private flushReply(): void {
    const reply = this.reply
    this.reply = null
    this.openTools.clear()
    if (!reply?.visible) return
    this.count += 1
    if (!this.options.keepMessages) return
    const message: ImportedMessage = {
      role: "assistant",
      text: clampText(reply.texts.join("\n\n"), IMPORT_LIMITS.maxMessageChars)
        .text,
      createdAt: reply.createdAt,
    }
    if (reply.reasoning.length > 0) {
      message.reasoning = clampText(
        reply.reasoning.join("\n\n"),
        IMPORT_LIMITS.maxReasoningChars
      ).text
    }
    if (reply.tools.length > 0) message.toolCalls = reply.tools
    if (reply.modelId) message.modelId = reply.modelId
    this.push(message)
  }

  private push(message: ImportedMessage): void {
    this.kept.push(message)
    // Drop the oldest in batches rather than per message.
    const limit = IMPORT_LIMITS.maxMessages
    if (this.kept.length > limit + Math.ceil(limit / 4)) {
      this.kept.splice(0, this.kept.length - limit)
    }
  }
}
