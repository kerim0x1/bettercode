import { ChevronRightIcon, MousePointer2Icon, XIcon } from "lucide-react"
import {
  browserElementKey,
  type BrowserElementReference,
} from "@betterc0de/schema"
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover"
import { cn } from "@/lib/utils"

export function BrowserElementDetails({
  element,
}: {
  element: BrowserElementReference
}) {
  return (
    <div className="flex min-w-0 flex-col gap-4 text-xs">
      <div className="flex items-start gap-3 border-b border-border/60 pb-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-foreground/[0.06] text-muted-foreground">
          <MousePointer2Icon className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center gap-2 text-[11px] text-muted-foreground">
            Browser element{" "}
            <code className="rounded bg-foreground/[0.06] px-1.5 py-0.5">
              &lt;{element.tagName}&gt;
            </code>
          </div>
          <div className="text-[13px] font-medium break-words text-foreground">
            {element.label}
          </div>
        </div>
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2">
        <dt className="text-muted-foreground">Selector</dt>
        <dd className="font-mono break-all">{element.selector}</dd>
        <dt className="text-muted-foreground">Page</dt>
        <dd className="break-all">{element.url}</dd>
        {element.id && (
          <>
            <dt className="text-muted-foreground">ID</dt>
            <dd className="font-mono break-all">{element.id}</dd>
          </>
        )}
        {element.className && (
          <>
            <dt className="text-muted-foreground">Classes</dt>
            <dd className="font-mono break-all">{element.className}</dd>
          </>
        )}
        {element.rect && (
          <>
            <dt className="text-muted-foreground">Bounds</dt>
            <dd>
              {element.rect.w} x {element.rect.h} px, x {element.rect.x}, y{" "}
              {element.rect.y}
            </dd>
          </>
        )}
        {element.viewport && (
          <>
            <dt className="text-muted-foreground">Viewport</dt>
            <dd>
              {element.viewport.width} x {element.viewport.height} px
            </dd>
          </>
        )}
        {element.childCount !== undefined && (
          <>
            <dt className="text-muted-foreground">Children</dt>
            <dd>{element.childCount}</dd>
          </>
        )}
      </dl>
      {element.text && (
        <div>
          <div className="mb-1 text-muted-foreground">Captured text</div>
          <div className="max-h-36 overflow-auto rounded-lg bg-muted/40 p-2 break-words whitespace-pre-wrap">
            {element.text}
          </div>
        </div>
      )}
      {element.styles && Object.keys(element.styles).length > 0 && (
        <details>
          <summary className="cursor-pointer text-muted-foreground">
            Computed styles
          </summary>
          <dl className="mt-2 grid grid-cols-2 gap-2 font-mono text-[11px]">
            {Object.entries(element.styles).map(([name, value]) => (
              <div key={name} className="contents">
                <dt className="break-all text-muted-foreground">{name}</dt>
                <dd className="break-all">{value}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}
    </div>
  )
}

export function BrowserElementMention({
  element,
  onRemove,
  inline = false,
  mirror = false,
  onReturnFocus,
}: {
  element: BrowserElementReference
  onRemove?: () => void
  inline?: boolean
  /** Preserve the exact width of the native token in the textarea mirror. */
  mirror?: boolean
  onReturnFocus?: () => void
}) {
  const name =
    element.mentionName ??
    element.tagName[0].toUpperCase() + element.tagName.slice(1)
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Inspect @${name}: ${element.label}`}
          title={`View browser element details: ${element.label}`}
          className={cn(
            "group pointer-events-auto cursor-pointer text-foreground transition-colors duration-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground/50",
            mirror
              ? "relative m-0 inline rounded-md border-0 bg-transparent p-0 align-baseline [line-height:inherit] [letter-spacing:inherit] [font:inherit]"
              : "inline-flex max-w-full items-center gap-2 rounded-lg border border-border bg-foreground/[0.04] px-2.5 py-1.5 text-xs hover:border-foreground/25 hover:bg-foreground/[0.08] data-[state=open]:border-foreground/30 data-[state=open]:bg-foreground/[0.08]",
            inline && !mirror && "mx-0.5 align-middle"
          )}
          onKeyDown={(event) => {
            if (
              onRemove &&
              !event.nativeEvent.isComposing &&
              (event.key === "Backspace" || event.key === "Delete")
            ) {
              event.preventDefault()
              onRemove()
              onReturnFocus?.()
            }
          }}
        >
          {mirror ? (
            <>
              {/* Reserve native text metrics so chip styling cannot shift the caret. */}
              <span aria-hidden="true" className="invisible">
                @{name}
              </span>
              <span className="absolute -inset-x-px inset-y-0 flex items-center justify-center rounded-md border border-foreground/15 bg-foreground/[0.07] text-[0.9em] leading-none transition-colors duration-100 group-hover:border-foreground/30 group-hover:bg-foreground/[0.13] group-data-[state=open]:border-foreground/35 group-data-[state=open]:bg-foreground/[0.13]">
                <span className="text-muted-foreground">@</span>
                {name}
              </span>
            </>
          ) : (
            <>
              <MousePointer2Icon
                className="size-3.5 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <span className="shrink-0 font-medium">@{name}</span>
              <span
                aria-hidden="true"
                className="h-3 w-px shrink-0 bg-border"
              />
              <span className="max-w-56 min-w-0 truncate text-muted-foreground">
                {element.label}
              </span>
              <span className="ml-auto flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground group-hover:text-foreground">
                Details
                <ChevronRightIcon className="size-3" aria-hidden="true" />
              </span>
            </>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        aria-label={`Browser element details: ${element.label}`}
        align="start"
        sideOffset={8}
        className="not-prose max-h-[min(480px,70vh)] w-[min(380px,calc(100vw-32px))] overflow-auto rounded-xl border border-border/60 bg-sidebar"
        onCloseAutoFocus={(event) => {
          if (onReturnFocus) {
            event.preventDefault()
            onReturnFocus()
          }
        }}
      >
        <BrowserElementDetails element={element} />
        {onRemove && (
          <button
            type="button"
            className="flex items-center gap-2 rounded-lg border border-border/60 px-2.5 py-2 text-xs text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground focus-visible:outline-2 focus-visible:outline-foreground/50"
            onClick={() => {
              onRemove()
              onReturnFocus?.()
            }}
          >
            <XIcon className="size-3.5" />
            Remove mention<span className="ml-auto">Backspace</span>
          </button>
        )}
      </PopoverContent>
    </Popover>
  )
}

export function BrowserElementChips({
  elements,
  onRemove,
  onReturnFocus,
}: {
  elements: readonly BrowserElementReference[]
  onRemove?: (key: string) => void
  onReturnFocus?: () => void
}) {
  if (!elements.length) return null
  return (
    <ul
      aria-label="Selected page elements"
      className="not-prose flex flex-wrap gap-1.5"
    >
      {elements.map((element) => (
        <li className="max-w-full min-w-0" key={browserElementKey(element)}>
          <BrowserElementMention
            element={element}
            onRemove={
              onRemove ? () => onRemove(browserElementKey(element)) : undefined
            }
            onReturnFocus={onReturnFocus}
          />
        </li>
      ))}
    </ul>
  )
}
