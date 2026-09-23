import { DropdownMenu } from "radix-ui"
import {
  AlignCenterIcon,
  AlignLeftIcon,
  AlignRightIcon,
  BoldIcon,
  CheckIcon,
  ChevronDownIcon,
  CodeIcon,
  CopyIcon,
  ItalicIcon,
  TrashIcon,
  TypeIcon,
} from "lucide-react"
import {
  hasText,
  OBJECT_COLORS,
  SHAPE_FORMS,
  TEXT_ALIGNS,
  TEXT_SIZES,
  type CanvasObject,
  type ObjectColor,
  type TextAlign,
} from "@/lib/canvas-objects"
import { MENU_ITEM, MENU_PANEL } from "@/components/ui/menu-chrome"
import { SHAPE_LABEL, SOLID, TEXT_SIZE_LABEL } from "./canvas-object-style"
import { cn } from "@/lib/utils"

const BAR_BUTTON =
  "flex h-7 shrink-0 items-center justify-center gap-1 rounded-md px-1.5 text-muted-foreground transition-colors duration-150 hover:bg-muted/70 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
const BAR_ACTIVE = "bg-primary/15 text-primary hover:bg-primary/20"

const ALIGN_ICON: Record<TextAlign, typeof AlignLeftIcon> = {
  left: AlignLeftIcon,
  center: AlignCenterIcon,
  right: AlignRightIcon,
}

/**
 * The bar that follows the selected object.
 *
 * It lives in viewport coordinates, not on the stage: a toolbar that shrank
 * with the zoom would be unreadable on a board fitted to 20%.
 */
export function CanvasFormatBar({
  object,
  left,
  top,
  onChange,
  onDuplicate,
  onRemove,
}: {
  object: CanvasObject
  /** Screen position of the object's top-left corner. */
  left: number
  top: number
  onChange: (object: CanvasObject) => void
  onDuplicate: (id: string) => void
  onRemove: (id: string) => void
}) {
  const text = hasText(object) ? object : null
  return (
    <div
      data-canvas-controls
      data-canvas-format-bar
      className="absolute z-40 flex max-w-[min(680px,calc(100%-24px))] items-center gap-0.5 overflow-x-auto rounded-xl border border-border/60 bg-card/95 px-1.5 py-1 shadow-xl backdrop-blur-sm"
      style={{ left, top, transform: "translate(0, -100%)" }}
    >
      {object.kind === "shape" && (
        <Choice
          label="Shape"
          value={SHAPE_LABEL[object.shape]}
          options={SHAPE_FORMS.map((shape) => ({
            key: shape,
            label: SHAPE_LABEL[shape],
            selected: object.shape === shape,
            select: () => onChange({ ...object, shape }),
          }))}
        />
      )}

      {text && (
        <>
          <Choice
            icon={<TypeIcon className="size-3.5" strokeWidth={1.5} />}
            label="Text size"
            value={TEXT_SIZE_LABEL[text.size]}
            options={TEXT_SIZES.map((size) => ({
              key: size,
              label: TEXT_SIZE_LABEL[size],
              selected: text.size === size,
              select: () => onChange({ ...text, size }),
            }))}
          />
          <Toggle
            label="Bold"
            on={text.bold}
            onClick={() => onChange({ ...text, bold: !text.bold })}
          >
            <BoldIcon className="size-3.5" strokeWidth={2} />
          </Toggle>
          <Toggle
            label="Italic"
            on={text.italic}
            onClick={() => onChange({ ...text, italic: !text.italic })}
          >
            <ItalicIcon className="size-3.5" strokeWidth={2} />
          </Toggle>
          <Toggle
            label="Monospace"
            on={text.mono}
            onClick={() => onChange({ ...text, mono: !text.mono })}
          >
            <CodeIcon className="size-3.5" strokeWidth={1.5} />
          </Toggle>
          <Choice
            icon={(() => {
              const Icon = ALIGN_ICON[text.align]
              return <Icon className="size-3.5" strokeWidth={1.5} />
            })()}
            label="Alignment"
            options={TEXT_ALIGNS.map((align) => ({
              key: align,
              label: align[0].toUpperCase() + align.slice(1),
              selected: text.align === align,
              select: () => onChange({ ...text, align }),
            }))}
          />
          <Swatches
            label="Text colour"
            value={text.color}
            onPick={(color) => onChange({ ...text, color })}
          />
        </>
      )}

      {object.kind === "shape" && (
        <Swatches
          label="Fill"
          value={object.fill}
          ring
          onPick={(fill) => onChange({ ...object, fill })}
        />
      )}

      {object.kind === "task" && (
        <Swatches
          label="Status colour"
          value={object.statusColor}
          onPick={(statusColor) => onChange({ ...object, statusColor })}
        />
      )}

      <span className="mx-0.5 h-4 w-px shrink-0 bg-border/60" />
      <button
        type="button"
        title="Duplicate"
        aria-label="Duplicate"
        onClick={() => onDuplicate(object.id)}
        className={BAR_BUTTON}
      >
        <CopyIcon className="size-3.5" strokeWidth={1.5} />
      </button>
      <button
        type="button"
        title="Delete"
        aria-label="Delete"
        onClick={() => onRemove(object.id)}
        className={cn(BAR_BUTTON, "hover:text-red-300")}
      >
        <TrashIcon className="size-3.5" strokeWidth={1.5} />
      </button>
    </div>
  )
}

function Toggle({
  label,
  on,
  onClick,
  children,
}: {
  label: string
  on: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={on}
      onClick={onClick}
      className={cn(BAR_BUTTON, on && BAR_ACTIVE)}
    >
      {children}
    </button>
  )
}

function Choice({
  icon,
  label,
  value,
  options,
}: {
  icon?: React.ReactNode
  label: string
  value?: string
  options: {
    key: string
    label: string
    selected: boolean
    select: () => void
  }[]
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          title={label}
          aria-label={label}
          className={BAR_BUTTON}
        >
          {icon}
          {value && <span className="text-[11px]">{value}</span>}
          <ChevronDownIcon className="size-3 opacity-60" strokeWidth={2} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={6}
          className={cn(MENU_PANEL, "z-50 min-w-36 text-foreground")}
        >
          {options.map((option) => (
            <DropdownMenu.Item
              key={option.key}
              onSelect={option.select}
              className={cn(
                MENU_ITEM,
                "flex cursor-default items-center outline-none data-highlighted:bg-accent"
              )}
            >
              <span className="flex-1">{option.label}</span>
              {option.selected && (
                <CheckIcon className="size-3.5 text-primary" strokeWidth={2} />
              )}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

function Swatches({
  label,
  value,
  ring,
  onPick,
}: {
  label: string
  value: ObjectColor
  /** Show the choice as an outline, which is how a fill reads on a shape. */
  ring?: boolean
  onPick: (color: ObjectColor) => void
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          title={label}
          aria-label={label}
          className={BAR_BUTTON}
        >
          <span
            className={cn(
              "size-3.5 rounded-full ring-1 ring-black/25",
              ring ? "bg-transparent p-px ring-2" : SOLID[value]
            )}
          >
            {ring && (
              <span
                className={cn(
                  "block size-full rounded-full opacity-50",
                  SOLID[value]
                )}
              />
            )}
          </span>
          <ChevronDownIcon className="size-3 opacity-60" strokeWidth={2} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={6}
          className={cn(MENU_PANEL, "z-50 flex gap-1 p-1.5")}
        >
          {OBJECT_COLORS.map((color) => (
            <DropdownMenu.Item
              key={color}
              aria-label={`${label} ${color}`}
              onSelect={() => onPick(color)}
              className="flex size-6 cursor-default items-center justify-center rounded-md outline-none data-highlighted:bg-accent"
            >
              <span
                className={cn(
                  "size-3.5 rounded-full ring-1",
                  SOLID[color],
                  value === color ? "ring-foreground/70" : "ring-black/25"
                )}
              />
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
