import { useEffect, useState } from "react"
import { useAppearanceStore } from "@/lib/appearance-store"
import { usePluginStore } from "@/lib/plugin-store"
import { usePreferencesStore } from "@/lib/preferences-store"
import { gitUserProfile } from "@/services/backend/gitApi"

/**
 * Startup initialization for persisted state + local git user info.
 *
 * On mount:
 *  - Loads plugin store (async — plugins are enumerated from disk).
 *  - Loads appearance + preferences stores (sync — just reads localStorage).
 *  - Fetches the effective Git identity through the dedicated read-only
 *    backend endpoint. Repository-local config overrides global config.
 *
 * Returns the two git-derived strings as `{ gitUserName, gitHubUser }` —
 * both default to empty strings so the caller can use them directly in
 * `||` fallback chains without null-checks.
 */
export function useStartupInit(gitCwd?: string | null) {
  useEffect(() => {
    usePluginStore
      .getState()
      .init()
      .catch(() => {
        console.warn("Failed to initialize plugin store")
      })
  }, [])
  useEffect(() => {
    useAppearanceStore.getState().load()
  }, [])
  useEffect(() => {
    usePreferencesStore.getState().load()
  }, [])

  const [gitUserName, setGitUserName] = useState("")
  const [gitHubUser, setGitHubUser] = useState("")

  useEffect(() => {
    let cancelled = false

    void gitUserProfile(gitCwd)
      .then((profile) => {
        if (cancelled) return
        const githubUser = profile.githubUser?.trim() ?? ""
        const displayName =
          profile.name?.trim() ||
          githubUser ||
          profile.email?.split("@")[0]?.trim() ||
          ""
        setGitUserName(displayName)
        setGitHubUser(githubUser)
      })
      .catch(() => {
        if (cancelled) return
        setGitUserName("")
        setGitHubUser("")
      })

    return () => {
      cancelled = true
    }
  }, [gitCwd])

  return { gitUserName, gitHubUser }
}
