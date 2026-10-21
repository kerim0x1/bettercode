import { Fragment } from "react"
import type { BrowserElementReference, ProviderSkill } from "@betterc0de/schema"
import { browserMentionRanges } from "@/lib/browser-element-mentions"
import { renderMessageWithMentions } from "@/lib/message-utils"
import { BrowserElementMention } from "./browser-element-chips"

export function BrowserElementMessage({
  content,
  elements,
  skills,
}: {
  content: string
  elements: readonly BrowserElementReference[]
  skills?: ReadonlyArray<Pick<ProviderSkill, "name" | "displayName">>
}) {
  const ranges = browserMentionRanges(content, elements)
  let start = 0
  return (
    <div className="break-words whitespace-pre-wrap">
      {ranges.map((range) => {
        const text = content.slice(start, range.start)
        start = range.end
        return (
          <Fragment key={range.start}>
            {renderMessageWithMentions(text, skills)}
            <BrowserElementMention element={range.element} inline />
          </Fragment>
        )
      })}
      {renderMessageWithMentions(content.slice(start), skills)}
    </div>
  )
}
