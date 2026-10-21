import type React from "react"
import type { ChatQuestion } from "@/lib/chat-store"
import type { ProviderSkill } from "@betterc0de/schema"
import { formatProviderSkillDisplayName } from "@/lib/provider-skill-presentation"
import {
  extractProposedPlanMarkdown,
  isBetterC0dePlanJson,
} from "@/lib/plan-content"

/**
 * Text-oriented helpers for chat messages.
 *
 * Kept out of App.tsx so they can be unit-tested and reused by message
 * rendering components.
 */

/** Does a user message start with `/plan` (optionally with leading whitespace)? */
export function isPlanSlashCommand(userText: string): boolean {
  return /^\s*\/plan\b/i.test(userText.trim())
}

/** Does a user message start with `/ask` to switch into read-only ask mode? */
export function isAskSlashCommand(userText: string): boolean {
  return /^\s*\/ask\b/i.test(userText.trim())
}

/** Does a user message start with `/security` to switch into security review mode? */
export function isSecuritySlashCommand(userText: string): boolean {
  return /^\s*\/security\b/i.test(userText.trim())
}

/** Does a user message start with `/debug` to switch into debug mode? */
export function isDebugSlashCommand(userText: string): boolean {
  return /^\s*\/debug\b/i.test(userText.trim())
}

/** Does a user message start with `/default` to leave special modes? */
export function isDefaultSlashCommand(userText: string): boolean {
  return /^\s*\/(?:default|build|agent-mode)\b/i.test(userText.trim())
}

/**
 * Is this assistant output an actual proposed plan we should render with the
 * plan view? Strict on purpose: only a real `<proposed_plan>` block or
 * BetterC0de plan JSON counts.
 *
 * The previous loose fallback (`# Plan`/`## Tasks` header or ≥3 checkbox
 * lines) misfired on ordinary plan-mode narration — the agent narrating "I'm
 * in plan mode, here are the tasks I'll investigate…" was promoted to a full
 * plan card before the real plan existed. Real plans now always arrive either
 * wrapped in `<proposed_plan>` (streamed text / `turn.proposed.completed`
 * activity) or as plan JSON, so the shape heuristic is both unnecessary and
 * harmful.
 */
export function isStructuredPlanMarkdown(text: string): boolean {
  if (!text) return false
  if (extractProposedPlanMarkdown(text)) return true
  if (isBetterC0dePlanJson(text)) return true
  return false
}

/** Merge multiple diffs for the same file into one entry. */
export function mergeDiffs(
  diffs: {
    path: string
    additions: number
    deletions: number
    oldText: string
    newText: string
    isNew: boolean
    /** Light transcript placeholder: the text is still to be read. */
    textOmitted?: boolean
  }[]
) {
  const map = new Map<string, (typeof diffs)[0]>()
  for (const d of diffs) {
    const existing = map.get(d.path)
    if (existing) {
      existing.additions += d.additions
      existing.deletions += d.deletions
      if (d.oldText)
        existing.oldText += (existing.oldText ? "\n" : "") + d.oldText
      if (d.newText)
        existing.newText += (existing.newText ? "\n" : "") + d.newText
      // Showing half of a merged diff would look complete; wait for all.
      if (d.textOmitted) existing.textOmitted = true
    } else {
      map.set(d.path, { ...d })
    }
  }
  return [...map.values()]
}

const SKILL_TOKEN_REGEX = /(^|\s)\$([a-zA-Z][a-zA-Z0-9:_-]*)(?=\s|$)/g

type InlineSkill = Pick<ProviderSkill, "name" | "displayName">

/** Render message text with `@file` mentions and provider `$skills` as labels. */
export function renderMessageWithMentions(
  text: string,
  skills: ReadonlyArray<InlineSkill> = []
): React.ReactNode {
  const mentionRegex = /@([\w./\\-]+)/g
  const tokens: Array<{
    start: number
    end: number
    node: React.ReactNode
  }> = []
  const skillsByName = new Map(skills.map((skill) => [skill.name, skill]))
  let lastIndex = 0
  let key = 0
  let match: RegExpExecArray | null

  while ((match = mentionRegex.exec(text)) !== null) {
    tokens.push({
      start: match.index,
      end: match.index + match[0].length,
      node: (
        <span key={`mention-${key++}`} className="mention-label">
          @{match[1]}
        </span>
      ),
    })
  }

  for (const skillMatch of text.matchAll(SKILL_TOKEN_REGEX)) {
    const prefix = skillMatch[1] ?? ""
    const name = skillMatch[2] ?? ""
    const skill = skillsByName.get(name)
    if (!skill) continue
    const start = (skillMatch.index ?? 0) + prefix.length
    const rawText = `$${name}`
    tokens.push({
      start,
      end: start + rawText.length,
      node: (
        <span key={`skill-${key++}`} className="skill-label">
          <span className="sr-only">{rawText}</span>
          <span aria-hidden="true">
            {formatProviderSkillDisplayName(skill)}
          </span>
        </span>
      ),
    })
  }

  if (tokens.length === 0) return text

  const parts: React.ReactNode[] = []
  for (const token of tokens.sort((left, right) => left.start - right.start)) {
    if (token.start < lastIndex) continue
    if (token.start > lastIndex) parts.push(text.slice(lastIndex, token.start))
    parts.push(token.node)
    lastIndex = token.end
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex))
  }

  return parts.length > 0 ? <>{parts}</> : text
}

/**
 * Parses an inline-edit chat message of the form:
 *   "Inline edit (L16:C1 - L29:C6) in <path>: <instruction>"
 * Returns null if the message is not an inline-edit message.
 *
 * The `lastIndexOf(": ")` approach sidesteps the Windows drive-letter
 * problem — `C:\` has no trailing space, so it never matches the separator.
 */
export function parseInlineEditMessage(content: string): {
  range: string
  filePath: string
  instruction: string
} | null {
  if (!content.startsWith("Inline edit (")) return null
  const parenEnd = content.indexOf(") in ")
  if (parenEnd === -1) return null
  const range = content.slice("Inline edit (".length, parenEnd)
  const rest = content.slice(parenEnd + ") in ".length)
  const sepIdx = rest.lastIndexOf(": ")
  if (sepIdx === -1) return null
  const filePath = rest.slice(0, sepIdx)
  const instruction = rest.slice(sepIdx + 2)
  if (!filePath.trim() || !instruction.trim()) return null
  return { range, filePath, instruction }
}

/**
 * Strip inline question text + option bullets from an assistant message so we
 * can re-render the questions as interactive cards without duplicating them
 * in the streamed prose.
 */
export function stripQuestionLines(
  text: string,
  questions: ChatQuestion[]
): string {
  if (!questions.length) return text

  // Build a set of all question texts (cleaned) and all option labels for matching
  const questionTexts = new Set(
    questions.map((q) =>
      q.text.replace(/\*\*/g, "").replace(/\?$/, "").trim().toLowerCase()
    )
  )
  const optionLabels = new Set(
    questions.flatMap((q) => q.options.map((o) => o.label.toLowerCase()))
  )

  const lines = text.split("\n")
  const result: string[] = []
  let skipping = false

  for (let i = 0; i < lines.length; i++) {
    const clean = lines[i].trim().replace(/\*\*/g, "")
    if (!clean) {
      // Empty line: keep if not mid-skip, otherwise skip
      if (!skipping) result.push(lines[i])
      continue
    }

    // Check if this is a numbered line that matches a question
    const numMatch = clean.match(/^\d+[.)]\s+(.+)/)
    if (numMatch) {
      const body = numMatch[1].trim().replace(/[?:]$/, "").toLowerCase()
      if (questionTexts.has(body)) {
        skipping = true // Skip this line and following sub-items
        continue
      }
      // Numbered line that's NOT a question — stop skipping, keep it
      skipping = false
    }

    // While skipping: also skip bullets/sub-items that are options
    if (skipping) {
      // Bullet items under a question
      const bulletMatch = clean.match(/^[-•*]\s+(.+)/)
      if (bulletMatch) {
        const label = bulletMatch[1].trim().replace(/\?$/, "").toLowerCase()
        if (optionLabels.has(label)) continue // Skip matching option
        continue // Skip any bullet under a skipped question
      }
      // Sub-numbered items
      if (clean.match(/^[a-z][.)]\s+/i)) continue
      // Non-bullet line — stop skipping
      skipping = false
    }

    // Check inline question format: "Question? (opt1, opt2)"
    const inlineMatch = clean.match(/^(?:\d+[.)]\s*)?(.+\?)\s*\(/)
    if (inlineMatch) {
      const qText = inlineMatch[1].trim().replace(/\?$/, "").toLowerCase()
      if (questionTexts.has(qText)) continue
    }

    result.push(lines[i])
  }

  return result
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}
