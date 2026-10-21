import { ArrowUpIcon, ListPlusIcon, ShipWheelIcon } from "lucide-react"
import {
  PromptInputSubmit,
  usePromptInputController,
  usePromptInputAttachments,
  type PromptInputSubmitProps,
} from "@/components/ai-elements/prompt-input"
import {
  steerModeForProvider,
  steerTargetFor,
  whileWorkingDeliveryCopy,
} from "@/lib/chat/steer-delivery"
import type { UiProvider } from "@/lib/provider-types"
import { useSettingsStore } from "@/lib/settings-store"

/**
 * The composer's send/stop button. While the agent works, a written draft
 * gets a second button for what Enter does then: queue the message or steer
 * it into the turn (Settings → Chat). Its tooltip says what that does with
 * this provider and what Ctrl/Cmd+Enter does instead.
 */
export function ComposerSubmit({
  provider,
  ...props
}: PromptInputSubmitProps & {
  /** The chat's provider; it decides whether steering stops the turn. */
  provider?: UiProvider
}) {
  const { textInput } = usePromptInputController()
  const attachments = usePromptInputAttachments()
  const whileWorkingEnter = useSettingsStore((state) => state.whileWorkingEnter)
  const running = props.status === "streaming" || props.status === "submitted"
  const draft = textInput.value.trim()
  const hasDraft = draft.length > 0 || attachments.files.length > 0
  const goalCommand = /^\/goal(?:\s|$)/i.test(draft)
  // Commands run now or wait for the turn; they never go into it.
  const command = draft.startsWith("/")
  const copy = whileWorkingDeliveryCopy(
    command ? "queue" : whileWorkingEnter,
    steerModeForProvider(steerTargetFor(provider).providerKind)
  )
  return (
    <>
      {running && hasDraft && (
        <PromptInputSubmit
          size={props.size}
          aria-label={goalCommand ? "Send goal command" : copy.label}
          title={
            goalCommand
              ? "Apply goal command now"
              : command
                ? copy.description
                : `${copy.description} · ${copy.alternate}`
          }
          className="rounded-full"
        >
          {goalCommand ? (
            <ArrowUpIcon className="size-4" />
          ) : copy.delivery === "steer" ? (
            <ShipWheelIcon className="size-4" />
          ) : (
            <ListPlusIcon className="size-4" />
          )}
        </PromptInputSubmit>
      )}
      <PromptInputSubmit {...props} />
    </>
  )
}
