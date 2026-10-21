import { ArrowUpIcon, ListPlusIcon } from "lucide-react"
import {
  PromptInputSubmit,
  usePromptInputController,
  usePromptInputAttachments,
  type PromptInputSubmitProps,
} from "@/components/ai-elements/prompt-input"

export function ComposerSubmit(props: PromptInputSubmitProps) {
  const { textInput } = usePromptInputController()
  const attachments = usePromptInputAttachments()
  const running = props.status === "streaming" || props.status === "submitted"
  const hasDraft =
    textInput.value.trim().length > 0 || attachments.files.length > 0
  const goalCommand = /^\/goal(?:\s|$)/i.test(textInput.value.trim())
  return (
    <>
      {running && hasDraft && (
        <PromptInputSubmit
          size={props.size}
          aria-label={goalCommand ? "Send goal command" : "Queue message"}
          title={
            goalCommand
              ? "Apply goal command now"
              : "Send after the current turn"
          }
          className="rounded-full"
        >
          {goalCommand ? (
            <ArrowUpIcon className="size-4" />
          ) : (
            <ListPlusIcon className="size-4" />
          )}
        </PromptInputSubmit>
      )}
      <PromptInputSubmit {...props} />
    </>
  )
}
