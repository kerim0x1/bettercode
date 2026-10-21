"use client"
import { copyText } from "@/lib/clipboard"

import { Button } from "@/components/ui/button"
import { ButtonGroup, ButtonGroupText } from "@/components/ui/button-group"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { sanitizeSvg } from "@/lib/sanitize"
import { useStreamdownPlugins } from "@/components/ai-elements/streamdown-plugins"
import { CodeBlock } from "@/components/ai-elements/code-block"
import {
  PREVIEWABLE_FENCE_LANGUAGES,
  closedFenceBodies,
  isVisualReplyClassName,
  normalizeFenceBody,
} from "@/lib/visual-reply"
import { useSettingsStore } from "@/lib/settings-store"
import type { BundledLanguage } from "shiki"
import type { UIMessage } from "ai"
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  CheckIcon,
  XIcon,
  CodeIcon,
  EyeIcon,
} from "lucide-react"
import { getFileIconUrl } from "@/lib/file-icons"
import { openSourceTarget } from "@/lib/source-opener"
import {
  parseSourceReference,
  type SourceOpenTarget,
} from "@/lib/source-target"
import type {
  ComponentProps,
  HTMLAttributes,
  ReactElement,
  ReactNode,
} from "react"
import {
  createContext,
  lazy,
  memo,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { Streamdown } from "streamdown"
import { MessageTable } from "./message-table"
import "./message-response.css"

// Visual replies load with the first page an answer shows.
const VisualReplyBlock = lazy(() =>
  import("@/components/ai-elements/visual-reply").then((module) => ({
    default: module.VisualReplyBlock,
  }))
)
const VisualReplyFrame = lazy(() =>
  import("@/components/ai-elements/visual-reply").then((module) => ({
    default: module.VisualReplyFrame,
  }))
)

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: UIMessage["role"]
}

export const Message = ({ className, from, ...props }: MessageProps) => (
  <div
    className={cn(
      "group flex w-full flex-col gap-2",
      from === "user" ? "is-user max-w-[95%]" : "is-assistant max-w-full",
      className
    )}
    {...props}
  />
)

export type MessageContentProps = HTMLAttributes<HTMLDivElement>

export const MessageContent = ({
  children,
  className,
  ...props
}: MessageContentProps) => (
  <div
    className={cn(
      // Settings → Chat → Message Text Size (13px by default).
      "is-user:dark flex w-fit max-w-full min-w-0 flex-col gap-2 overflow-hidden text-[length:var(--message-font-size)]",
      // bg-card (#1F1F1F) — user bubbles follow the card tier of the
      // two-color theme instead of the old secondary grey.
      "group-[.is-user]:rounded-lg group-[.is-user]:bg-card group-[.is-user]:px-4 group-[.is-user]:py-3 group-[.is-user]:text-foreground",
      "group-[.is-assistant]:text-foreground",
      className
    )}
    {...props}
  >
    {children}
  </div>
)

export type MessageActionsProps = ComponentProps<"div">

export const MessageActions = ({
  className,
  children,
  ...props
}: MessageActionsProps) => (
  <div className={cn("flex items-center gap-1", className)} {...props}>
    {children}
  </div>
)

export type MessageActionProps = ComponentProps<typeof Button> & {
  tooltip?: string
  label?: string
}

export const MessageAction = ({
  tooltip,
  children,
  label,
  variant = "ghost",
  size = "icon-sm",
  ...props
}: MessageActionProps) => {
  const button = (
    <Button size={size} type="button" variant={variant} {...props}>
      {children}
      <span className="sr-only">{label || tooltip}</span>
    </Button>
  )

  if (tooltip) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
          <TooltipContent>
            <p>{tooltip}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }

  return button
}

interface MessageBranchContextType {
  currentBranch: number
  totalBranches: number
  goToPrevious: () => void
  goToNext: () => void
  branches: ReactElement[]
  setBranches: (branches: ReactElement[]) => void
}

const MessageBranchContext = createContext<MessageBranchContextType | null>(
  null
)

const useMessageBranch = () => {
  const context = useContext(MessageBranchContext)

  if (!context) {
    throw new Error(
      "MessageBranch components must be used within MessageBranch"
    )
  }

  return context
}

export type MessageBranchProps = HTMLAttributes<HTMLDivElement> & {
  defaultBranch?: number
  onBranchChange?: (branchIndex: number) => void
}

export const MessageBranch = ({
  defaultBranch = 0,
  onBranchChange,
  className,
  ...props
}: MessageBranchProps) => {
  const [currentBranch, setCurrentBranch] = useState(defaultBranch)
  const [branches, setBranches] = useState<ReactElement[]>([])

  const handleBranchChange = useCallback(
    (newBranch: number) => {
      setCurrentBranch(newBranch)
      onBranchChange?.(newBranch)
    },
    [onBranchChange]
  )

  const goToPrevious = useCallback(() => {
    const newBranch =
      currentBranch > 0 ? currentBranch - 1 : branches.length - 1
    handleBranchChange(newBranch)
  }, [currentBranch, branches.length, handleBranchChange])

  const goToNext = useCallback(() => {
    const newBranch =
      currentBranch < branches.length - 1 ? currentBranch + 1 : 0
    handleBranchChange(newBranch)
  }, [currentBranch, branches.length, handleBranchChange])

  const contextValue = useMemo<MessageBranchContextType>(
    () => ({
      branches,
      currentBranch,
      goToNext,
      goToPrevious,
      setBranches,
      totalBranches: branches.length,
    }),
    [branches, currentBranch, goToNext, goToPrevious]
  )

  return (
    <MessageBranchContext.Provider value={contextValue}>
      <div
        className={cn("grid w-full gap-2 [&>div]:pb-0", className)}
        {...props}
      />
    </MessageBranchContext.Provider>
  )
}

export type MessageBranchContentProps = HTMLAttributes<HTMLDivElement>

export const MessageBranchContent = ({
  children,
  ...props
}: MessageBranchContentProps) => {
  const { currentBranch, setBranches, branches } = useMessageBranch()
  const childrenArray = useMemo(
    () => (Array.isArray(children) ? children : [children]),
    [children]
  )

  // Use useEffect to update branches when they change
  useEffect(() => {
    if (branches.length !== childrenArray.length) {
      setBranches(childrenArray)
    }
  }, [childrenArray, branches, setBranches])

  return childrenArray.map((branch, index) => (
    <div
      className={cn(
        "grid gap-2 overflow-hidden [&>div]:pb-0",
        index === currentBranch ? "block" : "hidden"
      )}
      key={branch.key}
      {...props}
    >
      {branch}
    </div>
  ))
}

export type MessageBranchSelectorProps = ComponentProps<typeof ButtonGroup>

export const MessageBranchSelector = ({
  className,
  ...props
}: MessageBranchSelectorProps) => {
  const { totalBranches } = useMessageBranch()

  // Don't render if there's only one branch
  if (totalBranches <= 1) {
    return null
  }

  return (
    <ButtonGroup
      className={cn(
        "[&>*:not(:first-child)]:rounded-l-md [&>*:not(:last-child)]:rounded-r-md",
        className
      )}
      orientation="horizontal"
      {...props}
    />
  )
}

export type MessageBranchPreviousProps = ComponentProps<typeof Button>

export const MessageBranchPrevious = ({
  children,
  ...props
}: MessageBranchPreviousProps) => {
  const { goToPrevious, totalBranches } = useMessageBranch()

  return (
    <Button
      aria-label="Previous branch"
      disabled={totalBranches <= 1}
      onClick={goToPrevious}
      size="icon-sm"
      type="button"
      variant="ghost"
      {...props}
    >
      {children ?? <ChevronLeftIcon size={14} />}
    </Button>
  )
}

export type MessageBranchNextProps = ComponentProps<typeof Button>

export const MessageBranchNext = ({
  children,
  ...props
}: MessageBranchNextProps) => {
  const { goToNext, totalBranches } = useMessageBranch()

  return (
    <Button
      aria-label="Next branch"
      disabled={totalBranches <= 1}
      onClick={goToNext}
      size="icon-sm"
      type="button"
      variant="ghost"
      {...props}
    >
      {children ?? <ChevronRightIcon size={14} />}
    </Button>
  )
}

export type MessageBranchPageProps = HTMLAttributes<HTMLSpanElement>

export const MessageBranchPage = ({
  className,
  ...props
}: MessageBranchPageProps) => {
  const { currentBranch, totalBranches } = useMessageBranch()

  return (
    <ButtonGroupText
      className={cn(
        "border-none bg-transparent text-muted-foreground shadow-none",
        className
      )}
      {...props}
    >
      {currentBranch + 1} of {totalBranches}
    </ButtonGroupText>
  )
}

export type MessageResponseProps = ComponentProps<typeof Streamdown> & {
  concealCodeBlocks?: boolean
  workspaceRoot?: string | null
  /** The answer is still arriving: pages render once their fence is closed. */
  streaming?: boolean
}

const MessageResponseRenderContext = createContext({
  concealCodeBlocks: false,
  workspaceRoot: undefined as string | null | undefined,
  /**
   * While streaming, the normalized bodies of the closed html fences; null
   * when the answer is complete.
   */
  closedVisualFences: null as ReadonlySet<string> | null,
})

/** Mermaid diagram renderer.
 * [SECURITY] sanitizeSvg lives in @/lib/sanitize (DOMPurify w/ SVG profile). The
 * prior regex-based sanitizer missed xlink:href="javascript:", <animate to=...>,
 * and CSS url() vectors. See src/lib/sanitize.ts. */
let mermaidIdCounter = 0

const MermaidBlock = memo(({ code }: { code: string }) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const [svg, setSvg] = useState<string>("")
  const [error, setError] = useState<string>("")

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const mermaid = (await import("mermaid")).default
        mermaid.initialize({
          startOnLoad: false,
          theme: "dark",
          securityLevel: "strict",
          fontFamily: "ui-monospace, monospace",
          // Use native SVG <text> elements for node labels instead of
          // <foreignObject><div>. Two reasons: (1) SVG text survives
          // DOMPurify's svg profile unchanged, (2) foreignObject-HTML
          // labels need extra CSS in the host page to inherit our font
          // color, which we don't have — hence the empty-box render
          // before this fix. Applies to every Mermaid diagram type.
          flowchart: { htmlLabels: false },
          class: { htmlLabels: false },
          // Explicit theme variables guarantee text contrast on our dark
          // background even if the built-in "dark" preset drifts between
          // Mermaid versions. Colors picked to match the app's own muted
          // palette so diagrams read like the surrounding chat.
          themeVariables: {
            primaryColor: "#1f2937",
            primaryTextColor: "#f3f4f6",
            primaryBorderColor: "#4b5563",
            lineColor: "#9ca3af",
            secondaryColor: "#374151",
            tertiaryColor: "#111827",
            background: "transparent",
            mainBkg: "#1f2937",
            nodeTextColor: "#f3f4f6",
            textColor: "#f3f4f6",
            labelTextColor: "#f3f4f6",
          },
        })
        const id = `mermaid-${++mermaidIdCounter}`
        const { svg: rendered } = await mermaid.render(id, code)
        if (!cancelled) setSvg(rendered)
      } catch (e) {
        if (!cancelled)
          setError((e as Error).message || "Mermaid render failed")
      }
    })()
    return () => {
      cancelled = true
    }
  }, [code])

  if (error) {
    return (
      <pre className="my-4 overflow-x-auto rounded-xl border border-border/60 bg-muted/20 p-4 font-mono text-xs text-muted-foreground">
        {code}
      </pre>
    )
  }

  if (!svg) {
    return (
      <div className="my-4 h-32 animate-pulse rounded-xl border border-border/60 bg-muted/10" />
    )
  }

  return (
    <div
      // `mermaid-diagram-host` scopes the global text-fill override in
      // index.css that forces node labels to the foreground color —
      // without it DOMPurify-sanitized Mermaid SVGs render labels as
      // invisible black-on-dark because mermaid's CSS selectors (keyed
      // on per-render-unique IDs) don't always survive sanitization.
      className="mermaid-diagram-host my-4 overflow-x-auto rounded-xl border border-border/60 bg-muted/10 p-4 [&_svg]:h-auto [&_svg]:max-w-full"
      ref={containerRef}
      dangerouslySetInnerHTML={{ __html: sanitizeSvg(svg) }}
    />
  )
})

/** Standalone copy button (outside CodeBlock context) */
const CopyBtn = ({ code }: { code: string }) => {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={async () => {
        if (!(await copyText(code))) return
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      }}
      className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
      title="Copy"
    >
      {copied ? (
        <CheckIcon className="size-3.5" />
      ) : (
        <CopyIcon className="size-3.5" />
      )}
    </button>
  )
}

/** Map language ID to a fake filename for the icon lookup */
const langToFilename = (lang: string) => {
  const map: Record<string, string> = {
    js: "file.js",
    javascript: "file.js",
    jsx: "file.jsx",
    ts: "file.ts",
    typescript: "file.ts",
    tsx: "file.tsx",
    html: "file.html",
    htm: "file.htm",
    css: "file.css",
    scss: "file.scss",
    json: "file.json",
    md: "file.md",
    markdown: "file.md",
    py: "file.py",
    python: "file.py",
    rust: "file.rs",
    rs: "file.rs",
    go: "file.go",
    java: "file.java",
    cpp: "file.cpp",
    c: "file.c",
    sh: "file.sh",
    bash: "file.sh",
    shell: "file.sh",
    yaml: "file.yaml",
    yml: "file.yml",
    toml: "file.toml",
    sql: "file.sql",
    graphql: "file.graphql",
    xml: "file.xml",
    svelte: "file.svelte",
    vue: "file.vue",
    swift: "file.swift",
    kotlin: "file.kt",
    dart: "file.dart",
    lua: "file.lua",
  }
  return map[lang.toLowerCase()] || `file.${lang}`
}

/** Custom code block renderer — collapsed by default, VSCode-style overlay */
const KiboCodeBlockComponent = ({
  node: _node,
  className,
  children,
  ...props
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}: any) => {
  const match = /language-(\w+)/.exec(className || "")
  const lang = match?.[1] || "text"
  const codeStr =
    typeof children === "string"
      ? children
      : String(children || "").replace(/\n$/, "")
  const [expanded, setExpanded] = useState(false)
  const [showPreview, setShowPreview] = useState(false)
  const [inlinePreview, setInlinePreview] = useState(false)
  const { concealCodeBlocks, closedVisualFences } = useContext(
    MessageResponseRenderContext
  )
  const visualRepliesEnabled = useSettingsStore((state) => state.visualReplies)

  // Inline code — no collapsing
  if (!("data-block" in props)) {
    return (
      <SourceInlineCode className={className} {...props}>
        {children}
      </SourceInlineCode>
    )
  }

  // Mermaid blocks — render as SVG graph directly
  if (lang === "mermaid") {
    return <MermaidBlock code={codeStr} />
  }

  const isVisualReply = isVisualReplyClassName(className)
  const isHtml = isVisualReply || ["html", "htm"].includes(lang.toLowerCase())
  // While the answer streams, a page renders only once its fence is closed;
  // half a document would reload the frame on every token.
  const fenceIncomplete =
    isHtml &&
    closedVisualFences !== null &&
    !closedVisualFences.has(normalizeFenceBody(codeStr))

  // ```html-render is a visual reply: a live page by default. With Visual
  // replies off it is an ordinary html block (its class reads as `html`).
  if (isVisualReply && visualRepliesEnabled) {
    return (
      <Suspense fallback={<div className="min-h-[120px]" aria-hidden="true" />}>
        <VisualReplyBlock code={codeStr} incomplete={fenceIncomplete} />
      </Suspense>
    )
  }

  const lineCount = codeStr.split("\n").length
  const preview = codeStr.split("\n").slice(0, 3).join("\n")
  const fakeFile = langToFilename(lang)
  const showInlinePreview = isHtml && inlinePreview && !fenceIncomplete

  return (
    <>
      {/* Collapsed card */}
      <div className="my-3 overflow-hidden rounded-xl border border-border/60 bg-muted/20">
        <div className="flex items-center gap-2 px-3 py-2">
          <img
            src={getFileIconUrl(fakeFile)}
            alt=""
            className="size-4 shrink-0"
            onError={(e) => {
              ;(e.target as HTMLImageElement).style.display = "none"
            }}
          />
          <span className="font-mono text-[11px] font-medium text-muted-foreground">
            {lang}
          </span>
          <span className="text-[10px] text-muted-foreground/40">
            {lineCount} lines
          </span>
          <div className="flex-1" />
          <CopyBtn code={codeStr} />
          {isHtml && (
            <button
              type="button"
              aria-pressed={showInlinePreview}
              disabled={fenceIncomplete}
              onClick={() => setInlinePreview((value) => !value)}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-medium text-muted-foreground transition-colors outline-none hover:bg-muted/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50 aria-pressed:bg-muted aria-pressed:text-foreground"
              title={
                fenceIncomplete
                  ? "Preview is available once the block is complete"
                  : "Show the page here"
              }
            >
              <EyeIcon className="size-3.5" />
              Preview
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setExpanded(true)
              setShowPreview(false)
            }}
            className="rounded-md px-2 py-1 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
          >
            Open
          </button>
        </div>
        {showInlinePreview ? (
          <div className="border-t border-border/30">
            <Suspense fallback={null}>
              <VisualReplyFrame html={codeStr} title="HTML preview" />
            </Suspense>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => {
              setExpanded(true)
              setShowPreview(false)
            }}
            className="w-full cursor-pointer border-t border-border/30 px-3 py-2 text-left transition-colors hover:bg-muted/20"
          >
            {concealCodeBlocks ? (
              <div className="flex items-center gap-2 py-1 font-mono text-[11px] text-muted-foreground/60">
                <CodeIcon className="size-3.5" />
                <span>Code concealed</span>
              </div>
            ) : (
              <pre
                className="overflow-hidden font-mono text-[11px] whitespace-pre text-muted-foreground/60"
                style={{ maxHeight: "3.6em" }}
              >
                {preview}
                {lineCount > 3 ? "\n..." : ""}
              </pre>
            )}
          </button>
        )}
      </div>

      {/* VSCode-style overlay modal */}
      {expanded && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => setExpanded(false)}
        >
          <div
            className="relative flex h-[92vh] w-[96vw] max-w-[1600px] flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Tab bar — like VSCode */}
            <div className="flex shrink-0 items-center border-b border-border/40 bg-muted/20">
              {/* Active tab */}
              <div className="flex items-center gap-2 border-r border-b-2 border-border/40 border-b-primary bg-background px-4 py-2">
                <img
                  src={getFileIconUrl(fakeFile)}
                  alt=""
                  className="size-4 shrink-0"
                  onError={(e) => {
                    ;(e.target as HTMLImageElement).style.display = "none"
                  }}
                />
                <span className="font-mono text-xs font-medium">
                  {fakeFile}
                </span>
              </div>
              <div className="flex-1" />
              {/* View toggle for HTML */}
              {isHtml && (
                <div className="mr-2 flex items-center gap-0.5 rounded-md border border-border/40 p-0.5">
                  <button
                    type="button"
                    onClick={() => setShowPreview(false)}
                    className={`flex items-center gap-1 rounded px-2 py-1 text-[10px] transition-colors ${!showPreview ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                  >
                    <CodeIcon className="size-3" /> Code
                  </button>
                  <button
                    type="button"
                    disabled={fenceIncomplete}
                    onClick={() => setShowPreview(true)}
                    className={`flex items-center gap-1 rounded px-2 py-1 text-[10px] transition-colors disabled:opacity-50 ${showPreview ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                  >
                    <EyeIcon className="size-3" /> Preview
                  </button>
                </div>
              )}
              <CopyBtn code={codeStr} />
              <button
                type="button"
                onClick={() => setExpanded(false)}
                className="mr-2 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                title="Close"
              >
                <XIcon className="size-4" />
              </button>
            </div>

            {/* Editor area */}
            <div className="min-h-0 flex-1 overflow-auto">
              {showPreview && isHtml && !fenceIncomplete ? (
                // The visual reply frame: sandboxed, opaque origin, its own
                // policy (lib/visual-reply.ts). A srcdoc frame would inherit
                // the app's policy and run none of the page's scripts.
                <Suspense fallback={null}>
                  <VisualReplyFrame html={codeStr} title="HTML preview" fill />
                </Suspense>
              ) : (
                <CodeBlock
                  code={codeStr}
                  language={lang as BundledLanguage}
                  showLineNumbers
                  className="h-full [&>div]:h-full"
                ></CodeBlock>
              )}
            </div>

            {/* Status bar — like VSCode */}
            <div className="flex shrink-0 items-center gap-4 border-t border-border/40 bg-muted/10 px-4 py-1">
              <span className="font-mono text-[10px] text-muted-foreground">
                {lang.toUpperCase()}
              </span>
              <span className="text-[10px] text-muted-foreground/50">
                {lineCount} lines
              </span>
              <span className="text-[10px] text-muted-foreground/50">
                {codeStr.length} chars
              </span>
              <div className="flex-1" />
              <span className="text-[10px] text-muted-foreground/40">
                UTF-8
              </span>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function sourceTargetFromChildren(
  children: ReactNode,
  requirePathSignal: boolean
): SourceOpenTarget | null {
  if (typeof children !== "string") return null
  // Bare dotted identifiers and IP addresses are also valid file names. Only
  // turn inline code into a button when its text supplies a path or location.
  if (requirePathSignal && !/[\\/]|:\d+(?::\d+)?$|#L\d+/.test(children))
    return null
  const target = parseSourceReference(children, { requirePathSignal })
  if (requirePathSignal && target && target.kind !== "external") {
    const basename = target.filePath.split(/[\\/]/).pop() ?? ""
    if (
      !target.line &&
      !/\.[a-z0-9]+$/i.test(basename) &&
      !/^(?:readme|license|dockerfile|makefile|gemfile|procfile|rakefile)$/i.test(
        basename
      )
    )
      return null
  }
  return target
}

function SourceMarkdownLink({
  href,
  children,
  className,
  node: _node,
}: ComponentProps<"a"> & { node?: unknown }) {
  const { workspaceRoot } = useContext(MessageResponseRenderContext)
  const target = typeof href === "string" ? parseSourceReference(href) : null
  const linkClassName = cn(
    "font-medium wrap-anywhere text-primary underline",
    className
  )

  if (target) {
    return (
      <button
        type="button"
        className={cn(linkClassName, "appearance-none text-left")}
        onClick={() => {
          void openSourceTarget(target, { workspacePath: workspaceRoot })
        }}
        title={href}
      >
        {children}
      </button>
    )
  }

  if (href?.startsWith("#")) {
    return (
      <a className={linkClassName} href={href}>
        {children}
      </a>
    )
  }

  return <span className={linkClassName}>{children}</span>
}

function SourceInlineCode({
  children,
  className,
  node: _node,
  ...props
}: ComponentProps<"code"> & { node?: unknown }) {
  const { workspaceRoot } = useContext(MessageResponseRenderContext)
  const target = sourceTargetFromChildren(children, true)
  if (!target) {
    return (
      <code className={cn("message-inline-code", className)} {...props}>
        {children}
      </code>
    )
  }
  return (
    <button
      type="button"
      className={cn("message-inline-code message-source-link", className)}
      onClick={() => {
        void openSourceTarget(target, {
          workspacePath: workspaceRoot,
        })
      }}
      title={`Open ${typeof children === "string" ? children : "source"}`}
    >
      {children}
    </button>
  )
}

const streamdownComponents = {
  a: SourceMarkdownLink,
  code: KiboCodeBlockComponent,
  inlineCode: SourceInlineCode,
  table: MessageTable,
}

export const MessageResponse = memo(
  ({
    className,
    concealCodeBlocks = false,
    workspaceRoot,
    streaming = false,
    ...props
  }: MessageResponseProps) => {
    const streamdownPlugins = useStreamdownPlugins()
    const markdown = typeof props.children === "string" ? props.children : ""
    // Only a streaming answer can hold an html fence that is still open.
    const closedVisualFences = useMemo(
      () =>
        streaming && /html/i.test(markdown)
          ? closedFenceBodies(markdown, PREVIEWABLE_FENCE_LANGUAGES)
          : null,
      [streaming, markdown]
    )
    const renderContext = useMemo(
      () => ({ concealCodeBlocks, workspaceRoot, closedVisualFences }),
      [concealCodeBlocks, workspaceRoot, closedVisualFences]
    )
    return (
      <MessageResponseRenderContext.Provider value={renderContext}>
        <Streamdown
          className={cn(
            "message-response size-full min-w-0 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
            className
          )}
          plugins={streamdownPlugins}
          components={streamdownComponents}
          {...props}
        />
      </MessageResponseRenderContext.Provider>
    )
  },
  (prevProps, nextProps) =>
    prevProps.children === nextProps.children &&
    nextProps.isAnimating === prevProps.isAnimating &&
    nextProps.concealCodeBlocks === prevProps.concealCodeBlocks &&
    nextProps.workspaceRoot === prevProps.workspaceRoot &&
    nextProps.streaming === prevProps.streaming
)

MessageResponse.displayName = "MessageResponse"

export type MessageToolbarProps = ComponentProps<"div">

export const MessageToolbar = ({
  className,
  children,
  ...props
}: MessageToolbarProps) => (
  <div
    className={cn(
      "mt-4 flex w-full items-center justify-between gap-4",
      className
    )}
    {...props}
  >
    {children}
  </div>
)
