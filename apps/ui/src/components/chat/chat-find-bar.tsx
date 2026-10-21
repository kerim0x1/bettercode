import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react"
import {
  CaseSensitiveIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CircleAlertIcon,
  SearchIcon,
  XIcon,
} from "lucide-react"
import { useStickToBottomContext } from "use-stick-to-bottom"
import { CHAT_FIND_QUERY_MAX_LENGTH, chatFindPattern } from "@betterc0de/schema"
import type { ThreadMessageSearchHit } from "@betterc0de/schema/http-contracts"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  OLDER_MESSAGE_PAGE_SIZE,
  useChatStore,
  useThreadMessages,
} from "@/lib/chat-store"
import {
  buildChatFindResult,
  ChatFindCountCache,
  describeChatFindCount,
  EMPTY_CHAT_FIND_RESULT,
  findChatFindMatchIndex,
  formatChatFindCount,
  initialChatFindIndex,
  sameChatFindResult,
  stepChatFindIndex,
  type ChatFindMatch,
  type ChatFindResult,
  type ChatFindTarget,
} from "@/lib/chat-find"
import {
  CHAT_FIND_OPEN_EVENT,
  resolveChatFindScope,
  trackChatFindPointer,
  type ChatFindOpenRequest,
} from "@/lib/chat-find-events"
import {
  CHAT_FIND_ENTRY_ATTRIBUTE,
  chatFindEntryElement,
  chatFindEntryRanges,
  clearChatFindHighlights,
  markChatFindEntries,
  paintChatFindHighlights,
  scrollChatFindTargetIntoView,
  supportsChatFindHighlights,
} from "@/lib/chat-find-highlight"
import { searchThreadMessages } from "@/services/backend/coreApi"
import { cn } from "@/lib/utils"

/** Typing settles for this long before a search runs. */
const SEARCH_DEBOUNCE_MS = 150

interface ChatFindBarProps {
  /** Id of the transcript element (`Conversation`) this bar searches. */
  scopeId: string
  threadId: string | null
  /** The searchable entries the transcript holds, in transcript order. */
  targets: ReadonlyArray<ChatFindTarget>
  /**
   * Mounts an entry above the transcript's window, including one whose
   * message is still loading; an entry already mounted stays as it is.
   */
  revealEntry: (entryId: string) => void
}

/** The backend's answer for the part of the chat that is not loaded. */
interface OlderSearch {
  readonly key: string
  readonly status: "loading" | "ready" | "error"
  readonly hits: ReadonlyArray<ThreadMessageSearchHit>
  readonly truncated: boolean
}

type MatchRef = Pick<ChatFindMatch, "entryId" | "occurrence">

/**
 * Find in chat (Ctrl/Cmd+F): a compact bar over the top right of one
 * transcript. It searches every message of the chat: loaded entries are
 * counted here, the older part of a long chat by the backend, and going to
 * a match there loads that part of the history and mounts it. Matches are
 * highlighted in the rendered text without touching the DOM React owns
 * (`lib/chat-find-highlight.ts`). Memoized: the transcript re-renders on
 * every streamed delta, the bar only when its chat's entries change.
 */
export const ChatFindBar = memo(function ChatFindBar({
  scopeId,
  threadId,
  targets,
  revealEntry,
}: ChatFindBarProps) {
  const { scrollRef, stopScroll } = useStickToBottomContext()
  const [query, setQuery] = useState("")
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [current, setCurrent] = useState<MatchRef | null>(null)
  const [loadingEntryId, setLoadingEntryId] = useState<string | null>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  // Set when the current match should be scrolled to once it is mounted.
  const scrollPendingRef = useRef(false)
  // Bumped by every navigation, so a slow history load that was overtaken
  // does not mount its match.
  const navigationRef = useRef(0)

  const { open, close } = useChatFindOpenState(
    scopeId,
    threadId,
    barRef,
    inputRef
  )
  useEffect(() => {
    if (open) return
    navigationRef.current += 1
    scrollPendingRef.current = false
    setLoadingEntryId(null)
  }, [open])

  const settledQuery = useSettledQuery(open ? query : "")
  const searchKey = `${threadId ?? ""}\u0000${caseSensitive ? 1 : 0}\u0000${settledQuery}`
  const pattern = useMemo(
    () =>
      open && threadId
        ? chatFindPattern(settledQuery, { caseSensitive })
        : null,
    [caseSensitive, open, settledQuery, threadId]
  )
  const { older, hasOlderOnServer } = useOlderMessageSearch(
    threadId,
    pattern,
    settledQuery,
    caseSensitive,
    searchKey
  )
  const { result, deferredTargets } = useChatFindMatches(
    open ? threadId : null,
    targets,
    pattern,
    older
  )
  const currentIndex = findChatFindMatchIndex(result.matches, current)

  const goTo = useCallback(
    (match: ChatFindMatch) => {
      setCurrent({ entryId: match.entryId, occurrence: match.occurrence })
      scrollPendingRef.current = true
      const navigation = ++navigationRef.current
      const scope = document.getElementById(scopeId)
      if (scope && chatFindEntryElement(scope, match.entryId)) return
      if (match.loaded || !threadId) {
        revealEntry(match.entryId)
        return
      }
      setLoadingEntryId(match.entryId)
      void loadOlderMessagesUntil(threadId, match.entryId, match.sequence)
        .then((loaded) => {
          if (navigationRef.current !== navigation) return
          // The transcript mounts it once the page is in its timeline.
          if (loaded) revealEntry(match.entryId)
        })
        .finally(() => {
          if (navigationRef.current === navigation) setLoadingEntryId(null)
        })
    },
    [revealEntry, scopeId, threadId]
  )

  // A new search starts at the match nearest to what the reader is looking
  // at. Later changes (new messages, the backend's answer) keep the current
  // match, or start one when there was none.
  const searchedKeyRef = useRef<string | null>(null)
  const lastIndexRef = useRef(-1)
  useEffect(() => {
    if (!pattern) {
      searchedKeyRef.current = null
      setCurrent(null)
      return
    }
    const newSearch = searchedKeyRef.current !== searchKey
    searchedKeyRef.current = searchKey
    if (!newSearch && currentIndex >= 0) {
      lastIndexRef.current = currentIndex
      return
    }
    // A match whose history is loading can drop out of the list for a
    // render while its page lands; the navigation to it stands.
    if (!newSearch && current && scrollPendingRef.current) return
    if (result.matches.length === 0) {
      setCurrent(null)
      return
    }
    if (!newSearch && current) {
      // The current match went away (a reverted or rewritten message):
      // stay at the same place in the list, without scrolling.
      const index = Math.min(
        Math.max(lastIndexRef.current, 0),
        result.matches.length - 1
      )
      const match = result.matches[index]
      if (match) {
        setCurrent({ entryId: match.entryId, occurrence: match.occurrence })
      }
      return
    }
    const scope = document.getElementById(scopeId)
    const index = initialChatFindIndex(
      result.matches,
      deferredTargets,
      scope ? readingAnchorEntryId(scope, scrollRef.current) : null
    )
    const match = result.matches[index]
    if (match) goTo(match)
  }, [
    current,
    currentIndex,
    deferredTargets,
    goTo,
    pattern,
    result,
    scopeId,
    scrollRef,
    searchKey,
  ])

  const step = useCallback(
    (direction: 1 | -1) => {
      const index = stepChatFindIndex(
        currentIndex,
        result.matches.length,
        direction
      )
      const match = result.matches[index]
      if (match) goTo(match)
    },
    [currentIndex, goTo, result]
  )

  useChatFindPainter({
    scopeId,
    pattern: open ? pattern : null,
    result,
    current,
    scrollRef,
    stopScroll,
    scrollPendingRef,
  })

  // F3 / Shift+F3 while the chat is where the user is, also outside the bar.
  useEffect(() => {
    if (!open) return
    const handler = (event: KeyboardEvent) => {
      if (event.key !== "F3" || event.ctrlKey || event.metaKey || event.altKey)
        return
      // The find field handles its own F3 first.
      if (event.defaultPrevented) return
      if (resolveChatFindScope(event.target)?.id !== scopeId) return
      event.preventDefault()
      step(event.shiftKey ? -1 : 1)
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [open, scopeId, step])

  if (!open) return null

  const total = result.matches.length
  const olderFailed = older?.status === "error"
  const searching =
    (query.trim() !== "" && settledQuery !== query) ||
    (pattern !== null &&
      (older?.status === "loading" || (hasOlderOnServer && !older)))
  // "No results" waits until the older messages have answered too.
  const showCount = pattern !== null && (total > 0 || !searching)
  return (
    <ChatFindBarView
      scopeId={scopeId}
      barRef={barRef}
      inputRef={inputRef}
      query={query}
      onQueryChange={setQuery}
      caseSensitive={caseSensitive}
      onToggleCase={() => setCaseSensitive((value) => !value)}
      countText={
        showCount
          ? formatChatFindCount(currentIndex, total, result.truncated)
          : ""
      }
      announcement={
        showCount
          ? `${describeChatFindCount(currentIndex, total, result.truncated)}${
              olderFailed ? ". Older messages couldn't be searched." : ""
            }`
          : ""
      }
      busy={searching || loadingEntryId !== null}
      olderFailed={olderFailed}
      canStep={total > 0}
      onStep={step}
      onClose={() => close(true)}
    />
  )
})

/**
 * Whether the bar is open, and opening it on request: Ctrl/Cmd+F or the
 * command palette (`requestChatFind`). Closing clears the highlights and
 * gives focus back to where it was, or to the composer beside the
 * transcript. Another chat in the pane closes the bar.
 */
function useChatFindOpenState(
  scopeId: string,
  threadId: string | null,
  barRef: RefObject<HTMLDivElement | null>,
  inputRef: RefObject<HTMLInputElement | null>
): { open: boolean; close: (restoreFocus: boolean) => void } {
  const [open, setOpen] = useState(false)
  const [focusRequest, setFocusRequest] = useState(0)
  const returnFocusRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    trackChatFindPointer()
    const handler = (event: Event) => {
      const request = (event as CustomEvent<ChatFindOpenRequest>).detail
      if (!request || request.handled) return
      if (request.scopeId !== undefined) {
        if (request.scopeId !== scopeId) return
      } else if (
        !threadId ||
        threadId !== useChatStore.getState().activeThreadId
      ) {
        return
      }
      request.handled = true
      if (!threadId) return
      const active = document.activeElement
      if (
        active instanceof HTMLElement &&
        active !== document.body &&
        !barRef.current?.contains(active)
      ) {
        returnFocusRef.current = active
      }
      setOpen(true)
      setFocusRequest((value) => value + 1)
    }
    window.addEventListener(CHAT_FIND_OPEN_EVENT, handler)
    return () => window.removeEventListener(CHAT_FIND_OPEN_EVENT, handler)
  }, [barRef, scopeId, threadId])

  // After the commit, and after a dialog that just closed (the command
  // palette) has put focus back where it was: its restore runs on a
  // zero-delay timer queued before this one.
  useEffect(() => {
    if (focusRequest === 0) return
    const timer = window.setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [focusRequest, inputRef])

  const close = useCallback(
    (restoreFocus: boolean) => {
      setOpen(false)
      clearChatFindHighlights(scopeId, document.getElementById(scopeId))
      const previous = returnFocusRef.current
      returnFocusRef.current = null
      if (!restoreFocus) return
      if (previous?.isConnected) {
        previous.focus()
        return
      }
      // The composer beside this transcript.
      document
        .getElementById(scopeId)
        ?.parentElement?.querySelector<HTMLTextAreaElement>(
          "[data-composer-thread] textarea"
        )
        ?.focus()
    },
    [scopeId]
  )

  // Another chat in this pane: its matches are not this chat's.
  const threadRef = useRef(threadId)
  useEffect(() => {
    if (threadRef.current === threadId) return
    threadRef.current = threadId
    close(false)
  }, [close, threadId])

  useEffect(
    () => () =>
      clearChatFindHighlights(scopeId, document.getElementById(scopeId)),
    [scopeId]
  )

  return { open, close }
}

/**
 * The backend's search of the messages older than the loaded ones, for a
 * chat that has more history on the server. Pages loaded while the answer
 * is on its way are left to the loaded copies (`buildChatFindResult`). The
 * answer is returned only for the current search.
 */
function useOlderMessageSearch(
  threadId: string | null,
  pattern: RegExp | null,
  query: string,
  caseSensitive: boolean,
  searchKey: string
): { older: OlderSearch | null; hasOlderOnServer: boolean } {
  const [older, setOlder] = useState<OlderSearch | null>(null)
  const hasOlderOnServer = useChatStore((state) =>
    threadId ? state.olderMessagesCursorByThread[threadId] !== undefined : false
  )
  useEffect(() => {
    const cursor = threadId
      ? useChatStore.getState().olderMessagesCursorByThread[threadId]
      : undefined
    if (!pattern || !threadId || !hasOlderOnServer || cursor === undefined) {
      setOlder(null)
      return
    }
    const controller = new AbortController()
    setOlder({ key: searchKey, status: "loading", hits: [], truncated: false })
    searchThreadMessages(threadId, {
      query,
      caseSensitive,
      beforeSequence: cursor,
      signal: controller.signal,
    })
      .then((answer) => {
        if (controller.signal.aborted) return
        setOlder({
          key: searchKey,
          status: "ready",
          hits: answer.hits,
          truncated: answer.truncated,
        })
      })
      .catch(() => {
        if (controller.signal.aborted) return
        setOlder({
          key: searchKey,
          status: "error",
          hits: [],
          truncated: false,
        })
      })
    return () => controller.abort()
  }, [caseSensitive, hasOlderOnServer, pattern, query, searchKey, threadId])
  return {
    older: older?.key === searchKey ? older : null,
    hasOlderOnServer,
  }
}

/**
 * The numbered matches of the current search. Streaming re-derives the
 * timeline often: counting waits for idle time, reuses the counts of
 * entries whose text did not change, and keeps one result identity while
 * the matches stay the same, so nothing repaints for it.
 */
function useChatFindMatches(
  threadId: string | null,
  targets: ReadonlyArray<ChatFindTarget>,
  pattern: RegExp | null,
  older: OlderSearch | null
): {
  result: ChatFindResult
  deferredTargets: ReadonlyArray<ChatFindTarget>
} {
  // Deferred like the targets, so a page that just landed is in both or in
  // neither.
  const liveMessages = useThreadMessages(threadId)
  const messages = useDeferredValue(liveMessages)
  const loadedIds = useMemo(
    () => new Set(messages.map((message) => message.id)),
    [messages]
  )
  const deferredTargets = useDeferredValue(targets)
  const [countCache] = useState(() => new ChatFindCountCache())
  const computed = useMemo(
    () =>
      pattern
        ? buildChatFindResult({
            targets: deferredTargets,
            pattern,
            remoteHits: older?.hits,
            remoteTruncated: older?.truncated,
            loadedIds,
            cache: countCache,
          })
        : EMPTY_CHAT_FIND_RESULT,
    [countCache, deferredTargets, loadedIds, older, pattern]
  )
  const resultRef = useRef<ChatFindResult>(computed)
  if (!sameChatFindResult(resultRef.current, computed)) {
    resultRef.current = computed
  }
  return { result: resultRef.current, deferredTargets }
}

/**
 * Draws the matches of the mounted entries and scrolls to the current one
 * when a navigation asked for it. Repaints when the search changes, and
 * once per frame when entries mount (older history), re-render (a code
 * block highlighted late) or change; the streaming reply is not an entry,
 * so its deltas do not count.
 */
function useChatFindPainter({
  scopeId,
  pattern,
  result,
  current,
  scrollRef,
  stopScroll,
  scrollPendingRef,
}: {
  scopeId: string
  /** Null while the bar is closed: everything drawn is removed. */
  pattern: RegExp | null
  result: ChatFindResult
  current: MatchRef | null
  scrollRef: RefObject<HTMLElement | null>
  stopScroll: () => void
  scrollPendingRef: RefObject<boolean>
}): void {
  const paint = useCallback(() => {
    const scope = document.getElementById(scopeId)
    if (!scope) return
    if (!pattern) {
      clearChatFindHighlights(scopeId, scope)
      return
    }
    const canHighlight = supportsChatFindHighlights()
    // Only the mounted entries; most matches of a long chat are not.
    const mounted = new Map<string, HTMLElement>()
    for (const element of scope.querySelectorAll<HTMLElement>(
      `[${CHAT_FIND_ENTRY_ATTRIBUTE}]`
    )) {
      const id = element.getAttribute(CHAT_FIND_ENTRY_ATTRIBUTE)
      if (id) mounted.set(id, element)
    }
    const rangesByEntry = new Map<string, Range[]>()
    const marks = new Map<HTMLElement, "match" | "current">()
    const all: Range[] = []
    for (const match of result.matches) {
      if (!match.loaded || rangesByEntry.has(match.entryId)) continue
      const element = mounted.get(match.entryId)
      if (!element) continue
      const ranges = canHighlight ? chatFindEntryRanges(element, pattern) : []
      rangesByEntry.set(match.entryId, ranges)
      if (ranges.length > 0) all.push(...ranges)
      else marks.set(element, "match")
    }
    const currentElement = current
      ? (mounted.get(current.entryId) ?? null)
      : null
    let currentRange: Range | null = null
    if (current && currentElement) {
      const ranges = rangesByEntry.get(current.entryId) ?? []
      // The rendered text can hold fewer matches than the source (markdown
      // syntax, a collapsed block); the last one stands in.
      currentRange =
        ranges[Math.min(current.occurrence, ranges.length - 1)] ?? null
      if (!currentRange) marks.set(currentElement, "current")
    }
    paintChatFindHighlights(scopeId, all, currentRange)
    markChatFindEntries(scope, marks)

    const scroller = scrollRef.current
    if (scrollPendingRef.current && currentElement && scroller) {
      scrollPendingRef.current = false
      // Leaving the bottom stops the transcript following new output, so
      // only a match out of view does it.
      if (
        !currentRange ||
        !scrollChatFindTargetIntoView(scroller, currentRange, stopScroll)
      ) {
        scrollChatFindTargetIntoView(scroller, currentElement, stopScroll)
      }
    }
  }, [
    current,
    pattern,
    result,
    scopeId,
    scrollPendingRef,
    scrollRef,
    stopScroll,
  ])

  useEffect(() => {
    paint()
  }, [paint])

  const paintRef = useRef(paint)
  useEffect(() => {
    paintRef.current = paint
  })
  const watching = pattern !== null
  useEffect(() => {
    if (!watching) return
    const scope = document.getElementById(scopeId)
    if (!scope || typeof MutationObserver === "undefined") return
    let frame = 0
    const entrySelector = `[${CHAT_FIND_ENTRY_ATTRIBUTE}]`
    const observer = new MutationObserver((records) => {
      if (frame) return
      const relevant = records.some((record) => {
        const target =
          record.target instanceof Element
            ? record.target
            : record.target.parentElement
        if (target?.closest(entrySelector)) return true
        return Array.from(record.addedNodes).some(
          (node) =>
            node instanceof Element &&
            (node.matches(entrySelector) || node.querySelector(entrySelector))
        )
      })
      if (!relevant) return
      frame = window.requestAnimationFrame(() => {
        frame = 0
        paintRef.current()
      })
    })
    observer.observe(scope, {
      childList: true,
      subtree: true,
      characterData: true,
    })
    return () => {
      observer.disconnect()
      if (frame) window.cancelAnimationFrame(frame)
    }
  }, [scopeId, watching])
}

function ChatFindBarView({
  scopeId,
  barRef,
  inputRef,
  query,
  onQueryChange,
  caseSensitive,
  onToggleCase,
  countText,
  announcement,
  busy,
  olderFailed,
  canStep,
  onStep,
  onClose,
}: {
  scopeId: string
  barRef: RefObject<HTMLDivElement | null>
  inputRef: RefObject<HTMLInputElement | null>
  query: string
  onQueryChange: (query: string) => void
  caseSensitive: boolean
  onToggleCase: () => void
  /** "3 of 12"; empty before anything is typed. */
  countText: string
  /** The count in words, for screen readers. */
  announcement: string
  busy: boolean
  olderFailed: boolean
  canStep: boolean
  onStep: (direction: 1 | -1) => void
  onClose: () => void
}) {
  const countId = `${scopeId}-find-count`
  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === "Enter" || event.key === "F3") {
      event.preventDefault()
      onStep(event.shiftKey ? -1 : 1)
      return
    }
    // By key position: Option+C types "ç" on a Mac keyboard.
    if (
      event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      event.code === "KeyC"
    ) {
      event.preventDefault()
      onToggleCase()
    }
  }
  return (
    <TooltipProvider delayDuration={400}>
      <div
        ref={barRef}
        role="search"
        aria-label="Find in chat"
        onKeyDown={(event) => {
          if (event.key !== "Escape" || event.nativeEvent.isComposing) return
          event.preventDefault()
          event.stopPropagation()
          onClose()
        }}
        className={cn(
          "absolute top-2 right-3 z-20 flex w-[22rem] max-w-[calc(100%-1.5rem)] items-center gap-0.5",
          "rounded-[calc(var(--radius)+4px)] border border-border/60 bg-popover/95 p-1 text-popover-foreground backdrop-blur-sm",
          "shadow-[0_1px_2px_rgba(0,0,0,0.25),0_8px_24px_-12px_rgba(0,0,0,0.6)]",
          "motion-safe:animate-in motion-safe:duration-150 motion-safe:fade-in-0 motion-safe:slide-in-from-top-1"
        )}
      >
        <div className="relative flex min-w-0 flex-1 items-center">
          <SearchIcon
            aria-hidden="true"
            className="pointer-events-none absolute left-2 size-3.5 text-muted-foreground"
          />
          <input
            ref={inputRef}
            type="text"
            value={query}
            maxLength={CHAT_FIND_QUERY_MAX_LENGTH}
            spellCheck={false}
            autoComplete="off"
            aria-label="Find in chat"
            aria-describedby={countId}
            placeholder="Find in chat"
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={onInputKeyDown}
            className={cn(
              "h-7 w-full min-w-0 rounded-[var(--radius)] border border-transparent bg-input/30 pr-2 pl-7 text-[12px] text-foreground outline-none",
              "transition-colors duration-150 placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:bg-input/50 focus-visible:ring-2 focus-visible:ring-ring/30"
            )}
          />
        </div>
        <span
          id={countId}
          className="flex h-7 min-w-[4.5rem] shrink-0 items-center justify-center gap-1 px-1 text-[11px] whitespace-nowrap text-muted-foreground tabular-nums"
        >
          {busy ? <Spinner className="size-3" aria-hidden="true" /> : null}
          {olderFailed ? (
            <FindTooltip label="Older messages couldn't be searched; only the loaded part of the chat was.">
              <CircleAlertIcon
                aria-hidden="true"
                className="size-3 text-warning"
              />
            </FindTooltip>
          ) : null}
          <span aria-hidden="true">{countText}</span>
          <span className="sr-only" aria-live="polite">
            {announcement}
          </span>
        </span>
        <FindTooltip label="Match case (Alt+C)">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Match case"
            aria-pressed={caseSensitive}
            onClick={onToggleCase}
            className={cn(
              "rounded-[var(--radius)] text-muted-foreground",
              caseSensitive && "bg-accent text-foreground hover:bg-accent"
            )}
          >
            <CaseSensitiveIcon className="size-3.5" />
          </Button>
        </FindTooltip>
        <FindTooltip label="Previous match (Shift+Enter)">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Previous match"
            disabled={!canStep}
            onClick={() => onStep(-1)}
            className="rounded-[var(--radius)] text-muted-foreground"
          >
            <ChevronUpIcon className="size-3.5" />
          </Button>
        </FindTooltip>
        <FindTooltip label="Next match (Enter)">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Next match"
            disabled={!canStep}
            onClick={() => onStep(1)}
            className="rounded-[var(--radius)] text-muted-foreground"
          >
            <ChevronDownIcon className="size-3.5" />
          </Button>
        </FindTooltip>
        <FindTooltip label="Close (Escape)">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Close find"
            onClick={onClose}
            className="rounded-[var(--radius)] text-muted-foreground"
          >
            <XIcon className="size-3.5" />
          </Button>
        </FindTooltip>
      </div>
    </TooltipProvider>
  )
}

function FindTooltip({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="bottom" className="text-[11px]">
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

/** The query once typing pauses; clearing the field (or closing) is at once. */
function useSettledQuery(value: string): string {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = window.setTimeout(
      () => setSettled(value),
      value ? SEARCH_DEBOUNCE_MS : 0
    )
    return () => window.clearTimeout(timer)
  }, [value])
  return value ? settled : ""
}

/** The first mounted entry that reaches below the top of the viewport. */
function readingAnchorEntryId(
  scope: HTMLElement,
  scroller: HTMLElement | null
): string | null {
  if (!scroller) return null
  // Below the find bar, which covers the top of the transcript.
  const top = scroller.getBoundingClientRect().top + 48
  for (const element of scope.querySelectorAll<HTMLElement>(
    `[${CHAT_FIND_ENTRY_ATTRIBUTE}]`
  )) {
    if (element.getBoundingClientRect().bottom > top) {
      return element.getAttribute(CHAT_FIND_ENTRY_ATTRIBUTE)
    }
  }
  return null
}

/**
 * Loads older pages of a chat until it holds `messageId`. The message's
 * storage sequence tells how far back it is (sequences count a chat's
 * messages), so usually one read reaches it.
 */
async function loadOlderMessagesUntil(
  threadId: string,
  messageId: string,
  sequence: number | undefined
): Promise<boolean> {
  const holds = () =>
    useChatStore
      .getState()
      .threads.find((thread) => thread.id === threadId)
      ?.messages.some((message) => message.id === messageId) === true
  for (let attempt = 0; attempt < 50 && !holds(); attempt += 1) {
    const state = useChatStore.getState()
    const cursor = state.olderMessagesCursorByThread[threadId]
    if (cursor === undefined) break
    const limit =
      sequence !== undefined && sequence < cursor
        ? cursor - sequence + 20
        : OLDER_MESSAGE_PAGE_SIZE
    await state.loadOlderThreadMessages(threadId, { limit })
    // A failed read leaves the cursor where it was.
    if (
      useChatStore.getState().olderMessagesCursorByThread[threadId] === cursor
    )
      break
  }
  return holds()
}
