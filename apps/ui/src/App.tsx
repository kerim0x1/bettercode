import { AppShell } from "@/components/layout/app-shell"
import { BackendStatusBanner } from "@/components/layout/backend-status-banner"
import { SecretsEncryptionBanner } from "@/components/layout/secrets-encryption-banner"
import { PullRequestWakeBridge } from "@/components/pull-requests/pull-request-wake-bridge"
import { useAppShellBundles } from "@/hooks/use-app-shell-bundles"
// NOTE: `monaco-setup` is intentionally NOT imported here. The ~4 MB monaco
// bundle is lazy-loaded via the `MonacoEditorWrapper` (which itself is
// dynamic-imported from `file-editor-modal` / `editor-panel`). Importing the
// setup at the app entry would defeat that split and pull monaco into the
// critical render path on every cold start.

/**
 * Entry component. All orchestration — every state hook, every side
 * effect subscription, every prop-bag assembly — lives in
 * `useAppShellBundles()`; this component is only the top-level render
 * site. See `src/hooks/use-app-shell-bundles.tsx` for the full wiring.
 */
export function App() {
  const bundles = useAppShellBundles()
  return (
    <>
      <SecretsEncryptionBanner />
      <AppShell {...bundles} />
      <BackendStatusBanner />
      <PullRequestWakeBridge />
    </>
  )
}

export default App
