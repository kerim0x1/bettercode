import { ChevronLeftIcon, ChevronRightIcon, ImportIcon } from "lucide-react"
import { ConversationImportPicker } from "@/components/conversation-import/conversation-import-picker"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { useConversationImport } from "@/hooks/use-conversation-import"
import { useOnboardingStore } from "@/lib/onboarding-store"
import { StepHeader } from "./shared"

/**
 * "Bring your conversations": after the CLI check, offers the Claude Code
 * and Codex sessions on this computer for import. Nothing is selected at
 * first; Next or Skip moves on without importing.
 */
export function ConversationsStep() {
  const { nextStep, prevStep } = useOnboardingStore()
  const state = useConversationImport()
  const count = state.selectedCount

  return (
    <div className="w-full max-w-2xl">
      <StepHeader
        title="Bring your conversations"
        description="Import earlier Claude Code and Codex chats from this computer. Each joins the project it ran in, and continuing one picks up where you left off."
      />

      <ConversationImportPicker
        state={state}
        listClassName="max-h-[min(46vh,420px)]"
      />

      <div className="mt-5 flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={state.importing}
          onClick={prevStep}
        >
          <ChevronLeftIcon className="mr-1 size-3.5" />
          Back
        </Button>
        <div className="flex-1" />
        {count > 0 ? (
          <>
            <Button
              variant="ghost"
              size="sm"
              disabled={state.importing}
              onClick={nextStep}
            >
              Skip
            </Button>
            <Button
              size="sm"
              className="gap-1.5"
              disabled={state.importing}
              aria-busy={state.importing || undefined}
              onClick={() => void state.runImport()}
            >
              {state.importing ? (
                <Spinner className="size-3.5" />
              ) : (
                <ImportIcon className="size-3.5" aria-hidden="true" />
              )}
              {`Import ${count} ${count === 1 ? "chat" : "chats"}`}
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            className="gap-1"
            disabled={state.importing}
            onClick={nextStep}
          >
            Next <ChevronRightIcon className="size-3.5" />
          </Button>
        )}
      </div>
    </div>
  )
}
