import { useEffect, useState } from "react"
import { ActivityIndicator, Pressable, StyleSheet, Text } from "react-native"
import { GitBranch } from "lucide-react-native"
import type { ProjectSummary } from "@/types/remote"
import { colors, font, radius, spacing } from "@/design/theme"
import { remoteErrorMessage } from "@/lib/remote-errors"
import { useRemoteApi } from "@/transport/use-transport"
import { DropdownRow, DropdownSheet } from "./dropdown-sheet"

/**
 * A new chat in its own git worktree: pick the branch it starts from (the
 * checked-out one first), as the desktop's worktree mode does.
 */
export function WorktreeChatSheet({
  project,
  onClose,
  onCreate,
}: {
  /** The project to start in; `null` hides the sheet. */
  project: ProjectSummary | null
  onClose: () => void
  /** Resolves once the chat and its worktree exist. */
  onCreate: (baseBranch: string) => Promise<void>
}) {
  const api = useRemoteApi()
  const [branches, setBranches] = useState<string[] | null>(null)
  const [current, setCurrent] = useState("")
  const [chosen, setChosen] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!project || !api) return
    let cancelled = false
    setBranches(null)
    setError(null)
    setChosen(null)
    api
      .listBranches(project.path)
      .then((list) => {
        if (cancelled) return
        // The checked-out branch first, as the default to start from.
        const ordered = list.current
          ? [list.current, ...list.branches.filter((b) => b !== list.current)]
          : list.branches
        setBranches(ordered)
        setCurrent(list.current)
        setChosen(ordered[0] ?? null)
      })
      .catch((cause) => {
        if (!cancelled) setError(remoteErrorMessage(cause))
      })
    return () => {
      cancelled = true
    }
  }, [api, project])

  const create = async () => {
    if (!chosen) return
    setBusy(true)
    try {
      await onCreate(chosen)
    } finally {
      setBusy(false)
    }
  }

  return (
    <DropdownSheet
      visible={project !== null}
      onClose={onClose}
      title="New worktree chat"
    >
      <Text style={styles.note}>
        The chat works in its own git worktree, on a new branch from the one you
        pick, so its changes stay apart from the project folder.
      </Text>
      {error ? (
        <Text style={styles.error}>{error}</Text>
      ) : branches === null ? (
        <ActivityIndicator
          style={styles.loading}
          color={colors.textSecondary}
        />
      ) : (
        branches.map((branch) => (
          <DropdownRow
            key={branch}
            icon={<GitBranch size={15} color={colors.textSecondary} />}
            label={branch}
            sublabel={branch === current ? "Checked out" : undefined}
            active={branch === chosen}
            onPress={() => setChosen(branch)}
          />
        ))
      )}
      {chosen && !error ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: busy }}
          testID="worktree-create"
          disabled={busy}
          onPress={() => void create()}
          style={({ pressed }) => [styles.create, pressed && styles.pressed]}
        >
          {busy ? (
            <ActivityIndicator color={colors.primaryForeground} />
          ) : (
            <Text style={styles.createText}>Start from {chosen}</Text>
          )}
        </Pressable>
      ) : null}
    </DropdownSheet>
  )
}

const styles = StyleSheet.create({
  note: {
    color: colors.textSecondary,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
    paddingHorizontal: spacing.sm,
    paddingBottom: spacing.xs,
  },
  error: {
    color: colors.danger,
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 19,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  loading: { paddingVertical: spacing.md },
  create: {
    minHeight: 44,
    marginTop: spacing.sm,
    marginHorizontal: spacing.xs,
    borderRadius: radius.md,
    backgroundColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  createText: {
    color: colors.primaryForeground,
    fontFamily: font.semibold,
    fontSize: 14,
  },
  pressed: { opacity: 0.72 },
})
