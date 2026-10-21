// Side-effect import: registers monaco workers + pins the loader to the
// locally-bundled monaco instance. Must run before the first <Editor> mount,
// which is satisfied by being at module scope — any route that reaches here
// is already committed to rendering monaco.
import "@/lib/monaco-setup"
import { defineWorkbenchThemes } from "@/lib/monaco-workbench-theme"
import { enableWorkbenchJsx } from "@/lib/monaco-workbench-language"
import Editor, { type OnMount } from "@monaco-editor/react"
import { useTheme } from "@/components/theme-provider"
import { useEditorStore, type EditorSelectionContext } from "@/lib/editor-store"
import {
  normalizeMonacoMarkerSeverity,
  useEditorDiagnosticsStore,
  type EditorDiagnostic,
} from "@/lib/editor-diagnostics-store"
import {
  isReferenceSearchableSymbol,
  useEditorReferencesStore,
} from "@/lib/editor-references-store"
import { templateMode, useAppearanceStore } from "@/lib/appearance-store"
import { getCustomTheme } from "@/lib/custom-theme-cache"
import { customThemeIdOf } from "@/lib/vscode-theme"
import { defineCustomWorkbenchTheme } from "@/lib/monaco-workbench-theme"
import { usePreferencesStore } from "@/lib/preferences-store"
import type { EditorGotoLineDetail } from "@/lib/editor-go-to-line"
import { isRenameableIdentifier } from "@/lib/symbol-rename"
import { editorModelUri } from "@/lib/editor-path"
import { renameSymbolInOpenFiles } from "@/lib/monaco-symbol-rename"
import {
  installEditorModelDisposal,
  scheduleEditorModelCleanup,
} from "@/lib/monaco-model-disposal"
import { toast } from "@/lib/toast"
import { useCallback, useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import type { editor as MonacoEditor, IRange } from "monaco-editor"
import {
  computeLineDiff,
  editorCommandTargetsFile,
  resolveMonacoFontFamily,
  selectionStats,
} from "./monaco-editor/editor-helpers"
import { InlineEditPopup } from "./monaco-editor/inline-edit-popup"
import type {
  InlineEditProvider,
  InlineEditRequest,
} from "./monaco-editor/inline-edit-types"
import { RenameSymbolPopup } from "./monaco-editor/rename-symbol-popup"
import { resolveWorkspaceDefinition } from "./monaco-editor/workspace-definition"

export type {
  InlineEditModel,
  InlineEditProvider,
  InlineEditRequest,
} from "./monaco-editor/inline-edit-types"

interface MonacoEditorWrapperProps {
  workbench?: boolean
  filePath: string
  projectPath?: string | null
  language: string
  value: string
  onChange: (value: string) => void
  onSave: () => void
  onCursorChange?: (
    line: number,
    column: number,
    selection?: EditorSelectionContext
  ) => void
  onInlineEdit?: (request: InlineEditRequest) => void | Promise<void>
  /**
   * When set, renders inline diff decorations comparing `value` (new) against
   * this baseline (pre-AI-edit). Null/undefined = no diff overlay.
   */
  aiBaselineContent?: string | null
  /**
   * Provider/model data for the inline-edit widget's model picker.
   * If empty/undefined, the picker is hidden and the current global
   * model is used implicitly by the parent's onInlineEdit handler.
   */
  inlineEditProviders?: InlineEditProvider[]
  inlineEditSelectedModelId?: string
  inlineEditSelectedProviderId?: string
  onInlineEditModelChange?: (modelId: string, providerId: string) => void
}

interface RenameSymbolContext {
  modelUri: string
  modelVersion: number
  offset: number
  symbol: string
  line: number
  column: number
  startColumn: number
  endColumn: number
}

interface DiagnosticInlineFixDetail {
  filePath?: string
  line?: number
  column?: number
  endLine?: number
  endColumn?: number
  instruction?: string
}

export function MonacoEditorWrapper({
  workbench = false,
  filePath,
  projectPath,
  language,
  value,
  onChange,
  onSave,
  onCursorChange,
  onInlineEdit,
  aiBaselineContent,
  inlineEditProviders,
  inlineEditSelectedModelId,
  inlineEditSelectedProviderId,
  onInlineEditModelChange,
}: MonacoEditorWrapperProps) {
  const { theme } = useTheme()
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null)
  const monacoRef = useRef<typeof import("monaco-editor") | null>(null)
  const filePathRef = useRef(filePath)
  const projectPathRef = useRef(projectPath)
  const markerSubscriptionRef = useRef<{ dispose: () => void } | null>(null)
  const diffDecorationsRef =
    useRef<MonacoEditor.IEditorDecorationsCollection | null>(null)
  // View zone IDs for "removed" lines in the AI diff overlay. View zones
  // reserve vertical space between lines (content widgets would overlap
  // the code beneath them, which was the bug in the earlier implementation).
  const removedViewZoneIdsRef = useRef<string[]>([])
  const [isEditorActive, setIsEditorActive] = useState(
    () => !document.hidden && document.hasFocus()
  )

  // ── Inline Edit Widget state ─────────────────────────────────────────
  // Replaces the old shadcn Dialog. The widget is rendered via a Monaco
  // content widget anchored at the end of the user's selection, and its
  // React content is portaled into the widget's DOM node.
  const [widgetAnchor, setWidgetAnchor] = useState<{
    line: number
    column: number
    context: InlineEditRequest
  } | null>(null)
  const [widgetBusy, setWidgetBusy] = useState(false)
  const [widgetDom, setWidgetDom] = useState<HTMLDivElement | null>(null)
  const [renameAnchor, setRenameAnchor] = useState<RenameSymbolContext | null>(
    null
  )
  const [renameBusy, setRenameBusy] = useState(false)
  const [renameError, setRenameError] = useState<string | null>(null)
  const [renameDom, setRenameDom] = useState<HTMLDivElement | null>(null)
  const editorWordWrap = usePreferencesStore((state) => state.editorWordWrap)
  const editorMinimap = usePreferencesStore((state) => state.editorMinimap)
  const editorStickyScroll = usePreferencesStore(
    (state) => state.editorStickyScroll
  )
  const editorRenderWhitespace = usePreferencesStore(
    (state) => state.editorRenderWhitespace
  )
  const editorInlayHints = usePreferencesStore(
    (state) => state.editorInlayHints
  )
  const editorLineNumbers = usePreferencesStore(
    (state) => state.editorLineNumbers
  )
  const editorFontSize = useAppearanceStore((state) => state.codeFontSize)
  const appearanceTemplate = useAppearanceStore((state) => state.template)
  const editorCodeFontFamily = useAppearanceStore(
    (state) => state.codeFontFamily
  )
  const monacoFontFamily = resolveMonacoFontFamily(editorCodeFontFamily)

  const isDark =
    theme === "dark" ||
    (theme === "system" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches)
  // An imported VS Code theme brings its own editor colors; the built-in
  // templates map to the two workbench themes. The custom theme is
  // (re)defined on every mount because Monaco keeps theme definitions per
  // page, and a re-import with the same id must not show stale rules.
  const customTheme = workbench
    ? getCustomTheme(customThemeIdOf(appearanceTemplate))
    : null
  const monacoTheme = customTheme
    ? `betterc0de-editor-custom-${customTheme.id}`
    : workbench
      ? (templateMode(appearanceTemplate) ?? (isDark ? "dark" : "light")) ===
        "dark"
        ? "betterc0de-editor-dark"
        : "betterc0de-editor-light"
      : isDark
        ? "vs-dark"
        : "vs"
  const defineThemes = useCallback(
    (monaco: Parameters<typeof defineWorkbenchThemes>[0]) => {
      defineWorkbenchThemes(monaco)
      if (customTheme) defineCustomWorkbenchTheme(monaco, customTheme)
    },
    [customTheme]
  )

  useEffect(() => {
    filePathRef.current = filePath
  }, [filePath])

  useEffect(() => {
    projectPathRef.current = projectPath
  }, [projectPath])

  const publishDiagnostics = useCallback(() => {
    const editor = editorRef.current
    const monaco = monacoRef.current
    const model = editor?.getModel()
    if (!editor || !monaco || !model) return
    const currentPath = filePathRef.current
    const markers = monaco.editor.getModelMarkers({ resource: model.uri })
    const diagnostics: EditorDiagnostic[] = markers.map((marker, index) => ({
      id: `${currentPath}:${marker.startLineNumber}:${marker.startColumn}:${index}`,
      filePath: currentPath,
      severity: normalizeMonacoMarkerSeverity(marker.severity),
      message: marker.message,
      ...(marker.source ? { source: marker.source } : {}),
      ...(marker.code ? { code: String(marker.code) } : {}),
      startLineNumber: marker.startLineNumber,
      startColumn: marker.startColumn,
      endLineNumber: marker.endLineNumber,
      endColumn: marker.endColumn,
    }))
    useEditorDiagnosticsStore
      .getState()
      .setFileDiagnostics(currentPath, diagnostics)
  }, [])

  useEffect(() => {
    window.setTimeout(publishDiagnostics, 0)
  }, [filePath, publishDiagnostics])

  useEffect(() => {
    const updateVisibility = () => {
      setIsEditorActive(!document.hidden && document.hasFocus())
    }
    updateVisibility()
    window.addEventListener("focus", updateVisibility)
    window.addEventListener("blur", updateVisibility)
    document.addEventListener("visibilitychange", updateVisibility)
    return () => {
      window.removeEventListener("focus", updateVisibility)
      window.removeEventListener("blur", updateVisibility)
      document.removeEventListener("visibilitychange", updateVisibility)
    }
  }, [])

  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    editor.updateOptions({
      fontSize: editorFontSize,
      fontFamily: monacoFontFamily,
      minimap: { enabled: editorMinimap && isEditorActive, scale: 1 },
      smoothScrolling: isEditorActive,
      cursorBlinking: isEditorActive ? "smooth" : "blink",
      cursorSmoothCaretAnimation: isEditorActive ? "on" : "off",
      renderLineHighlight: isEditorActive ? "line" : "none",
      occurrencesHighlight: isEditorActive ? "singleFile" : "off",
      wordWrap: editorWordWrap ? "on" : "off",
      lineNumbers: editorLineNumbers ? "on" : "off",
      stickyScroll: { enabled: editorStickyScroll },
      renderWhitespace: editorRenderWhitespace ? "boundary" : "none",
      inlayHints: { enabled: editorInlayHints ? "on" : "off" },
    })
  }, [
    editorFontSize,
    editorInlayHints,
    editorLineNumbers,
    editorMinimap,
    editorRenderWhitespace,
    editorStickyScroll,
    editorWordWrap,
    isEditorActive,
    monacoFontFamily,
  ])

  useEffect(() => {
    const handleGotoLine = (event: Event) => {
      const detail = (event as CustomEvent<EditorGotoLineDetail>).detail
      if (!detail?.filePath || detail.filePath !== filePath) return
      const editor = editorRef.current
      const model = editor?.getModel()
      if (!editor || !model) return
      const lineNumber = Math.max(
        1,
        Math.min(model.getLineCount(), Math.floor(detail.line ?? 1))
      )
      const column = Math.max(
        1,
        Math.min(
          model.getLineMaxColumn(lineNumber),
          Math.floor(detail.column ?? 1)
        )
      )
      const endLine =
        typeof detail.endLine === "number"
          ? Math.max(
              lineNumber,
              Math.min(model.getLineCount(), Math.floor(detail.endLine))
            )
          : lineNumber
      const endColumn =
        typeof detail.endColumn === "number" || endLine > lineNumber
          ? Math.max(
              endLine === lineNumber ? column : 1,
              Math.min(
                model.getLineMaxColumn(endLine),
                typeof detail.endColumn === "number"
                  ? Math.floor(detail.endColumn)
                  : model.getLineMaxColumn(endLine)
              )
            )
          : null
      if (!detail.preserveNavigation) {
        useEditorStore.getState().recordNavigationPoint()
      }
      if (endColumn !== null && (endLine > lineNumber || endColumn > column)) {
        const range = {
          startLineNumber: lineNumber,
          startColumn: column,
          endLineNumber: endLine,
          endColumn,
        }
        editor.setSelection(range)
        editor.revealRangeInCenter(range)
      } else {
        editor.setPosition({ lineNumber, column })
        editor.revealLineInCenter(lineNumber)
      }
      editor.focus()
    }
    window.addEventListener(
      "betterc0de:editor-goto-line",
      handleGotoLine as EventListener
    )
    return () =>
      window.removeEventListener(
        "betterc0de:editor-goto-line",
        handleGotoLine as EventListener
      )
  }, [filePath])

  // Build & open the inline edit widget anchored at the current selection.
  // Stored in a ref so the Monaco action handler (registered once on mount)
  // always calls the latest version when filePath/language change.
  const widgetAnchorRef = useRef(widgetAnchor)
  useEffect(() => {
    widgetAnchorRef.current = widgetAnchor
  }, [widgetAnchor])

  const openInlineWidget = useCallback(() => {
    // If a widget is already open, don't recreate it — focus would be
    // lost and any in-progress instruction would be discarded.
    if (widgetAnchorRef.current) return
    setRenameAnchor(null)
    const editor = editorRef.current
    if (!editor) return
    const model = editor.getModel()
    if (!model) return

    const selection = editor.getSelection()
    const full = model.getValue()
    const hasSelection =
      !!selection &&
      !(
        selection.startLineNumber === selection.endLineNumber &&
        selection.startColumn === selection.endColumn
      )
    const selectedText = hasSelection ? model.getValueInRange(selection!) : full
    const safeSelection = selection ?? {
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: model.getLineCount(),
      endColumn: model.getLineMaxColumn(model.getLineCount()),
    }

    const context: InlineEditRequest = {
      filePath,
      language,
      instruction: "",
      selectedText,
      isWholeFile: !hasSelection,
      selection: {
        startLine: safeSelection.startLineNumber,
        startColumn: safeSelection.startColumn,
        endLine: safeSelection.endLineNumber,
        endColumn: safeSelection.endColumn,
      },
    }

    // Anchor the widget BELOW the selection end (or start if no selection)
    setWidgetAnchor({
      line: hasSelection
        ? safeSelection.endLineNumber
        : safeSelection.startLineNumber,
      column: hasSelection
        ? safeSelection.endColumn
        : safeSelection.startColumn,
      context,
    })
  }, [filePath, language])

  const openInlineWidgetRef = useRef(openInlineWidget)
  useEffect(() => {
    openInlineWidgetRef.current = openInlineWidget
  }, [openInlineWidget])

  const renameAnchorRef = useRef(renameAnchor)
  useEffect(() => {
    renameAnchorRef.current = renameAnchor
  }, [renameAnchor])

  const openRenameWidget = useCallback(() => {
    if (renameAnchorRef.current) return
    setWidgetAnchor(null)
    const editor = editorRef.current
    const model = editor?.getModel()
    const position = editor?.getPosition()
    if (!editor || !model || !position) return
    const word = model.getWordAtPosition(position)
    const symbol = word?.word ?? ""
    if (!isRenameableIdentifier(symbol)) return
    setRenameError(null)
    setRenameAnchor({
      modelUri: model.uri.toString(),
      modelVersion: model.getVersionId(),
      offset: model.getOffsetAt(position),
      symbol,
      line: position.lineNumber,
      column: word?.startColumn ?? position.column,
      startColumn: word?.startColumn ?? position.column,
      endColumn: word?.endColumn ?? position.column,
    })
  }, [])

  const openRenameWidgetRef = useRef(openRenameWidget)
  useEffect(() => {
    openRenameWidgetRef.current = openRenameWidget
  }, [openRenameWidget])

  const requestFindReferences = useCallback(() => {
    const editor = editorRef.current
    const model = editor?.getModel()
    const position = editor?.getPosition()
    if (!editor || !model || !position) return

    const selection = editor.getSelection()
    const selectedText =
      selection &&
      !(
        selection.startLineNumber === selection.endLineNumber &&
        selection.startColumn === selection.endColumn
      )
        ? model.getValueInRange(selection).trim()
        : ""
    const word = model.getWordAtPosition(position)
    const symbol = selectedText || word?.word || ""
    if (!isReferenceSearchableSymbol(symbol)) return

    useEditorReferencesStore.getState().setReferenceRequest({
      symbol,
      originFilePath: filePathRef.current,
      originLine: position.lineNumber,
      originColumn: word?.startColumn ?? position.column,
    })
    usePreferencesStore.getState().setMultiple({
      editorSidebarView: "references",
      sidebarOpen: true,
    })
  }, [])

  const requestFindReferencesRef = useRef(requestFindReferences)
  useEffect(() => {
    requestFindReferencesRef.current = requestFindReferences
  }, [requestFindReferences])

  const requestGoToDefinition = useCallback(async () => {
    const editor = editorRef.current
    const model = editor?.getModel()
    const position = editor?.getPosition()
    if (!editor || !model || !position) return

    const word = model.getWordAtPosition(position)
    const symbol = word?.word ?? ""
    if (!isReferenceSearchableSymbol(symbol)) return

    const definition = await resolveWorkspaceDefinition({
      projectPath: projectPathRef.current,
      currentFilePath: filePathRef.current,
      currentContent: model.getValue(),
      symbol,
      originLine: position.lineNumber,
      originColumn: word?.startColumn ?? position.column,
    })
    if (!definition) {
      requestFindReferencesRef.current()
      return
    }

    await useEditorStore.getState().openFile(definition.filePath, {
      line: definition.line,
      column: definition.column,
    })
    window.setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent("betterc0de:editor-goto-line", {
          detail: {
            filePath: definition.filePath,
            line: definition.line,
            column: definition.column,
            preserveNavigation: true,
          },
        })
      )
    }, 0)
  }, [])

  const requestGoToDefinitionRef = useRef(requestGoToDefinition)
  useEffect(() => {
    requestGoToDefinitionRef.current = requestGoToDefinition
  }, [requestGoToDefinition])

  useEffect(() => {
    const handleGoToDefinition = (event: Event) => {
      const detail = (event as CustomEvent<{ filePath?: string }>).detail
      if (!editorCommandTargetsFile(detail, filePathRef.current)) return
      void requestGoToDefinitionRef.current()
    }
    window.addEventListener(
      "betterc0de:editor-go-to-definition",
      handleGoToDefinition
    )
    return () =>
      window.removeEventListener(
        "betterc0de:editor-go-to-definition",
        handleGoToDefinition
      )
  }, [])

  useEffect(() => {
    const handleFindReferences = (event: Event) => {
      const detail = (event as CustomEvent<{ filePath?: string }>).detail
      if (!editorCommandTargetsFile(detail, filePathRef.current)) return
      requestFindReferencesRef.current()
    }
    window.addEventListener(
      "betterc0de:editor-find-references",
      handleFindReferences
    )
    return () =>
      window.removeEventListener(
        "betterc0de:editor-find-references",
        handleFindReferences
      )
  }, [])

  useEffect(() => {
    const handleEditWithAI = (event: Event) => {
      const detail = (event as CustomEvent<{ filePath?: string }>).detail
      if (!editorCommandTargetsFile(detail, filePathRef.current)) return
      openInlineWidgetRef.current()
    }
    window.addEventListener("betterc0de:editor-edit-with-ai", handleEditWithAI)
    return () =>
      window.removeEventListener(
        "betterc0de:editor-edit-with-ai",
        handleEditWithAI
      )
  }, [])

  useEffect(() => {
    const handleRenameSymbol = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          filePath?: string
          line?: number
          column?: number
        }>
      ).detail
      if (!editorCommandTargetsFile(detail, filePathRef.current)) return
      const editor = editorRef.current
      const model = editor?.getModel()
      if (editor && model && typeof detail?.line === "number") {
        const lineNumber = Math.max(
          1,
          Math.min(model.getLineCount(), Math.floor(detail.line))
        )
        const column = Math.max(
          1,
          Math.min(
            model.getLineMaxColumn(lineNumber),
            Math.floor(detail.column ?? 1)
          )
        )
        editor.setPosition({ lineNumber, column })
        editor.revealLineInCenter(lineNumber)
        editor.focus()
      }
      openRenameWidgetRef.current()
    }
    window.addEventListener(
      "betterc0de:editor-rename-symbol",
      handleRenameSymbol
    )
    return () =>
      window.removeEventListener(
        "betterc0de:editor-rename-symbol",
        handleRenameSymbol
      )
  }, [])

  useEffect(() => {
    const handleDiagnosticFix = (event: Event) => {
      const detail = (event as CustomEvent<DiagnosticInlineFixDetail>).detail
      if (!detail?.filePath || detail.filePath !== filePathRef.current) return
      const editor = editorRef.current
      const model = editor?.getModel()
      if (!editor || !model) return

      setRenameAnchor(null)
      const startLine = Math.max(
        1,
        Math.min(model.getLineCount(), Math.floor(detail.line ?? 1))
      )
      const endLine = Math.max(
        startLine,
        Math.min(model.getLineCount(), Math.floor(detail.endLine ?? startLine))
      )
      const startColumn = Math.max(
        1,
        Math.min(
          model.getLineMaxColumn(startLine),
          Math.floor(detail.column ?? 1)
        )
      )
      const rawEndColumn = Math.max(
        1,
        Math.min(
          model.getLineMaxColumn(endLine),
          Math.floor(detail.endColumn ?? model.getLineMaxColumn(endLine))
        )
      )
      const endColumn =
        endLine === startLine
          ? Math.max(startColumn, rawEndColumn)
          : rawEndColumn
      const range = {
        startLineNumber: startLine,
        startColumn,
        endLineNumber: endLine,
        endColumn,
      }
      const selectedText =
        model.getValueInRange(range) || model.getLineContent(startLine)
      editor.setSelection(range)
      editor.revealRangeInCenter(range)
      editor.focus()
      setWidgetAnchor({
        line: endLine,
        column: endColumn,
        context: {
          filePath: filePathRef.current,
          language,
          instruction: detail.instruction?.trim() ?? "",
          selectedText,
          isWholeFile: false,
          selection: {
            startLine,
            startColumn,
            endLine,
            endColumn,
          },
        },
      })
    }
    window.addEventListener(
      "betterc0de:editor-ai-fix-diagnostic",
      handleDiagnosticFix as EventListener
    )
    return () =>
      window.removeEventListener(
        "betterc0de:editor-ai-fix-diagnostic",
        handleDiagnosticFix as EventListener
      )
  }, [language])

  useEffect(() => {
    const handleFormatDocument = (event: Event) => {
      const detail = (event as CustomEvent<{ filePath?: string }>).detail
      if (detail?.filePath && detail.filePath !== filePathRef.current) return

      const editor = editorRef.current
      if (!editor?.getModel()) return
      editor.focus()

      const formatAction = editor.getAction("editor.action.formatDocument")
      if (!formatAction) return
      void formatAction
        .run()
        .catch(() => {})
        .finally(() => publishDiagnostics())
    }
    window.addEventListener(
      "betterc0de:editor-format-document",
      handleFormatDocument as EventListener
    )
    return () =>
      window.removeEventListener(
        "betterc0de:editor-format-document",
        handleFormatDocument as EventListener
      )
  }, [publishDiagnostics])

  const handleMount: OnMount = useCallback(
    (editor, monaco) => {
      editorRef.current = editor
      monacoRef.current = monaco
      diffDecorationsRef.current = editor.createDecorationsCollection()

      // The editor keeps one model per path it has shown. Release models of
      // closed tabs once the editor has moved on to its next model.
      installEditorModelDisposal(monaco)
      editor.onDidChangeModel(() => scheduleEditorModelCleanup())
      scheduleEditorModelCleanup()

      // Search can finish before the lazy editor mounts. Its target position
      // is already in the tab store even when the one-shot event was missed.
      if (workbench) {
        editor.onDidDispose(enableWorkbenchJsx(monaco.languages.typescript))
        const tab = useEditorStore
          .getState()
          .tabs.find((item) => item.filePath === filePathRef.current)
        const model = editor.getModel()
        if (tab && model) {
          const position = model.validatePosition({
            lineNumber: tab.cursorLine,
            column: tab.cursorColumn,
          })
          editor.setPosition(position)
          editor.revealPositionInCenter(
            position,
            monaco.editor.ScrollType.Immediate
          )
        }
      }

      // Ctrl+S save
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        onSave()
      })

      // Edit with AI — appears as the first item in the native right-click
      // context menu AND binds Ctrl+K. `0_ai` group sorts before Monaco's
      // default `1_modification` / `navigation` groups.
      editor.addAction({
        id: "betterc0de.editWithAI",
        label: "Edit with AI",
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK],
        contextMenuGroupId: "0_ai",
        contextMenuOrder: 1,
        run: () => {
          openInlineWidgetRef.current()
        },
      })

      editor.addAction({
        id: "betterc0de.findReferences",
        label: "Find References",
        keybindings: [monaco.KeyMod.Shift | monaco.KeyCode.F12],
        contextMenuGroupId: "navigation",
        contextMenuOrder: 2,
        run: () => {
          requestFindReferencesRef.current()
        },
      })

      editor.addAction({
        id: "betterc0de.goToDefinition",
        label: "Go to Definition",
        keybindings: [monaco.KeyCode.F12],
        contextMenuGroupId: "navigation",
        contextMenuOrder: 1,
        run: () => {
          void requestGoToDefinitionRef.current()
        },
      })

      editor.addAction({
        id: "betterc0de.renameSymbol",
        label: "Rename Symbol in Open Files",
        keybindings: [monaco.KeyCode.F2],
        contextMenuGroupId: "navigation",
        contextMenuOrder: 3,
        run: () => {
          openRenameWidgetRef.current()
        },
      })

      // Track cursor position and selection for the editor status bar.
      editor.onDidChangeCursorPosition((e) => {
        onCursorChange?.(e.position.lineNumber, e.position.column)
      })
      editor.onDidChangeCursorSelection((e) => {
        const position = editor.getPosition()
        if (!position) return
        onCursorChange?.(
          position.lineNumber,
          position.column,
          selectionStats(editor, e.selection)
        )
      })

      markerSubscriptionRef.current?.dispose()
      markerSubscriptionRef.current = monaco.editor.onDidChangeMarkers(
        (resources) => {
          const model = editor.getModel()
          if (!model) return
          const changedCurrentModel = resources.some(
            (resource) => resource.toString() === model.uri.toString()
          )
          if (changedCurrentModel) publishDiagnostics()
        }
      )
      publishDiagnostics()

      editor.focus()
    },
    [onSave, onCursorChange, publishDiagnostics, workbench]
  )

  // ── Mount Monaco content widget for the inline edit popup ────────────
  // When widgetAnchor becomes non-null, create a content widget anchored
  // at that position. The widget's DOM node is exposed via `setWidgetDom`
  // so the React content can be portaled into it.
  useEffect(() => {
    const editor = editorRef.current
    const monaco = monacoRef.current
    if (!editor || !monaco || !widgetAnchor) {
      setWidgetDom(null)
      return
    }

    const dom = document.createElement("div")
    dom.className = "inline-edit-widget-container"

    const widget: MonacoEditor.IContentWidget = {
      getId: () => "betterc0de.inline-edit-widget",
      getDomNode: () => dom,
      getPosition: () => ({
        position: {
          lineNumber: widgetAnchor.line,
          column: widgetAnchor.column,
        },
        preference: [
          monaco.editor.ContentWidgetPositionPreference.BELOW,
          monaco.editor.ContentWidgetPositionPreference.ABOVE,
        ],
      }),
    }
    editor.addContentWidget(widget)
    setWidgetDom(dom)

    return () => {
      editor.removeContentWidget(widget)
      setWidgetDom(null)
    }
  }, [widgetAnchor])

  useEffect(() => {
    const editor = editorRef.current
    const monaco = monacoRef.current
    if (!editor || !monaco || !renameAnchor) {
      setRenameDom(null)
      return
    }

    const dom = document.createElement("div")
    dom.className = "rename-symbol-widget-container"

    const widget: MonacoEditor.IContentWidget = {
      getId: () => "betterc0de.rename-symbol-widget",
      getDomNode: () => dom,
      getPosition: () => ({
        position: {
          lineNumber: renameAnchor.line,
          column: renameAnchor.startColumn,
        },
        preference: [
          monaco.editor.ContentWidgetPositionPreference.BELOW,
          monaco.editor.ContentWidgetPositionPreference.ABOVE,
        ],
      }),
    }
    editor.addContentWidget(widget)
    setRenameDom(dom)

    return () => {
      editor.removeContentWidget(widget)
      setRenameDom(null)
    }
  }, [renameAnchor])

  const submitInlineEdit = useCallback(
    async (instruction: string) => {
      if (!widgetAnchor || !onInlineEdit || !instruction.trim()) return
      setWidgetBusy(true)
      try {
        await onInlineEdit({
          ...widgetAnchor.context,
          instruction: instruction.trim(),
        })
        setWidgetAnchor(null)
        editorRef.current?.focus()
      } finally {
        setWidgetBusy(false)
      }
    },
    [widgetAnchor, onInlineEdit]
  )

  const cancelInlineEdit = useCallback(() => {
    if (widgetBusy) return
    setWidgetAnchor(null)
    editorRef.current?.focus()
  }, [widgetBusy])

  const submitRenameSymbol = useCallback(
    async (newName: string) => {
      if (!renameAnchor) return
      const editor = editorRef.current
      const model = editor?.getModel()
      if (!editor || !model) return
      const nextName = newName.trim()
      if (!isRenameableIdentifier(nextName)) {
        setRenameError("Use a valid identifier name.")
        return
      }
      if (nextName === renameAnchor.symbol) {
        setRenameAnchor(null)
        editor.focus()
        return
      }

      setRenameBusy(true)
      setRenameError(null)
      try {
        const monaco = monacoRef.current
        if (!monaco || model.uri.toString() !== renameAnchor.modelUri) {
          setRenameError("The selected document changed. Reopen Rename.")
          return
        }
        const result = await renameSymbolInOpenFiles({
          monaco,
          model,
          expectedModelVersion: renameAnchor.modelVersion,
          projectPath: projectPathRef.current,
          filePath: filePathRef.current,
          offset: renameAnchor.offset,
          newName: nextName,
        })
        if (result.status === "rejected") {
          setRenameError(result.reason)
          return
        }
        if (result.status === "conflict") {
          setRenameError(
            `Documents changed during Rename: ${result.filePaths.join(", ")}. Nothing was changed.`
          )
          return
        }
        toast.success(
          `Renamed ${result.replacements} references in ${result.changedTabIds.length} open files. Review and save the changes.`
        )
        setRenameAnchor(null)
        editor.focus()
      } catch (err) {
        setRenameError(err instanceof Error ? err.message : String(err))
      } finally {
        setRenameBusy(false)
      }
    },
    [renameAnchor]
  )

  const cancelRenameSymbol = useCallback(() => {
    if (renameBusy) return
    setRenameAnchor(null)
    setRenameError(null)
    editorRef.current?.focus()
  }, [renameBusy])

  // ── AI diff decorations ──────────────────────────────────────────────
  // When aiBaselineContent is provided, compute a line diff against `value`
  // and highlight added lines in green + render removed lines as VIEW
  // ZONES between their neighbors. View zones reserve real vertical space
  // (unlike content widgets, which overlap adjacent lines).
  useEffect(() => {
    const editor = editorRef.current
    const monaco = monacoRef.current
    const decorations = diffDecorationsRef.current
    if (!editor || !monaco || !decorations) return

    // Clean up any previous view zones
    if (removedViewZoneIdsRef.current.length > 0) {
      editor.changeViewZones((accessor) => {
        for (const id of removedViewZoneIdsRef.current) {
          accessor.removeZone(id)
        }
      })
      removedViewZoneIdsRef.current = []
    }

    if (!aiBaselineContent || aiBaselineContent === value) {
      decorations.clear()
      return
    }

    const ops = computeLineDiff(aiBaselineContent, value)
    const newDecorations: MonacoEditor.IModelDeltaDecoration[] = []
    let firstChangedLine: number | null = null
    let addedCount = 0
    let removedCount = 0

    // Collect removed-line zones first, then batch-add them so Monaco only
    // recomputes layout once.
    type PendingZone = { afterLineNumber: number; text: string }
    const pendingZones: PendingZone[] = []

    for (const op of ops) {
      if (op.type === "add") {
        addedCount++
        if (firstChangedLine === null) firstChangedLine = op.newLine
        const range: IRange = {
          startLineNumber: op.newLine,
          startColumn: 1,
          endLineNumber: op.newLine,
          endColumn: 1,
        }
        newDecorations.push({
          range,
          options: {
            isWholeLine: true,
            className: "ai-diff-added-line",
            linesDecorationsClassName: "ai-diff-added-gutter",
            marginClassName: "ai-diff-added-margin",
            overviewRuler: {
              color: "rgba(16, 185, 129, 0.7)",
              position: monaco.editor.OverviewRulerLane.Left,
            },
            minimap: {
              color: "rgba(16, 185, 129, 0.5)",
              position: monaco.editor.MinimapPosition.Inline,
            },
          },
        })
      } else if (op.type === "remove") {
        removedCount++
        // View zones attach AFTER a given line number. 0 means "before
        // line 1". We clamp to [0, lineCount] so trailing/leading removes
        // still render correctly.
        const lineCount = editor.getModel()?.getLineCount() ?? 1
        const afterLineNumber = Math.max(
          0,
          Math.min(op.beforeNewLine - 1, lineCount)
        )
        if (firstChangedLine === null) {
          firstChangedLine = Math.max(1, afterLineNumber)
        }
        pendingZones.push({ afterLineNumber, text: op.text })
      }
    }

    // Batch-add all view zones in a single layout pass
    if (pendingZones.length > 0) {
      editor.changeViewZones((accessor) => {
        for (const zone of pendingZones) {
          const dom = document.createElement("div")
          dom.className = "ai-diff-removed-widget"
          const marker = document.createElement("span")
          marker.className = "ai-diff-removed-marker"
          marker.textContent = "−"
          const content = document.createElement("span")
          content.className = "ai-diff-removed-content"
          content.textContent = zone.text || "\u00a0"
          dom.appendChild(marker)
          dom.appendChild(content)
          const id = accessor.addZone({
            afterLineNumber: zone.afterLineNumber,
            heightInLines: 1,
            domNode: dom,
          })
          removedViewZoneIdsRef.current.push(id)
        }
      })
    }

    decorations.set(newDecorations)

    // Scroll to the first change so the user sees what changed immediately
    if (firstChangedLine !== null) {
      editor.revealLineInCenterIfOutsideViewport(firstChangedLine)
    }

    // Expose counts for the status bar via a data attribute on the editor dom
    const dom = editor.getDomNode()
    if (dom) {
      dom.setAttribute("data-ai-diff-added", String(addedCount))
      dom.setAttribute("data-ai-diff-removed", String(removedCount))
    }
  }, [aiBaselineContent, value])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      const editor = editorRef.current
      if (!editor) return
      if (removedViewZoneIdsRef.current.length > 0) {
        editor.changeViewZones((accessor) => {
          for (const id of removedViewZoneIdsRef.current) {
            accessor.removeZone(id)
          }
        })
        removedViewZoneIdsRef.current = []
      }
      diffDecorationsRef.current?.clear()
      markerSubscriptionRef.current?.dispose()
      markerSubscriptionRef.current = null
    }
  }, [])

  const handleChange = useCallback(
    (val: string | undefined) => {
      onChange(val ?? "")
    },
    [onChange]
  )

  return (
    <>
      <Editor
        height="100%"
        path={editorModelUri(filePath)}
        language={language}
        value={value}
        theme={monacoTheme}
        beforeMount={workbench ? defineThemes : undefined}
        onChange={handleChange}
        onMount={handleMount}
        options={{
          fontSize: editorFontSize,
          fontFamily: monacoFontFamily,
          lineNumbers: editorLineNumbers ? "on" : "off",
          wordWrap: editorWordWrap ? "on" : "off",
          automaticLayout: true,
          minimap: { enabled: editorMinimap && isEditorActive, scale: 1 },
          stickyScroll: { enabled: editorStickyScroll },
          renderWhitespace: editorRenderWhitespace ? "boundary" : "none",
          inlayHints: { enabled: editorInlayHints ? "on" : "off" },
          scrollBeyondLastLine: false,
          padding: { top: 8 },
          smoothScrolling: isEditorActive,
          cursorBlinking: isEditorActive ? "smooth" : "blink",
          cursorSmoothCaretAnimation: isEditorActive ? "on" : "off",
          renderLineHighlight: isEditorActive ? "line" : "none",
          occurrencesHighlight: isEditorActive ? "singleFile" : "off",
          bracketPairColorization: { enabled: true },
          tabSize: 2,
          insertSpaces: true,
          formatOnPaste: true,
          suggest: { showWords: true },
          quickSuggestions: true,
        }}
        loading={
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Loading editor...
          </div>
        }
      />

      {widgetDom &&
        widgetAnchor &&
        createPortal(
          <InlineEditPopup
            selection={widgetAnchor.context.selection}
            isWholeFile={widgetAnchor.context.isWholeFile}
            initialInstruction={widgetAnchor.context.instruction}
            busy={widgetBusy}
            providers={inlineEditProviders ?? []}
            selectedModelId={inlineEditSelectedModelId ?? ""}
            selectedProviderId={inlineEditSelectedProviderId ?? ""}
            onSelectModel={onInlineEditModelChange}
            onSubmit={submitInlineEdit}
            onCancel={cancelInlineEdit}
          />,
          widgetDom
        )}

      {renameDom &&
        renameAnchor &&
        createPortal(
          <RenameSymbolPopup
            symbol={renameAnchor.symbol}
            busy={renameBusy}
            error={renameError}
            onSubmit={submitRenameSymbol}
            onCancel={cancelRenameSymbol}
          />,
          renameDom
        )}
    </>
  )
}
