import {
  ChevronRightIcon,
  FilmIcon,
  HeadingIcon,
  ImageIcon,
  LinkIcon,
  ListIcon,
  MousePointer2Icon,
  MousePointerClickIcon,
  SquareDashedIcon,
  TextCursorInputIcon,
  TypeIcon,
  type LucideIcon,
} from "lucide-react"
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

/** What kind of thing the picked element is, by its tag. */
function elementKindIcon(tagName: string): LucideIcon {
  if (/^h[1-6]$/.test(tagName)) return HeadingIcon
  if (["img", "picture", "svg", "canvas", "figure"].includes(tagName))
    return ImageIcon
  if (tagName === "video") return FilmIcon
  if (tagName === "a") return LinkIcon
  if (tagName === "button") return MousePointerClickIcon
  if (["input", "textarea", "select", "form"].includes(tagName))
    return TextCursorInputIcon
  if (["ul", "ol", "li", "dl", "table"].includes(tagName)) return ListIcon
  if (
    ["p", "span", "label", "strong", "em", "blockquote", "code"].includes(
      tagName
    )
  )
    return TypeIcon
  if (
    [
      "div",
      "section",
      "main",
      "header",
      "footer",
      "nav",
      "article",
      "aside",
    ].includes(tagName)
  )
    return SquareDashedIcon
  return MousePointer2Icon
}

/**
 * The words after the mention: the element's own label, or its size when the
 * label only repeats the tag ("@Img img" says nothing; "@Img 1200 × 630" does).
 */
function elementDetail(element: BrowserElementReference, name: string) {
  const label = element.label.trim()
  const lower = label.toLowerCase()
  if (label && lower !== element.tagName && lower !== name.toLowerCase())
    return label
  return element.rect
    ? `${Math.round(element.rect.w)} × ${Math.round(element.rect.h)}`
    : null
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
  const KindIcon = elementKindIcon(element.tagName)
  const detail = mirror ? null : elementDetail(element, name)
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
              : "inline-flex h-8 max-w-full items-center gap-2 rounded-lg border border-border/60 bg-foreground/[0.03] pr-2 pl-1 text-xs hover:border-foreground/20 hover:bg-foreground/[0.06] data-[state=open]:border-foreground/25 data-[state=open]:bg-foreground/[0.06]",
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
              <span
                aria-hidden="true"
                className="grid size-6 shrink-0 place-items-center rounded-md bg-foreground/[0.06] text-muted-foreground transition-colors duration-100 group-hover:text-foreground group-data-[state=open]:text-foreground"
              >
                <KindIcon className="size-3.5" />
              </span>
              <span className="shrink-0 font-medium">@{name}</span>
              {detail && (
                <span className="max-w-56 min-w-0 truncate text-muted-foreground">
                  {detail}
                </span>
              )}
              <ChevronRightIcon
                aria-hidden="true"
                className="-ml-0.5 size-3 shrink-0 text-muted-foreground/50 transition-[color,transform] duration-100 group-hover:translate-x-0.5 group-hover:text-foreground group-data-[state=open]:text-foreground motion-reduce:transition-none"
              />
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
