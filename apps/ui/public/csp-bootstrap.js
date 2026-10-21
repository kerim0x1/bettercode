// Narrows the Content-Security-Policy before the application module runs
// (see the comment above the CSP <meta> in index.html). Loaded as a classic,
// parser-blocking script from the bundle's own origin, so the policy needs
// no 'unsafe-inline' or hash for it.
;(() => {
  const loopback =
    "'self' http://127.0.0.1:* ws://127.0.0.1:* http://localhost:* ws://localhost:*"
  // Deepgram is the only renderer-owned external transport. Keep this
  // exact instead of reopening the broad `wss:` ceiling.
  const appServices = "wss://api.deepgram.com"
  let connectSources = `${loopback} ${appServices}`
  try {
    // When the backend serves this bundle directly, HTTP and WebSocket
    // stay on the page's exact origin. Add only that matching socket
    // origin; the server still enforces pairing + origin checks.
    if (location.protocol === "http:" || location.protocol === "https:") {
      const sameOriginSocket = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`
      connectSources += ` ${location.origin} ${sameOriginSocket}`
    }
    if (localStorage.getItem("betterc0de.backend.mode") === "remote_http") {
      const base = new URL(localStorage.getItem("betterc0de.remote.baseUrl") || "")
      const loopbackHost = ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)
      if (base.protocol === "https:" || loopbackHost) {
        const explicitWs = localStorage.getItem("betterc0de.remote.wsUrl")
        const websocket = explicitWs
          ? new URL(explicitWs)
          : new URL(base.toString().replace(/^http/, "ws"))
        const credentialOrigin = new URL(websocket)
        credentialOrigin.protocol = credentialOrigin.protocol === "wss:" ? "https:" : "http:"
        if (credentialOrigin.origin === base.origin) {
          connectSources += ` ${base.origin} ${websocket.origin}`
        }
      }
    }
  } catch {
    // Invalid persisted configuration remains restricted to loopback.
  }
  let directives = `connect-src ${connectSources};`
  // The desktop renderer (its preload exposes electronAPI before any page
  // script runs) holds privileged IPC: from here on only the bundle's own
  // scripts may run, and it frames only its own content. worker-src is
  // restated because it would otherwise fall back to this policy's
  // script-src and refuse blob: workers.
  if (window.electronAPI) {
    directives +=
      " script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; frame-src 'self' blob:;"
  }
  const policy = document.createElement("meta")
  policy.httpEquiv = "Content-Security-Policy"
  policy.content = directives
  document.head.append(policy)
})()
