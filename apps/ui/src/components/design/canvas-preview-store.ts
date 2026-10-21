import { create } from "zustand"
import {
  EMPTY_INSPECTOR_STATE,
  highlightCommand,
  selectCommand,
  withDomTree,
  withoutCssChanges,
  withoutSelection,
  withPageChange,
  withSelectedElement,
  withStyleChange,
  withTab,
  type ElementInspectorState,
  type InspectorTab,
  type PreviewCommand,
} from "@/components/browser-preview/inspector-state"
import type { PreviewViewportHandle } from "@/components/browser-preview/preview-viewport"
import type {
  CssChange,
  DomNode,
  SelectedElement,
} from "@/components/browser-preview/types"
import { hasElectronApi } from "@/services/ipc-facade"

/**
 * What the canvas shares between its cards, its toolbar and the inspector
 * side panel: the Select ⇄ Browse mode every preview follows, which preview
 * the inspector is looking at, and that preview's inspector state. The
 * editor keeps the same state locally in its panel; here several previews
 * feed one panel, so it lives in a store.
 */

export interface CanvasViewportFocus {
  readonly key: string
  readonly threadId: string
  readonly deviceId: string
  readonly pageUrl: string
}

export function canvasViewportKey(threadId: string, deviceId: string): string {
  return `${threadId}::${deviceId}`
}

/** Live viewport handles, so the side panel can talk to a card's page. */
const viewports = new Map<string, PreviewViewportHandle>()

export function registerCanvasViewport(
  key: string,
  handle: PreviewViewportHandle | null
): void {
  if (handle) viewports.set(key, handle)
  else viewports.delete(key)
}

export function canvasViewport(key: string): PreviewViewportHandle | null {
  return viewports.get(key) ?? null
}

interface CanvasPreviewStore {
  /** Select (pick elements) or Browse (use the page), for every card. */
  selectionMode: boolean
  inspectorOpen: boolean
  focus: CanvasViewportFocus | null
  /** Inspector state of the focused viewport. */
  inspector: ElementInspectorState
  /** Latest DOM tree per viewport, so focusing one shows it immediately. */
  treesByViewport: Record<string, DomNode | null>
  setSelectionMode: (value: boolean) => void
  setInspectorOpen: (value: boolean) => void
  focusViewport: (threadId: string, deviceId: string, pageUrl: string) => void
  reportDomTree: (
    threadId: string,
    deviceId: string,
    tree: DomNode | null
  ) => void
  reportElement: (
    threadId: string,
    deviceId: string,
    pageUrl: string,
    element: SelectedElement
  ) => void
  reportNavigation: (
    threadId: string,
    deviceId: string,
    pageUrl: string
  ) => void
  forgetViewport: (threadId: string, deviceId: string) => void
  clearSelection: () => void
  setTab: (tab: InspectorTab) => void
  applyStyle: (property: string, value: string) => void
  highlight: (selector: string) => void
  selectFromTree: (selector: string) => void
  /** Hands the buffered style edits to the caller and empties the buffer. */
  takeCssChanges: () => CssChange[]
}

function post(
  focus: CanvasViewportFocus | null,
  command: PreviewCommand | null
) {
  if (!focus || !command) return
  canvasViewport(focus.key)?.postToPreview(command)
}

export const useCanvasPreviewStore = create<CanvasPreviewStore>((set, get) => ({
  selectionMode: hasElectronApi(),
  inspectorOpen: false,
  focus: null,
  inspector: EMPTY_INSPECTOR_STATE,
  treesByViewport: {},

  setSelectionMode: (value) => set({ selectionMode: value }),
  setInspectorOpen: (value) => set({ inspectorOpen: value }),

  focusViewport: (threadId, deviceId, pageUrl) =>
    set((state) => {
      const key = canvasViewportKey(threadId, deviceId)
      if (state.focus?.key === key && state.focus.pageUrl === pageUrl)
        return state
      const tree = state.treesByViewport[key] ?? null
      // Style edits belong to the page they were made on; switching the
      // inspected preview keeps them until sent.
      return {
        focus: { key, threadId, deviceId, pageUrl },
        inspector: {
          ...withPageChange(state.inspector),
          tree,
          tab: state.inspector.tab,
        },
      }
    }),

  reportDomTree: (threadId, deviceId, tree) =>
    set((state) => {
      const key = canvasViewportKey(threadId, deviceId)
      const next: Partial<CanvasPreviewStore> = {
        treesByViewport: { ...state.treesByViewport, [key]: tree },
      }
      if (state.focus?.key === key)
        next.inspector = withDomTree(state.inspector, tree)
      return next
    }),

  reportElement: (threadId, deviceId, pageUrl, element) =>
    set((state) => {
      const key = canvasViewportKey(threadId, deviceId)
      const focused = state.focus?.key === key
      const base = focused
        ? state.inspector
        : { ...state.inspector, tree: state.treesByViewport[key] ?? null }
      return {
        focus: { key, threadId, deviceId, pageUrl },
        inspector: withSelectedElement(base, element),
      }
    }),

  reportNavigation: (threadId, deviceId, pageUrl) =>
    set((state) => {
      const key = canvasViewportKey(threadId, deviceId)
      const trees = { ...state.treesByViewport, [key]: null }
      if (state.focus?.key !== key) return { treesByViewport: trees }
      return {
        treesByViewport: trees,
        focus: { ...state.focus, pageUrl },
        inspector: withPageChange(state.inspector),
      }
    }),

  forgetViewport: (threadId, deviceId) =>
    set((state) => {
      const key = canvasViewportKey(threadId, deviceId)
      const { [key]: _gone, ...trees } = state.treesByViewport
      if (state.focus?.key !== key) return { treesByViewport: trees }
      return {
        treesByViewport: trees,
        focus: null,
        inspector: withPageChange(state.inspector),
      }
    }),

  clearSelection: () =>
    set((state) => ({ inspector: withoutSelection(state.inspector) })),
  setTab: (tab) =>
    set((state) => ({ inspector: withTab(state.inspector, tab) })),

  applyStyle: (property, value) => {
    const current = get()
    const result = withStyleChange(current.inspector, property, value)
    if (result.state !== current.inspector) set({ inspector: result.state })
    post(current.focus, result.command)
  },
  highlight: (selector) => post(get().focus, highlightCommand(selector)),
  selectFromTree: (selector) => post(get().focus, selectCommand(selector)),

  takeCssChanges: () => {
    const changes = [...get().inspector.cssChanges]
    if (changes.length)
      set((state) => ({ inspector: withoutCssChanges(state.inspector) }))
    return changes
  },
}))
