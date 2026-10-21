import type * as Monaco from "monaco-editor"
import type { AppliedCustomTheme } from "@/lib/vscode-theme"

/** Named themes keep the editor surface independent of the file modal. */
export function defineWorkbenchThemes(monaco: typeof Monaco) {
  monaco.editor.defineTheme("betterc0de-editor-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "6A9955" },
      { token: "keyword", foreground: "C586C0" },
      { token: "string", foreground: "CE9178" },
      { token: "number", foreground: "B5CEA8" },
      { token: "type", foreground: "4EC9B0" },
      { token: "tag", foreground: "569CD6" },
      { token: "attribute.name", foreground: "9CDCFE" },
      { token: "attribute.value", foreground: "CE9178" },
      { token: "string.key.json", foreground: "9CDCFE" },
      { token: "string.value.json", foreground: "CE9178" },
      { token: "keyword.json", foreground: "569CD6" },
    ],
    // The code panel is a card like the agent chat, so the editor matches
    // the default dark `--background` (#0f0f0f), not the shell around it.
    colors: {
      "editor.background": "#0f0f0f",
      "editorGutter.background": "#0f0f0f",
      "editorLineNumber.foreground": "#626262",
      "editorLineNumber.activeForeground": "#c8c8c8",
      "editor.lineHighlightBackground": "#ffffff06",
      "editor.selectionBackground": "#ffffff24",
      "editor.inactiveSelectionBackground": "#ffffff14",
      "editorIndentGuide.background1": "#ffffff0d",
      "editorIndentGuide.activeBackground1": "#ffffff25",
      "editorWidget.background": "#1a1a1a",
      "editorWidget.border": "#ffffff18",
      "editorStickyScroll.background": "#0f0f0f",
      "minimap.background": "#0f0f0f",
      "scrollbarSlider.background": "#ffffff12",
      "scrollbarSlider.hoverBackground": "#ffffff24",
    },
  })
  monaco.editor.defineTheme("betterc0de-editor-light", {
    base: "vs",
    inherit: true,
    rules: [
      { token: "comment", foreground: "008000" },
      { token: "keyword", foreground: "0000FF" },
      { token: "string", foreground: "A31515" },
      { token: "number", foreground: "098658" },
      { token: "type", foreground: "267F99" },
      { token: "tag", foreground: "800000" },
      { token: "attribute.name", foreground: "E50000" },
      { token: "attribute.value", foreground: "0000FF" },
      { token: "string.key.json", foreground: "0451A5" },
      { token: "string.value.json", foreground: "A31515" },
      { token: "keyword.json", foreground: "0000FF" },
    ],
    colors: {
      "editor.background": "#ffffff",
      "editorGutter.background": "#ffffff",
      "editorLineNumber.foreground": "#9a9a9a",
      "editor.lineHighlightBackground": "#00000004",
      "editor.selectionBackground": "#00000014",
      "editorIndentGuide.background1": "#0000000b",
      "editorStickyScroll.background": "#ffffff",
      "minimap.background": "#ffffff",
    },
  })
}

/**
 * Registers an imported VS Code theme under a per-theme name. Monaco
 * validates nothing beyond the shape, so the conversion in
 * `lib/vscode-theme.ts` already reduced the scopes and color ids to what
 * the standalone editor understands. The workbench surfaces around the
 * editor (gutter, sticky scroll, minimap) follow the editor background when
 * the theme did not name them, matching how the built-in themes are set up.
 */
export function defineCustomWorkbenchTheme(
  monaco: typeof Monaco,
  theme: AppliedCustomTheme
) {
  const background = theme.monaco.colors["editor.background"]
  const colors: Record<string, string> = { ...theme.monaco.colors }
  if (background) {
    for (const key of [
      "editorGutter.background",
      "editorStickyScroll.background",
      "minimap.background",
    ]) {
      if (!colors[key]) colors[key] = background
    }
  }
  monaco.editor.defineTheme(`betterc0de-editor-custom-${theme.id}`, {
    base: theme.monaco.base,
    inherit: theme.monaco.inherit,
    rules: theme.monaco.rules,
    colors,
  })
}
