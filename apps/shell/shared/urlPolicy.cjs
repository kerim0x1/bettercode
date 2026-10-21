const path = require('path')
const { fileURLToPath } = require('url')

function isLoopbackHost(hostname) {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]'
  )
}

function isPathInside(rootPath, candidatePath) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/** Trust only the renderer entrypoint BetterC0de itself loaded. */
function isTrustedRendererUrl(rawUrl, policy) {
  if (!rawUrl || !policy) return false

  if (policy.isPackaged) {
    if (!policy.packagedRendererRoot) return false
    try {
      const parsed = new URL(rawUrl)
      return parsed.protocol === 'file:'
        && isPathInside(policy.packagedRendererRoot, fileURLToPath(parsed))
    } catch {
      return false
    }
  }

  try {
    const url = new URL(rawUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    if (!isLoopbackHost(url.hostname) || !policy.devRendererOrigin) return false
    return url.origin === new URL(policy.devRendererOrigin).origin
  } catch {
    return false
  }
}

function isTrustedRendererContents(contents, policy) {
  return !!contents
    && policy?.trustedWebContentsIds instanceof Set
    && policy.trustedWebContentsIds.has(contents.id)
}

function isTrustedRendererPermission(contents, details, policy) {
  return isTrustedRendererContents(contents, policy)
    && !contents.isDestroyed()
    && details?.isMainFrame === true
    && isTrustedRendererUrl(contents.getURL(), policy)
    && isTrustedRendererUrl(details.requestingUrl, policy)
}

function assertTrustedIpcSender(event, channel, policy) {
  const sender = event?.sender
  const senderFrame = event?.senderFrame
  const senderUrl = event?.senderFrame?.url || event?.sender?.getURL?.() || ''
  const isMainFrame = !!senderFrame
    && (!sender?.mainFrame || senderFrame === sender.mainFrame)
    && !senderFrame.parent
  if (
    !isTrustedRendererContents(sender, policy)
    || !isMainFrame
    || !isTrustedRendererUrl(senderUrl, policy)
  ) {
    throw new Error(`Rejected IPC from untrusted sender for ${channel}`)
  }
}

/**
 * `webRequest` listeners are session-wide, so URL filtering alone is not a
 * trust boundary. Require a registered app renderer's main frame as source.
 */
function isTrustedRendererRequest(details, policy) {
  const contents = details?.webContents
  const contentsId = details?.webContentsId ?? contents?.id
  if (
    !(policy?.trustedWebContentsIds instanceof Set)
    || !policy.trustedWebContentsIds.has(contentsId)
  ) {
    return false
  }

  const frame = details?.frame
  if (!frame || frame.parent) return false
  if (contents?.mainFrame && frame !== contents.mainFrame) return false
  return isTrustedRendererUrl(frame.url || '', policy)
}

function isAllowedExternalUrl(rawUrl, isPackaged) {
  try {
    const parsed = new URL(rawUrl)
    if (parsed.protocol === 'https:') return true
    return !isPackaged && parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname)
  } catch {
    return false
  }
}

function isAllowedNavigationUrl(rawUrl, policy) {
  if (!rawUrl || rawUrl === 'about:blank') return true
  return isTrustedRendererUrl(rawUrl, policy)
}

// Host page of the chat's visual replies (apps/ui/public/visual-reply-frame.html).
// The chat frames it in <iframe sandbox="allow-scripts">, and it shows an
// agent's page in a nested sandboxed frame.
const VISUAL_REPLY_FRAME_FILE = 'visual-reply-frame.html'

function isVisualReplyFrameUrl(rawUrl, policy) {
  if (!isTrustedRendererUrl(rawUrl, policy)) return false
  try {
    return new URL(rawUrl).pathname.split('/').pop() === VISUAL_REPLY_FRAME_FILE
  } catch {
    return false
  }
}

/**
 * `will-frame-navigate` in an app window; the main frame is `will-navigate`'s
 * job. A frame that shows a visual reply runs an agent's page: it may reload
 * that page, never leave it for another app page, a file or a remote site.
 * Other frames keep what the renderer's Content-Security-Policy allows.
 */
function isAllowedFrameNavigation(details, policy) {
  if (!details || details.isMainFrame) return true
  let frameUrl = ''
  try {
    frameUrl = details.frame?.url || ''
  } catch {
    // The frame is gone; so is anything it could navigate.
    frameUrl = ''
  }
  if (!isVisualReplyFrameUrl(frameUrl, policy)) return true
  return isVisualReplyFrameUrl(String(details.url || ''), policy)
}

function isAllowedWebviewUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ||
      (parsed.protocol === 'betterc0de-html:' && /^[a-f0-9-]{36}$/.test(parsed.hostname))
  } catch {
    return false
  }
}

function forcePreviewPartition(webPreferences, params, partition) {
  webPreferences.partition = partition
  params.partition = partition
}

module.exports = {
  assertTrustedIpcSender,
  forcePreviewPartition,
  isAllowedExternalUrl,
  isAllowedFrameNavigation,
  isAllowedNavigationUrl,
  isAllowedWebviewUrl,
  isTrustedRendererRequest,
  isTrustedRendererPermission,
  isTrustedRendererUrl,
  isVisualReplyFrameUrl,
}
