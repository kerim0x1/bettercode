import { useState, useEffect, useMemo, useCallback, useRef } from "react"
import {
  ComposerSuggestionItem,
  ComposerSuggestionPanel,
} from "@/components/chat/composer-suggestion-panel"
import { searchEntriesDetailed } from "@/services/backend"
import { SearchTruncationNotice } from "@/components/search-truncation-notice"
import { findComposerTextarea } from "@/lib/composer-input"
import { getFileIconUrl, getFolderIconUrl } from "@/lib/file-icons"

interface FileEntry {
  name: string
  path: string
  type: "file" | "folder"
}

/** Whether — and why — the backend cut the entry walk behind the menu short. */
export interface FileMentionTruncation {
  truncated: boolean
  reason?: string
}

interface FileMentionMenuProps {
  threadId: string | null
  query: string
  visible: boolean
  projectPath: string
  onSelect: (file: FileEntry) => void
  onClose: () => void
  setInputText?: (text: string) => void
}

export function FileMentionMenu({
  threadId,
  query,
  visible,
  projectPath,
  onSelect,
  onClose,
  setInputText,
}: FileMentionMenuProps) {
  const [files, setFiles] = useState<FileEntry[]>([])
  // The backend caps its walk; when it did, the menu filters an incomplete
  // list and a file the user is typing can be missing without any match.
  const [truncation, setTruncation] = useState<FileMentionTruncation>({
    truncated: false,
  })
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [loading, setLoading] = useState(false)

  // Load files when visible. The backend returns a flat list of
  // { path, name, is_dir } — `path` is already the project-relative path with
  // forward slashes, so we map directly. Treating it as a nested tree (an
  // earlier bug) collapsed every entry's path to just its filename, which
  // duplicated React keys for repeated names like `page.js` and inserted the
  // wrong path on selection (causing 404s on @-mention reads).
  useEffect(() => {
    if (!visible || !projectPath) return
    let cancelled = false
    setFiles([])
    setTruncation({ truncated: false })
    setLoading(true)
    searchEntriesDetailed(projectPath, "")
      .then((data) => {
        if (cancelled) return
        const entries = data.entries.map((e) => ({
          name: e.name,
          path: e.path,
          type: e.is_dir ? ("folder" as const) : ("file" as const),
        }))
        setFiles(entries)
        setTruncation({
          truncated: data.truncated,
          reason: data.truncatedReason,
        })
        setLoading(false)
      })
      .catch(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [visible, projectPath])

  const filtered = useMemo(() => {
    if (!query) return files.slice(0, 15)
    const q = query.toLowerCase()
    return files
      .filter(
        (f) =>
          f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q)
      )
      .slice(0, 15)
  }, [files, query])

  useEffect(() => {
    setSelectedIndex(0)
  }, [query, visible, projectPath])

  const handleSelect = useCallback(
    (file: FileEntry) => {
      if (setInputText) {
        // Replace the @query with @filepath in the input
        const ta = findComposerTextarea(threadId)
        if (ta) {
          const val = ta.value || ""
          const atIdx = val.lastIndexOf("@")
          if (atIdx >= 0) {
            const newVal = val.slice(0, atIdx) + `@${file.path} `
            const nativeSet = Object.getOwnPropertyDescriptor(
              HTMLTextAreaElement.prototype,
              "value"
            )?.set
            nativeSet?.call(ta, newVal)
            ta.dispatchEvent(new Event("input", { bubbles: true }))
            ta.focus()
          }
        }
      }
      onSelect(file)
      onClose()
    },
    [onClose, onSelect, setInputText, threadId]
  )

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!visible) return
      if (
        e.target instanceof HTMLElement &&
        !e.target.closest(`[data-file-mention-menu]`) &&
        e.target !== findComposerTextarea(threadId)
      )
        return
      if (e.key === "ArrowDown") {
        e.preventDefault()
        setSelectedIndex((i) =>
          Math.max(0, Math.min(i + 1, filtered.length - 1))
        )
      } else if (e.key === "ArrowUp") {
        e.preventDefault()
        setSelectedIndex((i) => Math.max(i - 1, 0))
      } else if (
        (e.key === "Enter" || e.key === "Tab") &&
        filtered[selectedIndex]
      ) {
        e.preventDefault()
        handleSelect(filtered[selectedIndex])
      } else if (e.key === "Escape") {
        onClose()
      }
    },
    [visible, filtered, selectedIndex, handleSelect, onClose, threadId]
  )

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [handleKeyDown])

  if (!visible) return null
  if (filtered.length === 0 && loading) {
    return (
      <div className="z-50 mb-2" data-file-mention-menu>
        <ComposerSuggestionPanel symbol="@" title="Files" detail="Searching">
          <p
            role="status"
            className="px-2.5 py-5 text-xs text-muted-foreground"
          >
            Loading project files…
          </p>
        </ComposerSuggestionPanel>
      </div>
    )
  }
  if (filtered.length === 0 && files.length === 0) return null

  return (
    <FileMentionResultsPanel
      query={query}
      files={filtered}
      selectedIndex={selectedIndex}
      truncation={truncation}
      onSelect={handleSelect}
      onHover={setSelectedIndex}
    />
  )
}

interface FileMentionResultsPanelProps {
  query: string
  /** Already filtered and capped; an empty list means "nothing matched". */
  files: readonly FileEntry[]
  selectedIndex: number
  truncation: FileMentionTruncation
  onSelect: (file: FileEntry) => void
  onHover: (index: number) => void
}

/**
 * The loaded-state body of the @-mention menu, split from the fetching
 * component so the truncated and complete states can be rendered without
 * running effects. When the backend cut the walk short, both the match list
 * and the "no match" panel say so: the file being typed may simply be past
 * the cut, and a definitive-looking "no files" would send the user hunting
 * for a typo that is not there.
 */
export function FileMentionResultsPanel({
  query,
  files,
  selectedIndex,
  truncation,
  onSelect,
  onHover,
}: FileMentionResultsPanelProps) {
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    menuRef.current
      ?.querySelector('[data-selected="true"]')
      ?.scrollIntoView({ block: "nearest" })
  }, [selectedIndex, files])

  return (
    <div ref={menuRef} className="z-50 mb-2 min-w-0" data-file-mention-menu>
      <ComposerSuggestionPanel
        symbol="@"
        title="Files"
        detail={`${files.length} ${files.length === 1 ? "result" : "results"}`}
        notice={
          <SearchTruncationNotice
            truncated={truncation.truncated}
            reason={truncation.reason}
            subject="File list"
            hint={
              files.length === 0
                ? "the file may exist but was not listed"
                : "some files may be missing"
            }
            className="border-t border-border/50 px-3.5"
          />
        }
      >
        {files.length === 0 && (
          <p
            role="status"
            className="px-2.5 py-5 text-xs break-words text-muted-foreground"
          >
            No files matching &quot;{query}&quot;
          </p>
        )}
        {files.map((file, i) => (
          <ComposerSuggestionItem
            key={file.path}
            selected={i === selectedIndex}
            title={file.path}
            aria-label={`${file.type === "folder" ? "Folder" : "File"}: ${file.path}`}
            onClick={() => onSelect(file)}
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => onHover(i)}
          >
            <img
              src={
                file.type === "folder"
                  ? getFolderIconUrl(false, file.path)
                  : getFileIconUrl(file.path)
              }
              alt=""
              className="size-4 shrink-0"
            />
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium tracking-[-0.01em]">
              {file.name}
            </span>
            <span className="max-w-[45%] truncate text-xs text-muted-foreground">
              {file.path.includes("/")
                ? file.path.slice(0, file.path.lastIndexOf("/"))
                : "Project root"}
            </span>
          </ComposerSuggestionItem>
        ))}
      </ComposerSuggestionPanel>
    </div>
  )
}

/** Hook to detect @ in input */
export function useFileMentions() {
  const [active, setActive] = useState(false)
  const [query, setQuery] = useState("")

  const checkInput = useCallback((text: string) => {
    // Find the last @ that's not inside a code block
    const atIdx = text.lastIndexOf("@")
    if (
      atIdx >= 0 &&
      !text.slice(atIdx).includes(" ") &&
      text.length > atIdx + 1
    ) {
      setActive(true)
      setQuery(text.slice(atIdx + 1))
    } else if (atIdx === text.length - 1 && text.endsWith("@")) {
      setActive(true)
      setQuery("")
    } else {
      setActive(false)
      setQuery("")
    }
  }, [])

  const close = useCallback(() => {
    setActive(false)
    setQuery("")
  }, [])

  return { active, query, checkInput, close }
}
