import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { isRenameableIdentifier } from "@/lib/symbol-rename"
import { PencilLineIcon, XIcon } from "lucide-react"
import { useEffect, useRef, useState } from "react"

interface RenameSymbolPopupProps {
  symbol: string
  busy: boolean
  error: string | null
  onSubmit: (name: string) => void
  onCancel: () => void
}

export function RenameSymbolPopup({
  symbol,
  busy,
  error,
  onSubmit,
  onCancel,
}: RenameSymbolPopupProps) {
  const [name, setName] = useState(symbol)
  const inputRef = useRef<HTMLInputElement>(null)
  const valid = isRenameableIdentifier(name)
  const changed = name.trim() !== symbol

  useEffect(() => {
    const handle = window.setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 30)
    return () => window.clearTimeout(handle)
  }, [])

  return (
    <div
      className="inline-edit-widget rename-symbol-widget"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault()
          event.stopPropagation()
          onCancel()
          return
        }
        if (event.key === "Enter") {
          event.preventDefault()
          event.stopPropagation()
          if (valid && changed && !busy) onSubmit(name)
        }
      }}
    >
      <div className="inline-edit-header">
        <PencilLineIcon className="size-3.5 text-primary" />
        <span className="inline-edit-header-title">
          Rename Symbol in Open Files
        </span>
        <span className="inline-edit-header-range">{symbol}</span>
        <div className="flex-1" />
        <button
          type="button"
          className="inline-edit-close"
          onClick={onCancel}
          aria-label="Cancel"
          disabled={busy}
        >
          <XIcon className="size-3" />
        </button>
      </div>

      <input
        ref={inputRef}
        value={name}
        onChange={(event) => setName(event.target.value)}
        className="inline-edit-input h-9 resize-none"
        disabled={busy}
        spellCheck={false}
      />

      <div className="inline-edit-footer">
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-[10px]",
            error || (!valid && name.trim())
              ? "text-destructive"
              : "text-muted-foreground"
          )}
        >
          {error ??
            (!valid && name.trim()
              ? "Use a valid identifier."
              : "Open TypeScript/JavaScript files only. Review and save the changes.")}
        </span>
        <span className="inline-edit-hint">↵</span>
        <Button
          size="sm"
          className="h-7 gap-1.5 text-xs"
          onClick={() => onSubmit(name)}
          disabled={!valid || !changed || busy}
        >
          {busy ? (
            <>
              <div className="size-3 animate-spin rounded-full border border-current border-t-transparent" />
              Renaming
            </>
          ) : (
            <>
              <PencilLineIcon className="size-3" />
              Rename
            </>
          )}
        </Button>
      </div>
    </div>
  )
}
