import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react"
import {
  browserElementKey,
  type BrowserElementReference,
} from "@betterc0de/schema"
import {
  EMPTY_BROWSER_ELEMENTS,
  useBrowserContextStore,
} from "@/lib/browser-context-store"
import {
  browserMentionRanges,
  removeBrowserMentionAtCursor,
  removedBrowserMentions,
  removeBrowserMentionText,
} from "@/lib/browser-element-mentions"
import {
  BrowserElementChips,
  BrowserElementMention,
} from "./browser-element-chips"
import {
  PromptInputTextarea,
  usePromptInputController,
  type PromptInputTextareaProps,
} from "@/components/ai-elements/prompt-input"
import {
  DICTATION_PREVIEW_EVENT,
  readDictationPreview,
  type DictationDraft,
} from "@/lib/dictation-preview"
import {
  hasMarkdownSource,
  MARKDOWN_SOURCE as MD,
  markdownSourceRuns,
} from "@/lib/markdown-source"
import { cn } from "@/lib/utils"

/**
 * Markdown styles for the mirror. Each one keeps glyph advances unchanged so
 * the textarea's caret and selection stay on the painted text: bold is a
 * stroke, the bullet is drawn over its hyphen, and italic is synthesized
 * because Figtree ships no italic face.
 */
function mirrorMarkdownClass(flags: number) {
  if (!flags) return undefined
  const has = (flag: number) => (flags & flag) !== 0
  return cn(
    has(MD.strong | MD.heading) && "markdown-source-strong",
    has(MD.em) && "italic",
    has(MD.code | MD.codeBlock) && "markdown-source-code",
    has(MD.strike) && "line-through",
    has(MD.link) &&
      "text-primary underline decoration-primary/50 underline-offset-2",
    has(
      MD.marker |
        MD.linkTarget |
        MD.quote |
        MD.quoteMark |
        MD.listNumber |
        MD.fence |
        MD.rule
    ) && "text-muted-foreground",
    has(MD.bullet) && "markdown-source-bullet"
  )
}

/** Native editing stays in the textarea; the mirror adds Markdown styles, dictation color and inspectable mentions. */
export function ComposerVoiceTextarea({
  threadId,
  className,
  onScroll,
  onChange,
  onKeyDown,
  ...props
}: Omit<PromptInputTextareaProps, "ref"> & { threadId: string | null }) {
  const { textInput } = usePromptInputController()
  const input = useRef<HTMLTextAreaElement>(null)
  const mirror = useRef<HTMLDivElement>(null)
  const [preview, setPreview] = useState<DictationDraft | null>(null)
  const [metrics, setMetrics] = useState<CSSProperties>({})
  const showPreview =
    preview?.interimStart != null && preview.value === textInput.value
  const elements = useBrowserContextStore((state) =>
    threadId
      ? (state.byThread[threadId] ?? EMPTY_BROWSER_ELEMENTS)
      : EMPTY_BROWSER_ELEMENTS
  )
  const previousKeys = useRef(new Set<string>())
  const pendingCursor = useRef<{ value: string; cursor: number } | null>(null)
  const ranges = browserMentionRanges(textInput.value, elements)
  const markdown = useMemo(
    () => markdownSourceRuns(textInput.value),
    [textInput.value]
  )
  const showMirror =
    showPreview || ranges.length > 0 || hasMarkdownSource(markdown)

  useLayoutEffect(() => {
    if (!threadId) return
    const named = useBrowserContextStore
      .getState()
      .ensureMentionNames(threadId, textInput.value)
    const additions = named.filter(
      (element) =>
        !previousKeys.current.has(browserElementKey(element)) &&
        !browserMentionRanges(textInput.value, [element]).length
    )
    previousKeys.current = new Set(named.map(browserElementKey))
    if (!additions.length) return
    let cursor = input.current?.selectionEnd ?? textInput.value.length
    const containing = browserMentionRanges(textInput.value, named).find(
      (range) => cursor > range.start && cursor < range.end
    )
    if (containing) cursor = containing.end
    const before = textInput.value.slice(0, cursor)
    const after = textInput.value.slice(cursor)
    const inserted = `${before && !/\s$/.test(before) ? " " : ""}${additions.map((element) => `@${element.mentionName}`).join(" ")} `
    const value = before + inserted + after
    pendingCursor.current = { value, cursor: before.length + inserted.length }
    textInput.setInput(value)
  }, [elements, threadId, textInput])

  useLayoutEffect(() => {
    if (
      pendingCursor.current === null ||
      pendingCursor.current.value !== textInput.value ||
      !input.current
    )
      return
    input.current.setSelectionRange(
      pendingCursor.current.cursor,
      pendingCursor.current.cursor
    )
    pendingCursor.current = null
  }, [textInput.value])

  function removeMissing(before: string, after: string) {
    if (!threadId) return
    for (const element of removedBrowserMentions(before, after, elements)) {
      useBrowserContextStore
        .getState()
        .remove(threadId, browserElementKey(element))
    }
  }

  function removeMention(element: BrowserElementReference) {
    if (!threadId) return
    const value = removeBrowserMentionText(textInput.value, element)
    pendingCursor.current = {
      value,
      cursor: Math.min(
        input.current?.selectionStart ?? value.length,
        value.length
      ),
    }
    textInput.setInput(value)
    useBrowserContextStore
      .getState()
      .remove(threadId, browserElementKey(element))
  }

  useEffect(() => {
    const textarea = input.current
    if (!textarea) return
    const receive = (event: Event) => setPreview(readDictationPreview(event))
    textarea.addEventListener(DICTATION_PREVIEW_EVENT, receive)
    return () => textarea.removeEventListener(DICTATION_PREVIEW_EVENT, receive)
  }, [])

  useLayoutEffect(() => {
    const textarea = input.current
    if (!textarea || !showMirror) return
    const measure = () => {
      const style = getComputedStyle(textarea)
      setMetrics({
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        lineHeight: style.lineHeight,
        letterSpacing: style.letterSpacing,
        tabSize: style.tabSize,
        overflowWrap: "break-word",
        paddingTop: style.paddingTop,
        paddingRight: style.paddingRight,
        paddingBottom: style.paddingBottom,
        paddingLeft: style.paddingLeft,
        borderTopWidth: style.borderTopWidth,
        borderRightWidth: style.borderRightWidth,
        borderBottomWidth: style.borderBottomWidth,
        borderLeftWidth: style.borderLeftWidth,
        width:
          textarea.clientWidth +
          parseFloat(style.borderLeftWidth) +
          parseFloat(style.borderRightWidth),
      })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(textarea)
    return () => observer.disconnect()
  }, [showMirror, className])

  useLayoutEffect(() => {
    if (!showMirror || !input.current || !mirror.current) return
    mirror.current.scrollTop = input.current.scrollTop
    mirror.current.scrollLeft = input.current.scrollLeft
  }, [showMirror, textInput.value, preview, metrics])

  const mirroredText: ReactNode[] = []
  const interimStart = showPreview ? preview.interimStart : null
  let run = 0
  const appendText = (start: number, end: number) => {
    // Markdown runs and the start of interim dictation both split the text.
    for (let from = start; from < end; ) {
      while (markdown[run] && markdown[run].end <= from) run++
      const interim = interimStart !== null && from >= interimStart
      const to = Math.min(
        end,
        markdown[run]?.end ?? end,
        !interim && interimStart !== null && interimStart > from
          ? interimStart
          : end
      )
      mirroredText.push(
        <span
          key={`text:${from}`}
          aria-hidden="true"
          className={cn(
            mirrorMarkdownClass(markdown[run]?.flags ?? 0),
            interim && "text-muted-foreground"
          )}
          data-dictation-interim={interim || undefined}
        >
          {textInput.value.slice(from, to)}
        </span>
      )
      from = to
    }
  }
  let offset = 0
  for (const range of ranges) {
    appendText(offset, range.start)
    mirroredText.push(
      <BrowserElementMention
        key={`mention:${range.start}`}
        element={range.element}
        mirror
        onRemove={() => removeMention(range.element)}
        onReturnFocus={() => input.current?.focus()}
      />
    )
    offset = range.end
  }
  appendText(offset, textInput.value.length)

  return (
    <div className="w-full min-w-0">
      {elements.length > 0 && (
        <div className="mx-3 mt-3 mb-1 space-y-2 border-b border-border/50 pb-3">
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
            <span className="font-medium">Browser elements</span>
            <span className="tabular-nums">{elements.length}</span>
            <span className="ml-auto">Click to inspect</span>
          </div>
          <BrowserElementChips
            elements={elements}
            onRemove={(key) => {
              const element = elements.find(
                (item) => browserElementKey(item) === key
              )
              if (element) removeMention(element)
            }}
            onReturnFocus={() => input.current?.focus()}
          />
        </div>
      )}
      <div className="relative w-full min-w-0">
        <PromptInputTextarea
          {...props}
          ref={input}
          className={cn(
            className,
            "text-foreground",
            showMirror &&
              "text-transparent caret-foreground transition-none placeholder:text-transparent"
          )}
          onChange={(event) => {
            removeMissing(textInput.value, event.currentTarget.value)
            onChange?.(event)
          }}
          onKeyDown={(event) => {
            onKeyDown?.(event)
            if (
              event.defaultPrevented ||
              event.nativeEvent.isComposing ||
              (event.key !== "Backspace" && event.key !== "Delete")
            )
              return
            const edit = removeBrowserMentionAtCursor(
              textInput.value,
              event.currentTarget.selectionStart,
              event.currentTarget.selectionEnd,
              event.key,
              elements
            )
            if (!edit) return
            event.preventDefault()
            pendingCursor.current = edit
            removeMissing(textInput.value, edit.value)
            textInput.setInput(edit.value)
          }}
          onScroll={(event) => {
            if (mirror.current) {
              mirror.current.scrollTop = event.currentTarget.scrollTop
              mirror.current.scrollLeft = event.currentTarget.scrollLeft
            }
            onScroll?.(event)
          }}
        />
        {showMirror && (
          <div
            ref={mirror}
            data-dictation-preview={showPreview || undefined}
            className="pointer-events-none absolute inset-0 overflow-hidden border-transparent break-words whitespace-pre-wrap text-foreground"
            style={metrics}
          >
            {mirroredText}
            {"\u200b"}
          </div>
        )}
      </div>
    </div>
  )
}
