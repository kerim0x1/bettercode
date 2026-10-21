// [REFACTOR] Extracted from browser-preview-panel.tsx — the bare preview
// transport (webview under Electron, sandboxed iframe fallback) plus the
// host↔page message bridge. Owns NO chrome: no toolbar, no inspector, no
// console UI. Consumed by the editor's BrowserPreviewPanel and the
// design-mode canvas artboard.

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from "react"

import { cn } from "@/lib/utils"
import { toFileUrl } from "@/lib/asset-url"
import { PreviewSelectionOverlay } from "./preview-selection-overlay"
import { forwardCanvasWheel } from "./canvas-gesture"
import { INJECT_SCRIPT_WEBVIEW, buildIframeInjectScript } from "./inject-script"
import type {
  ConsoleLog,
  DomNode,
  ElectronWebviewElement,
  ElectronWebviewIpcEvent,
  SelectedElement,
} from "./types"

/** Imperative surface for hosts (reload, style pushes, page-level zoom …). */
export interface PreviewViewportHandle {
  /** Reload the current webview/iframe document without replacing the guest. */
  reload(): void
  /** Post a bc-* command (bc-apply-style / bc-highlight) into the page. */
  postToPreview(msg: Record<string, unknown>): void
  /** Reveal an element in the page. */
  highlight(selector: string): void
  /** Run JS in the page (webview only; resolves undefined on iframe). */
  executeJavaScript(code: string): Promise<unknown>
  /** Open the guest devtools (webview only). */
  openDevTools(): void
  /** Guest-page history (webview only) — distinct from host URL history. */
  goBackInPage(): void
  goForwardInPage(): void
  /** Page-content zoom via webview.setZoomLevel (webview only). */
  pageZoomIn(): void
  pageZoomOut(): void
  pageZoomReset(): void
  /**
   * The guest's webContents id once the webview is attached (null before,
   * and always on the iframe fallback). The shell keys its request log by it.
   */
  getWebContentsId(): number | null
}

interface PreviewViewportProps {
  url: string
  className?: string
  /**
   * When false the wrapper gets pointer-events:none so all pointer/wheel
   * input falls through to the host (canvas hand-tool / space-drag mode).
   */
  interactive?: boolean
  selectionMode?: boolean
  onSelectionExit?: () => void
  onNavigate?: (
    url: string,
    history: { back: boolean; forward: boolean }
  ) => void
  onLoadingChange?: (loading: boolean) => void
  onElementSelected?: (el: SelectedElement) => void
  onDomTree?: (tree: DomNode | null) => void
  /** Batched console entries to APPEND (already timestamped). */
  onConsoleEntries?: (entries: ConsoleLog[]) => void
  /** Keyboard shortcuts forwarded from the preload (zoom-in, reload-page, …). */
  onShortcut?: (shortcut: string) => void
  /** Canvas owns the transform; guest page zoom stays at 100% in its own session. */
  canvas?: boolean
}

export const PreviewViewport = forwardRef<
  PreviewViewportHandle,
  PreviewViewportProps
>(function PreviewViewport(
  {
    url,
    className,
    interactive = true,
    selectionMode = false,
    onSelectionExit,
    onNavigate,
    onLoadingChange,
    onElementSelected,
    onDomTree,
    onConsoleEntries,
    onShortcut,
    canvas = false,
  },
  ref
) {
  const webviewRef = useRef<ElectronWebviewElement>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const isElectron = !!window.electronAPI
  const electronPreloadPath = window.__BETTERC0DE__?.electronPath
  const webviewPreload = electronPreloadPath
    ? toFileUrl(`${electronPreloadPath}/browser-preview-preload.cjs`)
    : ""

  const iframeTargetOrigin = useMemo(() => {
    try {
      return new URL(url).origin
    } catch {
      return "*"
    }
  }, [url])

  // Keep callbacks in refs so the webview/iframe listeners never re-bind on
  // parent re-renders (re-attaching webview listeners mid-navigation is racy).
  const callbacksRef = useRef({
    onLoadingChange,
    onElementSelected,
    onDomTree,
    onConsoleEntries,
    onShortcut,
    onNavigate,
  })
  callbacksRef.current = {
    onLoadingChange,
    onElementSelected,
    onDomTree,
    onConsoleEntries,
    onShortcut,
    onNavigate,
  }

  // Normalize + dispatch bc-* messages from either transport ("bc-" prefixed
  // via iframe postMessage, bare channel via webview ipc-message).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleBcMessage = useCallback((type: string, data: any) => {
    const ch = type.startsWith("bc-") ? type.slice(3) : type
    const cbs = callbacksRef.current
    switch (ch) {
      case "console":
        cbs.onConsoleEntries?.([
          { level: data.level, message: data.message, timestamp: new Date() },
        ])
        break
      case "console-batch":
        cbs.onConsoleEntries?.(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (data.entries || []).map((e: any) => ({
            level: e.level,
            message: e.message,
            timestamp: new Date(),
          }))
        )
        break
      case "dom-tree":
        cbs.onDomTree?.(data.tree || null)
        break
      case "element-selected":
        cbs.onElementSelected?.(data as SelectedElement)
        break
      case "did-keydown":
        if (
          (data?.key === "Control" && data.ctrlKey === true) ||
          (data?.key === "Meta" && data.metaKey === true)
        )
          cbs.onShortcut?.("canvas-zoom-start")
        else if (
          data?.key === "Alt" &&
          data.altKey === true &&
          !data.ctrlKey &&
          !data.metaKey
        )
          cbs.onShortcut?.("canvas-pan-start")
        break
    }
  }, [])

  // Listen for postMessage (iframe fallback)
  useEffect(() => {
    function onMsg(e: MessageEvent) {
      if (isElectron) return
      if (
        !iframeRef.current?.contentWindow ||
        e.source !== iframeRef.current.contentWindow
      )
        return
      if (
        iframeTargetOrigin !== "*" &&
        e.origin !== iframeTargetOrigin &&
        e.origin !== "null"
      )
        return
      if (e.data?.type?.startsWith("bc-"))
        handleBcMessage(e.data.type, e.data.data || e.data)
    }
    window.addEventListener("message", onMsg)
    return () => window.removeEventListener("message", onMsg)
  }, [handleBcMessage, iframeTargetOrigin, isElectron])

  // Webview setup — preload bridge + ipc-message events (Cursor architecture)
  useEffect(() => {
    if (!isElectron) return
    const wv = webviewRef.current
    if (!wv) return

    const onDomReady = () => {
      if (canvas) wv.setZoomFactor(1)
      callbacksRef.current.onLoadingChange?.(false)
      // Inject the inspector script (uses window.cursorBrowser.send exposed by preload)
      wv.executeJavaScript(INJECT_SCRIPT_WEBVIEW).catch(() => {
        /* Expected: webview may not be ready for JS injection */
      })
    }
    const onNavigation = (event: Event) => {
      const nextUrl = (event as Event & { url?: string }).url
      if (nextUrl && /^(?:https?|betterc0de-html):\/\//.test(nextUrl))
        callbacksRef.current.onNavigate?.(nextUrl, {
          back: wv.canGoBack(),
          forward: wv.canGoForward(),
        })
    }

    const onIpcMessage = ((e: ElectronWebviewIpcEvent) => {
      if (e.channel === "canvas-wheel" && canvas) {
        forwardCanvasWheel(wv, e.args?.[0])
        return
      }
      if (e.channel === "keyboard-shortcut") {
        const shortcut = (e.args?.[0] as { shortcut?: string })?.shortcut
        if (shortcut) callbacksRef.current.onShortcut?.(shortcut)
        return
      }
      if (e.channel) handleBcMessage(e.channel, e.args?.[0])
    }) as unknown as EventListener

    wv.addEventListener("dom-ready", onDomReady)
    wv.addEventListener("ipc-message", onIpcMessage)
    wv.addEventListener("did-navigate", onNavigation)
    wv.addEventListener("did-navigate-in-page", onNavigation)

    return () => {
      wv.removeEventListener("dom-ready", onDomReady)
      wv.removeEventListener("ipc-message", onIpcMessage)
      wv.removeEventListener("did-navigate", onNavigation)
      wv.removeEventListener("did-navigate-in-page", onNavigation)
    }
  }, [isElectron, handleBcMessage, canvas])

  // iframe fallback injection
  const handleIframeLoad = useCallback(() => {
    callbacksRef.current.onLoadingChange?.(false)
    try {
      const doc = iframeRef.current?.contentDocument
      if (doc) {
        const s = doc.createElement("script")
        s.textContent = buildIframeInjectScript(window.location.origin)
        doc.head.appendChild(s)
      }
    } catch {
      /* cross-origin */
    }
  }, [])

  const postToPreview = useCallback(
    (msg: Record<string, unknown>) => {
      if (isElectron && webviewRef.current) {
        webviewRef.current
          .executeJavaScript(`window.postMessage(${JSON.stringify(msg)}, '*')`)
          .catch(() => {
            /* Expected: webview may have navigated away */
          })
        return
      }
      iframeRef.current?.contentWindow?.postMessage(msg, iframeTargetOrigin)
    },
    [iframeTargetOrigin, isElectron]
  )

  const execute = useCallback(async (code: string) => {
    try {
      return await webviewRef.current?.executeJavaScript(code)
    } catch {
      return undefined
    }
  }, [])

  useImperativeHandle(
    ref,
    (): PreviewViewportHandle => ({
      reload() {
        if (isElectron && webviewRef.current) {
          webviewRef.current.reload()
        } else if (iframeRef.current) {
          // Reassigning src also works cross-origin. An about:blank detour can
          // race guest loading and leave a device blank after a group refresh.
          iframeRef.current.setAttribute("src", iframeRef.current.src)
        }
      },
      postToPreview,
      highlight(selector: string) {
        postToPreview({ type: "bc-highlight", selector })
      },
      executeJavaScript(code: string) {
        if (isElectron && webviewRef.current) {
          return webviewRef.current
            .executeJavaScript(code)
            .catch(() => undefined)
        }
        return Promise.resolve(undefined)
      },
      openDevTools() {
        if (isElectron) webviewRef.current?.openDevTools()
      },
      goBackInPage() {
        if (isElectron) webviewRef.current?.goBack()
      },
      goForwardInPage() {
        if (isElectron) webviewRef.current?.goForward()
      },
      pageZoomIn() {
        const wv = webviewRef.current
        if (isElectron && wv) wv.setZoomLevel((wv.getZoomLevel?.() || 0) + 0.5)
      },
      pageZoomOut() {
        const wv = webviewRef.current
        if (isElectron && wv) wv.setZoomLevel((wv.getZoomLevel?.() || 0) - 0.5)
      },
      pageZoomReset() {
        if (isElectron) webviewRef.current?.setZoomLevel(0)
      },
      getWebContentsId() {
        if (!isElectron) return null
        try {
          const id = webviewRef.current?.getWebContentsId?.()
          return typeof id === "number" ? id : null
        } catch {
          // Thrown until the webview is attached.
          return null
        }
      },
    }),
    [isElectron, postToPreview]
  )

  return (
    <div
      className={cn(
        "relative size-full overflow-hidden",
        !interactive && "pointer-events-none",
        className
      )}
    >
      {isElectron ? (
        <webview
          tabIndex={selectionMode ? -1 : 0}
          ref={webviewRef as React.RefObject<HTMLWebViewElement>}
          src={url}
          className="size-full border-0 bg-background"
          style={{ display: "inline-flex" }}
          preload={webviewPreload || undefined}
          partition={
            canvas
              ? "betterc0de-canvas-preview"
              : window.__BETTERC0DE__?.previewPartition || "betterc0de-preview"
          }
        />
      ) : (
        <iframe
          ref={iframeRef}
          // `bg-background` matches the surrounding muted canvas so
          // pages with transparent or still-loading content don't
          // flash a bright white "border" against the dark UI. The
          // loaded page paints its own background on top; if it
          // doesn't, we stay in the app's color space instead of
          // blinding the user with #fff.
          className="size-full border-0 bg-background"
          // No `allow-same-origin`. In non-Electron dev mode the
          // renderer at e.g. http://localhost:5173 is reachable via
          // the URL bar; with `allow-same-origin` the iframe would
          // share that origin and could read `window.top.localStorage`
          // (where the bearer token may live). Cross-origin previews
          // are unaffected — iframes in their own origin already get
          // an opaque view of the renderer regardless of this flag,
          // and `postMessage` (the integration path) doesn't need it.
          // Electron uses <webview> above, which is OS-process isolated.
          sandbox="allow-scripts allow-forms allow-popups allow-presentation"
          src={url || undefined}
          title="Browser Preview"
          onLoad={handleIframeLoad}
        />
      )}
      {isElectron && selectionMode && (
        <PreviewSelectionOverlay
          execute={execute}
          onSelect={onElementSelected}
          onExit={onSelectionExit}
        />
      )}
    </div>
  )
})
