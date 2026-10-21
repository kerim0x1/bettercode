import {
  ArrowDownIcon,
  ArrowUpIcon,
  EllipsisIcon,
  GripVerticalIcon,
  ListOrderedIcon,
  PaperclipIcon,
  PencilIcon,
  PlayIcon,
  ShipWheelIcon,
  SquareMousePointerIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react"
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
} from "react"
import type { BrowserElementReference } from "@betterc0de/schema"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  MENU_ITEM_HINT,
  MENU_PANEL,
  MENU_SEPARATOR,
  MENU_WIDTH_SM,
} from "@/components/ui/menu-chrome"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { useChatStore } from "@/lib/chat-store"
import {
  canSteerPayload,
  steerDescription,
  steerModeForProvider,
  steerTargetFor,
  type SteerTarget,
} from "@/lib/chat/steer-delivery"
import { findComposerTextarea } from "@/lib/composer-input"
import { handleError } from "@/lib/errors/handle"
import {
  canMoveQueuedMessage,
  isQueuedMessageEditable,
} from "@/lib/message-queue-editing"
import {
  useMessageQueueStore,
  type QueuedMessage,
  type QueuedMessagePayload,
} from "@/lib/message-queue-store"
import type { UiProvider } from "@/lib/provider-types"
import {
  queuedMessageForEditKey,
  useQueuedMessageEditor,
} from "@/lib/queued-message-editor"
import { cn } from "@/lib/utils"

/** Drag data of a queued message; other drop zones (panes) ignore it. */
const QUEUED_MESSAGE_DRAG_TYPE = "application/x-betterc0de-queued-message"

/** The composer menus' chrome (menu-chrome.ts) on the item menu. */
const QUEUE_MENU_CLASS = cn(
  MENU_PANEL,
  MENU_WIDTH_SM,
  "**:data-[slot$=-item]:focus:bg-accent/50 **:data-[slot$=-item]:data-highlighted:bg-accent/50"
)
const QUEUE_MENU_ITEM =
  "min-h-7 gap-2 rounded-[var(--radius)] px-2 py-1 text-[11px] font-normal [&_svg]:text-muted-foreground"

function runQueueAction(action: () => void) {
  try {
    action()
  } catch (error) {
    handleError(error, { source: "message-queue" })
  }
}

function steerQueued(id: string, target: SteerTarget) {
  void import("@/lib/chat/steer-turn")
    .then(({ steerQueuedMessage }) => steerQueuedMessage(id, target))
    .catch((error: unknown) => handleError(error, { source: "chat-steer" }))
}

/**
 * The chat's queued messages above the composer. Each can be steered into
 * the running turn, edited inline (Alt+Up in the empty composer opens the
 * last one), moved by dragging or with Move up / Move down, and removed.
 */
export function QueuedMessages({
  threadId,
  selectedProvider,
}: {
  threadId: string | null
  /** The composer's provider; steering goes where Stop goes. */
  selectedProvider?: UiProvider
}) {
  const all = useMessageQueueStore((state) => state.messages)
  const messages = useMemo(
    () => all.filter((message) => message.threadId === threadId),
    [all, threadId]
  )
  const running = useChatStore((state) =>
    threadId ? state.streamingByThread[threadId]?.isStreaming === true : false
  )
  const session = useChatStore((state) =>
    threadId
      ? (state.threads.find((thread) => thread.id === threadId)?.session ??
        null)
      : null
  )
  const editingId = useQueuedMessageEditor((state) => state.editingId)
  // The message being dragged, and the one it would land in front of
  // (`null`: last).
  const [drag, setDrag] = useState<{
    id: string
    before: string | null
  } | null>(null)

  // Alt+Up in this chat's empty composer opens its last queued message.
  useEffect(() => {
    if (!threadId) return
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented) return
      const id = queuedMessageForEditKey(event)
      if (!id) return
      const scope =
        event.target instanceof HTMLElement
          ? event.target.closest<HTMLElement>("[data-composer-thread]")
          : null
      if (scope?.dataset.composerThread !== threadId) return
      event.preventDefault()
      useQueuedMessageEditor.getState().start(id)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [threadId])

  if (!threadId || messages.length === 0) return null
  const paused = messages.some(
    (message) => message.status === "paused" || message.status === "failed"
  )
  const target = steerTargetFor(selectedProvider, session)
  const steerHint = steerDescription(steerModeForProvider(target.providerKind))
  const closeEditor = (id: string) => {
    useQueuedMessageEditor.getState().stop(id)
    findComposerTextarea(threadId)?.focus()
  }
  const drop = () => {
    if (drag && drag.before !== drag.id)
      runQueueAction(() =>
        useMessageQueueStore.getState().moveBefore(drag.id, drag.before)
      )
    setDrag(null)
  }

  return (
    <section
      aria-label="Queued messages"
      className="mb-2 rounded-xl border border-border/50 bg-sidebar px-3 py-2 text-xs"
    >
      <div className="mb-1.5 flex items-center gap-2 text-muted-foreground">
        <ListOrderedIcon className="size-3.5" />
        <span>
          {messages.length} queued ·{" "}
          {paused ? "Paused" : "Send after the current turn"}
        </span>
        {paused && (
          <button
            type="button"
            className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-1 text-foreground hover:bg-accent"
            onClick={() =>
              runQueueAction(() =>
                useMessageQueueStore.getState().resume(threadId)
              )
            }
          >
            <PlayIcon className="size-3" /> Resume
          </button>
        )}
      </div>
      <ol
        className="max-h-56 space-y-0.5 overflow-y-auto"
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null))
            setDrag((current) =>
              current ? { ...current, before: current.id } : current
            )
        }}
      >
        {messages.map((message, index) => (
          <QueuedMessageRow
            key={message.id}
            message={message}
            index={index}
            queue={all}
            editing={editingId === message.id}
            running={running}
            steerHint={steerHint}
            dragging={drag?.id === message.id}
            dropBefore={
              drag !== null &&
              drag.before === message.id &&
              drag.id !== message.id
            }
            dropAfter={
              drag !== null &&
              drag.before === null &&
              index === messages.length - 1 &&
              drag.id !== message.id
            }
            onSteer={() => steerQueued(message.id, target)}
            onEdit={() => useQueuedMessageEditor.getState().start(message.id)}
            onCloseEditor={() => closeEditor(message.id)}
            onDragStart={() => setDrag({ id: message.id, before: message.id })}
            onDragOver={(upperHalf) =>
              setDrag((current) =>
                current
                  ? {
                      ...current,
                      before: upperHalf
                        ? message.id
                        : (messages[index + 1]?.id ?? null),
                    }
                  : current
              )
            }
            onDrop={drop}
            onDragEnd={() => setDrag(null)}
            acceptsDrop={drag !== null}
          />
        ))}
      </ol>
    </section>
  )
}

function QueuedMessageRow({
  message,
  index,
  queue,
  editing,
  running,
  steerHint,
  dragging,
  dropBefore,
  dropAfter,
  acceptsDrop,
  onSteer,
  onEdit,
  onCloseEditor,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  message: QueuedMessage
  index: number
  /** The whole queue, for whether the message can move. */
  queue: readonly QueuedMessage[]
  editing: boolean
  running: boolean
  steerHint: string
  dragging: boolean
  dropBefore: boolean
  dropAfter: boolean
  acceptsDrop: boolean
  onSteer: () => void
  onEdit: () => void
  onCloseEditor: () => void
  onDragStart: () => void
  onDragOver: (upperHalf: boolean) => void
  onDrop: () => void
  onDragEnd: () => void
}) {
  const number = index + 1
  const sending = message.status === "sending"
  const editable = isQueuedMessageEditable(message)
  const steerable = running && editable && canSteerPayload(message.payload)
  // Edit returns focus to the editor, not to the menu's trigger.
  const editRequested = useRef(false)
  const files = message.payload.files.length
  const elements = message.payload.browserElements.length
  const handlesDrop = (event: DragEvent) =>
    acceptsDrop && event.dataTransfer.types.includes(QUEUED_MESSAGE_DRAG_TYPE)

  return (
    <li
      draggable={editable && !editing}
      onDragStart={(event) => {
        event.dataTransfer.setData(QUEUED_MESSAGE_DRAG_TYPE, message.id)
        event.dataTransfer.effectAllowed = "move"
        onDragStart()
      }}
      onDragOver={(event) => {
        if (!handlesDrop(event)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = "move"
        const box = event.currentTarget.getBoundingClientRect()
        onDragOver(event.clientY < box.top + box.height / 2)
      }}
      onDrop={(event) => {
        if (!handlesDrop(event)) return
        event.preventDefault()
        onDrop()
      }}
      onDragEnd={onDragEnd}
      className={cn(
        "group/queued relative flex items-start gap-1.5 rounded-md py-1 pr-0.5",
        dragging && "opacity-50"
      )}
    >
      {dropBefore && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 -top-px h-0.5 rounded-full bg-primary"
        />
      )}
      {dropAfter && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-primary"
        />
      )}
      <GripVerticalIcon
        aria-hidden="true"
        className={cn(
          "mt-0.5 size-3.5 shrink-0 text-muted-foreground/50 transition-opacity motion-reduce:transition-none",
          editable && !editing
            ? "cursor-grab opacity-0 group-hover/queued:opacity-100"
            : "opacity-0"
        )}
      />
      <span className="pt-0.5 text-muted-foreground tabular-nums">
        {number}.
      </span>
      <div className="min-w-0 flex-1">
        {editing ? (
          <QueuedMessageEditor
            message={message}
            number={number}
            onClose={onCloseEditor}
          />
        ) : (
          <>
            <p
              className="line-clamp-2 break-words whitespace-pre-wrap"
              onDoubleClick={editable ? onEdit : undefined}
            >
              {message.payload.visibleText ?? message.payload.text}
            </p>
            {files > 0 && (
              <p className="text-muted-foreground">
                {files} attachment{files === 1 ? "" : "s"}
              </p>
            )}
            {elements > 0 && (
              <p className="text-muted-foreground">
                {elements} tagged element{elements === 1 ? "" : "s"}
              </p>
            )}
            {sending ? (
              <p className="mt-0.5 flex items-center gap-1 text-muted-foreground">
                <Spinner className="size-3 motion-reduce:animate-none" />
                Sending…
              </p>
            ) : (
              message.error && (
                <p className="mt-0.5 text-muted-foreground">{message.error}</p>
              )
            )}
          </>
        )}
      </div>
      {!editing && (
        <div className="flex shrink-0 items-center">
          {steerable && (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={`Steer queued message ${number} now`}
              title={steerHint}
              className="size-6 text-muted-foreground hover:text-foreground"
              onClick={onSteer}
            >
              <ShipWheelIcon className="size-3.5" />
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={`Queued message ${number} actions`}
                disabled={sending}
                className="size-6 text-muted-foreground hover:text-foreground data-[state=open]:text-foreground"
              >
                <EllipsisIcon className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              side="top"
              align="end"
              className={QUEUE_MENU_CLASS}
              onCloseAutoFocus={(event) => {
                if (!editRequested.current) return
                editRequested.current = false
                event.preventDefault()
              }}
            >
              {steerable && (
                <DropdownMenuItem
                  className={QUEUE_MENU_ITEM}
                  onSelect={onSteer}
                >
                  <ShipWheelIcon />
                  <span className="min-w-0">
                    Steer now
                    <span className={MENU_ITEM_HINT}>{steerHint}</span>
                  </span>
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                className={QUEUE_MENU_ITEM}
                disabled={!editable}
                onSelect={() => {
                  editRequested.current = true
                  onEdit()
                }}
              >
                <PencilIcon />
                Edit
              </DropdownMenuItem>
              <DropdownMenuItem
                className={QUEUE_MENU_ITEM}
                disabled={!canMoveQueuedMessage(queue, message.id, -1)}
                onSelect={() =>
                  runQueueAction(() =>
                    useMessageQueueStore.getState().move(message.id, -1)
                  )
                }
              >
                <ArrowUpIcon />
                Move up
              </DropdownMenuItem>
              <DropdownMenuItem
                className={QUEUE_MENU_ITEM}
                disabled={!canMoveQueuedMessage(queue, message.id, 1)}
                onSelect={() =>
                  runQueueAction(() =>
                    useMessageQueueStore.getState().move(message.id, 1)
                  )
                }
              >
                <ArrowDownIcon />
                Move down
              </DropdownMenuItem>
              <DropdownMenuSeparator className={MENU_SEPARATOR} />
              <DropdownMenuItem
                className={QUEUE_MENU_ITEM}
                onSelect={() =>
                  runQueueAction(() =>
                    useMessageQueueStore.getState().remove(message.id)
                  )
                }
              >
                <Trash2Icon />
                Remove
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={`Remove queued message ${number}`}
            disabled={sending}
            className="size-6 text-muted-foreground hover:text-foreground"
            onClick={() =>
              runQueueAction(() =>
                useMessageQueueStore.getState().remove(message.id)
              )
            }
          >
            <XIcon className="size-3.5" />
          </Button>
        </div>
      )}
    </li>
  )
}

/** A file in a queued draft, by the name the composer gave it. */
function fileLabel(file: unknown, index: number): string {
  if (file && typeof file === "object") {
    const record = file as Record<string, unknown>
    for (const key of ["filename", "name"]) {
      const value = record[key]
      if (typeof value === "string" && value.trim()) return value.trim()
    }
  }
  return `Attachment ${index + 1}`
}

function elementLabel(element: BrowserElementReference): string {
  return `<${element.tagName}> ${element.label}`.trim()
}

/**
 * Inline editor of a queued draft: its text, and which attachments and
 * tagged elements it keeps. Enter saves, Shift+Enter adds a line, Escape
 * cancels.
 */
function QueuedMessageEditor({
  message,
  number,
  onClose,
}: {
  message: QueuedMessage
  number: number
  onClose: () => void
}) {
  const [text, setText] = useState(message.payload.text)
  const [files, setFiles] = useState(message.payload.files)
  const [elements, setElements] = useState(message.payload.browserElements)
  const input = useRef<HTMLTextAreaElement>(null)
  const empty = !text.trim() && files.length === 0

  useEffect(() => {
    // After the menu that opened the editor has closed.
    const frame = requestAnimationFrame(() => {
      const field = input.current
      if (!field) return
      field.focus()
      field.setSelectionRange(field.value.length, field.value.length)
    })
    return () => cancelAnimationFrame(frame)
  }, [])

  const save = () => {
    if (empty) return
    const current = useMessageQueueStore
      .getState()
      .messages.find((entry) => entry.id === message.id)
    if (!isQueuedMessageEditable(current)) {
      handleError(
        new Error("This message was sent before the edit was saved."),
        {
          source: "message-queue",
        }
      )
      onClose()
      return
    }
    const payload: QueuedMessagePayload = {
      ...current.payload,
      text,
      files,
      browserElements: elements,
      // A label for the sent text (an implemented plan) no longer fits it.
      ...(text !== current.payload.text ? { visibleText: undefined } : {}),
    }
    try {
      useMessageQueueStore.getState().edit(message.id, payload)
    } catch (error) {
      handleError(error, { source: "message-queue" })
      return
    }
    onClose()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      onClose()
    } else if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      save()
    }
  }

  return (
    <div className="space-y-1.5">
      <Textarea
        ref={input}
        value={text}
        aria-label={`Edit queued message ${number}`}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        className="max-h-40 min-h-14 rounded-lg bg-background px-2 py-1.5 text-xs md:text-xs"
      />
      {(files.length > 0 || elements.length > 0) && (
        <ul aria-label="Attachments" className="flex flex-wrap gap-1">
          {files.map((file, fileIndex) => {
            const label = fileLabel(file, fileIndex)
            return (
              <li key={`file:${fileIndex}`} className={EDITOR_CHIP}>
                <PaperclipIcon className="size-3 shrink-0 text-muted-foreground" />
                <span className="truncate">{label}</span>
                <button
                  type="button"
                  aria-label={`Remove ${label}`}
                  className={EDITOR_CHIP_REMOVE}
                  onClick={() =>
                    setFiles((current) =>
                      current.filter((_, at) => at !== fileIndex)
                    )
                  }
                >
                  <XIcon className="size-3" />
                </button>
              </li>
            )
          })}
          {elements.map((element, elementIndex) => {
            const label = elementLabel(element)
            return (
              <li key={`element:${elementIndex}`} className={EDITOR_CHIP}>
                <SquareMousePointerIcon className="size-3 shrink-0 text-muted-foreground" />
                <span className="truncate">{label}</span>
                <button
                  type="button"
                  aria-label={`Remove ${label}`}
                  className={EDITOR_CHIP_REMOVE}
                  onClick={() =>
                    setElements((current) =>
                      current.filter((_, at) => at !== elementIndex)
                    )
                  }
                >
                  <XIcon className="size-3" />
                </button>
              </li>
            )
          })}
        </ul>
      )}
      <div className="flex items-center gap-1">
        <span className="mr-auto text-[10px] text-muted-foreground">
          Enter saves · Esc cancels
        </span>
        <Button type="button" variant="ghost" size="xs" onClick={onClose}>
          Cancel
        </Button>
        <Button type="button" size="xs" disabled={empty} onClick={save}>
          Save
        </Button>
      </div>
    </div>
  )
}

const EDITOR_CHIP =
  "flex max-w-full items-center gap-1 rounded-md border border-border/60 bg-foreground/[0.03] py-0.5 pr-0.5 pl-1.5 text-[11px]"
const EDITOR_CHIP_REMOVE =
  "rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
