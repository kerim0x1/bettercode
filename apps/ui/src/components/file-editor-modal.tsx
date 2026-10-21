import { copyText } from "@/lib/clipboard"
import {
  lazy,
  Suspense,
  useState,
  useEffect,
  useCallback,
  useMemo,
} from "react"
import { cn } from "@/lib/utils"
import { useAppearanceStore } from "@/lib/appearance-store"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import { readFile } from "@/services/backend/workspaceApi"

// [PERF] Monaco is ~4 MB of JS + web workers. Defer it until the file-editor
// modal actually opens instead of paying the parse cost at startup.
const MonacoEditorWrapper = lazy(() =>
  import("@/components/monaco-editor-wrapper").then((m) => ({
    default: m.MonacoEditorWrapper,
  }))
)
import {
  XIcon,
  SaveIcon,
  CopyIcon,
  CheckIcon,
  EyeIcon,
  EyeOffIcon,
} from "lucide-react"
import { getLanguage } from "@/lib/editor-store"
import { getEditorFileKind } from "@/lib/editor-file-kind"
import { FilePreview } from "@/components/editor/file-preview"

interface FileEditorModalProps {
  open: boolean
  onClose: () => void
  filePath: string | null
  cwd?: string
}

export function FileEditorModal({
  open,
  onClose,
  filePath,
  cwd,
}: FileEditorModalProps) {
  const isSimple = useAppearanceStore((s) => s.chatUiStyle === "simple")
  const [content, setContent] = useState("")
  const [originalContent, setOriginalContent] = useState("")
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [copied, setCopied] = useState(false)
  const [showHtmlPreview, setShowHtmlPreview] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cursorLine, setCursorLine] = useState(1)
  const [cursorCol, setCursorCol] = useState(1)

  // Images, audio, video, PDFs and known-binary files never go through the
  // UTF-8 text read — they render via FilePreview (binary read + blob URL).
  const fileKind = filePath ? getEditorFileKind(filePath) : "text"
  const isTextFile = fileKind === "text"

  useEffect(() => {
    if (!open || !filePath || !isTextFile) return
    setLoading(true)
    setError(null)
    readFile(filePath)
      .then((res) => {
        setContent(res.content)
        setOriginalContent(res.content)
      })
      .catch((e) => {
        setError(String(e))
        setContent("")
      })
      .finally(() => setLoading(false))
  }, [open, filePath, isTextFile])

  const isDirty = content !== originalContent
  const fileName = filePath?.split(/[/\\]/).pop() || ""
  const lang = filePath ? getLanguage(filePath) : "plaintext"
  const isHtmlFile = /\.(html?|xhtml?)$/i.test(fileName)

  useEffect(() => {
    if (!open) {
      setShowHtmlPreview(false)
      return
    }
    if (!isHtmlFile) {
      setShowHtmlPreview(false)
    }
  }, [open, isHtmlFile, filePath])

  const previewDocument = useMemo(() => {
    if (!isHtmlFile) return ""

    const dirFromPath =
      filePath && filePath.includes("\\")
        ? filePath.slice(0, filePath.lastIndexOf("\\") + 1)
        : filePath && filePath.includes("/")
          ? filePath.slice(0, filePath.lastIndexOf("/") + 1)
          : cwd || ""

    const normalizedDir = dirFromPath.replace(/\\/g, "/")
    const fileHref = /^[a-zA-Z]:\//.test(normalizedDir)
      ? `file:///${normalizedDir}`
      : normalizedDir
        ? `file://${normalizedDir}`
        : ""

    if (/<base\s/i.test(content) || !fileHref) {
      return content
    }

    const baseTag = `<base href="${encodeURI(fileHref)}">`

    if (/<head[\s>]/i.test(content)) {
      return content.replace(/<head(\s[^>]*)?>/i, (m) => `${m}\n    ${baseTag}`)
    }
    if (/<html[\s>]/i.test(content)) {
      return content.replace(
        /<html(\s[^>]*)?>/i,
        (m) => `${m}\n<head>${baseTag}</head>`
      )
    }
    return `<!doctype html><html><head>${baseTag}</head><body>${content}</body></html>`
  }, [content, filePath, cwd, isHtmlFile])

  const handleSave = useCallback(async () => {
    if (!filePath || !isDirty) return
    setSaving(true)
    try {
      const { writeFile } = await import("@/services/backend/workspaceApi")
      const dir = filePath.substring(
        0,
        Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\")) + 1
      )
      await writeFile(dir, fileName, content)
      setOriginalContent(content)
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }, [filePath, content, isDirty, fileName])

  const handleCopy = useCallback(async () => {
    if (!(await copyText(content))) return
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }, [content])

  if (!open) return null

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose()
      }}
    >
      <DialogContent
        showCloseButton={false}
        className={cn(
          isSimple
            ? "flex h-[75vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl"
            : "flex h-[94vh] !w-[99vw] !max-w-[99vw] flex-col gap-0 overflow-hidden p-0 sm:!w-[99vw] sm:!max-w-[99vw]"
        )}
      >
        <DialogTitle className="sr-only">{fileName}</DialogTitle>
        <DialogDescription className="sr-only">File editor</DialogDescription>

        {/* Header */}
        <div
          className={cn(
            "flex shrink-0 items-center gap-2 border-b border-border/40",
            isSimple ? "px-4 py-2" : "px-5 py-3"
          )}
        >
          <span className="font-mono text-xs font-medium text-foreground">
            {fileName}
          </span>
          <span className="font-mono text-[10px] text-muted-foreground">
            {isTextFile ? lang : fileKind}
          </span>
          {isDirty && (
            <span
              className="size-2 rounded-full bg-amber-400"
              title="Unsaved changes"
            />
          )}
          <div className="flex-1" />
          {isTextFile && (
            <span className="text-[10px] text-muted-foreground">
              {showHtmlPreview
                ? "Rendered HTML"
                : `Ln ${cursorLine}, Col ${cursorCol}`}
            </span>
          )}
          {isHtmlFile && (
            <Button
              variant={showHtmlPreview ? "secondary" : "ghost"}
              size="icon-xs"
              onClick={() => setShowHtmlPreview((v) => !v)}
              title={showHtmlPreview ? "Show code" : "Show rendered HTML"}
            >
              {showHtmlPreview ? (
                <EyeOffIcon className="size-3" />
              ) : (
                <EyeIcon className="size-3" />
              )}
            </Button>
          )}
          {isTextFile && (
            <Button variant="ghost" size="icon-xs" onClick={handleCopy}>
              {copied ? (
                <CheckIcon className="size-3" />
              ) : (
                <CopyIcon className="size-3" />
              )}
            </Button>
          )}
          {isDirty && (
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={handleSave}
              disabled={saving}
            >
              <SaveIcon className="size-3" />
            </Button>
          )}
          <Button variant="ghost" size="icon-xs" onClick={onClose}>
            <XIcon className="size-3" />
          </Button>
        </div>

        {/* Editor area */}
        <div className="min-h-0 flex-1">
          {!isTextFile && filePath ? (
            <FilePreview tab={{ filePath, fileName, fileKind }} />
          ) : loading ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Loading...
            </div>
          ) : error ? (
            <div className="flex h-full items-center justify-center text-sm text-destructive">
              {error}
            </div>
          ) : showHtmlPreview && isHtmlFile ? (
            <iframe
              title={`Rendered preview of ${fileName}`}
              className={cn("h-full w-full bg-white")}
              // SECURITY: drop `allow-same-origin` so the preview runs in an
              // opaque origin and cannot reach `window.top.electronAPI`. A
              // booby-trapped .html file in the workspace would otherwise
              // obtain full IPC access here.
              sandbox="allow-scripts allow-forms allow-modals allow-popups"
              srcDoc={previewDocument}
            />
          ) : (
            <Suspense
              fallback={
                <div className="h-full w-full animate-pulse bg-muted/30" />
              }
            >
              <MonacoEditorWrapper
                filePath={filePath || "untitled"}
                language={lang}
                value={content}
                onChange={setContent}
                onSave={handleSave}
                onCursorChange={(line, col) => {
                  setCursorLine(line)
                  setCursorCol(col)
                }}
              />
            </Suspense>
          )}
        </div>

        {/* Footer */}
        <div className="flex shrink-0 items-center gap-2 border-t border-border/40 px-4 py-1.5 text-[10px] text-muted-foreground">
          <span className="max-w-md truncate font-mono">{filePath}</span>
          <div className="flex-1" />
          {isDirty && <span className="text-amber-400">Modified</span>}
          {isTextFile && (
            <kbd className="rounded border border-border bg-muted px-1 py-0.5 font-mono text-[9px]">
              Ctrl+S
            </kbd>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
