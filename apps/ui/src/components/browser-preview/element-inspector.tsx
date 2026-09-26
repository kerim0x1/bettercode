import { useId, useMemo, useState } from "react"
import {
  LayersIcon,
  MousePointerClickIcon,
  SearchIcon,
  SlidersHorizontalIcon,
  XIcon,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { TAG_COLORS } from "./constants"
import { DomTreeNode } from "./dom-tree-node"
import { elementName, filterElementTree } from "./element-tree"
import { LayoutControls } from "./layout-controls"
import type { DomNode, SelectedElement } from "./types"
import "./inspector.css"

interface ElementInspectorProps {
  compact?: boolean
  tree: DomNode | null
  selected: SelectedElement | null
  tab: "tree" | "styles"
  onTabChange: (tab: "tree" | "styles") => void
  onSelect: (selector: string) => void
  onHighlight: (selector: string) => void
  onClear: () => void
  loading: boolean
  styles: Record<string, string>
  onStyleChange: (property: string, value: string) => void
  pageUrl: string
}

export function ElementInspector({
  compact = false,
  tree,
  selected,
  tab,
  onTabChange,
  onSelect,
  onHighlight,
  onClear,
  loading,
  styles,
  onStyleChange,
  pageUrl,
}: ElementInspectorProps) {
  const [query, setQuery] = useState("")
  const id = useId()
  const filtered = useMemo(
    () => (tree ? filterElementTree(tree, query) : null),
    [tree, query]
  )
  const selectedName = selected
    ? elementName({
        tag: selected.tagName,
        id: selected.id,
        text: selected.text,
        classes: selected.className.split(/\s+/).filter(Boolean),
      })
    : ""

  return (
    <aside
      className={cn(
        "preview-inspector",
        compact && "preview-inspector--compact"
      )}
      aria-label="Element inspector"
    >
      <div
        className="preview-inspector-tabs"
        role="tablist"
        aria-label="Inspect element"
      >
        {(["tree", "styles"] as const).map((value) => {
          const Icon = value === "tree" ? LayersIcon : SlidersHorizontalIcon
          return (
            <button
              key={value}
              type="button"
              role="tab"
              id={`${id}-${value}`}
              aria-controls={`${id}-content`}
              aria-selected={tab === value}
              tabIndex={tab === value ? 0 : -1}
              onClick={() => onTabChange(value)}
              onKeyDown={(event) => {
                if (
                  !["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                    event.key
                  )
                )
                  return
                event.preventDefault()
                const next =
                  event.key === "Home"
                    ? "tree"
                    : event.key === "End"
                      ? "styles"
                      : value === "tree"
                        ? "styles"
                        : "tree"
                onTabChange(next)
                document.getElementById(`${id}-${next}`)?.focus()
              }}
            >
              <Icon className="size-3.5" />
              {value === "tree" ? "Elements" : "Styles"}
            </button>
          )
        })}
      </div>
      {selected && (
        <div className="preview-inspector-selection">
          <div className="flex min-w-0 items-center gap-2">
            <span
              className={cn(
                "preview-element-tag",
                TAG_COLORS[selected.tagName]
              )}
            >
              {selected.tagName}
            </span>
            <span
              className="min-w-0 flex-1 truncate text-[12px] font-medium"
              title={selectedName}
            >
              {selectedName}
            </span>
            <button
              type="button"
              className="preview-inspector-icon"
              aria-label="Clear selected element"
              onClick={onClear}
            >
              <XIcon className="size-3.5" />
            </button>
          </div>
          <div className="mt-1 flex min-w-0 items-center gap-2 text-[10px] text-muted-foreground">
            <span
              className="min-w-0 flex-1 truncate font-mono"
              title={selected.selector}
            >
              {selected.selector}
            </span>
            <span
              className="shrink-0 tabular-nums"
              title="Measured size when selected (px)"
            >
              {Number(selected.rect.w.toFixed(1))} ×{" "}
              {Number(selected.rect.h.toFixed(1))}
            </span>
          </div>
        </div>
      )}
      {tab === "tree" && (
        <div className="px-3 pt-3 pb-2">
          <label className="preview-inspector-search">
            <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <input
              aria-label="Find an element"
              placeholder="Find by tag, name or class…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            {query && (
              <button
                type="button"
                aria-label="Clear element search"
                onClick={() => setQuery("")}
              >
                <XIcon className="size-3" />
              </button>
            )}
          </label>
          <p className="mt-3 mb-0 text-[10px] font-medium text-muted-foreground">
            Page structure
          </p>
        </div>
      )}
      <div
        className="preview-inspector-scroll"
        role="tabpanel"
        id={`${id}-content`}
        aria-labelledby={`${id}-${tab}`}
      >
        {tab === "tree" ? (
          filtered ? (
            <div
              role="tree"
              aria-label="Page elements"
              className="pb-3"
              onKeyDown={(event) => {
                if (
                  ![
                    "ArrowDown",
                    "ArrowUp",
                    "ArrowLeft",
                    "ArrowRight",
                    "Home",
                    "End",
                  ].includes(event.key)
                )
                  return
                const rows = [
                  ...event.currentTarget.querySelectorAll<HTMLElement>(
                    '[role="treeitem"]'
                  ),
                ]
                const row = (event.target as HTMLElement).closest<HTMLElement>(
                  '[role="treeitem"]'
                )
                const index = row ? rows.indexOf(row) : -1
                if (index < 0) return
                event.preventDefault()
                const level = Number(row?.getAttribute("aria-level"))
                let next = index
                if (event.key === "Home") next = 0
                if (event.key === "End") next = rows.length - 1
                if (event.key === "ArrowDown")
                  next = Math.min(rows.length - 1, index + 1)
                if (event.key === "ArrowUp") next = Math.max(0, index - 1)
                if (
                  event.key === "ArrowRight" &&
                  Number(rows[index + 1]?.getAttribute("aria-level")) > level
                )
                  next = index + 1
                if (event.key === "ArrowLeft") {
                  for (let i = index - 1; i >= 0; i--) {
                    if (Number(rows[i].getAttribute("aria-level")) < level) {
                      next = i
                      break
                    }
                  }
                }
                rows[next]?.focus()
              }}
            >
              <DomTreeNode
                node={filtered}
                depth={0}
                selectedSelector={selected?.selector ?? null}
                onSelect={onSelect}
                onHighlight={onHighlight}
                forceExpanded={Boolean(query.trim())}
              />
            </div>
          ) : (
            <div className="preview-inspector-empty">
              <LayersIcon className="size-5" />
              <p>
                {query
                  ? "No matching elements"
                  : loading
                    ? "Loading page elements…"
                    : "Open a page to explore its elements"}
              </p>
            </div>
          )
        ) : selected ? (
          <LayoutControls
            key={`${pageUrl}:${selected.selector}`}
            styles={styles}
            onChange={onStyleChange}
          />
        ) : (
          <div className="preview-inspector-empty">
            <MousePointerClickIcon className="size-5" />
            <p>
              Select an element in the preview or element list to edit its
              styles.
            </p>
          </div>
        )}
      </div>
    </aside>
  )
}
