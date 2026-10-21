import { create } from "zustand"
import type { ListEntry, SearchHit } from "@/services/backend/filesystem"

export type LoadState = "idle" | "loading" | "ready" | "error"

export type BrowserMode = "browse" | "search"

/**
 * Feature-local state for the System Browser overlay. Kept in its own
 * store (not bundled into `useAppUiStore`) because the modal owns a lot
 * of transient state — directory content, selection per directory, search
 * results, load flags — that would drown the shared UI-state store.
 *
 * The single cross-cutting flag (`systemBrowserOpen`) still lives in
 * `useAppUiStore` (`lib/app-ui-store.ts`); this store only runs while the
 * modal is mounted.
 */
export interface SystemBrowserState {
  mode: BrowserMode
  currentPath: string | null
  entries: ListEntry[]
  truncated: boolean
  loadState: LoadState
  errorMessage: string | null

  searchQuery: string
  searchResults: SearchHit[]
  searchLoadState: LoadState
  searchTookMs: number

  showHidden: boolean
  selectedIndex: number
  // Remember the last selected child per directory so navigating "up"
  // places the cursor back on where we came from.
  lastSelectedByDir: Record<string, string>

  setMode: (mode: BrowserMode) => void
  setCurrentPath: (p: string | null) => void
  setEntries: (e: ListEntry[], truncated: boolean) => void
  setLoadState: (s: LoadState, errorMessage?: string | null) => void
  setSearchQuery: (q: string) => void
  setSearchResults: (r: SearchHit[], tookMs: number) => void
  setSearchLoadState: (s: LoadState) => void
  toggleHidden: () => void
  setSelectedIndex: (i: number) => void
  rememberSelection: (dir: string, name: string) => void
  reset: () => void
}

const INITIAL: Omit<
  SystemBrowserState,
  | "setMode"
  | "setCurrentPath"
  | "setEntries"
  | "setLoadState"
  | "setSearchQuery"
  | "setSearchResults"
  | "setSearchLoadState"
  | "toggleHidden"
  | "setSelectedIndex"
  | "rememberSelection"
  | "reset"
> = {
  mode: "browse",
  currentPath: null,
  entries: [],
  truncated: false,
  loadState: "idle",
  errorMessage: null,
  searchQuery: "",
  searchResults: [],
  searchLoadState: "idle",
  searchTookMs: 0,
  showHidden: false,
  selectedIndex: 0,
  lastSelectedByDir: {},
}

export const useSystemBrowserState = create<SystemBrowserState>((set) => ({
  ...INITIAL,
  setMode: (mode) => set({ mode }),
  setCurrentPath: (currentPath) => set({ currentPath }),
  setEntries: (entries, truncated) => set({ entries, truncated }),
  setLoadState: (loadState, errorMessage = null) =>
    set({ loadState, errorMessage }),
  setSearchQuery: (searchQuery) => set({ searchQuery }),
  setSearchResults: (searchResults, searchTookMs) =>
    set({ searchResults, searchTookMs }),
  setSearchLoadState: (searchLoadState) => set({ searchLoadState }),
  toggleHidden: () => set((s) => ({ showHidden: !s.showHidden })),
  setSelectedIndex: (selectedIndex) => set({ selectedIndex }),
  rememberSelection: (dir, name) =>
    set((s) => ({
      lastSelectedByDir: { ...s.lastSelectedByDir, [dir]: name },
    })),
  reset: () => set({ ...INITIAL }),
}))
