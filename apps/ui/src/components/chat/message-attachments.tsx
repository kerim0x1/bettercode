import { useState } from "react"
import { DownloadIcon, ImageIcon, PaperclipIcon } from "lucide-react"
import {
  readBrowserElementAttachment,
  type ChatAttachment,
} from "@betterc0de/schema"
import { cn } from "@/lib/utils"
import { BrowserElementChips } from "@/components/chat/browser-element-chips"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"

export function attachmentLabel(
  attachment: Pick<ChatAttachment, "filename">,
  index: number
): string {
  return attachment.filename?.trim() || `Attachment ${index + 1}`
}

export function formatAttachmentSize(
  attachment: Pick<ChatAttachment, "url">
): string | null {
  const match = /^data:[^;]+;base64,(.*)$/i.exec(attachment.url)
  if (!match) return null
  const base64 = match[1].replace(/\s/g, "")
  if (!base64) return null
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0
  const bytes = Math.max(0, Math.floor((base64.length * 3) / 4) - padding)
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

/** Anything an `<img>` can show. Other files keep opening as a link. */
export function isPreviewableImage(
  attachment: Pick<ChatAttachment, "mediaType">
): boolean {
  return (attachment.mediaType?.trim().toLowerCase() ?? "").startsWith("image/")
}

interface AttachmentPreview {
  attachment: ChatAttachment
  label: string
  meta: string
}

/**
 * The large view of an image attachment. A chip in the bubble is a thumbnail
 * the size of a fingernail; this is where the user actually looks at what
 * they sent.
 */
export function AttachmentPreviewDialog({
  preview,
  onClose,
}: {
  preview: AttachmentPreview | null
  onClose: () => void
}) {
  return (
    <Dialog
      open={preview !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      {/* A fixed stage of three quarters of the screen; the image scales to
          fill it, so a small screenshot is as readable as a large one. */}
      <DialogContent
        aria-label={
          preview ? `Preview of ${preview.label}` : "Attachment preview"
        }
        className="h-[75vh] w-[75vw] max-w-none grid-rows-[auto_minmax(0,1fr)] gap-3 p-4 sm:max-w-none"
      >
        <div className="flex min-w-0 items-center gap-3 pr-12">
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate text-[13px] font-medium">
              {preview?.label}
            </DialogTitle>
            <DialogDescription className="truncate text-[11px] text-muted-foreground">
              {preview?.meta}
            </DialogDescription>
          </div>
          {preview ? (
            <a
              href={preview.attachment.url}
              download={preview.attachment.filename?.trim() || preview.label}
              className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-foreground/10 px-3 text-[12px] font-medium text-foreground transition-colors hover:bg-foreground/15"
            >
              <DownloadIcon className="size-3.5" strokeWidth={2} />
              Download
            </a>
          ) : null}
        </div>
        {preview ? (
          // A lighter stage behind the image, so a dark screenshot has an
          // edge against the dialog. `object-contain` scales the image up or
          // down to the stage while keeping its aspect ratio.
          <div className="min-h-0 rounded-xl bg-foreground/8 p-3">
            <img
              src={preview.attachment.url}
              alt={preview.label}
              className="block size-full rounded-md object-contain"
            />
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

const chipClassName =
  "group inline-flex max-w-full items-center gap-2 overflow-hidden rounded-md border border-border/50 bg-muted/35 px-2 py-1.5 text-left text-[11px] text-foreground/85 transition-colors hover:bg-muted/55"

/**
 * The attachment chips under a user message. Page-element references render
 * as their own chips; images open the large preview on click; every other
 * file opens as a link.
 */
export function MessageAttachments({
  attachments,
}: {
  attachments: readonly ChatAttachment[]
}) {
  const [preview, setPreview] = useState<AttachmentPreview | null>(null)
  if (attachments.length === 0) return null

  // No bottom margin: MessageContent is a flex column with its own gap, and
  // stacking a margin on top of it pushed the user's text a full line below
  // the chips.
  return (
    <div className="flex flex-wrap gap-2">
      {attachments.map((attachment, index) => {
        const element = readBrowserElementAttachment(attachment)
        if (element)
          return (
            <BrowserElementChips
              key={`element-${index}`}
              elements={[element]}
            />
          )
        const mediaType = attachment.mediaType?.trim() || "file"
        const isImage = isPreviewableImage(attachment)
        const label = attachmentLabel(attachment, index)
        const size = formatAttachmentSize(attachment)
        const meta = size ? `${mediaType} · ${size}` : mediaType
        const key = `${attachment.url.slice(0, 48)}-${index}`
        const body = (
          <>
            {isImage ? (
              <span className="relative grid size-8 shrink-0 place-items-center overflow-hidden rounded border border-border/45 bg-background/80">
                <img
                  alt=""
                  className="size-full object-cover"
                  src={attachment.url}
                />
                <ImageIcon className="absolute size-3 text-muted-foreground opacity-0 group-hover:opacity-100" />
              </span>
            ) : (
              <PaperclipIcon className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className="min-w-0">
              <span className="block truncate font-medium">{label}</span>
              <span className="block truncate text-[10px] text-muted-foreground">
                {meta}
              </span>
            </span>
          </>
        )
        return isImage ? (
          <button
            key={key}
            type="button"
            aria-label={`Preview ${label}`}
            title="Click to preview"
            onClick={() => setPreview({ attachment, label, meta })}
            className={cn(chipClassName, "cursor-zoom-in pr-2")}
          >
            {body}
          </button>
        ) : (
          <a
            key={key}
            className={chipClassName}
            href={attachment.url}
            rel="noreferrer"
            target="_blank"
          >
            {body}
          </a>
        )
      })}
      <AttachmentPreviewDialog
        preview={preview}
        onClose={() => setPreview(null)}
      />
    </div>
  )
}
