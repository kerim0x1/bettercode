import { Button } from "@/components/ui/button"
import {
  SimpleDropdown,
  SimpleDropdownSub,
  SimpleDropdownSubItem,
} from "@/components/ui/simple-dropdown"
import { cn } from "@/lib/utils"
import {
  CheckIcon,
  ChevronDownIcon,
  SparklesIcon,
  TerminalIcon,
  XIcon,
} from "lucide-react"
import { useEffect, useRef, useState } from "react"
import type { InlineEditProvider, InlineEditRequest } from "./inline-edit-types"

// ═════════════════════════════════════════════════════════════════════════
// Inline Edit Popup — Cursor-style floating card rendered inside Monaco
// ═════════════════════════════════════════════════════════════════════════

interface InlineEditPopupProps {
  selection: InlineEditRequest["selection"]
  isWholeFile: boolean
  initialInstruction?: string
  busy: boolean
  providers: InlineEditProvider[]
  selectedModelId: string
  selectedProviderId: string
  onSelectModel?: (modelId: string, providerId: string) => void
  onSubmit: (instruction: string) => void
  onCancel: () => void
}

export function InlineEditPopup({
  selection,
  isWholeFile,
  initialInstruction = "",
  busy,
  providers,
  selectedModelId,
  selectedProviderId,
  onSelectModel,
  onSubmit,
  onCancel,
}: InlineEditPopupProps) {
  const [instruction, setInstruction] = useState(initialInstruction)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // Autofocus on mount
  useEffect(() => {
    const handle = setTimeout(() => inputRef.current?.focus(), 30)
    return () => clearTimeout(handle)
  }, [])

  const currentProvider = providers.find((p) => p.id === selectedProviderId)
  const currentModel = currentProvider?.models.find(
    (m) => m.id === selectedModelId
  )
  const currentModelName =
    currentModel?.name || selectedModelId || "Select model"

  const rangeLabel = isWholeFile
    ? "Whole file"
    : `L${selection.startLine}–L${selection.endLine}`

  const canSubmit = instruction.trim().length > 0 && !busy

  return (
    <div
      className="inline-edit-widget"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault()
          e.stopPropagation()
          onCancel()
        } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault()
          e.stopPropagation()
          if (canSubmit) onSubmit(instruction)
        }
      }}
    >
      <div className="inline-edit-header">
        <SparklesIcon className="size-3.5 text-primary" />
        <span className="inline-edit-header-title">Edit with AI</span>
        <span className="inline-edit-header-range">{rangeLabel}</span>
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

      <textarea
        ref={inputRef}
        value={instruction}
        onChange={(e) => setInstruction(e.target.value)}
        placeholder="Describe the change you want for this selection..."
        className="inline-edit-input"
        rows={3}
        disabled={busy}
      />

      <div className="inline-edit-footer">
        {providers.length > 0 && onSelectModel ? (
          <SimpleDropdown
            align="start"
            trigger={
              <button
                type="button"
                className="inline-edit-model-button"
                disabled={busy}
                aria-label="Change model"
              >
                {currentProvider?.logo ? (
                  <img
                    src={currentProvider.logo}
                    alt={currentProvider.name}
                    className={cn(
                      "size-3.5 shrink-0",
                      currentProvider.invertDark && "dark:invert"
                    )}
                    onError={(e) =>
                      ((e.target as HTMLImageElement).style.display = "none")
                    }
                  />
                ) : (
                  <TerminalIcon className="size-3.5 shrink-0" />
                )}
                <span className="inline-edit-model-label">
                  {currentModelName}
                </span>
                <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" />
              </button>
            }
            className="max-h-[360px] min-w-[180px]"
          >
            {providers
              .filter((p) => p.models.length > 0)
              .map((provider) => (
                <SimpleDropdownSub
                  key={provider.id}
                  trigger={
                    <>
                      {provider.logo ? (
                        <img
                          src={provider.logo}
                          alt={provider.name}
                          className={cn(
                            "!size-3.5 shrink-0",
                            provider.invertDark && "dark:invert"
                          )}
                          onError={(e) =>
                            ((e.target as HTMLImageElement).style.display =
                              "none")
                          }
                        />
                      ) : (
                        <TerminalIcon className="!size-3.5 shrink-0" />
                      )}
                      <span className="flex-1">{provider.name}</span>
                      <span className="mr-1 text-xs text-muted-foreground">
                        {provider.models.length}
                      </span>
                    </>
                  }
                  className="max-h-[320px]"
                >
                  {provider.models.map((model) => {
                    const isSelected =
                      selectedProviderId === provider.id &&
                      selectedModelId === model.id
                    return (
                      <SimpleDropdownSubItem
                        key={model.id}
                        onClick={() => onSelectModel(model.id, provider.id)}
                        active={isSelected}
                      >
                        {provider.logo ? (
                          <img
                            src={provider.logo}
                            alt={provider.name}
                            className={cn(
                              "!size-3.5 shrink-0",
                              provider.invertDark && "dark:invert"
                            )}
                            onError={(e) =>
                              ((e.target as HTMLImageElement).style.display =
                                "none")
                            }
                          />
                        ) : (
                          <TerminalIcon className="!size-3.5 shrink-0" />
                        )}
                        <span className="flex-1 truncate text-left text-xs">
                          {model.name}
                        </span>
                        {isSelected && (
                          <CheckIcon className="size-3 shrink-0 text-primary" />
                        )}
                      </SimpleDropdownSubItem>
                    )
                  })}
                </SimpleDropdownSub>
              ))}
          </SimpleDropdown>
        ) : (
          <div />
        )}

        <div className="flex-1" />

        <span className="inline-edit-hint">⌘↵</span>

        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs"
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </Button>
        <Button
          size="sm"
          className="h-7 gap-1.5 text-xs"
          onClick={() => onSubmit(instruction)}
          disabled={!canSubmit}
        >
          {busy ? (
            <>
              <div className="size-3 animate-spin rounded-full border border-current border-t-transparent" />
              Applying
            </>
          ) : (
            <>
              <SparklesIcon className="size-3" />
              Apply
            </>
          )}
        </Button>
      </div>
    </div>
  )
}
