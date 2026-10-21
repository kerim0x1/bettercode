"use client"
import { copyText } from "@/lib/clipboard"

import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { CheckIcon, CopyIcon } from "lucide-react"
import type { ComponentProps, CSSProperties, HTMLAttributes } from "react"
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import type { BundledLanguage, ThemedToken, ThemeRegistrationRaw } from "shiki"
import { useAppearanceStore } from "@/lib/appearance-store"
import { getHighlighter } from "@/lib/shiki-highlighter"
import { getCustomTheme } from "@/lib/custom-theme-cache"
import { customThemeIdOf, type AppliedCustomTheme } from "@/lib/vscode-theme"

// Shiki uses bitflags for font styles: 1=italic, 2=bold, 4=underline
// oxlint-disable-next-line eslint(no-bitwise)
const isItalic = (fontStyle: number | undefined) => fontStyle && fontStyle & 1
// oxlint-disable-next-line eslint(no-bitwise)
const isBold = (fontStyle: number | undefined) => fontStyle && fontStyle & 2
const isUnderline = (fontStyle: number | undefined) =>
  // oxlint-disable-next-line eslint(no-bitwise)
  fontStyle && fontStyle & 4

// Transform tokens to include pre-computed keys to avoid noArrayIndexKey lint
interface KeyedToken {
  token: ThemedToken
  key: string
}
interface KeyedLine {
  tokens: KeyedToken[]
  key: string
}

const addKeysToTokens = (lines: ThemedToken[][]): KeyedLine[] =>
  lines.map((line, lineIdx) => ({
    key: `line-${lineIdx}`,
    tokens: line.map((token, tokenIdx) => ({
      key: `line-${lineIdx}-${tokenIdx}`,
      token,
    })),
  }))

// Token rendering component
const TokenSpan = ({ token }: { token: ThemedToken }) => (
  <span
    className="dark:!bg-[var(--shiki-dark-bg)] dark:!text-[var(--shiki-dark)]"
    style={
      {
        backgroundColor: token.bgColor,
        color: token.color,
        fontStyle: isItalic(token.fontStyle) ? "italic" : undefined,
        fontWeight: isBold(token.fontStyle) ? "bold" : undefined,
        textDecoration: isUnderline(token.fontStyle) ? "underline" : undefined,
        ...token.htmlStyle,
      } as CSSProperties
    }
  >
    {token.content}
  </span>
)

// Line number styles using CSS counters
const LINE_NUMBER_CLASSES = cn(
  "block",
  "before:content-[counter(line)]",
  "before:inline-block",
  "before:[counter-increment:line]",
  "before:w-8",
  "before:mr-4",
  "before:text-right",
  "before:text-muted-foreground/50",
  "before:font-mono",
  "before:select-none"
)

// Line rendering component
const LineSpan = ({
  keyedLine,
  showLineNumbers,
}: {
  keyedLine: KeyedLine
  showLineNumbers: boolean
}) => (
  <span className={showLineNumbers ? LINE_NUMBER_CLASSES : "block"}>
    {keyedLine.tokens.length === 0
      ? "\n"
      : keyedLine.tokens.map(({ token, key }) => (
          <TokenSpan key={key} token={token} />
        ))}
  </span>
)

// Types
type CodeBlockProps = HTMLAttributes<HTMLDivElement> & {
  code: string
  language: BundledLanguage
  showLineNumbers?: boolean
}

interface TokenizedCode {
  tokens: ThemedToken[][]
  fg: string
  bg: string
}

interface CodeBlockContextType {
  code: string
}

// Context
const CodeBlockContext = createContext<CodeBlockContextType>({
  code: "",
})

/**
 * Chat code blocks follow the imported VS Code theme when one is active:
 * shiki reads the theme as-is, so the colors are the theme's own, not an
 * approximation. Without an imported theme the GitHub pair stays.
 */
function activeCustomShikiTheme(): AppliedCustomTheme | null {
  return getCustomTheme(customThemeIdOf(useAppearanceStore.getState().template))
}

// Token cache. Capped so a long session that expands many or large code blocks
// can't grow this module-level map without bound. Map preserves insertion
// order, so the oldest entry is evicted first; reads promote to most-recent.
const tokensCache = new Map<string, TokenizedCode>()
const MAX_TOKENS_CACHE_ENTRIES = 256
const readTokensCache = (key: string): TokenizedCode | undefined => {
  const value = tokensCache.get(key)
  if (value !== undefined) {
    tokensCache.delete(key)
    tokensCache.set(key, value)
  }
  return value
}
const writeTokensCache = (key: string, value: TokenizedCode): void => {
  tokensCache.set(key, value)
  if (tokensCache.size > MAX_TOKENS_CACHE_ENTRIES) {
    const oldest = tokensCache.keys().next().value
    if (oldest !== undefined) tokensCache.delete(oldest)
  }
}

// Subscribers for async token updates
const subscribers = new Map<string, Set<(result: TokenizedCode) => void>>()

const getTokensCacheKey = (
  code: string,
  language: BundledLanguage,
  themeName: string
) => {
  const start = code.slice(0, 100)
  const end = code.length > 100 ? code.slice(-100) : ""
  return `${themeName}:${language}:${code.length}:${start}:${end}`
}

// Create raw tokens for immediate display while highlighting loads
const createRawTokens = (code: string): TokenizedCode => {
  const lines = code.split("\n")
  // Remove trailing empty line (from trailing newline)
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop()
  return {
    bg: "transparent",
    fg: "inherit",
    tokens: lines.map((line) =>
      line === "" ? [] : [{ color: "inherit", content: line } as ThemedToken]
    ),
  }
}

// Synchronous highlight with callback for async results
const highlightCode = (
  code: string,
  language: BundledLanguage,
  // oxlint-disable-next-line eslint-plugin-promise(prefer-await-to-callbacks)
  callback?: (result: TokenizedCode) => void
): TokenizedCode | null => {
  const custom = activeCustomShikiTheme()
  const tokensCacheKey = getTokensCacheKey(
    code,
    language,
    custom?.shiki.name ?? "github"
  )

  // Return cached result if available
  const cached = readTokensCache(tokensCacheKey)
  if (cached) {
    return cached
  }

  // Subscribe callback if provided
  if (callback) {
    if (!subscribers.has(tokensCacheKey)) {
      subscribers.set(tokensCacheKey, new Set())
    }
    subscribers.get(tokensCacheKey)?.add(callback)
  }

  // Start highlighting in background - fire-and-forget async pattern.
  // The shared highlighter (lib/shiki-highlighter) loads shiki lazily, so its
  // grammars stay off the launch path; callers render `createRawTokens` until
  // this resolves. Unknown languages come back as plain "text".
  getHighlighter({
    language,
    themes: custom
      ? [
          "github-light",
          "github-dark",
          custom.shiki as unknown as ThemeRegistrationRaw,
        ]
      : ["github-light", "github-dark"],
  })
    // oxlint-disable-next-line eslint-plugin-promise(prefer-await-to-then)
    .then(({ highlighter, language: langToUse }) => {
      const result = highlighter.codeToTokens(code, {
        lang: langToUse,
        themes: {
          dark: custom?.mode === "dark" ? custom.shiki.name : "github-dark",
          light: custom?.mode === "light" ? custom.shiki.name : "github-light",
        },
      })

      const tokenized: TokenizedCode = {
        bg: result.bg ?? "transparent",
        fg: result.fg ?? "inherit",
        tokens: result.tokens,
      }

      // Cache the result
      writeTokensCache(tokensCacheKey, tokenized)

      // Notify all subscribers
      const subs = subscribers.get(tokensCacheKey)
      if (subs) {
        for (const sub of subs) {
          sub(tokenized)
        }
        subscribers.delete(tokensCacheKey)
      }
    })
    // oxlint-disable-next-line eslint-plugin-promise(prefer-await-to-then), eslint-plugin-promise(prefer-await-to-callbacks)
    .catch((error) => {
      console.error("Failed to highlight code:", error)
      subscribers.delete(tokensCacheKey)
    })

  return null
}

const CodeBlockBody = memo(
  ({
    tokenized,
    showLineNumbers,
    className,
  }: {
    tokenized: TokenizedCode
    showLineNumbers: boolean
    className?: string
  }) => {
    const preStyle = useMemo(
      () => ({
        backgroundColor: tokenized.bg,
        color: tokenized.fg,
      }),
      [tokenized.bg, tokenized.fg]
    )

    const keyedLines = useMemo(() => {
      let lines = addKeysToTokens(tokenized.tokens)
      // Remove trailing empty line
      while (lines.length > 1 && lines[lines.length - 1].tokens.length === 0)
        lines = lines.slice(0, -1)
      return lines
    }, [tokenized.tokens])

    return (
      <pre
        className={cn(
          "m-0 p-4 text-sm dark:!bg-[var(--shiki-dark-bg)] dark:!text-[var(--shiki-dark)]",
          className
        )}
        style={preStyle}
      >
        <code
          className={cn(
            "font-mono text-sm",
            showLineNumbers && "[counter-increment:line_0] [counter-reset:line]"
          )}
        >
          {keyedLines.map((keyedLine) => (
            <LineSpan
              key={keyedLine.key}
              keyedLine={keyedLine}
              showLineNumbers={showLineNumbers}
            />
          ))}
        </code>
      </pre>
    )
  },
  (prevProps, nextProps) =>
    prevProps.tokenized === nextProps.tokenized &&
    prevProps.showLineNumbers === nextProps.showLineNumbers &&
    prevProps.className === nextProps.className
)

CodeBlockBody.displayName = "CodeBlockBody"

export const CodeBlockContainer = ({
  className,
  language,
  style,
  ...props
}: HTMLAttributes<HTMLDivElement> & { language: string }) => (
  <div
    className={cn(
      "group relative w-full overflow-hidden rounded-md border bg-background text-foreground",
      className
    )}
    data-language={language}
    style={{
      containIntrinsicSize: "auto 200px",
      contentVisibility: "auto",
      ...style,
    }}
    {...props}
  />
)

export const CodeBlockHeader = ({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex items-center gap-2 border-b bg-muted/80 px-3 py-2 text-xs text-muted-foreground",
      className
    )}
    {...props}
  >
    {children}
  </div>
)

export const CodeBlockTitle = ({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex items-center gap-2", className)} {...props}>
    {children}
  </div>
)

export const CodeBlockFilename = ({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement>) => (
  <span className={cn("font-mono", className)} {...props}>
    {children}
  </span>
)

export const CodeBlockActions = ({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("-my-1 flex items-center gap-1", className)} {...props}>
    {children}
  </div>
)

export const CodeBlockContent = ({
  code,
  language,
  showLineNumbers = false,
}: {
  code: string
  language: BundledLanguage
  showLineNumbers?: boolean
}) => {
  // Memoized raw tokens for immediate display
  const rawTokens = useMemo(() => createRawTokens(code), [code])

  // The template is part of the cache key so switching themes re-tokenizes
  // visible blocks instead of serving colors from the previous theme.
  const appearanceTemplate = useAppearanceStore((state) => state.template)
  const asyncKey = getTokensCacheKey(
    code,
    language,
    getCustomTheme(customThemeIdOf(appearanceTemplate))?.shiki.name ?? "github"
  )

  // Synchronous cache lookup — avoids setState in effect for cached results
  const syncTokens = useMemo(
    () => highlightCode(code, language) ?? rawTokens,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- asyncKey carries the theme
    [code, language, rawTokens, asyncKey]
  )

  // Async highlighting result (populated after shiki loads)
  const [asyncResult, setAsyncResult] = useState<{
    key: string
    tokens: TokenizedCode
  } | null>(null)

  useEffect(() => {
    let cancelled = false

    highlightCode(code, language, (result) => {
      if (!cancelled) {
        setAsyncResult({ key: asyncKey, tokens: result })
      }
    })

    return () => {
      cancelled = true
    }
  }, [asyncKey, code, language])

  const tokenized =
    asyncResult?.key === asyncKey ? asyncResult.tokens : syncTokens

  return (
    <div className="relative overflow-auto">
      <CodeBlockBody showLineNumbers={showLineNumbers} tokenized={tokenized} />
    </div>
  )
}

export const CodeBlock = ({
  code,
  language,
  showLineNumbers = false,
  className,
  children,
  ...props
}: CodeBlockProps) => {
  const contextValue = useMemo(() => ({ code }), [code])

  return (
    <CodeBlockContext.Provider value={contextValue}>
      <CodeBlockContainer className={className} language={language} {...props}>
        {children}
        <CodeBlockContent
          code={code}
          language={language}
          showLineNumbers={showLineNumbers}
        />
      </CodeBlockContainer>
    </CodeBlockContext.Provider>
  )
}

export type CodeBlockCopyButtonProps = ComponentProps<typeof Button> & {
  onCopy?: () => void
  onError?: (error: Error) => void
  timeout?: number
}

export const CodeBlockCopyButton = ({
  onCopy,
  onError,
  timeout = 2000,
  children,
  className,
  ...props
}: CodeBlockCopyButtonProps) => {
  const [isCopied, setIsCopied] = useState(false)
  const timeoutRef = useRef<number>(0)
  const { code } = useContext(CodeBlockContext)

  const copyToClipboard = useCallback(async () => {
    if (typeof window === "undefined") {
      onError?.(new Error("Clipboard API not available"))
      return
    }

    try {
      if (!isCopied) {
        if (!(await copyText(code))) return
        setIsCopied(true)
        onCopy?.()
        timeoutRef.current = window.setTimeout(
          () => setIsCopied(false),
          timeout
        )
      }
    } catch (error) {
      onError?.(error as Error)
    }
  }, [code, onCopy, onError, timeout, isCopied])

  useEffect(
    () => () => {
      window.clearTimeout(timeoutRef.current)
    },
    []
  )

  const Icon = isCopied ? CheckIcon : CopyIcon

  return (
    <Button
      className={cn("shrink-0", className)}
      onClick={copyToClipboard}
      size="icon"
      variant="ghost"
      {...props}
    >
      {children ?? <Icon size={14} />}
    </Button>
  )
}

export type CodeBlockLanguageSelectorProps = ComponentProps<typeof Select>

export const CodeBlockLanguageSelector = (
  props: CodeBlockLanguageSelectorProps
) => <Select {...props} />

export type CodeBlockLanguageSelectorTriggerProps = ComponentProps<
  typeof SelectTrigger
>

export const CodeBlockLanguageSelectorTrigger = ({
  className,
  ...props
}: CodeBlockLanguageSelectorTriggerProps) => (
  <SelectTrigger
    className={cn(
      "h-7 border-none bg-transparent px-2 text-xs shadow-none",
      className
    )}
    size="sm"
    {...props}
  />
)

export type CodeBlockLanguageSelectorValueProps = ComponentProps<
  typeof SelectValue
>

export const CodeBlockLanguageSelectorValue = (
  props: CodeBlockLanguageSelectorValueProps
) => <SelectValue {...props} />

export type CodeBlockLanguageSelectorContentProps = ComponentProps<
  typeof SelectContent
>

export const CodeBlockLanguageSelectorContent = ({
  align = "end",
  ...props
}: CodeBlockLanguageSelectorContentProps) => (
  <SelectContent align={align} {...props} />
)

export type CodeBlockLanguageSelectorItemProps = ComponentProps<
  typeof SelectItem
>

export const CodeBlockLanguageSelectorItem = (
  props: CodeBlockLanguageSelectorItemProps
) => <SelectItem {...props} />
