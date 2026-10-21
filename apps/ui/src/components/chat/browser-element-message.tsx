import type { ReactNode } from "react"
import type { BrowserElementReference, ProviderSkill } from "@betterc0de/schema"
import { browserMentionRanges } from "@/lib/browser-element-mentions"
import {
  MARKDOWN_SOURCE as MD,
  markdownSourceRuns,
} from "@/lib/markdown-source"
import { renderMessageWithMentions } from "@/lib/message-utils"
import { cn } from "@/lib/utils"
import { BrowserElementMention } from "./browser-element-chips"

type InlineSkills = ReadonlyArray<Pick<ProviderSkill, "name" | "displayName">>

/**
 * A sent message keeps the composer's Markdown styles. Syntax that only
 * styles (`**`, backticks, `#`) is hidden; everything else the user typed,
 * including link targets, fences and escapes, stays visible.
 */
export function BrowserElementMessage({
  content,
  elements,
  skills,
}: {
  content: string
  elements: readonly BrowserElementReference[]
  skills?: InlineSkills
}) {
  const ranges = browserMentionRanges(content, elements)
  const runs = markdownSourceRuns(content)
  const parts: ReactNode[] = []
  let run = 0
  const appendText = (start: number, end: number) => {
    for (let from = start; from < end; ) {
      while (runs[run] && runs[run].end <= from) run++
      const to = Math.min(end, runs[run]?.end ?? end)
      parts.push(
        <MarkdownSourcePiece
          key={`text:${from}`}
          text={content.slice(from, to)}
          flags={runs[run]?.flags ?? 0}
          skills={skills}
        />
      )
      from = to
    }
  }
  let start = 0
  for (const range of ranges) {
    appendText(start, range.start)
    parts.push(
      <BrowserElementMention
        key={`mention:${range.start}`}
        element={range.element}
        inline
      />
    )
    start = range.end
  }
  appendText(start, content.length)
  return <div className="break-words whitespace-pre-wrap">{parts}</div>
}

function MarkdownSourcePiece({
  text,
  flags,
  skills,
}: {
  text: string
  flags: number
  skills?: InlineSkills
}) {
  const has = (flag: number) => (flags & flag) !== 0
  if (has(MD.marker)) return null
  if (has(MD.bullet)) return <span className="text-muted-foreground">•</span>
  if (has(MD.quoteMark))
    return (
      <span
        aria-hidden="true"
        className="mr-2 inline-block h-[1.15em] w-0.5 rounded-full bg-border align-[-0.2em]"
      />
    )
  if (has(MD.rule))
    return (
      <span
        role="separator"
        className="inline-block w-full border-t border-border align-middle"
      />
    )
  const code = has(MD.code | MD.codeBlock | MD.fence)
  const Tag = code
    ? "code"
    : has(MD.strong)
      ? "strong"
      : has(MD.em)
        ? "em"
        : has(MD.strike)
          ? "del"
          : "span"
  const node = code ? text : renderMessageWithMentions(text, skills)
  if (!flags) return node
  return (
    <Tag
      className={cn(
        code && "font-mono text-[0.9em]",
        has(MD.code) && "markdown-source-code px-[0.3em]",
        has(MD.strong | MD.heading) && "font-[650] text-foreground",
        has(MD.heading) && "text-[1.08em]",
        has(MD.em) && "italic",
        has(MD.strike) && "line-through",
        has(MD.link) &&
          "text-primary underline decoration-primary/50 underline-offset-2",
        has(MD.linkTarget | MD.quote | MD.listNumber | MD.fence) &&
          "text-muted-foreground"
      )}
    >
      {node}
    </Tag>
  )
}
