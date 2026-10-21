import { useCallback, useEffect, useLayoutEffect, useRef } from "react"
import { ChevronUpIcon } from "lucide-react"
import { useStickToBottomContext } from "use-stick-to-bottom"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"

/** Attribute that names a mounted transcript entry (see ChatTranscript). */
export const TRANSCRIPT_ENTRY_ID_ATTRIBUTE = "data-transcript-entry-id"

function findEntryNode(
  scope: HTMLElement,
  entryId: string
): HTMLElement | null {
  for (const node of scope.querySelectorAll<HTMLElement>(
    `[${TRANSCRIPT_ENTRY_ID_ATTRIBUTE}]`
  )) {
    if (node.getAttribute(TRANSCRIPT_ENTRY_ID_ATTRIBUTE) === entryId) {
      return node
    }
  }
  return null
}

/**
 * Top-of-transcript control that grows the mounted window toward older
 * history: earlier entries that are loaded but not mounted, then older pages
 * from the backend. It also loads on its own when the user scrolls up to it.
 *
 * Growing the content above the viewport would push what the user is reading
 * down, so the first mounted entry is pinned to its screen position until the
 * new rows are in.
 */
export function TranscriptHistoryControl({
  hiddenCount,
  hasOlderOnServer,
  loading,
  firstEntryId,
  onShowEarlier,
}: {
  /** Loaded entries above the mounted window. */
  hiddenCount: number
  /** The backend has messages older than the first loaded one. */
  hasOlderOnServer: boolean
  loading: boolean
  /** First mounted message entry, used to keep the reading position. */
  firstEntryId: string | null
  onShowEarlier: () => void
}) {
  const { scrollRef, escapedFromLock } = useStickToBottomContext()
  const sentinelRef = useRef<HTMLDivElement>(null)
  const restoreRef = useRef<{ entryId: string; top: number } | null>(null)
  const canShowEarlier = hiddenCount > 0 || hasOlderOnServer
  // The state the last automatic load started from; a load that changed
  // nothing (for example a failed read) is not retried until the user acts.
  const progressKey = `${hiddenCount}:${firstEntryId ?? ""}:${hasOlderOnServer}`
  const lastAutoKeyRef = useRef<string | null>(null)

  const showEarlier = useCallback(() => {
    if (loading) return
    const scroller = scrollRef.current
    const node =
      scroller && firstEntryId ? findEntryNode(scroller, firstEntryId) : null
    restoreRef.current =
      node && firstEntryId
        ? { entryId: firstEntryId, top: node.getBoundingClientRect().top }
        : null
    onShowEarlier()
  }, [firstEntryId, loading, onShowEarlier, scrollRef])

  const showEarlierRef = useRef(showEarlier)
  const progressKeyRef = useRef(progressKey)
  useEffect(() => {
    showEarlierRef.current = showEarlier
    progressKeyRef.current = progressKey
  })

  // Keep the pinned entry where it was on screen while rows land above it.
  useLayoutEffect(() => {
    const restore = restoreRef.current
    const scroller = scrollRef.current
    if (!restore || !scroller) return
    const node = findEntryNode(scroller, restore.entryId)
    if (node) {
      const delta = node.getBoundingClientRect().top - restore.top
      if (Math.abs(delta) >= 1) scroller.scrollTop += delta
    }
    if (!loading) restoreRef.current = null
  }, [firstEntryId, hiddenCount, loading, scrollRef])

  // Load on scroll: only once the user has scrolled up (escaped the bottom
  // lock), so opening a chat never pulls in history on its own.
  useEffect(() => {
    const sentinel = sentinelRef.current
    const root = scrollRef.current
    if (
      !sentinel ||
      !root ||
      !canShowEarlier ||
      loading ||
      !escapedFromLock ||
      typeof IntersectionObserver === "undefined"
    ) {
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        if (lastAutoKeyRef.current === progressKeyRef.current) return
        lastAutoKeyRef.current = progressKeyRef.current
        showEarlierRef.current()
      },
      { root, rootMargin: "240px 0px 0px 0px" }
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [canShowEarlier, escapedFromLock, loading, scrollRef])

  if (!canShowEarlier) return null
  return (
    <div
      className="flex flex-col items-center"
      data-betterc0de-transcript-history="true"
    >
      <div ref={sentinelRef} aria-hidden className="h-px w-full" />
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className="text-muted-foreground"
        disabled={loading}
        onClick={() => {
          lastAutoKeyRef.current = null
          showEarlier()
        }}
      >
        {loading ? (
          <Spinner className="size-3" />
        ) : (
          <ChevronUpIcon aria-hidden />
        )}
        {loading ? "Loading earlier messages…" : "Show earlier messages"}
      </Button>
    </div>
  )
}
