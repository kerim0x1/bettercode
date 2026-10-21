import { forwardRef, type ReactNode } from "react"

import { cn } from "@/lib/utils"
import type { CanvasDevicePreset } from "@/components/browser-preview/constants"
import {
  PreviewViewport,
  type PreviewViewportHandle,
} from "@/components/browser-preview/preview-viewport"
import type {
  ConsoleLog,
  DomNode,
  SelectedElement,
} from "@/components/browser-preview/types"

interface DesignArtboardProps {
  preset: CanvasDevicePreset
  /** Live preview URL; null renders the empty state inside the frame. */
  url: string | null
  /** hand → preview gets pointer-events:none so the canvas pans over it. */
  interactMode: "interact" | "hand"
  isLoading: boolean
  onLoadingChange: (loading: boolean) => void
  onElementSelected: (el: SelectedElement) => void
  onShortcut: (shortcut: string) => void
  /**
   * Select (pick elements) or Browse (use the page). Defaults to Select so
   * a host without the toggle keeps picking; the hand tool overrides both.
   */
  selectionMode?: boolean
  onDomTree?: (tree: DomNode | null) => void
  onConsoleEntries?: (entries: ConsoleLog[]) => void
  onNavigate?: (url: string) => void
  /** The guest's webContents id once attached; null when it is destroyed. */
  onGuestChange?: (webContentsId: number | null) => void
  /** Rendered inside the frame when no URL is set (empty-state matrix). */
  emptyState: ReactNode
  hideLabel?: boolean
}

/**
 * A single Figma-style artboard on the design canvas: label row above a
 * fixed-size device frame that hosts the live PreviewViewport.
 */
export const DesignArtboard = forwardRef<
  PreviewViewportHandle,
  DesignArtboardProps
>(function DesignArtboard(
  {
    preset,
    url,
    interactMode,
    isLoading,
    onLoadingChange,
    onElementSelected,
    onShortcut,
    selectionMode = true,
    onDomTree,
    onConsoleEntries,
    onNavigate,
    onGuestChange,
    emptyState,
    hideLabel,
  },
  ref
) {
  return (
    <div style={{ width: preset.width }}>
      {/* Frame label — Figma-style artboard caption */}
      {!hideLabel && (
        <div className="flex items-center gap-2 pb-2">
          <span className="text-[11px] font-medium text-muted-foreground">
            {preset.label}
          </span>
          <span className="font-mono text-[10px] text-muted-foreground/60">
            {preset.width} × {preset.height}
          </span>
          {url && (
            <span className="min-w-0 truncate font-mono text-[10px] text-muted-foreground/40">
              {url}
            </span>
          )}
        </div>
      )}

      <div
        className="relative overflow-hidden rounded-lg bg-background shadow-2xl ring-1 ring-border/60"
        style={{ width: preset.width, height: preset.height }}
      >
        {isLoading && url && (
          <div className="absolute inset-x-0 top-0 z-10 h-0.5 bg-primary/70" />
        )}
        {url ? (
          <PreviewViewport
            ref={ref}
            url={url}
            canvas
            interactive={interactMode === "interact"}
            selectionMode={interactMode === "interact" && selectionMode}
            onLoadingChange={onLoadingChange}
            onElementSelected={onElementSelected}
            onShortcut={onShortcut}
            onDomTree={onDomTree}
            onConsoleEntries={onConsoleEntries}
            onGuestChange={onGuestChange}
            onNavigate={
              onNavigate ? (nextUrl) => onNavigate(nextUrl) : undefined
            }
          />
        ) : (
          <div
            className={cn(
              "flex size-full items-center justify-center bg-muted/10 p-8",
              interactMode === "hand" && "pointer-events-none"
            )}
          >
            {emptyState}
          </div>
        )}
      </div>
    </div>
  )
})
