import * as React from "react"
import { createPortal } from "react-dom"
import { cn } from "@/lib/utils"
import {
  shouldCloseOnOtherSubOpen,
  shouldCloseOnPointerDown,
} from "@/components/ui/simple-dropdown-behavior"
import { ChevronRight } from "lucide-react"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"

/* ------------------------------------------------------------------ */
/*  Context                                                            */
/* ------------------------------------------------------------------ */

const SimpleDropdownCtx = React.createContext<{ close: () => void }>({
  close: () => {},
})

const VIEWPORT_PADDING = 8
const ROOT_GAP = 6
const SUBMENU_GAP = 4

function useSimpleDropdown() {
  return React.useContext(SimpleDropdownCtx)
}

/* ------------------------------------------------------------------ */
/*  Root                                                               */
/* ------------------------------------------------------------------ */

interface SimpleDropdownProps {
  trigger: React.ReactNode
  children: React.ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
  align?: "start" | "end"
  /**
   * Which side of the trigger to render the panel on.
   * - "top" (default): panel grows UPWARD from the trigger — used by the
   *   chat-bar model picker and other bottom-anchored triggers.
   * - "bottom": panel drops DOWNWARD from the trigger — used by titlebar
   *   menus (File/Edit/View) in Simple UI mode.
   */
  side?: "top" | "bottom"
  className?: string
}

function SimpleDropdown({
  trigger,
  children,
  open: controlledOpen,
  onOpenChange,
  align = "start",
  side = "top",
  className,
}: SimpleDropdownProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(false)
  const isControlled = controlledOpen !== undefined
  const open = controlledOpen ?? uncontrolledOpen
  const [mounted, setMounted] = React.useState(false)
  const triggerRef = React.useRef<HTMLDivElement>(null)
  const panelRef = React.useRef<HTMLDivElement>(null)
  const posRef = React.useRef({ top: 0, bottom: 0, left: 0, right: 0 })
  const [panelStyle, setPanelStyle] =
    React.useState<React.CSSProperties | null>(null)

  const updatePosition = React.useCallback(() => {
    if (!triggerRef.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    posRef.current = {
      top: rect.top,
      bottom: rect.bottom,
      left: rect.left,
      right: rect.right,
    }
  }, [])

  const updatePanelStyle = React.useCallback(() => {
    const panel = panelRef.current
    if (!panel) return
    updatePosition()

    const rect = posRef.current
    const panelRect = panel.getBoundingClientRect()
    const panelWidth = panelRect.width
    const viewportWidth = window.innerWidth
    const maxLeft = Math.max(
      VIEWPORT_PADDING,
      viewportWidth - panelWidth - VIEWPORT_PADDING
    )
    const desiredLeft = align === "start" ? rect.left : rect.right - panelWidth
    const left = Math.min(Math.max(desiredLeft, VIEWPORT_PADDING), maxLeft)

    setPanelStyle({
      position: "fixed",
      left,
      ...(side === "top"
        ? { bottom: window.innerHeight - rect.top + ROOT_GAP }
        : { top: rect.bottom + ROOT_GAP }),
      borderRadius: "var(--radius)",
      maxWidth: `calc(100vw - ${VIEWPORT_PADDING * 2}px)`,
    })
  }, [align, side, updatePosition])

  const setOpen = React.useCallback(
    (nextOpen: boolean) => {
      if (nextOpen) updatePosition()
      if (!isControlled) {
        setUncontrolledOpen(nextOpen)
      }
      onOpenChange?.(nextOpen)
    },
    [isControlled, onOpenChange, updatePosition]
  )

  // Mount when opening, schedule unmount when closing (after exit anim).
  React.useEffect(() => {
    if (open) {
      updatePosition()
      setMounted(true)
      requestAnimationFrame(updatePanelStyle)
    } else if (mounted) {
      const timer = setTimeout(() => setMounted(false), 150)
      return () => clearTimeout(timer)
    }
  }, [open, mounted, updatePanelStyle, updatePosition])

  React.useLayoutEffect(() => {
    if (!mounted) return
    updatePanelStyle()
  }, [mounted, children, className, updatePanelStyle])

  React.useEffect(() => {
    if (!open) return
    const handleWindowMove = () => updatePanelStyle()
    window.addEventListener("resize", handleWindowMove)
    window.addEventListener("scroll", handleWindowMove, true)
    return () => {
      window.removeEventListener("resize", handleWindowMove)
      window.removeEventListener("scroll", handleWindowMove, true)
    }
  }, [open, updatePanelStyle])

  const handleOpen = React.useCallback(() => {
    if (open) {
      setOpen(false)
      return
    }
    setOpen(true)
  }, [open, setOpen])

  // close on outside click
  React.useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      const target = e.target as Node
      const allPanels = document.querySelectorAll(
        "[data-simple-dropdown-panel]"
      )
      for (const panel of allPanels) {
        if (panel.contains(target)) return
      }
      if (triggerRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [open, setOpen])

  // close on Escape
  React.useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false)
    }
    document.addEventListener("keydown", handler)
    return () => document.removeEventListener("keydown", handler)
  }, [open, setOpen])

  return (
    <>
      <div ref={triggerRef} onClick={handleOpen} className="cursor-pointer">
        {trigger}
      </div>

      {mounted &&
        createPortal(
          <div
            ref={panelRef}
            data-simple-dropdown-panel
            style={{
              position: "fixed",
              left: posRef.current.left,
              ...(side === "top"
                ? { bottom: window.innerHeight - posRef.current.top + ROOT_GAP }
                : { top: posRef.current.bottom + ROOT_GAP }),
              borderRadius: "var(--radius)",
              maxWidth: `calc(100vw - ${VIEWPORT_PADDING * 2}px)`,
              ...panelStyle,
            }}
            className={cn(
              "z-50 max-h-[300px] overflow-y-auto overscroll-contain",
              "border border-border/50 bg-popover/95 p-0.5 shadow-[0_14px_40px_-24px_rgba(0,0,0,0.85)] backdrop-blur-sm",
              "transition-opacity duration-100 ease-out",
              open ? "opacity-100" : "pointer-events-none opacity-0",
              className
            )}
          >
            <SimpleDropdownCtx.Provider value={{ close: () => setOpen(false) }}>
              {children}
            </SimpleDropdownCtx.Provider>
          </div>,
          document.body
        )}
    </>
  )
}

/* ------------------------------------------------------------------ */
/*  Item                                                               */
/* ------------------------------------------------------------------ */

interface SimpleDropdownItemProps {
  children: React.ReactNode
  /**
   * Fires with the click, modifier keys included (Shift, Ctrl, ⌘; a key
   * press on the row reports them too). Calling `event.preventDefault()`
   * keeps the menu open for this click, as `keepOpen` does for every click.
   */
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void
  onContextMenu?: React.MouseEventHandler<HTMLButtonElement>
  className?: string
  active?: boolean
  /** Explicit toggle state; `active` alone remains a visual selection marker. */
  "aria-pressed"?: React.AriaAttributes["aria-pressed"]
  /**
   * When true, the item is greyed out, the cursor flips to
   * `not-allowed`, and `onClick` is suppressed so a click neither fires
   * the handler nor auto-closes the menu. Used by the model picker to
   * mark provider entries whose backend adapter has no API key / no
   * running CLI / no reachable local server. When combined with
   * `tooltip`, the on-hover hint explains why.
   */
  disabled?: boolean
  /**
   * Optional on-hover hint. When set the trigger button is wrapped in a
   * radix Tooltip so the user can see WHY a disabled item is unclickable
   * (e.g. "API-Key fehlt — in den Einstellungen hinterlegen"). Works on
   * enabled items too (e.g. for keyboard hints) but the disabled-state
   * is the primary use.
   */
  tooltip?: React.ReactNode
  /**
   * When true, clicking the item fires `onClick` but does NOT close the
   * menu. For toggle rows (e.g. the Fast Mode switch in the model picker)
   * where the user flips a state and expects to keep browsing the menu.
   */
  keepOpen?: boolean
}

function SimpleDropdownItem({
  children,
  onClick,
  onContextMenu,
  className,
  active,
  "aria-pressed": ariaPressed,
  disabled,
  tooltip,
  keepOpen,
}: SimpleDropdownItemProps) {
  const { close } = useSimpleDropdown()

  const button = (
    <button
      type="button"
      disabled={disabled}
      aria-disabled={disabled || undefined}
      aria-pressed={ariaPressed}
      onContextMenu={disabled ? undefined : onContextMenu}
      className={cn(
        "flex min-h-7 w-full items-center gap-1.5 px-2 py-1 text-left text-[11px]",
        // A Shift-click (Compare) must not select the menu's text.
        "leading-none text-popover-foreground transition-colors select-none",
        !disabled && "hover:bg-accent/50",
        active && !disabled && "bg-accent/30 text-foreground",
        disabled && "cursor-not-allowed opacity-50",
        className
      )}
      style={{ borderRadius: "var(--radius)" }}
      onClick={(event) => {
        if (disabled) return
        onClick?.(event)
        if (!keepOpen && !event.defaultPrevented) close()
      }}
    >
      {children}
    </button>
  )

  if (!tooltip) return button

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          {/* asChild on a disabled <button> would suppress pointer events
              entirely on some browsers. Wrap in a span so the tooltip
              still surfaces on hover even when the button is disabled. */}
          <span className="block">{button}</span>
        </TooltipTrigger>
        <TooltipContent side="right">{tooltip}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

/* ------------------------------------------------------------------ */
/*  Sub-menu  (nested flyout)                                          */
/* ------------------------------------------------------------------ */

interface SimpleDropdownSubProps {
  trigger: React.ReactNode
  children: React.ReactNode
  className?: string
  /** Extra classes for the trigger ROW (not the flyout panel) — e.g. to
   *  give a menu roomier Codex-style rows (`min-h-9 px-3 text-[13px]`). */
  triggerClassName?: string
  /** When true, the sub-trigger is greyed out and hovering it does NOT
   *  open the flyout (so a click can't accidentally fire either, and
   *  the user can't navigate into a sub-menu they shouldn't act on).
   *  Used by the model picker to gate provider entries whose backend
   *  adapter has no API key / no running server / no logged-in CLI. */
  disabled?: boolean
  /** Optional on-hover hint shown via the radix Tooltip primitive. The
   *  whole sub-trigger row is the tooltip target so the message surfaces
   *  whether the user hovers the icon, label, or chevron. */
  tooltip?: React.ReactNode
}

/**
 * Broadcast so that opening one sub-menu closes its siblings. Hover used to
 * provide that implicitly — with click-to-open every sub owns its state, and
 * without this you could leave three flyouts stacked on screen.
 */
const SUB_OPENED_EVENT = "betterc0de:simple-dropdown-sub-opened"
let subInstanceCounter = 0

function SimpleDropdownSub({
  trigger,
  children,
  className,
  triggerClassName,
  disabled,
  tooltip,
}: SimpleDropdownSubProps) {
  const [open, setOpen] = React.useState(false)
  const triggerRef = React.useRef<HTMLDivElement>(null)
  const panelRef = React.useRef<HTMLDivElement>(null)
  const posRef = React.useRef({ top: 0, left: 0, right: 0, bottom: 0 })
  const [panelStyle, setPanelStyle] =
    React.useState<React.CSSProperties | null>(null)
  const instanceId = React.useRef(`sub-${(subInstanceCounter += 1)}`).current

  /**
   * Sub-menus open on CLICK, not on hover. Hover-to-open fired whenever the
   * pointer crossed a row on its way somewhere else, so flyouts appeared
   * unbidden and the menu felt like it was reacting to the wrong thing.
   */
  const openSub = React.useCallback(() => {
    if (triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect()
      posRef.current = {
        top: rect.top,
        left: rect.left,
        right: rect.right,
        bottom: rect.bottom,
      }
    }
    window.dispatchEvent(
      new CustomEvent(SUB_OPENED_EVENT, {
        detail: { id: instanceId, trigger: triggerRef.current },
      })
    )
    setOpen(true)
  }, [instanceId])

  const handleTriggerClick = (event: React.MouseEvent) => {
    if (disabled) return
    // The parent menu must not treat this as "an item was chosen".
    event.preventDefault()
    event.stopPropagation()
    if (open) setOpen(false)
    else openSub()
  }

  const handleTriggerKeyDown = (event: React.KeyboardEvent) => {
    if (disabled) return
    if (
      event.key === "Enter" ||
      event.key === " " ||
      event.key === "ArrowRight"
    ) {
      event.preventDefault()
      event.stopPropagation()
      openSub()
      return
    }
    if (event.key === "Escape" || event.key === "ArrowLeft") {
      if (!open) return
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
    }
  }

  // Close when a SIBLING sub-menu takes over — never when a descendant one
  // does. The model picker nests these (Model › provider › model), so closing
  // on any other sub opening would collapse the whole chain the moment the
  // user clicked a provider.
  React.useEffect(() => {
    const onOtherOpened = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          id?: string
          trigger?: Node | null
        }>
      ).detail
      const opener = detail?.trigger ?? null
      const shouldClose = shouldCloseOnOtherSubOpen(instanceId, {
        openerId: detail?.id,
        openerIsDescendant: Boolean(
          opener && panelRef.current?.contains(opener)
        ),
      })
      if (shouldClose) setOpen(false)
    }
    window.addEventListener(SUB_OPENED_EVENT, onOtherOpened)
    return () => window.removeEventListener(SUB_OPENED_EVENT, onOtherOpened)
  }, [instanceId])

  // Close on a click outside the trigger and its flyout, so dismissing works
  // the same way it does for the parent menu.
  React.useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (!target) return
      const shouldClose = shouldCloseOnPointerDown({
        insideOwnTrigger: Boolean(triggerRef.current?.contains(target)),
        insideOwnPanel: Boolean(panelRef.current?.contains(target)),
        insideAnyDropdownPanel:
          target instanceof Element &&
          target.closest("[data-simple-dropdown-panel]") !== null,
      })
      if (shouldClose) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false)
    }
    window.addEventListener("pointerdown", onPointerDown, true)
    window.addEventListener("keydown", onKeyDown)
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true)
      window.removeEventListener("keydown", onKeyDown)
    }
  }, [open])

  const updateSubPanelStyle = React.useCallback(() => {
    const trigger = triggerRef.current
    const panel = panelRef.current
    if (!trigger || !panel) return

    const triggerRect = trigger.getBoundingClientRect()
    const panelRect = panel.getBoundingClientRect()
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight
    const panelWidth = panelRect.width
    const panelHeight = panelRect.height
    const rightSideLeft = triggerRect.right + SUBMENU_GAP
    const leftSideLeft = triggerRect.left - panelWidth - SUBMENU_GAP
    const shouldOpenLeft =
      rightSideLeft + panelWidth > viewportWidth - VIEWPORT_PADDING &&
      leftSideLeft >= VIEWPORT_PADDING

    const rawLeft = shouldOpenLeft ? leftSideLeft : rightSideLeft
    const left = Math.min(
      Math.max(rawLeft, VIEWPORT_PADDING),
      Math.max(VIEWPORT_PADDING, viewportWidth - panelWidth - VIEWPORT_PADDING)
    )

    const top = Math.min(
      Math.max(triggerRect.top, VIEWPORT_PADDING),
      Math.max(
        VIEWPORT_PADDING,
        viewportHeight - panelHeight - VIEWPORT_PADDING
      )
    )

    setPanelStyle({
      position: "fixed",
      top,
      bottom: "auto",
      left,
      borderRadius: "var(--radius)",
      maxWidth: `calc(100vw - ${VIEWPORT_PADDING * 2}px)`,
    })
  }, [])

  React.useLayoutEffect(() => {
    if (!open) return
    updateSubPanelStyle()
  }, [open, children, className, updateSubPanelStyle])

  React.useEffect(() => {
    if (!open) return
    const handleWindowMove = () => updateSubPanelStyle()
    window.addEventListener("resize", handleWindowMove)
    window.addEventListener("scroll", handleWindowMove, true)
    return () => {
      window.removeEventListener("resize", handleWindowMove)
      window.removeEventListener("scroll", handleWindowMove, true)
    }
  }, [open, updateSubPanelStyle])

  const triggerRow = (
    <div ref={triggerRef} className="relative">
      {/* Sub-trigger row */}
      <div
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-disabled={disabled || undefined}
        onClick={handleTriggerClick}
        onKeyDown={handleTriggerKeyDown}
        className={cn(
          "flex min-h-7 w-full items-center gap-1.5 px-2 py-1 text-left text-[11px]",
          "leading-none text-popover-foreground transition-colors outline-none",
          !disabled && "cursor-pointer hover:bg-accent/50",
          !disabled &&
            "focus-visible:bg-accent/50 focus-visible:ring-1 focus-visible:ring-ring/50",
          !disabled && open && "bg-accent/50",
          disabled && "cursor-not-allowed opacity-50",
          triggerClassName
        )}
        style={{ borderRadius: "var(--radius)" }}
      >
        {trigger}
        <ChevronRight
          className={cn(
            "ml-auto size-3 text-muted-foreground transition-transform duration-100",
            open && "rotate-90",
            disabled && "opacity-60"
          )}
        />
      </div>

      {/* Flyout sub-panel */}
      {open &&
        !disabled &&
        createPortal(
          <div
            ref={panelRef}
            data-simple-dropdown-panel
            style={{
              position: "fixed",
              left: posRef.current.right + SUBMENU_GAP,
              top: posRef.current.top,
              bottom: "auto",
              borderRadius: "var(--radius)",
              maxWidth: `calc(100vw - ${VIEWPORT_PADDING * 2}px)`,
              ...panelStyle,
            }}
            className={cn(
              "z-[60] max-h-[300px] min-w-[150px] overflow-y-auto overscroll-contain",
              "border border-border/50 bg-popover/95 p-0.5 shadow-[0_14px_40px_-24px_rgba(0,0,0,0.85)] backdrop-blur-sm",
              "animate-in duration-100 fade-in",
              className
            )}
          >
            {children}
          </div>,
          document.body
        )}
    </div>
  )

  if (!tooltip) return triggerRow

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>{triggerRow}</TooltipTrigger>
        <TooltipContent side="right">{tooltip}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

/* ------------------------------------------------------------------ */
/*  Sub-menu Item (same as Item but usable inside sub-menus)           */
/* ------------------------------------------------------------------ */

function SimpleDropdownSubItem({
  children,
  onClick,
  className,
  active,
  "aria-pressed": ariaPressed,
  disabled,
  tooltip,
  keepOpen,
}: SimpleDropdownItemProps) {
  const { close } = useSimpleDropdown()

  const button = (
    <button
      type="button"
      disabled={disabled}
      aria-disabled={disabled || undefined}
      aria-pressed={ariaPressed}
      className={cn(
        "flex min-h-7 w-full items-center gap-1.5 px-2 py-1 text-left text-[11px]",
        // A Shift-click (Compare) must not select the menu's text.
        "leading-none text-popover-foreground transition-colors select-none",
        !disabled && "hover:bg-accent/50",
        active && !disabled && "bg-accent/30 text-foreground",
        disabled && "cursor-not-allowed opacity-50",
        className
      )}
      style={{ borderRadius: "var(--radius)" }}
      onClick={(event) => {
        if (disabled) return
        onClick?.(event)
        if (!keepOpen && !event.defaultPrevented) close()
      }}
    >
      {children}
    </button>
  )

  if (!tooltip) return button

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="block">{button}</span>
        </TooltipTrigger>
        <TooltipContent side="right">{tooltip}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

/* ------------------------------------------------------------------ */
/*  Label  (section header for grouped items)                          */
/* ------------------------------------------------------------------ */

function SimpleDropdownLabel({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "px-2 pt-1.5 pb-0.5 text-[9px] font-medium tracking-wider text-muted-foreground uppercase first:pt-0.5",
        className
      )}
    >
      {children}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Separator                                                          */
/* ------------------------------------------------------------------ */

function SimpleDropdownSeparator({ className }: { className?: string }) {
  return <div className={cn("my-1 h-px bg-border/40", className)} />
}

export {
  SimpleDropdown,
  SimpleDropdownItem,
  SimpleDropdownSub,
  SimpleDropdownSubItem,
  SimpleDropdownLabel,
  SimpleDropdownSeparator,
  useSimpleDropdown,
}
