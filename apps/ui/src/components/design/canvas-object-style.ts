import type {
  ObjectColor,
  ShapeForm,
  TextAlign,
  TextSize,
} from "@/lib/canvas-objects"

/**
 * Every class is written out in full: Tailwind reads the source, so a
 * template like `text-${color}-300` produces no stylesheet at all.
 */

export const TEXT_COLOR: Record<ObjectColor, string> = {
  default: "text-foreground",
  amber: "text-amber-300",
  sky: "text-sky-300",
  emerald: "text-emerald-300",
  rose: "text-rose-300",
  violet: "text-violet-300",
}

/** A shape's body: a tint the canvas can still be read through. */
export const FILL_SURFACE: Record<ObjectColor, string> = {
  default: "bg-foreground/[0.06] ring-border/70",
  amber: "bg-amber-300/[0.13] ring-amber-200/25",
  sky: "bg-sky-300/[0.13] ring-sky-200/25",
  emerald: "bg-emerald-300/[0.13] ring-emerald-200/25",
  rose: "bg-rose-300/[0.13] ring-rose-200/25",
  violet: "bg-violet-300/[0.13] ring-violet-200/25",
}

/** Solid, for swatches and status pills, where the colour has to be exact. */
export const SOLID: Record<ObjectColor, string> = {
  default: "bg-muted-foreground",
  amber: "bg-amber-400",
  sky: "bg-sky-500",
  emerald: "bg-emerald-500",
  rose: "bg-rose-500",
  violet: "bg-violet-500",
}

export const ON_SOLID: Record<ObjectColor, string> = {
  default: "text-background",
  amber: "text-amber-950",
  sky: "text-white",
  emerald: "text-white",
  rose: "text-white",
  violet: "text-white",
}

export const TEXT_SIZE_CLASS: Record<TextSize, string> = {
  s: "text-[12px] leading-[1.5]",
  m: "text-[15px] leading-[1.45]",
  l: "text-[22px] leading-[1.3]",
  xl: "text-[32px] leading-[1.2]",
}

export const TEXT_SIZE_LABEL: Record<TextSize, string> = {
  s: "Small",
  m: "Medium",
  l: "Large",
  xl: "Display",
}

export const ALIGN_CLASS: Record<TextAlign, string> = {
  left: "text-left",
  center: "text-center",
  right: "text-right",
}

export const SHAPE_LABEL: Record<ShapeForm, string> = {
  rect: "Rectangle",
  rounded: "Rounded",
  ellipse: "Ellipse",
  diamond: "Diamond",
}

/** Rounded corners for the box shapes; the other two are clipped instead. */
export const SHAPE_RADIUS: Record<ShapeForm, string> = {
  rect: "rounded-[2px]",
  rounded: "rounded-2xl",
  ellipse: "rounded-full",
  diamond: "rounded-[2px]",
}

/** A diamond is a square turned 45°, which CSS can only do by clipping. */
export const DIAMOND_CLIP = "polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)"

/**
 * A press inside any of these keeps the board's selection.
 *
 * The last two entries are the menus of the format bar. Radix portals them to
 * <body>, so they reach the canvas through React's tree while `closest` —
 * which walks the DOM — sees only <body> above them. Drop them and picking an
 * alignment or a colour deselects the object, unmounting the bar before the
 * choice is applied.
 */
export const KEEPS_SELECTION = [
  "[data-canvas-object]",
  "[data-canvas-format-bar]",
  "[data-connect-handle]",
  "[data-radix-popper-content-wrapper]",
  "[role=menu]",
].join(",")
