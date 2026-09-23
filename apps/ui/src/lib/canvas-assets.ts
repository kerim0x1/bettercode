/**
 * Bytes for pictures pasted or dropped onto the canvas.
 *
 * They go to IndexedDB, not localStorage: one screenshot is bigger than the
 * whole 5 MB text quota, and a board is expected to hold several. The board
 * itself only stores the asset's id, so the JSON stays small and readable.
 */

const DB_NAME = "betterc0de-canvas"
const DB_VERSION = 1
const STORE = "assets"
/** Roughly a very large screenshot; past this a picture belongs in the repo. */
export const MAX_ASSET_BYTES = 24 * 1024 * 1024

export interface CanvasAsset {
  id: string
  blob: Blob
  name: string
  type: string
  addedAt: number
}

function database(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null)
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION)
    } catch {
      resolve(null)
      return
    }
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE))
        request.result.createObjectStore(STORE, { keyPath: "id" })
    }
    request.onsuccess = () => resolve(request.result)
    // A private window, a blocked origin or a corrupt store: the board still
    // works, pictures just cannot be kept.
    request.onerror = () => resolve(null)
    request.onblocked = () => resolve(null)
  })
}

function run<T>(
  store: IDBObjectStore,
  request: IDBRequest<T>
): Promise<T | null> {
  return new Promise((resolve) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(null)
    store.transaction.onabort = () => resolve(null)
  })
}

async function withStore<T>(
  mode: IDBTransactionMode,
  // Not named `use`: the React hooks lint rule reads that as the `use` hook.
  work: (store: IDBObjectStore) => Promise<T | null>
): Promise<T | null> {
  const db = await database()
  if (!db) return null
  try {
    const store = db.transaction(STORE, mode).objectStore(STORE)
    return await work(store)
  } catch {
    return null
  } finally {
    db.close()
  }
}

/** Stores the bytes and answers with the id the board should remember. */
export async function putCanvasAsset(
  blob: Blob,
  name: string
): Promise<string | null> {
  if (blob.size > MAX_ASSET_BYTES) return null
  const id = crypto.randomUUID()
  const asset: CanvasAsset = {
    id,
    blob,
    name,
    type: blob.type || "application/octet-stream",
    addedAt: Date.now(),
  }
  const stored = await withStore("readwrite", (store) =>
    run(store, store.put(asset))
  )
  return stored === null ? null : id
}

export async function getCanvasAsset(id: string): Promise<CanvasAsset | null> {
  const asset = await withStore("readonly", (store) =>
    run<CanvasAsset>(store, store.get(id) as IDBRequest<CanvasAsset>)
  )
  return asset?.blob ? asset : null
}

/**
 * Object URLs are handed out once per asset and kept for the session: the
 * same picture is often on screen, off screen and on screen again as the
 * board is panned, and re-reading it each time would flicker.
 */
const urls = new Map<string, Promise<string | null>>()

export function canvasAssetUrl(id: string): Promise<string | null> {
  const known = urls.get(id)
  if (known) return known
  const pending = getCanvasAsset(id).then((asset) =>
    asset ? URL.createObjectURL(asset.blob) : null
  )
  urls.set(id, pending)
  return pending
}

async function forgetUrl(id: string): Promise<void> {
  const pending = urls.get(id)
  urls.delete(id)
  const url = await pending
  if (url) URL.revokeObjectURL(url)
}

/**
 * Drops the pictures no object points at any more. Called after a board
 * change rather than on every delete, so an undo has a moment to put the
 * object back before its bytes go.
 */
export async function pruneCanvasAssets(
  keep: ReadonlySet<string>
): Promise<number> {
  const ids = await withStore("readonly", (store) =>
    run<IDBValidKey[]>(store, store.getAllKeys())
  )
  if (!ids) return 0
  const stale = ids.filter(
    (id): id is string => typeof id === "string" && !keep.has(id)
  )
  if (!stale.length) return 0
  await withStore("readwrite", async (store) => {
    for (const id of stale) await run(store, store.delete(id))
    return true
  })
  await Promise.all(stale.map(forgetUrl))
  return stale.length
}

/** How long a remote picture gets to answer before the board stops waiting. */
const MEASURE_TIMEOUT_MS = 5000

/**
 * The picture's own proportions, so a resize need not distort it. A remote
 * address that never answers must not hold up the paste, so the measurement
 * gives up and the object lands at the default box.
 */
export function readImageRatio(source: Blob | string): Promise<number | null> {
  return new Promise((resolve) => {
    if (typeof Image === "undefined") {
      resolve(null)
      return
    }
    const url =
      typeof source === "string" ? source : URL.createObjectURL(source)
    const image = new Image()
    let settled = false
    const done = (ratio: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (typeof source !== "string") URL.revokeObjectURL(url)
      resolve(ratio)
    }
    const timer = setTimeout(() => {
      image.src = ""
      done(null)
    }, MEASURE_TIMEOUT_MS)
    image.onload = () =>
      done(
        image.naturalHeight > 0
          ? image.naturalWidth / image.naturalHeight
          : null
      )
    image.onerror = () => done(null)
    image.src = url
  })
}
