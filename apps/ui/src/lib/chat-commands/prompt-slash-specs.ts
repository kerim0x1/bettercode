import {
  BETTERC0DE_COMPOSER_KEYBIND_DEFAULTS,
  BETTERC0DE_INPUT_ACTION_COMMANDS,
  findBetterC0deKeybindDefault,
} from "@/lib/betterc0de-keybinds"
import { useChatStore } from "@/lib/chat-store"
import { dispatchComposerDraftRestoreAfterSubmit } from "@/lib/composer-draft-events"
import { usePreferencesStore } from "@/lib/preferences-store"
import {
  buildPromptHistoryListOutput,
  resolvePromptHistoryEntry,
} from "@/lib/prompt-history"
import {
  buildPromptStashListOutput,
  createPromptStashEntry,
  pushPromptStashEntry,
} from "@/lib/prompt-stash"
import { resolveThreadRuntimePath } from "@/lib/thread-context"
import {
  type ActiveThreadRef,
  escapeInlineCode,
  escapeMarkdownTableCell,
} from "./provider-config"
import type { SlashCommandRunSpec, SlashCommandRuntimeRun } from "./slash-run"
import {
  buildPromptStashDeleteOutput,
  buildPromptStashPopOutput,
} from "./thread-actions"

function buildPromptHistoryUseOutput(
  selector: string | undefined,
  threadId: string
): string {
  const resolved = resolvePromptHistoryEntry(
    usePreferencesStore.getState().promptHistoryEntries,
    selector
  )
  if (!resolved) {
    return [
      "# Prompt History",
      "",
      "> No matching prompt history entry found.",
      "",
      "Use `/history` to inspect recorded prompts.",
    ].join("\n")
  }
  dispatchComposerDraftRestoreAfterSubmit({
    text: resolved.entry.input,
    threadId,
  })
  return [
    "# Prompt History",
    "",
    `Restored prompt #${resolved.displayIndex} (\`${resolved.entry.id.slice(0, 8)}\`) into the composer.`,
    "",
    "> History entries are kept after restore; use Prompt Stash if you want pop/remove semantics.",
  ].join("\n")
}

function buildPromptClearOutput(threadId: string): string {
  useChatStore.getState().setDraft(threadId, "")
  dispatchComposerDraftRestoreAfterSubmit({ threadId, text: "" })
  return [
    "# Prompt Clear",
    "",
    "Compatibility reference: `prompt.clear`.",
    "",
    "Cleared the current composer draft.",
  ].join("\n")
}

async function buildPromptPasteOutput(
  threadId: string,
  fallbackText: string
): Promise<string> {
  const explicitText = fallbackText.trim()
  const clipboardText = explicitText || (await readClipboardTextSafely())
  if (!clipboardText) {
    return [
      "# Prompt Paste",
      "",
      "Compatibility reference: `prompt.paste`.",
      "",
      "> Clipboard text was not available. Use the native paste shortcut in the composer, or pass text after the command.",
    ].join("\n")
  }

  useChatStore.getState().setDraft(threadId, clipboardText)
  dispatchComposerDraftRestoreAfterSubmit({ threadId, text: clipboardText })
  return [
    "# Prompt Paste",
    "",
    "Compatibility reference: `prompt.paste`.",
    "",
    `Pasted ${clipboardText.length.toLocaleString()} character${clipboardText.length === 1 ? "" : "s"} into the composer draft.`,
  ].join("\n")
}

function buildPromptSubmitOutput(): string {
  return [
    "# Prompt Submit",
    "",
    "Compatibility reference: `prompt.submit`.",
    "",
    "BetterC0de submits the composer through the native Enter/Send button flow. This command is registered for compatibility command-map parity; put the prompt text in the composer and submit normally.",
  ].join("\n")
}

export function buildComposerInputActionsOutput(command: string): string {
  const normalized = command.replace(/^\//, "")
  const matched =
    normalized === "input-actions"
      ? null
      : findBetterC0deKeybindDefault(normalized)
  const rows =
    matched && matched.command.startsWith("input.")
      ? [matched]
      : BETTERC0DE_COMPOSER_KEYBIND_DEFAULTS.filter((item) =>
          item.command.startsWith("input.")
        )

  return [
    "# Composer Input Actions",
    "",
    matched
      ? `Compatibility reference: \`${escapeInlineCode(matched.command)}\`.`
      : "BetterC0de input command-map actions handled by the BetterC0de composer.",
    "",
    "| Command | Default | BetterC0de Handling | Description |",
    "|:--------|:--------|:--------------------|:------------|",
    ...rows.map(
      (item) =>
        `| \`${escapeMarkdownTableCell(item.command)}\` | ${escapeMarkdownTableCell(item.binding)} | ${escapeMarkdownTableCell(item.handling ?? "Native textarea")} | ${escapeMarkdownTableCell(item.description)} |`
    ),
    "",
    "> These slash aliases are read-only references. To edit text, use the native keyboard shortcut inside the composer.",
  ].join("\n")
}

async function readClipboardTextSafely(): Promise<string | null> {
  if (typeof navigator === "undefined") return null
  if (!navigator.clipboard?.readText) return null
  try {
    const text = await navigator.clipboard.readText()
    return text.trim() ? text : null
  } catch {
    return null
  }
}

function buildPromptStashPushOutput(
  input: string,
  threadId: string | null | undefined,
  activeThread: ActiveThreadRef
): string {
  const prompt = input.trim()
  if (!prompt) {
    return [
      "# Prompt Stash",
      "",
      "> No prompt text provided.",
      "",
      "Use `/stash <prompt>` to save text, `/stashes` to list saved prompts, and `/stash-pop` to restore the latest one into the composer.",
    ].join("\n")
  }
  const prefs = usePreferencesStore.getState()
  const entry = createPromptStashEntry(prompt, {
    projectPath: resolveThreadRuntimePath(activeThread),
    threadId,
  })
  prefs.set(
    "promptStashEntries",
    pushPromptStashEntry(prefs.promptStashEntries, entry)
  )
  return [
    "# Prompt Stash",
    "",
    `Saved prompt \`${entry.id.slice(0, 8)}\`.`,
    "",
    "> Use `/stash-pop` to restore the newest stashed prompt.",
  ].join("\n")
}

/** Prompt history, composer draft controls, input actions and the prompt stash. */
export const PROMPT_SLASH_SPECS: readonly SlashCommandRunSpec<SlashCommandRuntimeRun>[] =
  [
    {
      names: ["history", "prompt-history", "histories"],
      run: (run) => {
        run.output = buildPromptHistoryListOutput(
          usePreferencesStore.getState().promptHistoryEntries
        )
      },
    },
    {
      names: [
        "history-use",
        "history-pop",
        "prompt-history-use",
        "prompt.history.previous",
        "prompt-history-previous",
        "prompt.history.next",
        "prompt-history-next",
      ],
      run: (run) => {
        const { args, store } = run
        if (!run.threadId) {
          run.threadId = store.createThread("New Chat", "BetterC0de")
        }
        run.output = buildPromptHistoryUseOutput(args[0], run.threadId)
      },
    },
    {
      names: ["prompt-clear", "prompt.clear", "clear-prompt"],
      run: (run) => {
        const { store } = run
        if (!run.threadId) {
          run.threadId = store.createThread("New Chat", "BetterC0de")
        }
        run.output = buildPromptClearOutput(run.threadId)
      },
    },
    {
      names: ["prompt-paste", "prompt.paste"],
      run: async (run) => {
        const { args, store } = run
        if (!run.threadId) {
          run.threadId = store.createThread("New Chat", "BetterC0de")
        }
        run.output = await buildPromptPasteOutput(run.threadId, args.join(" "))
      },
    },
    {
      names: ["prompt-submit", "prompt.submit"],
      run: (run) => {
        run.output = buildPromptSubmitOutput()
      },
    },
    {
      names: ["input-actions", ...BETTERC0DE_INPUT_ACTION_COMMANDS],
      run: (run) => {
        const { cmd } = run
        run.output = buildComposerInputActionsOutput(cmd)
      },
    },
    {
      names: ["stash", "prompt-stash", "prompt.stash"],
      run: (run) => {
        const { args, activeThread, threadId } = run
        run.output = buildPromptStashPushOutput(
          args.join(" "),
          threadId,
          activeThread
        )
      },
    },
    {
      names: [
        "stashes",
        "stash-list",
        "prompt-stash-list",
        "prompt.stash.list",
      ],
      run: (run) => {
        run.output = buildPromptStashListOutput(
          usePreferencesStore.getState().promptStashEntries
        )
      },
    },
    {
      names: ["stash-pop", "prompt-stash-pop", "prompt.stash.pop"],
      run: (run) => {
        const { args, store } = run
        if (!run.threadId) {
          run.threadId = store.createThread("New Chat", "BetterC0de")
        }
        run.output = buildPromptStashPopOutput(args[0], run.threadId)
      },
    },
    {
      names: [
        "stash-delete",
        "stash-remove",
        "prompt-stash-delete",
        "stash.delete",
      ],
      run: (run) => {
        const { args } = run
        run.output = buildPromptStashDeleteOutput(args[0])
      },
    },
  ]
