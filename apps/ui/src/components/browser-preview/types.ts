// [REFACTOR] Extracted from browser-preview-panel.tsx — shared types for the
// browser-preview subtree. No runtime code here.

/** Serialized DOM node forwarded from the previewed page to the inspector tree. */
export interface DomNode {
  tag: string
  id: string
  classes: string[]
  selector: string
  text: string
  children: DomNode[]
}

/** One line in the captured console panel. */
export interface ConsoleLog {
  level: "log" | "warn" | "error"
  message: string
  timestamp: Date
}

/** A CSS property edit, buffered until the user sends the batch to chat. */
export interface CssChange {
  selector: string
  property: string
  oldValue: string
  newValue: string
}

/** Element currently selected in the preview for inspection / style editing. */
export interface SelectedElement {
  url?: string
  label?: string
  viewport?: { width: number; height: number }
  selector: string
  tagName: string
  id: string
  className: string
  text: string
  childCount: number
  styles: Record<string, string>
  rect: { x: number; y: number; w: number; h: number }
}

/**
 * Electron <webview> element with its IPC/navigation methods. Uses
 * intersection rather than `extends HTMLElement` so the Electron-specific
 * `addEventListener` narrowing doesn't conflict with the DOM
 * `addEventListener<K extends keyof HTMLElementEventMap>` overload.
 */
export type ElectronWebviewElement = HTMLElement & {
  executeJavaScript(code: string): Promise<unknown>
  reload(): void
  goBack(): void
  goForward(): void
  canGoBack(): boolean
  canGoForward(): boolean
  openDevTools(): void
  getZoomLevel?(): number
  setZoomLevel(level: number): void
  setZoomFactor(factor: number): void
  getZoomFactor(): number
  getURL(): string
  /** The guest's webContents id; how the shell attributes its requests. */
  getWebContentsId?(): number
  getUserAgent?(): string
  setUserAgent?(userAgent: string): void
}

export interface ElectronWebviewIpcEvent {
  channel: string
  args: unknown[]
}
