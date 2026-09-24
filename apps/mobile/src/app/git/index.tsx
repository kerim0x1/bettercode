import { useCallback, useEffect, useRef, useState } from "react"
import {
  Alert,
  Pressable,
  RefreshControl,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native"
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router"
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowUpFromLine,
  Check,
  ChevronRight,
  GitBranch,
  History,
  Minus,
  Plus,
  RefreshCw,
  Sparkles,
  Undo2,
  X,
} from "lucide-react-native"
import { ActionButton } from "@/components/action-button"
import {
  DropdownRow,
  DropdownSectionLabel,
  DropdownSheet,
} from "@/components/dropdown-sheet"
import { IconButton } from "@/components/icon-button"
import { Screen, StateView } from "@/components/layout"
import { colors, font, radius, spacing, type } from "@/design/theme"
import {
  changeCount,
  checkoutConfirmation,
  commitChanges,
  discardConfirmation,
  generateCommitMessage,
  gitSections,
  lineCounts,
  pullConfirmation,
  pushConfirmation,
  type Confirmation,
  type GitSectionKey,
  type LineCounts,
} from "@/lib/git-review"
import { describeRemoteError, remoteErrorMessage } from "@/lib/remote-errors"
import { useReadOnly, useRemoteApi } from "@/transport/use-transport"
import type { GitStatusResult } from "@/transport/types"

function firstParam(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? ""
}

function baseName(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() ?? path
  )
}

function ask(
  confirmation: Confirmation,
  destructive: boolean,
  run: () => void
) {
  Alert.alert(confirmation.title, confirmation.message, [
    { text: "Cancel", style: "cancel" },
    {
      text: confirmation.action,
      style: destructive ? "destructive" : "default",
      onPress: run,
    },
  ])
}

/**
 * The desktop's git panel for one project or worktree folder: the branch
 * and its remote, a commit box with a generated message, and the staged,
 * changed and untracked files. A file opens its diff for hunk review.
 */
export default function GitReviewScreen() {
  const params = useLocalSearchParams<{
    root?: string | string[]
    name?: string | string[]
  }>()
  const root = firstParam(params.root)
  const name = firstParam(params.name) || baseName(root)
  const router = useRouter()
  const api = useRemoteApi()
  const readOnly = useReadOnly()

  const [status, setStatus] = useState<GitStatusResult | null>(null)
  const [counts, setCounts] = useState<{
    staged: Record<string, LineCounts>
    unstaged: Record<string, LineCounts>
  }>({ staged: {}, unstaged: {} })
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState("")
  const [commitError, setCommitError] = useState<string | null>(null)
  const [remoteError, setRemoteError] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)
  const generation = useRef<AbortController | null>(null)
  const loads = useRef(0)
  const [branchesOpen, setBranchesOpen] = useState(false)

  const load = useCallback(async () => {
    if (!api || !root || readOnly) return
    const id = ++loads.current
    setLoading(true)
    try {
      const [next, unstaged, staged] = await Promise.all([
        api.gitStatus(root),
        api.gitDiff(root, false),
        api.gitDiff(root, true),
      ])
      if (id !== loads.current) return
      setStatus(next)
      setCounts({
        staged: lineCounts(staged.diff),
        unstaged: lineCounts(unstaged.diff),
      })
      setLoadError(null)
    } catch (error) {
      if (id === loads.current) setLoadError(remoteErrorMessage(error))
    } finally {
      if (id === loads.current) setLoading(false)
    }
  }, [api, root, readOnly])

  useFocusEffect(
    useCallback(() => {
      void load()
    }, [load])
  )
  useEffect(() => () => generation.current?.abort(), [])

  /** One change at a time; afterwards the lists are read again. */
  const run = async (
    key: string,
    action: () => Promise<unknown>,
    onError?: (message: string) => void
  ) => {
    if (busy) return
    setBusy(key)
    try {
      await action()
    } catch (error) {
      const described = describeRemoteError(error)
      if (onError) onError(described.message)
      else Alert.alert(described.title, described.message)
    } finally {
      setBusy(null)
      await load()
    }
  }

  if (readOnly) {
    return (
      <Screen edges={["top", "bottom"]}>
        <Header name={name} onBack={() => router.back()} />
        <StateView
          title="This phone can only watch"
          message="It paired over plain HTTP from outside your network. Pair it again over your Wi-Fi, Tailscale or HTTPS to review and commit changes."
        />
      </Screen>
    )
  }
  if (!api || !root) {
    return (
      <Screen edges={["top", "bottom"]}>
        <Header name={name} onBack={() => router.back()} />
        <StateView
          title="No project folder"
          message="Open source control from a chat or a project."
        />
      </Screen>
    )
  }

  const openDiff = (file: string, section: GitSectionKey) =>
    router.push({
      pathname: "/git/diff",
      params: {
        root,
        path: file,
        source:
          section === "staged"
            ? "staged"
            : section === "untracked"
              ? "untracked"
              : "unstaged",
      },
    })

  const commit = () => {
    if (!status || !message.trim() || generating) return
    setCommitError(null)
    void run(
      "commit",
      async () => {
        await commitChanges(api, root, status, message)
        setMessage("")
      },
      setCommitError
    )
  }

  const generate = async () => {
    if (generating || busy) return
    const controller = new AbortController()
    generation.current = controller
    setGenerating(true)
    setCommitError(null)
    try {
      const text = await generateCommitMessage(api, root, controller.signal)
      if (generation.current === controller) setMessage(text)
    } catch (error) {
      if (generation.current === controller && !controller.signal.aborted)
        setCommitError(remoteErrorMessage(error))
    } finally {
      if (generation.current === controller) {
        generation.current = null
        setGenerating(false)
      }
    }
  }

  const cancelGeneration = () => {
    generation.current?.abort()
    generation.current = null
    setGenerating(false)
  }

  const push = () => {
    if (!status) return
    const branch = status.branch || "main"
    ask(pushConfirmation(status), false, () => {
      setRemoteError(null)
      void run(
        "push",
        () =>
          status.upstream
            ? api.gitPush(root)
            : api.gitPush(root, { setUpstream: true, branch }),
        setRemoteError
      )
    })
  }

  const pull = () => {
    if (!status) return
    ask(pullConfirmation(status), false, () => {
      setRemoteError(null)
      void run("pull", () => api.gitPull(root), setRemoteError)
    })
  }

  const fetchRemote = () => {
    setRemoteError(null)
    void run("fetch", () => api.gitFetch(root), setRemoteError)
  }

  const total = status ? changeCount(status) : 0
  const sections = status
    ? gitSections(status).map((section) => ({
        ...section,
        data: section.files,
      }))
    : []

  return (
    <Screen edges={["top", "bottom"]}>
      <Header
        name={name}
        onBack={() => router.back()}
        onHistory={() =>
          router.push({ pathname: "/git/history", params: { root, name } })
        }
        onRefresh={() => void load()}
      />
      {!status ? (
        loadError ? (
          <StateView
            title="Git unavailable"
            message={loadError}
            actionLabel="Try again"
            onAction={() => void load()}
          />
        ) : (
          <StateView
            loading
            title="Reading the repository"
            message="Status and changes come from the desktop."
          />
        )
      ) : (
        <SectionList
          testID="git-screen"
          sections={sections}
          keyExtractor={(file, index) => `${file}:${index}`}
          stickySectionHeadersEnabled={false}
          contentContainerStyle={styles.list}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            <RefreshControl
              refreshing={loading}
              tintColor={colors.mint}
              colors={[colors.mint]}
              onRefresh={() => void load()}
            />
          }
          ListHeaderComponent={
            <View style={styles.overview}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Branch ${status.branch || "main"}${status.ahead > 0 ? `, ${status.ahead} to push` : ""}${status.behind > 0 ? `, ${status.behind} to pull` : ""}. Switch or create a branch`}
                testID="git-branch"
                onPress={() => setBranchesOpen(true)}
                style={({ pressed }) => [
                  styles.branch,
                  pressed && styles.pressed,
                ]}
              >
                <GitBranch size={17} color={colors.textSecondary} />
                <View style={styles.branchCopy}>
                  <Text style={styles.branchName} numberOfLines={1}>
                    {status.branch || "main"}
                  </Text>
                  <Text style={styles.branchUpstream} numberOfLines={1}>
                    {status.upstream ?? "No upstream yet"}
                  </Text>
                </View>
                {status.ahead > 0 ? (
                  <Text
                    style={styles.count}
                    accessibilityLabel={`${status.ahead} to push`}
                  >
                    ↑{status.ahead}
                  </Text>
                ) : null}
                {status.behind > 0 ? (
                  <Text
                    style={styles.count}
                    accessibilityLabel={`${status.behind} to pull`}
                  >
                    ↓{status.behind}
                  </Text>
                ) : null}
                <ChevronRight size={17} color={colors.textMuted} />
              </Pressable>

              <View style={styles.remoteRow}>
                <ActionButton
                  label={busy === "fetch" ? "Fetching…" : "Fetch"}
                  icon={RefreshCw}
                  busy={busy === "fetch"}
                  disabled={busy !== null}
                  accessibilityLabel="Fetch remote updates"
                  testID="git-fetch"
                  onPress={fetchRemote}
                  style={styles.remoteButton}
                />
                <ActionButton
                  label={status.behind > 0 ? `Pull ${status.behind}` : "Pull"}
                  icon={ArrowDownToLine}
                  busy={busy === "pull"}
                  disabled={busy !== null || !status.upstream}
                  testID="git-pull"
                  onPress={pull}
                  style={styles.remoteButton}
                />
                <ActionButton
                  label={
                    status.upstream
                      ? status.ahead > 0
                        ? `Push ${status.ahead}`
                        : "Push"
                      : "Publish"
                  }
                  icon={ArrowUpFromLine}
                  busy={busy === "push"}
                  disabled={
                    busy !== null ||
                    (Boolean(status.upstream) && status.ahead === 0)
                  }
                  testID="git-push"
                  onPress={push}
                  style={styles.remoteButton}
                />
              </View>
              {remoteError ? (
                <Text style={styles.error} testID="git-remote-error">
                  {remoteError}
                </Text>
              ) : null}

              <View style={styles.commitBox}>
                <TextInput
                  testID="git-commit-message"
                  accessibilityLabel="Commit message"
                  value={message}
                  onChangeText={(value) => {
                    setMessage(value)
                    if (commitError) setCommitError(null)
                  }}
                  editable={!generating && busy !== "commit"}
                  placeholder="Commit message"
                  placeholderTextColor={colors.textMuted}
                  multiline
                  style={styles.commitInput}
                />
                <View style={styles.commitActions}>
                  {generating ? (
                    <ActionButton
                      label="Cancel"
                      icon={X}
                      testID="git-generate-cancel"
                      accessibilityLabel="Stop waiting for the commit message"
                      onPress={cancelGeneration}
                    />
                  ) : (
                    <ActionButton
                      label="Generate"
                      icon={Sparkles}
                      disabled={busy !== null || total === 0}
                      testID="git-generate"
                      accessibilityLabel="Generate a commit message from the reviewed changes"
                      onPress={() => void generate()}
                    />
                  )}
                  <ActionButton
                    label="Commit"
                    icon={Check}
                    tone="primary"
                    busy={busy === "commit"}
                    disabled={
                      !message.trim() ||
                      generating ||
                      busy !== null ||
                      total === 0
                    }
                    testID="git-commit"
                    onPress={commit}
                    style={styles.commitButton}
                  />
                </View>
                {generating ? (
                  <Text style={styles.hint} accessibilityLiveRegion="polite">
                    Reading changes and writing a commit summary…
                  </Text>
                ) : null}
                {commitError ? (
                  <Text style={styles.error} testID="git-commit-error">
                    {commitError}
                  </Text>
                ) : null}
                {status.staged.length === 0 && total > 0 ? (
                  <Text style={styles.hint}>
                    Nothing is staged, so Commit takes every change.
                  </Text>
                ) : null}
              </View>
            </View>
          }
          renderSectionHeader={({ section }) => (
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle} accessibilityRole="header">
                {section.title}
              </Text>
              <Text style={styles.sectionCount}>{section.data.length}</Text>
              {section.key === "staged" ? (
                <ActionButton
                  label="Unstage All"
                  disabled={busy !== null}
                  testID="git-unstage-all"
                  onPress={() => void run("all", () => api.gitUnstageAll(root))}
                  style={styles.sectionAction}
                />
              ) : section.key === "changes" ||
                (section.key === "untracked" &&
                  status.modified.length === 0) ? (
                <ActionButton
                  label="Stage All"
                  disabled={busy !== null}
                  testID="git-stage-all"
                  onPress={() => void run("all", () => api.gitStageAll(root))}
                  style={styles.sectionAction}
                />
              ) : null}
            </View>
          )}
          renderItem={({ item, section }) => (
            <FileRow
              file={item}
              section={section.key}
              counts={
                section.key === "staged"
                  ? counts.staged[item]
                  : counts.unstaged[item]
              }
              disabled={busy !== null}
              onOpen={() => openDiff(item, section.key)}
              onStage={() =>
                void run(`file:${item}`, () => api.gitStage(root, [item]))
              }
              onUnstage={() =>
                void run(`file:${item}`, () => api.gitUnstage(root, [item]))
              }
              onDiscard={() =>
                ask(discardConfirmation(item), true, () => {
                  void run(`file:${item}`, () => api.gitDiscard(root, item))
                })
              }
            />
          )}
          ListEmptyComponent={
            <Text style={styles.clean} testID="git-clean">
              No changes — working tree is clean.
            </Text>
          }
        />
      )}
      <BranchSheet
        visible={branchesOpen}
        root={root}
        onClose={() => setBranchesOpen(false)}
        onSwitch={(branch) => {
          setBranchesOpen(false)
          ask(checkoutConfirmation(branch), false, () => {
            void run("branch", () => api.gitCheckout(root, branch))
          })
        }}
        onCreate={(branch) => {
          setBranchesOpen(false)
          void run("branch", () => api.gitCheckout(root, branch, true))
        }}
      />
    </Screen>
  )
}

function Header({
  name,
  onBack,
  onHistory,
  onRefresh,
}: {
  name: string
  onBack: () => void
  onHistory?: () => void
  onRefresh?: () => void
}) {
  return (
    <View style={styles.header}>
      <IconButton icon={ArrowLeft} label="Back" onPress={onBack} />
      <View style={styles.headerCopy}>
        <Text style={styles.eyebrow}>SOURCE CONTROL</Text>
        <Text style={styles.title} numberOfLines={1}>
          {name || "Repository"}
        </Text>
      </View>
      {onHistory ? (
        <IconButton
          icon={History}
          label="Commit history"
          testID="git-history"
          onPress={onHistory}
        />
      ) : null}
      {onRefresh ? (
        <IconButton icon={RefreshCw} label="Refresh" onPress={onRefresh} />
      ) : null}
    </View>
  )
}

function FileRow({
  file,
  section,
  counts,
  disabled,
  onOpen,
  onStage,
  onUnstage,
  onDiscard,
}: {
  file: string
  section: GitSectionKey
  counts?: LineCounts
  disabled: boolean
  onOpen: () => void
  onStage: () => void
  onUnstage: () => void
  onDiscard: () => void
}) {
  const slash = file.lastIndexOf("/")
  const fileName = slash === -1 ? file : file.slice(slash + 1)
  const folder = slash === -1 ? "" : file.slice(0, slash)
  return (
    <View style={styles.fileRow}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${file}, open the diff`}
        testID={`git-file-${file}`}
        onPress={onOpen}
        style={({ pressed }) => [styles.fileOpen, pressed && styles.pressed]}
      >
        <Text style={styles.fileName} numberOfLines={1}>
          {fileName}
        </Text>
        <View style={styles.fileMeta}>
          {folder ? (
            <Text style={styles.folder} numberOfLines={1}>
              {folder}
            </Text>
          ) : null}
          {counts?.additions ? (
            <Text style={styles.add}>+{counts.additions}</Text>
          ) : null}
          {counts?.deletions ? (
            <Text style={styles.del}>−{counts.deletions}</Text>
          ) : null}
        </View>
      </Pressable>
      {section === "changes" ? (
        <IconButton
          icon={Undo2}
          label={`Discard changes to ${file}`}
          tone="danger"
          disabled={disabled}
          testID={`git-discard-${file}`}
          onPress={onDiscard}
        />
      ) : null}
      {section === "staged" ? (
        <IconButton
          icon={Minus}
          label={`Unstage ${file}`}
          disabled={disabled}
          testID={`git-unstage-${file}`}
          onPress={onUnstage}
        />
      ) : (
        <IconButton
          icon={Plus}
          label={`Stage ${file}`}
          disabled={disabled}
          testID={`git-stage-${file}`}
          onPress={onStage}
        />
      )}
    </View>
  )
}

function BranchSheet({
  visible,
  root,
  onClose,
  onSwitch,
  onCreate,
}: {
  visible: boolean
  root: string
  onClose: () => void
  onSwitch: (branch: string) => void
  onCreate: (branch: string) => void
}) {
  const api = useRemoteApi()
  const [branches, setBranches] = useState<string[]>([])
  const [current, setCurrent] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState("")

  useEffect(() => {
    if (!visible || !api) return
    let active = true
    setError(null)
    setDraft("")
    api
      .listBranches(root)
      .then((result) => {
        if (!active) return
        setBranches(result.branches)
        setCurrent(result.current)
      })
      .catch((caught: unknown) => {
        if (active) setError(remoteErrorMessage(caught))
      })
    return () => {
      active = false
    }
  }, [api, root, visible])

  const name = draft.trim()
  return (
    <DropdownSheet visible={visible} onClose={onClose} title="Branches">
      {error ? <Text style={styles.sheetError}>{error}</Text> : null}
      {branches.map((branch) => (
        <DropdownRow
          key={branch}
          icon={<GitBranch size={15} color={colors.textSecondary} />}
          label={branch}
          active={branch === current}
          onPress={() => (branch === current ? onClose() : onSwitch(branch))}
        />
      ))}
      <DropdownSectionLabel>
        New branch from {current || "HEAD"}
      </DropdownSectionLabel>
      <View style={styles.newBranch}>
        <TextInput
          testID="git-new-branch"
          accessibilityLabel="New branch name"
          value={draft}
          onChangeText={setDraft}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="feature/name"
          placeholderTextColor={colors.textMuted}
          style={styles.newBranchInput}
          onSubmitEditing={() => (name ? onCreate(name) : undefined)}
        />
        <ActionButton
          label="Create"
          icon={Plus}
          disabled={!name || branches.includes(name)}
          testID="git-create-branch"
          onPress={() => onCreate(name)}
        />
      </View>
    </DropdownSheet>
  )
}

const styles = StyleSheet.create({
  header: {
    minHeight: 68,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
  },
  headerCopy: { flex: 1, minWidth: 0, marginHorizontal: 2 },
  eyebrow: {
    color: colors.mint,
    fontSize: 10,
    fontFamily: font.bold,
    letterSpacing: 1.1,
  },
  title: {
    color: colors.text,
    fontSize: 17,
    fontFamily: font.bold,
    marginTop: 2,
  },
  list: { paddingBottom: spacing.xxl },
  overview: { padding: spacing.md, gap: spacing.sm },
  branch: {
    minHeight: 56,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
  },
  branchCopy: { flex: 1, minWidth: 0 },
  branchName: {
    color: colors.text,
    fontFamily: font.bold,
    fontSize: type.body,
  },
  branchUpstream: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: type.micro,
    marginTop: 2,
  },
  count: {
    color: colors.textSecondary,
    fontFamily: font.semibold,
    fontSize: type.micro,
  },
  pressed: { opacity: 0.7 },
  remoteRow: { flexDirection: "row", gap: spacing.xs },
  remoteButton: { flex: 1 },
  commitBox: {
    padding: spacing.sm,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    gap: spacing.xs,
  },
  commitInput: {
    minHeight: 72,
    maxHeight: 180,
    padding: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.input,
    color: colors.text,
    fontFamily: font.regular,
    fontSize: type.small,
    textAlignVertical: "top",
  },
  commitActions: { flexDirection: "row", gap: spacing.xs },
  commitButton: { flex: 1 },
  hint: {
    color: colors.textSecondary,
    fontFamily: font.regular,
    fontSize: type.micro,
  },
  error: {
    color: colors.danger,
    fontFamily: font.regular,
    fontSize: type.micro,
  },
  sectionHeader: {
    minHeight: 52,
    paddingHorizontal: spacing.md,
    marginTop: spacing.xs,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
  },
  sectionTitle: {
    color: colors.textSecondary,
    fontFamily: font.bold,
    fontSize: type.micro,
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  sectionCount: {
    color: colors.textMuted,
    fontFamily: font.semibold,
    fontSize: type.micro,
  },
  sectionAction: { marginLeft: "auto" },
  fileRow: {
    minHeight: 56,
    paddingLeft: spacing.md,
    paddingRight: spacing.xs,
    flexDirection: "row",
    alignItems: "center",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  fileOpen: { flex: 1, minWidth: 0, minHeight: 56, justifyContent: "center" },
  fileName: {
    color: colors.text,
    fontFamily: font.medium,
    fontSize: type.small,
  },
  fileMeta: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    marginTop: 2,
  },
  folder: {
    flexShrink: 1,
    color: colors.textMuted,
    fontFamily: type.mono,
    fontSize: type.micro,
  },
  add: { color: colors.success, fontFamily: font.bold, fontSize: type.micro },
  del: { color: colors.danger, fontFamily: font.bold, fontSize: type.micro },
  clean: {
    padding: spacing.xl,
    textAlign: "center",
    color: colors.textSecondary,
    fontFamily: font.regular,
    fontSize: type.small,
  },
  sheetError: {
    color: colors.danger,
    fontFamily: font.regular,
    fontSize: type.micro,
    paddingHorizontal: spacing.sm,
    paddingBottom: spacing.xs,
  },
  newBranch: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    paddingHorizontal: spacing.xs,
    paddingBottom: spacing.xs,
  },
  newBranchInput: {
    flex: 1,
    minHeight: 44,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.input,
    color: colors.text,
    fontFamily: type.mono,
    fontSize: type.small,
  },
})
