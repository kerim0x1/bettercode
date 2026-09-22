import { useCallback, useEffect, useState } from "react"
import { canvasAssetUrl } from "@/lib/canvas-assets"
import type { CanvasEmbedObject } from "@/lib/canvas-objects"

/** The object URL for a stored picture, or null while it is being read. */
export function useCanvasAssetUrl(assetId: string | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!assetId) {
      setUrl(null)
      return
    }
    let live = true
    canvasAssetUrl(assetId).then((value) => {
      if (live) setUrl(value)
    })
    return () => {
      live = false
    }
  }, [assetId])
  return url
}

/**
 * A grant is issued per renderer and dies with it, so the same project+file
 * is asked for once per session and shared by every embed pointing at it.
 */
const grants = new Map<string, Promise<string>>()

function grantKey(projectPath: string, relativePath: string): string {
  return `${projectPath}\u0000${relativePath}`
}

async function openLocal(
  projectPath: string,
  relativePath: string
): Promise<string> {
  const api = window.electronAPI
  if (!api?.openHtmlPreview) {
    throw new Error("Local files can only be embedded in the desktop app.")
  }
  const result = await api.openHtmlPreview({ projectPath, relativePath })
  if (result.status !== "ready" || !result.url) {
    throw new Error("That file is no longer available in the project.")
  }
  return result.url
}

export interface EmbedSource {
  url: string | null
  error: string | null
  /** Bumped to force the guest to load again. */
  nonce: number
  reload: () => void
}

/** Resolves an embed to a URL the guest can load, web or local alike. */
export function useCanvasEmbedUrl(object: CanvasEmbedObject): EmbedSource {
  const [state, setState] = useState<{
    url: string | null
    error: string | null
  }>(() => ({
    url: object.source === "web" ? (object.url ?? null) : null,
    error: null,
  }))
  const [nonce, setNonce] = useState(0)
  const { source, url: webUrl, projectPath, relativePath } = object

  useEffect(() => {
    if (source === "web") {
      setState({ url: webUrl ?? null, error: null })
      return
    }
    if (!projectPath || !relativePath) {
      setState({ url: null, error: "This embed lost its file." })
      return
    }
    let live = true
    const key = grantKey(projectPath, relativePath)
    let pending = grants.get(key)
    if (!pending) {
      pending = openLocal(projectPath, relativePath)
      grants.set(key, pending)
      // A failed grant must not be cached, or a retry can never succeed.
      pending.catch(() => grants.delete(key))
    }
    pending.then(
      (value) => live && setState({ url: value, error: null }),
      (error: unknown) =>
        live &&
        setState({
          url: null,
          error:
            error instanceof Error ? error.message : "Could not open the file.",
        })
    )
    return () => {
      live = false
    }
  }, [source, webUrl, projectPath, relativePath, nonce])

  const reload = useCallback(() => {
    if (object.source === "local" && object.projectPath && object.relativePath)
      grants.delete(grantKey(object.projectPath, object.relativePath))
    setNonce((value) => value + 1)
  }, [object.source, object.projectPath, object.relativePath])

  return { ...state, nonce, reload }
}
