import { useEffect, useMemo, useState } from "react"
import {
  ExternalLinkIcon,
  FileWarningIcon,
  MusicIcon,
  MinusIcon,
  PlusIcon,
  RefreshCwIcon,
  ScanIcon,
} from "lucide-react"
import type { EditorTab } from "@/lib/editor-store"
import { getEditorFileMimeType } from "@/lib/editor-file-kind"
import { readBinaryFile } from "@/services/backend"
import { Button } from "@/components/ui/button"
import { HttpError } from "@/lib/errors/types"

const MIN_IMAGE_ZOOM = 25
const MAX_IMAGE_ZOOM = 400
const IMAGE_ZOOM_STEP = 25

const inFlightBinaryReads = new Map<string, ReturnType<typeof readBinaryFile>>()

function readPreviewFile(path: string): ReturnType<typeof readBinaryFile> {
  const existing = inFlightBinaryReads.get(path)
  if (existing) return existing
  const request = readBinaryFile(path)
  inFlightBinaryReads.set(path, request)
  const clear = () => {
    if (inFlightBinaryReads.get(path) === request) {
      inFlightBinaryReads.delete(path)
    }
  }
  void request.then(clear, clear)
  return request
}

function base64BlobUrl(base64: string, mimeType: string): string {
  const decoded = window.atob(base64)
  const bytes = new Uint8Array(decoded.length)
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index)
  }
  return URL.createObjectURL(new Blob([bytes], { type: mimeType }))
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// Only path, name and kind are needed, so callers outside the editor-tab
// world (e.g. the file-editor modal) can pass a minimal object.
export function FilePreview({
  tab,
}: {
  tab: Pick<EditorTab, "filePath" | "fileName" | "fileKind">
}) {
  const mimeType = useMemo(
    () => getEditorFileMimeType(tab.filePath),
    [tab.filePath]
  )
  const [preview, setPreview] = useState<{
    url: string
    size: number
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [zoom, setZoom] = useState<number | "fit">("fit")
  const [previewRevision, setPreviewRevision] = useState(0)

  useEffect(() => {
    return window.electronAPI?.onBackendStatus?.(() => {
      setPreviewRevision((current) => current + 1)
    })
  }, [])

  useEffect(() => {
    if (tab.fileKind === "binary") return
    let disposed = false
    let objectUrl: string | null = null
    setPreview(null)
    setError(null)
    setZoom("fit")

    void readPreviewFile(tab.filePath)
      .then((file) => {
        if (disposed) return
        objectUrl = base64BlobUrl(file.base64, mimeType)
        setPreview({ url: objectUrl, size: file.size })
      })
      .catch((reason: unknown) => {
        if (!disposed) {
          setError(
            reason instanceof HttpError && reason.status === 404
              ? "The development backend is older than the editor. Restart BetterC0de once to enable previews."
              : reason instanceof Error
                ? reason.message
                : "Preview could not be loaded"
          )
        }
      })

    return () => {
      disposed = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [mimeType, previewRevision, tab.fileKind, tab.filePath])

  const openInSystem = () => {
    void window.electronAPI?.openPath?.(tab.filePath)
  }

  if (tab.fileKind === "binary") {
    return (
      <PreviewMessage
        icon={<FileWarningIcon className="size-8" strokeWidth={1.4} />}
        title="Binary file"
        description="This file type cannot be edited safely as text. Open it with the system application instead."
        action={<OpenInSystemButton onClick={openInSystem} />}
      />
    )
  }

  if (error) {
    return (
      <PreviewMessage
        icon={<FileWarningIcon className="size-8" strokeWidth={1.4} />}
        title="Preview unavailable"
        description={error}
        action={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={() => setPreviewRevision((current) => current + 1)}
            >
              <RefreshCwIcon className="size-3.5" />
              Retry
            </Button>
            <OpenInSystemButton onClick={openInSystem} />
          </div>
        }
      />
    )
  }

  if (!preview) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center bg-background text-xs text-muted-foreground">
        Loading preview…
      </div>
    )
  }

  if (tab.fileKind === "image") {
    return (
      <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-[radial-gradient(circle_at_1px_1px,color-mix(in_oklab,var(--border)_45%,transparent)_1px,transparent_0)] bg-[length:16px_16px]">
        <div className="absolute top-2 right-2 z-10 flex items-center gap-1 rounded-md border border-border/70 bg-background/90 p-1 shadow-lg backdrop-blur">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Zoom out"
            onClick={() =>
              setZoom((current) =>
                Math.max(
                  MIN_IMAGE_ZOOM,
                  (current === "fit" ? 100 : current) - IMAGE_ZOOM_STEP
                )
              )
            }
          >
            <MinusIcon className="size-3.5" />
          </Button>
          <button
            type="button"
            className="min-w-12 rounded px-1 font-mono text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => setZoom(100)}
          >
            {zoom === "fit" ? "Fit" : `${zoom}%`}
          </button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Zoom in"
            onClick={() =>
              setZoom((current) =>
                Math.min(
                  MAX_IMAGE_ZOOM,
                  (current === "fit" ? 100 : current) + IMAGE_ZOOM_STEP
                )
              )
            }
          >
            <PlusIcon className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Fit image"
            onClick={() => setZoom("fit")}
          >
            <ScanIcon className="size-3.5" />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-8">
          <div className="flex min-h-full min-w-full items-center justify-center">
            <img
              src={preview.url}
              alt={tab.fileName}
              draggable={false}
              className={
                zoom === "fit"
                  ? "max-h-full max-w-full object-contain shadow-2xl shadow-black/25"
                  : "max-w-none object-contain shadow-2xl shadow-black/25"
              }
              style={zoom === "fit" ? undefined : { width: `${zoom}%` }}
            />
          </div>
        </div>
        <PreviewMeta fileName={tab.fileName} size={preview.size} />
      </div>
    )
  }

  if (tab.fileKind === "video") {
    return (
      <div className="flex h-full min-h-0 flex-col bg-black">
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          <video
            src={preview.url}
            className="max-h-full max-w-full"
            controls
            preload="metadata"
          />
        </div>
        <PreviewMeta fileName={tab.fileName} size={preview.size} />
      </div>
    )
  }

  if (tab.fileKind === "audio") {
    return (
      <div className="flex h-full min-h-0 flex-col bg-background">
        <div className="flex min-h-0 flex-1 items-center justify-center p-8">
          <div className="flex w-full max-w-xl flex-col items-center gap-6 rounded-xl border border-border/70 bg-muted/20 p-8 shadow-xl shadow-black/10">
            <div className="flex size-16 items-center justify-center rounded-full border border-border bg-background text-muted-foreground">
              <MusicIcon className="size-7" strokeWidth={1.4} />
            </div>
            <div className="text-center">
              <p className="text-sm font-medium text-foreground">
                {tab.fileName}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {formatBytes(preview.size)}
              </p>
            </div>
            <audio
              src={preview.url}
              className="w-full"
              controls
              preload="metadata"
            />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full min-h-0 bg-neutral-800 p-2">
      <iframe
        src={preview.url}
        title={`Preview of ${tab.fileName}`}
        className="h-full w-full rounded border-0 bg-white"
      />
    </div>
  )
}

function PreviewMeta({ fileName, size }: { fileName: string; size: number }) {
  return (
    <div className="flex h-7 shrink-0 items-center justify-between border-t border-border/60 bg-background/95 px-3 text-[10px] text-muted-foreground">
      <span className="truncate">{fileName}</span>
      <span className="shrink-0 font-mono">{formatBytes(size)}</span>
    </div>
  )
}

function OpenInSystemButton({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="outline" size="sm" className="gap-2" onClick={onClick}>
      <ExternalLinkIcon className="size-3.5" />
      Open in system
    </Button>
  )
}

function PreviewMessage({
  icon,
  title,
  description,
  action,
}: {
  icon: React.ReactNode
  title: string
  description: string
  action?: React.ReactNode
}) {
  return (
    <div className="flex h-full min-h-0 items-center justify-center bg-background p-8">
      <div className="flex max-w-md flex-col items-center text-center text-muted-foreground">
        {icon}
        <h2 className="mt-4 text-sm font-medium text-foreground">{title}</h2>
        <p className="mt-2 text-xs leading-5">{description}</p>
        {action && <div className="mt-5">{action}</div>}
      </div>
    </div>
  )
}
