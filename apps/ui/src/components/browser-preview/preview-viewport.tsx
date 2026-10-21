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
import { parsePreviewPageMessage, readIframeEnvelope } from "./preview-messages"
import type {
  ConsoleLog,
  DomNode,
  ElectronWebviewElement,
  ElectronWebviewIpcEvent,
  SelectedElement,
} from "./types"
import { hasElectronApi } from "@/services/ipc-facade"

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
  /**
   * The page's title, and its first favicon URL, as the guest reports them.
   * Webview only; the iframe fallback never reports.
   */
  onPageInfo?: (info: { title?: string; favicon?: string | null }) => void
  /**
   * The user agent the page should see (a tablet or phone preset), or null
   * for the guest's own. Webview only; changing it reloads the page.
   */
  userAgent?: string | null
  onLoadingChange?: (loading: boolean) => void
  onElementSelected?: (el: SelectedElement) => void
  onDomTree?: (tree: DomNode | null) => void
  /** Batched console entries to APPEND (already timestamped). */
  onConsoleEntries?: (entries: ConsoleLog[]) => void
  /** Keyboard shortcuts forwarded from the preload (zoom-in, reload-page, …). */
  onShortcut?: (shortcut: string) => void
  /** Canvas owns the transform; guest page zoom stays at 100% in its own session. */
  canvas?: boolean
  /**
   * The guest's webContents id once the webview attaches, and null when its
   * guest is destroyed. Electron only; the iframe fallback never reports.
   */
  onGuestChange?: (webContentsId: number | null) => void
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
    onPageInfo,
    userAgent = null,
    onLoadingChange,
    onElementSelected,
    onDomTree,
    onConsoleEntries,
    onShortcut,
    canvas = false,
    onGuestChange,
  },
  ref
) {
  const webviewRef = useRef<ElectronWebviewElement>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const isElectron = hasElectronApi()
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
    onPageInfo,
    onGuestChange,
  })
  callbacksRef.current = {
    onLoadingChange,
    onElementSelected,
    onDomTree,
    onConsoleEntries,
    onShortcut,
    onNavigate,
    onPageInfo,
    onGuestChange,
  }

  // The guest's own user agent, read once before a preset replaces it.
  const userAgentRef = useRef(userAgent)
  userAgentRef.current = userAgent
  const defaultUserAgentRef = useRef<string | null>(null)
  const applyUserAgent = useCallback((wv: ElectronWebviewElement) => {
    try {
      if (!wv.getUserAgent || !wv.setUserAgent) return
      defaultUserAgentRef.current ??= wv.getUserAgent()
      const target = userAgentRef.current ?? defaultUserAgentRef.current
      if (!target || wv.getUserAgent() === target) return
      wv.setUserAgent(target)
      wv.reload()
    } catch {
      // Not attached yet; dom-ready applies it.
    }
  }, [])
  useEffect(() => {
    if (isElectron && webviewRef.current) applyUserAgent(webviewRef.current)
  }, [applyUserAgent, isElectron, userAgent])

  // Validate + dispatch bc-* messages from either transport ("bc-" prefixed
  // via iframe postMessage, bare channel via webview ipc-message). The page
  // is untrusted: anything that does not parse is dropped here.
  const handleBcMessage = useCallback((type: string, data: unknown) => {
    const message = parsePreviewPageMessage(type, data)
    if (!message) return
    const cbs = callbacksRef.current
    switch (message.kind) {
      case "console":
        cbs.onConsoleEntries?.(message.entries)
        break
      case "dom-tree":
        cbs.onDomTree?.(message.tree)
        break
      case "element-selected":
        cbs.onElementSelected?.(message.element)
        break
      case "shortcut":
        cbs.onShortcut?.(message.shortcut)
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
      const envelope = readIframeEnvelope(e.data as unknown)
      if (envelope) handleBcMessage(envelope.type, envelope.data)
    }
    window.addEventListener("message", onMsg)
    return () => window.removeEventListener("message", onMsg)
  }, [handleBcMessage, iframeTargetOrigin, isElectron])

  // Webview setup — preload bridge + ipc-message events (Cursor architecture)
  useEffect(() => {
    if (!isElectron) return
    const wv = webviewRef.current
    if (!wv) return

    // Hosts key per-guest buffers by this id; report it once it exists and
    // retract it when the guest dies, so those buffers can be dropped.
    let guestId: number | null = null
    const reportGuest = () => {
      let id: number | null = null
      try {
        const value = wv.getWebContentsId?.()
        id = typeof value === "number" ? value : null
      } catch {
        // Thrown until the webview is attached.
      }
      if (id === null || id === guestId) return
      guestId = id
      callbacksRef.current.onGuestChange?.(id)
    }
    const onDestroyed = () => {
      if (guestId === null) return
      guestId = null
      callbacksRef.current.onGuestChange?.(null)
    }

    const onDomReady = () => {
      reportGuest()
      applyUserAgent(wv)
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

    const onTitle = (event: Event) => {
      const title = (event as Event & { title?: unknown }).title
      if (typeof title === "string")
        callbacksRef.current.onPageInfo?.({ title })
    }
    const onFavicon = (event: Event) => {
      const favicons = (event as Event & { favicons?: unknown }).favicons
      const first = Array.isArray(favicons)
        ? favicons.find(
            (entry): entry is string =>
              typeof entry === "string" && entry.startsWith("https://")
          )
        : undefined
      callbacksRef.current.onPageInfo?.({ favicon: first ?? null })
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

    wv.addEventListener("did-attach", reportGuest)
    wv.addEventListener("destroyed", onDestroyed)
    wv.addEventListener("dom-ready", onDomReady)
    wv.addEventListener("ipc-message", onIpcMessage)
    wv.addEventListener("did-navigate", onNavigation)
    wv.addEventListener("did-navigate-in-page", onNavigation)
    wv.addEventListener("page-title-updated", onTitle)
    wv.addEventListener("page-favicon-updated", onFavicon)

    return () => {
      wv.removeEventListener("did-attach", reportGuest)
      wv.removeEventListener("destroyed", onDestroyed)
      wv.removeEventListener("dom-ready", onDomReady)
      wv.removeEventListener("ipc-message", onIpcMessage)
      wv.removeEventListener("did-navigate", onNavigation)
      wv.removeEventListener("did-navigate-in-page", onNavigation)
      wv.removeEventListener("page-title-updated", onTitle)
      wv.removeEventListener("page-favicon-updated", onFavicon)
    }
  }, [isElectron, handleBcMessage, canvas, applyUserAgent])

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
