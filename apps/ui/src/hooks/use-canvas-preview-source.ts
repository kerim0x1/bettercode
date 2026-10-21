import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useChatStore } from "@/lib/chat-store"
import type { ThreadSettings } from "@/lib/chat/types"
import {
  readPreviewSource,
  type CanvasPreviewSource,
} from "@/lib/canvas-preview-source"
import type { useDevServer } from "./use-dev-server"
import { getElectronApi } from "@/services/ipc-facade"

type HtmlState = { key: string; url: string | null; error: string | null }

export function useCanvasPreviewSource(
  threadId: string,
  projectPath: string | null,
  settings: ThreadSettings | undefined,
  dev: ReturnType<typeof useDevServer>
) {
  const source = useMemo(
    () =>
      readPreviewSource(
        settings?.designPreviewSource,
        settings?.designPreviewUrl
      ),
    [settings?.designPreviewSource, settings?.designPreviewUrl]
  )
  const [html, setHtml] = useState<HtmlState | null>(null)
  const [picker, setPicker] = useState<{ busy: boolean; error: string | null }>(
    { busy: false, error: null }
  )
  const operation = useRef(0)
  const relativePath = source.kind === "html" ? source.relativePath : null
  const htmlKey = JSON.stringify([threadId, projectPath, relativePath])

  useEffect(() => {
    let cancelled = false
    const pendingOperation = operation
    // A changed project/source invalidates any outstanding native file picker.
    operation.current++
    setPicker({ busy: false, error: null })
    if (relativePath) {
      const api = getElectronApi()
      if (!api?.openHtmlPreview || !projectPath) {
        setHtml({
          key: htmlKey,
          url: null,
          error: !projectPath
            ? "Attach a project folder to preview HTML."
            : "Open this project in the desktop app to preview local HTML.",
        })
      } else {
        void api
          .openHtmlPreview({ projectPath, relativePath })
          .then((result) => {
            if (!cancelled && result.status === "ready")
              setHtml({ key: htmlKey, url: result.url, error: null })
          })
          .catch((error: unknown) => {
            if (!cancelled)
              setHtml({
                key: htmlKey,
                url: null,
                error:
                  error instanceof Error
                    ? error.message
                    : "Could not open this HTML file.",
              })
          })
      }
    }
    return () => {
      cancelled = true
      pendingOperation.current++
    }
  }, [threadId, projectPath, relativePath, htmlKey, source.kind])

  const select = useCallback(
    (next: CanvasPreviewSource) => {
      operation.current++
      setPicker({ busy: false, error: null })
      useChatStore
        .getState()
        .setThreadSetting(threadId, "designPreviewSource", next)
    },
    [threadId]
  )

  const chooseHtml = useCallback(async () => {
    const desktopBridge = getElectronApi()
    if (!projectPath || !desktopBridge?.openHtmlPreview) return
    const version = ++operation.current
    setPicker({ busy: true, error: null })
    try {
      const result = await desktopBridge.openHtmlPreview({ projectPath })
      if (operation.current !== version) return
      if (result.status === "ready") {
        setHtml({
          key: JSON.stringify([threadId, projectPath, result.relativePath]),
          url: result.url,
          error: null,
        })
        select({ kind: "html", relativePath: result.relativePath })
      }
      setPicker({ busy: false, error: null })
    } catch (error: unknown) {
      if (operation.current === version)
        setPicker({
          busy: false,
          error:
            error instanceof Error
              ? error.message
              : "Could not open this HTML file.",
        })
    }
  }, [projectPath, threadId, select])

  const { probe, status: serverStatus } = dev
  const manualUrl = source.kind === "url" ? source.url : null
  useEffect(() => {
    if (
      serverStatus === "idle" &&
      manualUrl &&
      /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::|\/)/i.test(manualUrl)
    )
      void probe(manualUrl)
  }, [serverStatus, probe, manualUrl])

  const currentHtml = html?.key === htmlKey ? html : null
  const url =
    source.kind === "url"
      ? source.url
      : source.kind === "server"
        ? dev.url
        : (currentHtml?.url ?? null)
  return {
    source,
    url,
    select,
    chooseHtml,
    busy: picker.busy,
    error:
      picker.error ??
      (source.kind === "html" ? (currentHtml?.error ?? null) : null),
    resolving: source.kind === "html" && !currentHtml,
    canChooseHtml: Boolean(projectPath && getElectronApi()?.openHtmlPreview),
  }
}
