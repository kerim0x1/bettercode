import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import "./index.css"
import App from "./App.tsx"
import { ThemeProvider } from "@/components/theme-provider.tsx"
import { ConfirmProvider } from "@/components/dialogs/confirm-provider"
import { PromptProvider } from "@/components/dialogs/prompt-provider"
import { Toaster } from "@/components/ui/sonner"
import { ErrorBoundary } from "@/components/error-boundary"
import { logToErrorStore } from "@/lib/error-log-store"
import { createLogger } from "@/lib/logger"
import { RemoteAccessGate } from "@/components/remote/remote-access-gate"
import { prefetchStreamdownCodePlugin } from "@/components/ai-elements/streamdown-plugins"
import { initDesktopRuntimeConfig } from "@/services/backend/desktop-runtime-config"

const log = createLogger("window")

// Desktop: backend port and preview settings come from the shell over IPC.
void initDesktopRuntimeConfig()

// [SECURITY/OBSERVABILITY] Capture otherwise-silent async failures so they surface in the
// error log store (and eventually in the copy-diagnostics button) instead of disappearing.
// `logToErrorStore` is called explicitly with the `unhandledrejection` level kept distinct
// from the logger's normal `error` channel; the createLogger calls handle console emission
// + duplicate-to-error-store for ordinary errors via `warn`/`error` severity.
window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason
  const err = reason instanceof Error ? reason : new Error(String(reason))
  log.error(
    "[unhandledrejection]",
    err.message,
    "\n",
    err.stack ?? "(no stack)"
  )
  logToErrorStore({
    level: "unhandledrejection",
    message: err.message || "Unhandled promise rejection",
    stack: err.stack,
    source: "window.unhandledrejection",
  })
})

window.addEventListener("error", (event) => {
  const err =
    event.error instanceof Error ? event.error : new Error(event.message)
  const source = `${event.filename ?? "?"}:${event.lineno ?? 0}:${event.colno ?? 0}`
  log.error(
    "[uncaught error]",
    err.message,
    `(${source})`,
    "\n",
    err.stack ?? "(no stack)"
  )
  logToErrorStore({
    level: "error",
    message: err.message || "Uncaught error",
    stack: err.stack,
    source,
  })
})

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary label="BetterC0de IDE">
      <ThemeProvider>
        <ConfirmProvider>
          <PromptProvider>
            <RemoteAccessGate>
              <App />
            </RemoteAccessGate>
          </PromptProvider>
        </ConfirmProvider>
        <Toaster />
      </ThemeProvider>
    </ErrorBoundary>
  </StrictMode>
)

// Syntax highlighting is off the launch critical path (see
// `streamdown-plugins`). Warming it once the window is idle means the chunk is
// usually resolved before a transcript renders, so the unhighlighted phase
// stays invisible without costing anything at startup.
const warmHighlighting = () => void prefetchStreamdownCodePlugin()
if (typeof requestIdleCallback === "function") {
  requestIdleCallback(warmHighlighting, { timeout: 3000 })
} else {
  setTimeout(warmHighlighting, 1000)
}
