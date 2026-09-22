import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ContextMenu } from "radix-ui"
import {
  HandIcon,
  MaximizeIcon,
  MinusIcon,
  MousePointer2Icon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  PlusIcon,
  SparklesIcon,
  StickyNoteIcon,
  FrameIcon,
  GlobeIcon,
  ImageIcon,
  SquareCheckBigIcon,
  SquareIcon,
  TypeIcon,
} from "lucide-react"
import { normalizeBrowserElement } from "@betterc0de/schema"
import {
  isEditingInside,
  useCanvasTransform,
} from "@/hooks/use-canvas-transform"
import { useCanvasProjectDrag } from "@/hooks/use-canvas-project-drag"
import { useChatStore } from "@/lib/chat-store"
import type { UiProvider } from "@/lib/provider-types"
import {
  MAX_BROWSER_ELEMENTS,
  useBrowserContextStore,
} from "@/lib/browser-context-store"
import {
  canvasBounds,
  canvasProjectSize,
  nextCanvasPosition,
  PROJECT_CANVAS_STORAGE_KEY,
  readCanvasPlacements,
  screenToCanvas,
  type CanvasPlacement,
  type CanvasPoint,
} from "@/lib/project-canvas"
import type { SelectedElement } from "@/components/browser-preview/types"
import { SelectBrowseToggle } from "@/components/browser-preview/select-browse-toggle"
import { cssChangesPrompt } from "@/components/browser-preview/inspector-state"
import { dispatchComposerDraftRestoreAfterSubmit } from "@/lib/composer-draft-events"
import {
  CANVAS_NOTES_STORAGE_KEY,
  createCanvasNote,
  moveNote,
  noteConnectors,
  NOTE_DEFAULT_HEIGHT,
  NOTE_DEFAULT_WIDTH,
  pinNote,
  readCanvasNotes,
  resolveNotePosition,
  unpinNote,
  type CanvasNote,
} from "@/lib/canvas-notes"
import {
  addConnection,
  anchorKey,
  CANVAS_CONNECTIONS_STORAGE_KEY,
  connectionGeometries,
  pairKey,
  readCanvasConnections,
  removeAnchor,
  removeConnection,
  type CanvasAnchorRef,
  type CanvasConnection,
  type CanvasItemRect,
} from "@/lib/canvas-connections"
import { useCanvasConnectDrag } from "@/hooks/use-canvas-connect-drag"
import { CanvasConnectionLayer } from "./canvas-connection-layer"
import {
  CANVAS_OBJECTS_STORAGE_KEY,
  createCanvasObject,
  moveObject,
  OBJECT_SIZES,
  readCanvasObjects,
  referencedAssets,
  type CanvasObject,
  type CanvasObjectKind,
} from "@/lib/canvas-objects"
import {
  basename,
  canvasDropSpecs,
  describeUrl,
  relativeToProject,
  type CanvasDropSpec,
} from "@/lib/canvas-paste"
import {
  MAX_ASSET_BYTES,
  pruneCanvasAssets,
  putCanvasAsset,
  readImageRatio,
} from "@/lib/canvas-assets"
import { resolveThreadRuntimePath } from "@/lib/thread-context"
import { CanvasObjectCard } from "./canvas-object-card"
import { CanvasFormatBar } from "./canvas-format-bar"
import { KEEPS_SELECTION } from "./canvas-object-style"
import { useCanvasPreviewStore } from "./canvas-preview-store"
import { toast } from "@/lib/toast"
import { cn } from "@/lib/utils"
import { MENU_PANEL, MENU_ITEM } from "@/components/ui/menu-chrome"
import { CanvasNoteCard } from "./canvas-note-card"
import { CanvasProjectFrame } from "./canvas-project-frame"
import { CanvasProjectPicker } from "./canvas-project-picker"
import { ToolButton, ToolbarDivider } from "./design-preview-controls"

/** One camera and one dot grid. Project frames share its coordinate space. */
export function DesignCanvas({
  activeThreadId,
  providers,
}: {
  activeThreadId: string | null
  providers?: UiProvider[]
}) {
  const canvasRef = useRef<HTMLDivElement>(null)
  const threads = useChatStore((state) => state.threads)
  const settings = useChatStore((state) => state.settingsByThread)
  const [placements, setPlacements] = useState<CanvasPlacement[]>(() => {
    try {
      return readCanvasPlacements(
        localStorage.getItem(PROJECT_CANVAS_STORAGE_KEY)
      )
    } catch {
      return []
    }
  })
  const [notes, setNotes] = useState<CanvasNote[]>(() => {
    try {
      return readCanvasNotes(localStorage.getItem(CANVAS_NOTES_STORAGE_KEY))
    } catch {
      return []
    }
  })
  const [connections, setConnections] = useState<CanvasConnection[]>(() => {
    try {
      return readCanvasConnections(
        localStorage.getItem(CANVAS_CONNECTIONS_STORAGE_KEY)
      )
    } catch {
      return []
    }
  })
  const [objects, setObjects] = useState<CanvasObject[]>(() => {
    try {
      return readCanvasObjects(localStorage.getItem(CANVAS_OBJECTS_STORAGE_KEY))
    } catch {
      return []
    }
  })
  const [selectedObject, setSelectedObject] = useState<string | null>(null)
  const [editingObject, setEditingObject] = useState<string | null>(null)
  const [hoveredItem, setHoveredItem] = useState<string | null>(null)
  const [tool, setTool] = useState<"select" | "hand">("select")
  const filePicker = useRef<HTMLInputElement>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const selectionMode = useCanvasPreviewStore((state) => state.selectionMode)
  const setSelectionMode = useCanvasPreviewStore(
    (state) => state.setSelectionMode
  )
  const inspectorOpen = useCanvasPreviewStore((state) => state.inspectorOpen)
  const setInspectorOpen = useCanvasPreviewStore(
    (state) => state.setInspectorOpen
  )
  const pendingCssChanges = useCanvasPreviewStore(
    (state) => state.inspector.cssChanges.length
  )
  const insertionPoint = useRef<CanvasPoint | null>(null)
  const lastActive = useRef<string | null>(null)
  const visible = useMemo(
    () =>
      placements.filter(
        (placement) =>
          !placement.hidden &&
          threads.some((thread) => thread.id === placement.threadId)
      ),
    [placements, threads]
  )
  const rectangles = useMemo(
    () =>
      visible.map((placement) => ({
        ...placement,
        ...canvasProjectSize(settings[placement.threadId]),
      })),
    [visible, settings]
  )
  const bounds = useMemo(() => canvasBounds(rectangles), [rectangles])
  const {
    zoom,
    pan,
    stageStyle,
    gridStyle,
    isPanning,
    spaceHeld,
    altHeld,
    zoomHeld,
    beginZoomGesture,
    beginPanGesture,
    zoomIn,
    zoomOut,
    zoomTo,
    fit,
    fitBounds,
    panHandlers,
  } = useCanvasTransform(canvasRef, bounds, false)
  // Guests re-render at the settled zoom, not at every frame of a gesture.
  const panActive = tool === "hand" || spaceHeld || altHeld

  useEffect(() => {
    try {
      localStorage.setItem(
        PROJECT_CANVAS_STORAGE_KEY,
        JSON.stringify(placements)
      )
    } catch {
      /* The board still works without storage. */
    }
  }, [placements])
  useEffect(() => {
    try {
      localStorage.setItem(CANVAS_NOTES_STORAGE_KEY, JSON.stringify(notes))
    } catch {
      /* The board still works without storage. */
    }
  }, [notes])
  useEffect(() => {
    try {
      localStorage.setItem(
        CANVAS_CONNECTIONS_STORAGE_KEY,
        JSON.stringify(connections)
      )
    } catch {
      /* The board still works without storage. */
    }
  }, [connections])
  useEffect(() => {
    try {
      localStorage.setItem(CANVAS_OBJECTS_STORAGE_KEY, JSON.stringify(objects))
    } catch {
      /* The board still works without storage. */
    }
  }, [objects])
  // Pasted pictures are dropped once the board has settled, so a delete that
  // is undone a moment later still finds its bytes.
  useEffect(() => {
    const timer = setTimeout(() => {
      void pruneCanvasAssets(referencedAssets(objects))
    }, 30_000)
    return () => clearTimeout(timer)
  }, [objects])
  useEffect(() => {
    if (
      !activeThreadId ||
      !threads.some((thread) => thread.id === activeThreadId) ||
      lastActive.current === activeThreadId
    )
      return
    const initialSelection = lastActive.current === null
    lastActive.current = activeThreadId
    const existing = placements.find(
      (placement) => placement.threadId === activeThreadId
    )
    if (existing) {
      if (initialSelection) fitBounds(canvasBounds(rectangles))
      return
    }
    const point = nextCanvasPosition(rectangles)
    setPlacements((previous) => [
      ...previous,
      { threadId: activeThreadId, ...point },
    ])
    fitBounds(
      canvasBounds([
        ...rectangles,
        { ...point, ...canvasProjectSize(settings[activeThreadId]) },
      ])
    )
  }, [activeThreadId, threads, placements, rectangles, settings, fitBounds])

  const openChat = useCallback((threadId: string) => {
    const store = useChatStore.getState()
    const thread = store.threads.find((item) => item.id === threadId)
    if (!thread) return
    store.setActiveThread(threadId)
    window.dispatchEvent(
      new CustomEvent("betterc0de:open-thread", {
        detail: { threadId, label: thread.title || "Chat" },
      })
    )
  }, [])
  const attach = (threadId: string) => {
    const existing = placements.find((item) => item.threadId === threadId)
    if (existing && !existing.hidden) {
      openChat(threadId)
      return
    }
    const point =
      insertionPoint.current ??
      (existing
        ? { x: existing.x, y: existing.y }
        : nextCanvasPosition(rectangles))
    insertionPoint.current = null
    setPlacements((previous) => [
      ...previous.filter((item) => item.threadId !== threadId),
      { threadId, ...point },
    ])
    lastActive.current = threadId
    openChat(threadId)
    fitBounds(
      canvasBounds([
        ...rectangles,
        {
          ...point,
          ...canvasProjectSize(
            useChatStore.getState().settingsByThread[threadId]
          ),
        },
      ])
    )
  }
  const move = useCallback((threadId: string, point: CanvasPoint) => {
    setPlacements((previous) =>
      previous.map((item) =>
        item.threadId === threadId ? { threadId, ...point } : item
      )
    )
  }, [])
  const drag = useCanvasProjectDrag(zoom, move)
  // Card geometry with the in-flight drag applied, so a pinned note and its
  // connector track the card while it is being moved, not after the drop.
  const cardRects = useMemo(() => {
    const entries = rectangles.map((rectangle) => {
      const live =
        drag.preview?.threadId === rectangle.threadId ? drag.preview : rectangle
      return [
        rectangle.threadId,
        {
          x: live.x,
          y: live.y,
          width: rectangle.width,
          height: rectangle.height,
        },
      ] as const
    })
    return new Map(entries)
  }, [rectangles, drag.preview])
  const cardPoints = useMemo(
    () =>
      new Map(
        [...cardRects].map(([id, rect]) => [id, { x: rect.x, y: rect.y }])
      ),
    [cardRects]
  )
  const moveNoteTo = useCallback(
    (id: string, point: CanvasPoint) => {
      setNotes((previous) =>
        previous.map((item) =>
          item.id === id ? moveNote(item, point, cardPoints) : item
        )
      )
    },
    [cardPoints]
  )
  const noteDrag = useCanvasProjectDrag(zoom, moveNoteTo)
  // The dragged note is resolved through the same pure move, so its stored
  // offset and its connector agree with what is on screen.
  const liveNotes = useMemo(() => {
    const preview = noteDrag.preview
    if (!preview) return notes
    return notes.map((item) =>
      item.id === preview.threadId
        ? moveNote(item, { x: preview.x, y: preview.y }, cardPoints)
        : item
    )
  }, [notes, noteDrag.preview, cardPoints])
  const moveObjectTo = useCallback((id: string, point: CanvasPoint) => {
    setObjects((previous) =>
      previous.map((item) => (item.id === id ? moveObject(item, point) : item))
    )
  }, [])
  const objectDrag = useCanvasProjectDrag(zoom, moveObjectTo)
  const liveObjects = useMemo(() => {
    const preview = objectDrag.preview
    if (!preview) return objects
    return objects.map((item) =>
      item.id === preview.threadId
        ? moveObject(item, { x: preview.x, y: preview.y })
        : item
    )
  }, [objects, objectDrag.preview])
  // Everything an edge can attach to, in one addressable set.
  const items = useMemo(() => {
    const map = new Map<string, CanvasItemRect>()
    for (const [threadId, rect] of cardRects) {
      const card: CanvasItemRect = { ...rect, kind: "card", id: threadId }
      map.set(anchorKey(card), card)
    }
    for (const object of liveObjects) {
      const entry: CanvasItemRect = {
        x: object.x,
        y: object.y,
        width: object.width,
        height: object.height,
        kind: "object",
        id: object.id,
      }
      map.set(anchorKey(entry), entry)
    }
    for (const note of liveNotes) {
      const entry: CanvasItemRect = {
        ...resolveNotePosition(note, cardPoints),
        width: note.width,
        height: note.height,
        kind: "note",
        id: note.id,
      }
      map.set(anchorKey(entry), entry)
    }
    return map
  }, [cardRects, cardPoints, liveNotes, liveObjects])
  const geometries = useMemo(
    () => connectionGeometries(connections, items),
    [connections, items]
  )
  // A pinned note that is also wired to its card would otherwise carry two
  // lines; the drawn edge is the one the user made, so it wins.
  const connectors = useMemo(() => {
    const wired = new Set(
      connections.map((edge) => pairKey(edge.from, edge.to))
    )
    const tethered = liveNotes.filter(
      (note) =>
        !note.pinnedTo ||
        !wired.has(
          pairKey(
            { kind: "note", id: note.id },
            { kind: "card", id: note.pinnedTo }
          )
        )
    )
    return noteConnectors(tethered, cardRects)
  }, [liveNotes, cardRects, connections])
  const toCanvas = useCallback(
    (client: CanvasPoint) => {
      const rect = canvasRef.current?.getBoundingClientRect()
      if (!rect) return client
      return screenToCanvas(client, { x: rect.left, y: rect.top }, pan, zoom)
    },
    [pan, zoom]
  )
  const canConnect = useCallback(
    (from: CanvasAnchorRef, to: CanvasAnchorRef) => {
      const key = pairKey(from, to)
      return !connections.some((edge) => pairKey(edge.from, edge.to) === key)
    },
    [connections]
  )
  const connect = useCallback((from: CanvasAnchorRef, to: CanvasAnchorRef) => {
    setConnections((previous) =>
      addConnection(previous, from, to, `edge-${crypto.randomUUID()}`)
    )
  }, [])
  const connectDrag = useCanvasConnectDrag({
    toCanvas,
    items,
    canConnect,
    onConnect: connect,
  })
  const disconnect = useCallback((id: string) => {
    setConnections((previous) => removeConnection(previous, id))
  }, [])
  /** Project folders on the board, used to grant a local file to an embed. */
  const projectRoots = useMemo(() => {
    const roots = new Set<string>()
    for (const placement of visible) {
      const path = resolveThreadRuntimePath(
        threads.find((thread) => thread.id === placement.threadId)
      )
      if (path) roots.add(path)
    }
    return [...roots]
  }, [visible, threads])
  /** Where something new lands: the spot right-clicked, else the view centre. */
  const placeAt = useCallback(
    (size: { width: number; height: number }) => {
      const taken = insertionPoint.current
      insertionPoint.current = null
      if (taken) return taken
      const rect = canvasRef.current?.getBoundingClientRect()
      if (!rect) return { x: 0, y: 0 }
      const centre = screenToCanvas(
        { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
        { x: rect.left, y: rect.top },
        pan,
        zoom
      )
      return { x: centre.x - size.width / 2, y: centre.y - size.height / 2 }
    },
    [pan, zoom]
  )
  const addObject = useCallback(
    (kind: CanvasObjectKind, patch: Partial<CanvasObject> = {}) => {
      const made = createCanvasObject(kind, placeAt(OBJECT_SIZES[kind]), patch)
      setObjects((previous) => [...previous, made])
      setSelectedObject(made.id)
      // Anything whose point is its words opens ready to type.
      if (kind === "text" || kind === "shape" || kind === "task")
        setEditingObject(made.id)
      return made
    },
    [placeAt]
  )
  const changeObject = useCallback((next: CanvasObject) => {
    setObjects((previous) =>
      previous.map((item) => (item.id === next.id ? next : item))
    )
  }, [])
  const removeObject = useCallback((id: string) => {
    setObjects((previous) => previous.filter((item) => item.id !== id))
    setConnections((previous) => removeAnchor(previous, { kind: "object", id }))
    setSelectedObject((current) => (current === id ? null : current))
    setEditingObject((current) => (current === id ? null : current))
  }, [])
  const duplicateObject = useCallback((id: string) => {
    setObjects((previous) => {
      const source = previous.find((item) => item.id === id)
      if (!source) return previous
      const copy = {
        ...source,
        id: crypto.randomUUID(),
        x: source.x + 24,
        y: source.y + 24,
      }
      setSelectedObject(copy.id)
      return [...previous, copy]
    })
  }, [])

  /**
   * Turns a paste or a drop into objects. Pictures are read and measured
   * first, so each one lands at its own proportions instead of a default box
   * that snaps a moment later.
   */
  const applyDropSpecs = useCallback(
    async (specs: CanvasDropSpec[], origin: CanvasPoint) => {
      const made: CanvasObject[] = []
      let step = 0
      const imageBox = (ratio: number | null) => {
        const width = OBJECT_SIZES.image.width
        return ratio && ratio > 0
          ? { width, height: Math.round(width / ratio), ratio }
          : {}
      }
      for (const spec of specs) {
        const point = { x: origin.x + step, y: origin.y + step }
        step += 28
        if (spec.kind === "image-file") {
          if (spec.file.size > MAX_ASSET_BYTES) {
            toast.error(
              `${spec.file.name} is larger than ${Math.round(MAX_ASSET_BYTES / 1024 / 1024)} MB.`
            )
            continue
          }
          const assetId = await putCanvasAsset(spec.file, spec.file.name)
          if (!assetId) {
            toast.error("This browser cannot store pictures for the canvas.")
            continue
          }
          const ratio = await readImageRatio(spec.file)
          made.push(
            createCanvasObject("image", point, {
              assetId,
              alt: spec.file.name,
              ...imageBox(ratio),
            })
          )
        } else if (spec.kind === "image-url") {
          const ratio = await readImageRatio(spec.url)
          made.push(
            createCanvasObject("image", point, {
              src: spec.url,
              alt: describeUrl(spec.url),
              ...imageBox(ratio),
            })
          )
        } else if (spec.kind === "embed-web") {
          made.push(
            createCanvasObject("embed", point, {
              source: "web",
              url: spec.url,
              title: describeUrl(spec.url),
            })
          )
        } else if (spec.kind === "embed-local") {
          const match = projectRoots
            .map((root) => ({ root, rel: relativeToProject(root, spec.path) }))
            .find((candidate) => candidate.rel)
          if (!match?.rel) {
            toast.info(
              `Add ${basename(spec.path)}'s project to the canvas first — local files are served out of an open project.`
            )
            continue
          }
          made.push(
            createCanvasObject("embed", point, {
              source: "local",
              projectPath: match.root,
              relativePath: match.rel,
              title: basename(spec.path),
            })
          )
        } else if (spec.kind === "local-file") {
          toast.info(
            `Drop ${basename(spec.path)} onto the board — a path on its own cannot be read from here.`
          )
        } else {
          made.push(createCanvasObject("text", point, { text: spec.text }))
        }
      }
      if (!made.length) return
      setObjects((previous) => [...previous, ...made])
      setSelectedObject(made.at(-1)?.id ?? null)
    },
    [projectRoots]
  )
  const formatTarget = useMemo(
    () => liveObjects.find((item) => item.id === selectedObject) ?? null,
    [liveObjects, selectedObject]
  )
  const readTransfer = useCallback(
    (data: DataTransfer | null) =>
      data
        ? canvasDropSpecs({
            files: [...data.files],
            text: data.getData("text/plain"),
            uriList: data.getData("text/uri-list"),
          })
        : [],
    []
  )
  /**
   * Ctrl/Cmd+V onto the board. The listener is on the window because the
   * canvas is a div, not a field: without it a paste would only ever reach
   * whatever text input happened to have the caret.
   */
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const viewport = canvasRef.current
      if (!viewport) return
      const active = document.activeElement
      if (isEditingInside(viewport, active)) return
      if (active && active !== document.body && !viewport.contains(active))
        return
      const specs = readTransfer(event.clipboardData)
      if (!specs.length) return
      event.preventDefault()
      void applyDropSpecs(specs, placeAt(OBJECT_SIZES.image))
    }
    window.addEventListener("paste", onPaste)
    return () => window.removeEventListener("paste", onPaste)
  }, [applyDropSpecs, placeAt, readTransfer])
  const noteTargets = useMemo(
    () =>
      visible.map((placement) => ({
        threadId: placement.threadId,
        label:
          threads.find((thread) => thread.id === placement.threadId)?.title ||
          "Chat",
      })),
    [visible, threads]
  )
  const addNote = useCallback(() => {
    const point = placeAt({
      width: NOTE_DEFAULT_WIDTH,
      height: NOTE_DEFAULT_HEIGHT,
    })
    setNotes((previous) => [...previous, createCanvasNote(point)])
  }, [placeAt])
  const changeNote = useCallback((next: CanvasNote) => {
    setNotes((previous) =>
      previous.map((item) => (item.id === next.id ? next : item))
    )
  }, [])
  const removeNote = useCallback((id: string) => {
    setNotes((previous) => previous.filter((item) => item.id !== id))
    setConnections((previous) => removeAnchor(previous, { kind: "note", id }))
  }, [])
  const attachNote = useCallback(
    (id: string, threadId: string) => {
      const card = cardPoints.get(threadId)
      if (!card) return
      setNotes((previous) =>
        previous.map((item) =>
          item.id === id ? pinNote(item, card, threadId, cardPoints) : item
        )
      )
    },
    [cardPoints]
  )
  const detachNote = useCallback(
    (id: string) => {
      setNotes((previous) =>
        previous.map((item) =>
          item.id === id ? unpinNote(item, cardPoints) : item
        )
      )
    },
    [cardPoints]
  )
  const remove = useCallback((threadId: string) => {
    setPlacements((previous) =>
      previous.map((item) =>
        item.threadId === threadId ? { ...item, hidden: true } : item
      )
    )
    setConnections((previous) =>
      removeAnchor(previous, { kind: "card", id: threadId })
    )
  }, [])
  const pickElement = useCallback(
    (threadId: string, picked: SelectedElement) => {
      const element = normalizeBrowserElement(picked)
      if (!element) return
      if (!useBrowserContextStore.getState().add(threadId, element))
        toast.info(
          `You can select up to ${MAX_BROWSER_ELEMENTS} elements per message`
        )
      openChat(threadId)
    },
    [openChat]
  )
  const shortcut = useCallback(
    (key: string) => {
      if (key === "canvas-zoom-start") beginZoomGesture()
      else if (key === "canvas-pan-start") beginPanGesture()
      else if (key === "zoom-in") zoomIn()
      else if (key === "zoom-out") zoomOut()
      else if (key === "zoom-reset") fit()
    },
    [zoomIn, zoomOut, fit, beginZoomGesture, beginPanGesture]
  )

  const addProject = () => {
    insertionPoint.current = null
    setPickerOpen(true)
  }
  // Same batch the editor's preview sends: the buffered style edits become a
  // change request in the inspected card's own chat.
  const sendCssToAI = () => {
    const store = useCanvasPreviewStore.getState()
    const focus = store.focus
    if (!focus) return
    const changes = store.takeCssChanges()
    if (changes.length === 0) return
    const chat = useChatStore.getState()
    dispatchComposerDraftRestoreAfterSubmit({
      threadId: focus.threadId,
      text: [
        chat.getDraft(focus.threadId),
        cssChangesPrompt(changes, focus.pageUrl),
      ]
        .filter(Boolean)
        .join("\n\n"),
    })
    openChat(focus.threadId)
  }
  return (
    <section
      data-project-canvas
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background"
    >
      <ContextMenu.Root modal={false}>
        <ContextMenu.Trigger asChild>
          <div
            ref={canvasRef}
            data-canvas-viewport
            tabIndex={0}
            aria-label="Project canvas"
            className="relative min-h-0 flex-1 overflow-hidden outline-none"
            style={gridStyle}
            onPointerDown={(event) => {
              if (event.target === event.currentTarget)
                event.currentTarget.focus()
              // A press on bare canvas drops the selection, as it does in
              // every other board: the format bar belongs to one object.
              if (
                event.target instanceof Element &&
                !event.target.closest(KEEPS_SELECTION)
              ) {
                setSelectedObject(null)
                setEditingObject(null)
              }
            }}
            onDragOver={(event) => {
              if (
                !event.dataTransfer?.types.some((type) =>
                  ["Files", "text/uri-list", "text/plain"].includes(type)
                )
              )
                return
              event.preventDefault()
              event.dataTransfer.dropEffect = "copy"
            }}
            onDrop={(event) => {
              const specs = readTransfer(event.dataTransfer)
              if (!specs.length) return
              event.preventDefault()
              const rect = event.currentTarget.getBoundingClientRect()
              void applyDropSpecs(
                specs,
                screenToCanvas(
                  { x: event.clientX, y: event.clientY },
                  { x: rect.left, y: rect.top },
                  pan,
                  zoom
                )
              )
            }}
            onPointerDownCapture={(event) => {
              if (!event.ctrlKey && !event.metaKey && !event.altKey) return
              if (!(event.target as Element).closest("[data-canvas-project]"))
                return
              event.preventDefault()
              event.stopPropagation()
              if (event.ctrlKey || event.metaKey) beginZoomGesture()
              else beginPanGesture()
            }}
            onContextMenu={(event) => {
              if (
                zoomHeld ||
                panActive ||
                (event.target as Element).closest(
                  "[data-canvas-project],[data-canvas-controls],[data-canvas-note]"
                )
              ) {
                event.preventDefault()
                return
              }
              const rect = event.currentTarget.getBoundingClientRect()
              insertionPoint.current = screenToCanvas(
                { x: event.clientX, y: event.clientY },
                { x: rect.left, y: rect.top },
                pan,
                zoom
              )
            }}
            onClickCapture={(event) => {
              if (!event.ctrlKey && !event.metaKey && !event.altKey) return
              if (!(event.target as Element).closest("[data-canvas-project]"))
                return
              event.preventDefault()
              event.stopPropagation()
            }}
            onKeyDown={(event) => {
              if (
                event.nativeEvent.isComposing ||
                (event.target as Element).closest(
                  "input,textarea,select,[contenteditable]:not([contenteditable=false]),[role=textbox],[role=dialog]"
                )
              )
                return
              if (event.ctrlKey || event.metaKey) {
                if (event.key === "+" || event.key === "=") {
                  event.preventDefault()
                  zoomIn()
                } else if (event.key === "-") {
                  event.preventDefault()
                  zoomOut()
                } else if (event.key === "0") {
                  event.preventDefault()
                  fit()
                } else if (event.key.toLowerCase() === "a") {
                  // Nothing out here is text, so a select-all would only
                  // light up the app chrome around the board.
                  event.preventDefault()
                }
              } else if (!event.altKey) {
                const key = event.key.toLowerCase()
                if (key === "delete" || key === "backspace") {
                  if (!selectedObject) return
                  event.preventDefault()
                  removeObject(selectedObject)
                } else if (key === "v") {
                  event.preventDefault()
                  setTool("select")
                  canvasRef.current?.focus({ preventScroll: true })
                } else if (key === "h") {
                  event.preventDefault()
                  setTool("hand")
                  canvasRef.current?.focus({ preventScroll: true })
                } else if (key === "t") {
                  event.preventDefault()
                  addObject(event.shiftKey ? "task" : "text")
                } else if (key === "r") {
                  event.preventDefault()
                  addObject("shape")
                } else if (key === "f") {
                  event.preventDefault()
                  addObject("frame")
                } else if (key === "n") {
                  event.preventDefault()
                  addNote()
                } else if (key === "e") {
                  event.preventDefault()
                  addObject("embed")
                } else if (key === "i") {
                  event.preventDefault()
                  filePicker.current?.click()
                }
              }
            }}
          >
            <div
              data-canvas-stage
              inert={zoomHeld || panActive}
              className="absolute top-0 left-0"
              style={stageStyle}
              onPointerOver={(event) => {
                // Whatever the pointer is over decides whose pull handles
                // show. The order matches the painting order, innermost
                // first, so a note lying on a card wins.
                const target = event.target as Element
                const handle = target.closest("[data-connect-handle]")
                if (handle) {
                  setHoveredItem(handle.getAttribute("data-connect-handle"))
                  return
                }
                const note = target.closest("[data-canvas-note]")
                if (note) {
                  setHoveredItem(
                    `note:${note.getAttribute("data-canvas-note")}`
                  )
                  return
                }
                const object = target.closest("[data-canvas-object]")
                if (object) {
                  setHoveredItem(
                    `object:${object.getAttribute("data-canvas-object")}`
                  )
                  return
                }
                const card = target.closest("[data-canvas-project]")
                setHoveredItem(
                  card
                    ? `card:${card.getAttribute("data-canvas-project")}`
                    : null
                )
              }}
              onPointerLeave={() => setHoveredItem(null)}
            >
              <CanvasConnectionLayer
                geometries={geometries}
                tethers={connectors}
                items={items}
                hovered={
                  panActive || drag.preview || noteDrag.preview
                    ? null
                    : hoveredItem
                }
                selected={
                  selectedObject && !objectDrag.preview
                    ? `object:${selectedObject}`
                    : null
                }
                draft={connectDrag.draft}
                onBeginConnect={connectDrag.begin}
                onRemove={disconnect}
              />
              {visible.map((placement) => {
                const point =
                  drag.preview?.threadId === placement.threadId
                    ? drag.preview
                    : placement
                return (
                  <div
                    key={placement.threadId}
                    data-canvas-position={placement.threadId}
                    className="absolute top-0 left-0"
                    style={{
                      transform: `translate(${point.x}px, ${point.y}px)`,
                      width: canvasProjectSize(settings[placement.threadId])
                        .width,
                    }}
                  >
                    <CanvasProjectFrame
                      providers={providers}
                      placement={placement}
                      active={placement.threadId === activeThreadId}
                      panActive={tool === "hand" || Boolean(drag.preview)}
                      onOpenChat={openChat}
                      onRemove={remove}
                      onMoveStart={drag.begin}
                      onMove={move}
                      onElementSelected={pickElement}
                      onShortcut={shortcut}
                      zoom={zoom}
                    />
                  </div>
                )
              })}
              {liveObjects.map((object) => (
                <div
                  key={object.id}
                  data-canvas-object-position={object.id}
                  className="absolute top-0 left-0"
                  style={{
                    transform: `translate(${object.x}px, ${object.y}px)`,
                  }}
                >
                  <CanvasObjectCard
                    object={object}
                    selected={selectedObject === object.id}
                    editing={editingObject === object.id}
                    panActive={tool === "hand" || Boolean(objectDrag.preview)}
                    zoom={zoom}
                    onSelect={(id) => {
                      setSelectedObject(id)
                      setEditingObject((current) =>
                        current === id ? current : null
                      )
                    }}
                    onEdit={setEditingObject}
                    onChange={changeObject}
                    onMoveStart={(event, origin) =>
                      objectDrag.begin(event, {
                        threadId: object.id,
                        ...origin,
                      })
                    }
                  />
                </div>
              ))}
              {liveNotes.map((note) => {
                const point = resolveNotePosition(note, cardPoints)
                return (
                  <div
                    key={note.id}
                    data-canvas-note-position={note.id}
                    className="absolute top-0 left-0"
                    style={{
                      transform: `translate(${point.x}px, ${point.y}px)`,
                    }}
                  >
                    <CanvasNoteCard
                      note={note}
                      origin={point}
                      targets={noteTargets}
                      panActive={tool === "hand" || Boolean(noteDrag.preview)}
                      zoom={zoom}
                      onChange={changeNote}
                      onRemove={removeNote}
                      onMoveStart={(event, origin) =>
                        noteDrag.begin(event, { threadId: note.id, ...origin })
                      }
                      onPin={attachNote}
                      onUnpin={detachNote}
                    />
                  </div>
                )
              })}
            </div>
            {/* Only a truly empty board, not one holding notes or objects. */}
            {!visible.length && !notes.length && !objects.length && (
              <div className="pointer-events-none absolute inset-0 grid place-items-center">
                <div
                  className="pointer-events-auto max-w-xs space-y-3 text-center"
                  data-canvas-controls
                >
                  <p className="text-sm font-medium">Your project canvas</p>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Bring a repo or chat onto the canvas to connect its live
                    preview.
                  </p>
                  <button
                    type="button"
                    onClick={addProject}
                    className="rounded-lg border border-border bg-card px-3 py-2 text-xs hover:bg-muted"
                  >
                    Add your first project
                  </button>
                </div>
              </div>
            )}
            {(panActive || zoomHeld) && (
              <div
                data-canvas-navigation={zoomHeld ? "zoom" : "pan"}
                aria-hidden="true"
                className={cn(
                  "absolute inset-0 z-30 touch-none",
                  zoomHeld
                    ? "cursor-zoom-in"
                    : isPanning
                      ? "cursor-grabbing"
                      : "cursor-grab"
                )}
                {...(zoomHeld
                  ? {
                      onPointerDown: (
                        event: React.PointerEvent<HTMLDivElement>
                      ) => {
                        event.preventDefault()
                        canvasRef.current?.focus({ preventScroll: true })
                      },
                    }
                  : panHandlers)}
              />
            )}
            {drag.preview && (
              <div
                data-canvas-drag-overlay
                aria-hidden="true"
                className="fixed inset-0 z-50 cursor-grabbing touch-none"
                {...drag.overlayProps}
              />
            )}
            {noteDrag.preview && (
              <div
                data-canvas-drag-overlay="note"
                aria-hidden="true"
                className="fixed inset-0 z-50 cursor-grabbing touch-none"
                {...noteDrag.overlayProps}
              />
            )}
            {objectDrag.preview && (
              <div
                data-canvas-drag-overlay="object"
                aria-hidden="true"
                className="fixed inset-0 z-50 cursor-grabbing touch-none"
                {...objectDrag.overlayProps}
              />
            )}
            {connectDrag.draft && (
              <div
                data-canvas-drag-overlay="connection"
                aria-hidden="true"
                className="fixed inset-0 z-50 cursor-crosshair touch-none"
                {...connectDrag.overlayProps}
              />
            )}
            {formatTarget && !objectDrag.preview && (
              <CanvasFormatBar
                object={formatTarget}
                left={Math.max(12, pan.x + formatTarget.x * zoom)}
                top={Math.max(46, pan.y + formatTarget.y * zoom - 8)}
                onChange={changeObject}
                onDuplicate={duplicateObject}
                onRemove={removeObject}
              />
            )}
            <div
              data-canvas-controls
              className="absolute top-3 left-3 z-40 flex max-w-[calc(100%-24px)] flex-wrap items-center gap-1 rounded-xl border border-border/60 bg-card/95 px-1.5 py-1 shadow-xl backdrop-blur-sm"
            >
              <ToolButton
                active={!panActive}
                title="Select (V)"
                onClick={() => {
                  setTool("select")
                  canvasRef.current?.focus({ preventScroll: true })
                }}
              >
                <MousePointer2Icon className="size-3.5" />
              </ToolButton>
              <ToolButton
                active={panActive}
                title="Hand — pan the canvas (H, or hold Alt / Space)"
                onClick={() => {
                  setTool("hand")
                  canvasRef.current?.focus({ preventScroll: true })
                }}
              >
                <HandIcon className="size-3.5" />
              </ToolButton>
              <ToolbarDivider />
              <button
                type="button"
                onClick={addProject}
                className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] font-medium hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
              >
                <PlusIcon className="size-3.5" />
                Add project
              </button>
              <ToolbarDivider />
              <ToolButton title="Sticky note (N)" onClick={addNote}>
                <StickyNoteIcon className="size-3.5" />
              </ToolButton>
              <ToolButton title="Text (T)" onClick={() => addObject("text")}>
                <TypeIcon className="size-3.5" />
              </ToolButton>
              <ToolButton title="Shape (R)" onClick={() => addObject("shape")}>
                <SquareIcon className="size-3.5" />
              </ToolButton>
              <ToolButton
                title="Task card (Shift T)"
                onClick={() => addObject("task")}
              >
                <SquareCheckBigIcon className="size-3.5" />
              </ToolButton>
              <ToolButton title="Frame (F)" onClick={() => addObject("frame")}>
                <FrameIcon className="size-3.5" />
              </ToolButton>
              <ToolButton
                title="Image (I) — or just paste one"
                onClick={() => filePicker.current?.click()}
              >
                <ImageIcon className="size-3.5" />
              </ToolButton>
              <ToolButton
                title="Embed a page (E) — or paste a link"
                onClick={() => addObject("embed")}
              >
                <GlobeIcon className="size-3.5" />
              </ToolButton>
              <span className="px-2 text-[10px] text-muted-foreground tabular-nums">
                {visible.length} {visible.length === 1 ? "project" : "projects"}
              </span>
              <ToolbarDivider />
              <SelectBrowseToggle
                selectionMode={selectionMode}
                onToggle={() => setSelectionMode(!selectionMode)}
                available={Boolean(window.electronAPI)}
              />
              <ToolButton
                active={inspectorOpen}
                title="Elements — inspect and edit the focused preview"
                onClick={() => setInspectorOpen(!inspectorOpen)}
              >
                {inspectorOpen ? (
                  <PanelLeftCloseIcon className="size-3.5" />
                ) : (
                  <PanelLeftOpenIcon className="size-3.5" />
                )}
              </ToolButton>
              {pendingCssChanges > 0 && (
                <button
                  type="button"
                  onClick={sendCssToAI}
                  className="flex h-7 items-center gap-1.5 rounded-md bg-primary px-2 text-[11px] font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <SparklesIcon className="size-3.5" />
                  Send to AI
                  <span className="rounded bg-primary-foreground/20 px-1 text-[10px] tabular-nums">
                    {pendingCssChanges}
                  </span>
                </button>
              )}
            </div>
            <div
              data-canvas-controls
              className="absolute right-3 bottom-3 z-40 flex items-center gap-0.5 rounded-lg border border-border/60 bg-card/95 px-1 py-0.5 shadow-lg backdrop-blur-sm"
            >
              <ToolButton title="Fit all projects (Ctrl 0)" onClick={fit}>
                <MaximizeIcon className="size-3.5" />
              </ToolButton>
              <ToolbarDivider />
              <ToolButton title="Zoom out (Ctrl -)" onClick={zoomOut}>
                <MinusIcon className="size-3.5" />
              </ToolButton>
              <button
                type="button"
                onClick={() => zoomTo(1)}
                title="Reset to 100%"
                className="h-6 min-w-12 rounded-md font-mono text-[11px] hover:bg-muted"
              >
                {Math.round(zoom * 100)}%
              </button>
              <ToolButton title="Zoom in (Ctrl +)" onClick={zoomIn}>
                <PlusIcon className="size-3.5" />
              </ToolButton>
            </div>
          </div>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content
            className={cn(MENU_PANEL, "z-50 min-w-48 text-foreground")}
          >
            <ContextMenu.Item
              className={cn(
                MENU_ITEM,
                "flex cursor-default items-center outline-none data-highlighted:bg-accent"
              )}
              onSelect={() => setPickerOpen(true)}
            >
              <PlusIcon />
              Add repo or chat here
            </ContextMenu.Item>
            <ContextMenu.Item
              className={cn(
                MENU_ITEM,
                "flex cursor-default items-center outline-none data-highlighted:bg-accent"
              )}
              onSelect={addNote}
            >
              <StickyNoteIcon />
              Add note here
            </ContextMenu.Item>
            <ContextMenu.Item
              className={cn(
                MENU_ITEM,
                "flex cursor-default items-center outline-none data-highlighted:bg-accent"
              )}
              onSelect={() => addObject("text")}
            >
              <TypeIcon />
              Add text here
            </ContextMenu.Item>
            <ContextMenu.Item
              className={cn(
                MENU_ITEM,
                "flex cursor-default items-center outline-none data-highlighted:bg-accent"
              )}
              onSelect={() => addObject("shape")}
            >
              <SquareIcon />
              Add shape here
            </ContextMenu.Item>
            <ContextMenu.Item
              className={cn(
                MENU_ITEM,
                "flex cursor-default items-center outline-none data-highlighted:bg-accent"
              )}
              onSelect={() => addObject("task")}
            >
              <SquareCheckBigIcon />
              Add task here
            </ContextMenu.Item>
            <ContextMenu.Item
              className={cn(
                MENU_ITEM,
                "flex cursor-default items-center outline-none data-highlighted:bg-accent"
              )}
              onSelect={() => {
                // The picker has to open from the click, not from the menu's
                // unmount, or the browser treats it as an unprompted dialog.
                const point = insertionPoint.current
                queueMicrotask(() => {
                  insertionPoint.current = point
                  filePicker.current?.click()
                })
              }}
            >
              <ImageIcon />
              Add image here…
            </ContextMenu.Item>
            <ContextMenu.Item
              className={cn(
                MENU_ITEM,
                "flex cursor-default items-center outline-none data-highlighted:bg-accent"
              )}
              onSelect={() => addObject("embed")}
            >
              <GlobeIcon />
              Embed a page here
            </ContextMenu.Item>
            <ContextMenu.Item
              className={cn(
                MENU_ITEM,
                "flex cursor-default items-center outline-none data-highlighted:bg-accent"
              )}
              onSelect={fit}
            >
              <MaximizeIcon />
              Fit all projects
            </ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
      <input
        ref={filePicker}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(event) => {
          const files = [...(event.target.files ?? [])]
          event.target.value = ""
          if (!files.length) return
          void applyDropSpecs(
            canvasDropSpecs({ files }),
            placeAt(OBJECT_SIZES.image)
          )
        }}
      />
      <CanvasProjectPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        attachedIds={visible.map((item) => item.threadId)}
        onAttach={attach}
      />
    </section>
  )
}
