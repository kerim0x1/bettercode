import { create } from "zustand"

/**
 * Compare: one prompt sent to several models at once, each in its own chat.
 *
 * Before a new chat's first message, Shift-, Ctrl- or ⌘-clicking a model in
 * the composer's model menu adds it to a comparison of up to four models.
 * The composer's own selection is always the first model; this module keeps
 * the others as a draft per chat, each with its own reasoning level. On send
 * every model gets its own chat (see `compare-send.ts`), and the chats share
 * a `compareGroupId` kept with each chat's settings, so the sidebar and the
 * chat header can show them as a group.
 */

/** The most models one prompt goes to. */
export const COMPARE_MAX_MODELS = 4

export interface CompareModelRef {
  readonly providerId: string
  readonly modelId: string
}

export interface CompareModelEntry extends CompareModelRef {
  readonly thinkingMode: string | null
}

export function compareModelKey(model: CompareModelRef): string {
  return JSON.stringify([model.providerId, model.modelId])
}

export function sameCompareModel(
  left: CompareModelRef,
  right: CompareModelRef
): boolean {
  return left.providerId === right.providerId && left.modelId === right.modelId
}

/** Shift, Ctrl or ⌘ held: the click adds to the comparison instead of replacing the model. */
export function isCompareModifier(event: {
  readonly shiftKey?: boolean
  readonly ctrlKey?: boolean
  readonly metaKey?: boolean
}): boolean {
  return Boolean(event.shiftKey || event.ctrlKey || event.metaKey)
}

/**
 * The models to compare: the composer's own first, then the added ones,
 * without duplicates and within the limit. The composer's model can change
 * elsewhere (another pane, `/model`), so an added copy of it is dropped here.
 */
export function compareEntries(
  primary: CompareModelEntry,
  extras: ReadonlyArray<CompareModelEntry>,
  max = COMPARE_MAX_MODELS
): CompareModelEntry[] {
  const entries: CompareModelEntry[] = [primary]
  for (const extra of extras) {
    if (entries.length >= max) break
    if (entries.some((entry) => sameCompareModel(entry, extra))) continue
    entries.push(extra)
  }
  return entries
}

/** What a modifier-click on a model does to the comparison. */
export type CompareToggle =
  /** Added or removed: the models after the composer's own. */
  | { readonly kind: "changed"; readonly extras: CompareModelEntry[] }
  /** The composer's own model was removed; the next one takes its place. */
  | {
      readonly kind: "promoted"
      readonly primary: CompareModelEntry
      readonly extras: CompareModelEntry[]
    }
  /** Already at the limit. */
  | { readonly kind: "full" }
  /** The only model cannot be removed. */
  | { readonly kind: "unchanged" }

export function toggleCompareModel(
  primary: CompareModelEntry,
  extras: ReadonlyArray<CompareModelEntry>,
  candidate: CompareModelEntry,
  max = COMPARE_MAX_MODELS
): CompareToggle {
  const current = compareEntries(primary, extras, max).slice(1)
  if (sameCompareModel(primary, candidate)) {
    const [next, ...rest] = current
    return next
      ? { kind: "promoted", primary: next, extras: rest }
      : { kind: "unchanged" }
  }
  if (current.some((entry) => sameCompareModel(entry, candidate))) {
    return {
      kind: "changed",
      extras: current.filter((entry) => !sameCompareModel(entry, candidate)),
    }
  }
  if (current.length + 1 >= max) return { kind: "full" }
  return { kind: "changed", extras: [...current, candidate] }
}

/** A model's name in a chat title: "Claude" is dropped, the rest stays ("Opus 4.5"). */
export function compareModelLabel(name: string): string {
  const trimmed = name.trim()
  return trimmed.replace(/^claude\s+/i, "").trim() || trimmed
}

/**
 * Title labels for the compared models, in order. Two that read the same
 * (one model through two accounts) are told apart by their provider.
 */
export function compareModelLabels(
  models: ReadonlyArray<{
    readonly name: string
    readonly providerName: string
  }>
): string[] {
  const labels = models.map((model) => compareModelLabel(model.name))
  return labels.map((label, index) => {
    const providerName = models[index]?.providerName.trim()
    const repeated =
      labels.filter((other) => other.toLowerCase() === label.toLowerCase())
        .length > 1
    return repeated && providerName ? `${label} (${providerName})` : label
  })
}

const TITLE_SEPARATOR = " · "

/** "Fix login" and "GPT-5" read "Fix login · GPT-5"; a title that has the label keeps it. */
export function compareChatTitle(title: string, label: string): string {
  const base = title.trim()
  const suffix = `${TITLE_SEPARATOR}${label}`
  if (!base) return label
  return base.endsWith(suffix) ? base : `${base}${suffix}`
}

/** The prompt's first line, shortened: the shared title when none is generated. */
export function compareBaseTitle(prompt: string, max = 40): string {
  const line = (prompt.trim().split(/\r?\n/, 1)[0] ?? "")
    .replace(/\s+/g, " ")
    .trim()
  return line.length > max ? `${line.slice(0, max).trimEnd()}…` : line
}

/**
 * The chats of a compare group, oldest first, so the chat the comparison
 * was started from leads.
 */
export function compareGroupThreadIds(
  threads: ReadonlyArray<{ readonly id: string; readonly createdAt: string }>,
  settingsByThread: Readonly<
    Record<string, { readonly compareGroupId?: string } | undefined>
  >,
  groupId: string | null | undefined
): string[] {
  if (!groupId) return []
  return threads
    .filter((thread) => settingsByThread[thread.id]?.compareGroupId === groupId)
    .sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.id.localeCompare(right.id)
    )
    .map((thread) => thread.id)
}

function withoutKey<T>(
  record: Record<string, T>,
  key: string
): Record<string, T> {
  if (!(key in record)) return record
  const rest = { ...record }
  delete rest[key]
  return rest
}

interface CompareSelectionState {
  /** The models added to each new chat's comparison, after the composer's own. */
  extrasByThread: Record<string, CompareModelEntry[]>
  /** What a chat's comparison is doing while its chats are being prepared. */
  progressByThread: Record<string, string>
  setExtras: (threadId: string, extras: CompareModelEntry[]) => void
  setThinking: (
    threadId: string,
    model: CompareModelRef,
    thinkingMode: string | null
  ) => void
  setProgress: (threadId: string, progress: string | null) => void
  clear: (threadId: string) => void
}

/**
 * The unsent comparison of each new chat. It lives only in this window: it
 * is a draft, and the chats it starts keep what matters in their own settings.
 */
export const useCompareSelectionStore = create<CompareSelectionState>(
  (set) => ({
    extrasByThread: {},
    progressByThread: {},
    setExtras: (threadId, extras) =>
      set((state) => ({
        extrasByThread:
          extras.length > 0
            ? { ...state.extrasByThread, [threadId]: extras }
            : withoutKey(state.extrasByThread, threadId),
      })),
    setThinking: (threadId, model, thinkingMode) =>
      set((state) => {
        const extras = state.extrasByThread[threadId]
        if (!extras?.some((entry) => sameCompareModel(entry, model)))
          return state
        return {
          extrasByThread: {
            ...state.extrasByThread,
            [threadId]: extras.map((entry) =>
              sameCompareModel(entry, model)
                ? { ...entry, thinkingMode }
                : entry
            ),
          },
        }
      }),
    setProgress: (threadId, progress) =>
      set((state) => ({
        progressByThread: progress
          ? { ...state.progressByThread, [threadId]: progress }
          : withoutKey(state.progressByThread, threadId),
      })),
    clear: (threadId) =>
      set((state) => {
        const extrasByThread = withoutKey(state.extrasByThread, threadId)
        return extrasByThread === state.extrasByThread
          ? state
          : { extrasByThread }
      }),
  })
)
