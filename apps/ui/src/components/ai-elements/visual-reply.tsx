"use client"
import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react"
import {
  AppWindowIcon,
  CheckIcon,
  CodeIcon,
  CopyIcon,
  DownloadIcon,
  EyeIcon,
  Maximize2Icon,
  XIcon,
} from "lucide-react"
import { CodeBlock } from "@/components/ai-elements/code-block"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { assetUrl } from "@/lib/asset-url"
import { copyText } from "@/lib/clipboard"
import { cn } from "@/lib/utils"
import {
  VISUAL_REPLY_FRAME_PATH,
  VISUAL_REPLY_MAX_CHARS,
  VISUAL_REPLY_MESSAGE,
  VISUAL_REPLY_MIN_HEIGHT,
  buildVisualReplyDocument,
  clampVisualReplyHeight,
  fallbackVisualReplyTheme,
  hashVisualReply,
  parseVisualReplyFrameMessage,
  readVisualReplyTheme,
  visualReplyFileName,
  visualReplyThemeKey,
  visualReplyTitle,
  type VisualReplyTheme,
} from "@/lib/visual-reply"

/**
 * Visual replies: an agent's ```html-render page, live in the chat. The page
 * runs in a sandboxed frame on a static host page with its own policy; see
 * lib/visual-reply.ts for why and for what the page may load.
 */

const VISUAL_REPLY_FRAME_SRC = assetUrl(VISUAL_REPLY_FRAME_PATH)

// ── Theme ────────────────────────────────────────────────────────────────
// One observer for every frame: the theme lives on <html> (its class and
// inline custom properties), so a change there is the only thing that can
// change what a page should look like.

const SERVER_THEME = fallbackVisualReplyTheme("dark")
let themeSnapshot: VisualReplyTheme | null = null
let themeSnapshotKey = ""
let themeObserver: MutationObserver | null = null
let themeFrame = 0
const themeListeners = new Set<() => void>()

function computeTheme(): VisualReplyTheme {
  if (typeof document === "undefined") return SERVER_THEME
  const root = document.documentElement
  return readVisualReplyTheme(
    getComputedStyle(root),
    root.classList.contains("dark") ? "dark" : "light"
  )
}

function refreshTheme(): void {
  themeFrame = 0
  const next = computeTheme()
  const key = visualReplyThemeKey(next)
  if (key === themeSnapshotKey) return
  themeSnapshot = next
  themeSnapshotKey = key
  for (const listener of themeListeners) listener()
}

function subscribeTheme(listener: () => void): () => void {
  themeListeners.add(listener)
  if (!themeObserver && typeof MutationObserver !== "undefined") {
    themeObserver = new MutationObserver(() => {
      // Dragging a sidebar rewrites <html style> every frame: read once per frame.
      if (!themeFrame) themeFrame = requestAnimationFrame(refreshTheme)
    })
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    })
    // Nothing watched while no frame was on screen.
    refreshTheme()
  }
  return () => {
    themeListeners.delete(listener)
    if (themeListeners.size > 0 || !themeObserver) return
    themeObserver.disconnect()
    themeObserver = null
    if (themeFrame) cancelAnimationFrame(themeFrame)
    themeFrame = 0
  }
}

function getThemeSnapshot(): VisualReplyTheme {
  if (!themeSnapshot) {
    themeSnapshot = computeTheme()
    themeSnapshotKey = visualReplyThemeKey(themeSnapshot)
  }
  return themeSnapshot
}

function useVisualReplyTheme(): VisualReplyTheme {
  return useSyncExternalStore(
    subscribeTheme,
    getThemeSnapshot,
    () => SERVER_THEME
  )
}

// Last height per page, so a frame that mounts again (a virtualized row, the
// finished answer replacing the streaming one, a new theme) keeps its size
// instead of growing from the minimum.
const frameHeights = new Map<string, number>()
const MAX_REMEMBERED_HEIGHTS = 200

function rememberFrameHeight(key: string, height: number): void {
  frameHeights.delete(key)
  frameHeights.set(key, height)
  if (frameHeights.size > MAX_REMEMBERED_HEIGHTS) {
    const oldest = frameHeights.keys().next().value
    if (oldest !== undefined) frameHeights.delete(oldest)
  }
}

// ── Frame ────────────────────────────────────────────────────────────────

export interface VisualReplyFrameProps {
  /** The agent's HTML, as written in the fence. */
  html: string
  /** Accessible name of the frame. */
  title: string
  /** Fill the parent's height (full screen) instead of following the page. */
  fill?: boolean
  className?: string
  /** Escape was pressed while focus was inside the page. */
  onEscape?: () => void
}

/**
 * The sandboxed frame. It loads the host page, which shows the page in a
 * nested sandboxed frame. Messages count only from this frame's own window
 * and an opaque origin; the host page gets the document once it says it is
 * ready.
 */
export function VisualReplyFrame({
  html,
  title,
  fill = false,
  className,
  onEscape,
}: VisualReplyFrameProps) {
  const theme = useVisualReplyTheme()
  const documentHtml = useMemo(
    () => buildVisualReplyDocument(html, theme),
    [html, theme]
  )
  const contentKey = useMemo(() => hashVisualReply(html), [html])
  // A page reads the theme once, like any page reads its styles: a new theme
  // or a new page loads a new frame.
  const frameKey = useMemo(
    () => `${contentKey}:${hashVisualReply(visualReplyThemeKey(theme))}`,
    [contentKey, theme]
  )
  const [height, setHeight] = useState(
    () => frameHeights.get(contentKey) ?? VISUAL_REPLY_MIN_HEIGHT
  )
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const latest = useRef({ documentHtml, contentKey, title, fill, onEscape })
  latest.current = { documentHtml, contentKey, title, fill, onEscape }

  // A layout effect: the listener is in place in the same task that inserts
  // the frame, before the frame can announce that it is ready.
  useLayoutEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frameWindow = iframeRef.current?.contentWindow
      if (!frameWindow || event.source !== frameWindow) return
      const message = parseVisualReplyFrameMessage(event.origin, event.data)
      if (!message) return
      const current = latest.current
      if (message.type === "ready") {
        // An opaque origin cannot be named as the target; the source check
        // above is what ties the document to this frame.
        frameWindow.postMessage(
          {
            type: VISUAL_REPLY_MESSAGE.render,
            html: current.documentHtml,
            title: current.title,
          },
          "*"
        )
        return
      }
      if (message.type === "escape") {
        current.onEscape?.()
        return
      }
      if (current.fill) return
      const next = clampVisualReplyHeight(message.height)
      rememberFrameHeight(current.contentKey, next)
      setHeight(next)
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [])

  return (
    <iframe
      key={frameKey}
      ref={iframeRef}
      src={VISUAL_REPLY_FRAME_SRC}
      title={title}
      // Scripts only: an opaque origin without forms, popups, downloads,
      // modals or top navigation. Never add allow-same-origin: the host page
      // is served from the app's own origin.
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      loading={fill ? "eager" : "lazy"}
      className={cn(
        "block w-full border-0 bg-transparent",
        fill && "h-full",
        className
      )}
      style={fill ? undefined : { height }}
    />
  )
}

// ── Toolbar ──────────────────────────────────────────────────────────────

function saveHtmlFile(code: string): void {
  const url = URL.createObjectURL(
    new Blob([code], { type: "text/html;charset=utf-8" })
  )
  const link = document.createElement("a")
  link.href = url
  link.download = visualReplyFileName(code)
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function ToolbarButton({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={label}
          className="rounded-md text-muted-foreground hover:text-foreground"
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function CopyHtmlButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <ToolbarButton
      label={copied ? "Copied" : "Copy HTML"}
      onClick={async () => {
        if (!(await copyText(code))) return
        setCopied(true)
        window.setTimeout(() => setCopied(false), 2000)
      }}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </ToolbarButton>
  )
}

function ViewToggle({
  pressed,
  onClick,
  icon,
  label,
}: {
  pressed: boolean
  onClick: () => void
  icon: ReactNode
  label: string
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      aria-pressed={pressed}
      onClick={onClick}
      className="h-5 rounded-[5px] px-2 text-[10px] font-normal text-muted-foreground hover:text-foreground aria-pressed:bg-muted aria-pressed:text-foreground"
    >
      {icon}
      {label}
    </Button>
  )
}

// ── Full screen ──────────────────────────────────────────────────────────

function VisualReplyFullScreen({
  open,
  onOpenChange,
  code,
  label,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  code: string
  label: string
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="top-3 right-3 bottom-3 left-3 flex h-auto w-auto max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-none"
      >
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border/40 pr-2 pl-4">
          <AppWindowIcon
            aria-hidden="true"
            className="size-4 shrink-0 text-muted-foreground"
          />
          <DialogTitle className="min-w-0 truncate text-sm">
            {label}
          </DialogTitle>
          <DialogDescription className="sr-only">
            The agent's page, shown in a sandbox. Press Escape to close.
          </DialogDescription>
          <div className="flex-1" />
          <TooltipProvider delayDuration={300}>
            <CopyHtmlButton code={code} />
            <ToolbarButton
              label="Save as file"
              onClick={() => saveHtmlFile(code)}
            >
              <DownloadIcon />
            </ToolbarButton>
          </TooltipProvider>
          <DialogClose asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Close full screen"
              className="rounded-md text-muted-foreground hover:text-foreground"
            >
              <XIcon />
            </Button>
          </DialogClose>
        </div>
        <div className="min-h-0 flex-1 bg-background">
          {open ? (
            <VisualReplyFrame
              html={code}
              title={label}
              fill
              onEscape={() => onOpenChange(false)}
            />
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ── Block ────────────────────────────────────────────────────────────────

export interface VisualReplyBlockProps {
  /** The fence's HTML. */
  code: string
  /** The fence is still being written: a placeholder instead of half a page. */
  incomplete?: boolean
}

/** A ```html-render fence in a message: the live page with its toolbar. */
export function VisualReplyBlock({
  code,
  incomplete = false,
}: VisualReplyBlockProps) {
  const [view, setView] = useState<"page" | "code">("page")
  const [fullScreen, setFullScreen] = useState(false)
  const label = useMemo(() => visualReplyTitle(code) ?? "Visual reply", [code])
  const tooLarge = code.length > VISUAL_REPLY_MAX_CHARS
  const lineCount = incomplete ? code.split("\n").length : 0

  return (
    <div
      role="group"
      aria-label={label}
      className="my-3 overflow-hidden rounded-xl border border-border/60 bg-muted/20"
    >
      <div className="flex min-h-9 items-center gap-2 py-1 pr-1.5 pl-3">
        <AppWindowIcon
          aria-hidden="true"
          className="size-3.5 shrink-0 text-muted-foreground"
        />
        <span className="min-w-0 truncate text-[11px] font-medium text-muted-foreground">
          {label}
        </span>
        {incomplete ? (
          <span className="shrink-0 text-[10px] text-muted-foreground/60">
            {lineCount} lines
          </span>
        ) : null}
        <div className="flex-1" />
        {incomplete ? null : (
          <TooltipProvider delayDuration={300}>
            <div className="flex items-center gap-0.5">
              {tooLarge ? null : (
                <div
                  role="group"
                  aria-label="View"
                  className="mr-1 flex items-center gap-0.5 rounded-md border border-border/40 p-0.5"
                >
                  <ViewToggle
                    pressed={view === "page"}
                    onClick={() => setView("page")}
                    icon={<EyeIcon />}
                    label="Preview"
                  />
                  <ViewToggle
                    pressed={view === "code"}
                    onClick={() => setView("code")}
                    icon={<CodeIcon />}
                    label="Code"
                  />
                </div>
              )}
              <CopyHtmlButton code={code} />
              <ToolbarButton
                label="Save as file"
                onClick={() => saveHtmlFile(code)}
              >
                <DownloadIcon />
              </ToolbarButton>
              {tooLarge ? null : (
                <ToolbarButton
                  label="Full screen"
                  onClick={() => setFullScreen(true)}
                >
                  <Maximize2Icon />
                </ToolbarButton>
              )}
            </div>
          </TooltipProvider>
        )}
      </div>
      <div className="border-t border-border/30">
        {incomplete ? (
          <div
            role="status"
            className="flex h-[120px] items-center justify-center gap-2 text-[11px] text-muted-foreground"
          >
            <Spinner
              aria-hidden="true"
              className="size-3.5 motion-reduce:animate-none"
            />
            Shown when the page is complete
          </div>
        ) : !tooLarge && view === "page" ? (
          <VisualReplyFrame html={code} title={label} />
        ) : (
          <>
            {tooLarge ? (
              <p className="px-3 pt-2 text-[11px] text-muted-foreground">
                Too large to show as a page, so here is its code.
              </p>
            ) : null}
            <CodeBlock
              code={code}
              language="html"
              className="rounded-none border-0 [&>div]:max-h-[480px]"
            />
          </>
        )}
      </div>
      {incomplete || tooLarge ? null : (
        <VisualReplyFullScreen
          open={fullScreen}
          onOpenChange={setFullScreen}
          code={code}
          label={label}
        />
      )}
    </div>
  )
}
