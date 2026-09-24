import { useEffect, useMemo, useRef, useState } from "react"
import {
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native"
import * as Haptics from "expo-haptics"
import { Redirect, useLocalSearchParams, useRouter } from "expo-router"
import {
  ArrowLeft,
  FolderTree,
  GitCompareArrows,
  GitBranch,
  WifiOff,
} from "lucide-react-native"
import type { ChatMessage, ModelOption, PendingRequest } from "@/types/remote"
import { Screen, StateView } from "@/components/layout"
import { IconButton } from "@/components/icon-button"
import { ChatComposer } from "@/components/chat-composer"
import { MessageItem, StreamingMessage } from "@/components/message-item"
import { ModelPicker } from "@/components/model-picker"
import { PendingRequestCard } from "@/components/pending-request-card"
import { colors, font, spacing, type } from "@/design/theme"
import { effectiveThreadRoot } from "@/lib/endpoint"
import { remoteApi } from "@/lib/remote-api"
import { modelOptions, preferredModel } from "@/lib/provider-selection"
import { useAppStore } from "@/store/app-store"
import { useSessionStore } from "@/store/session-store"

const EMPTY_REQUESTS: PendingRequest[] = []

export default function ChatScreen() {
  const params = useLocalSearchParams<{ id: string | string[] }>()
  const threadId = Array.isArray(params.id) ? params.id[0] : params.id
  const router = useRouter()
  const profile = useSessionStore((state) => state.profile)
  const connectionState = useSessionStore((state) => state.state)
  const threads = useAppStore((state) => state.threads)
  const messages = useAppStore((state) =>
    threadId ? state.messagesByThread[threadId] : undefined
  )
  const stream = useAppStore((state) =>
    threadId ? state.streamsByThread[threadId] : undefined
  )
  const storedRequests = useAppStore((state) =>
    threadId ? state.requestsByThread[threadId] : undefined
  )
  const requests = storedRequests ?? EMPTY_REQUESTS
  const loading = useAppStore((state) =>
    threadId ? state.loadingMessages[threadId] : false
  )
  const selected = useAppStore((state) =>
    threadId ? state.selectedModels[threadId] : undefined
  )
  const loadMessages = useAppStore((state) => state.loadMessages)
  const loadActivities = useAppStore((state) => state.loadActivities)
  const send = useAppStore((state) => state.send)
  const interrupt = useAppStore((state) => state.interrupt)
  const resolveRequest = useAppStore((state) => state.resolveRequest)
  const setSelectedModel = useAppStore((state) => state.setSelectedModel)
  const turnOptions = useAppStore((state) =>
    threadId ? state.turnOptionsByThread[threadId] : undefined
  )
  const setTurnOptions = useAppStore((state) => state.setTurnOptions)
  const [draft, setDraft] = useState("")
  const [options, setOptions] = useState<ModelOption[]>([])
  const [pickerOpen, setPickerOpen] = useState(false)
  const [modelError, setModelError] = useState<string | null>(null)
  const [busyRequest, setBusyRequest] = useState<string | null>(null)
  const listRef = useRef<FlatList<ChatMessage>>(null)
  const thread = threads.find((candidate) => candidate.id === threadId)
  const threadRoot = thread ? effectiveThreadRoot(thread) : ""
  const isRunning = Boolean(stream?.running || thread?.session?.activeTurnId)
  const effectiveMessages = useMemo(
    () => messages ?? thread?.messages ?? [],
    [messages, thread?.messages]
  )

  useEffect(() => {
    if (!profile || !threadId) return
    void Promise.allSettled([
      loadMessages(profile, threadId),
      loadActivities(profile, threadId),
    ])
  }, [loadActivities, loadMessages, profile, threadId])

  useEffect(() => {
    if (!profile || !thread || !threadId) return
    let cancelled = false
    void remoteApi(profile)
      .listProviderInstances(threadRoot)
      .then((instances) => {
        if (cancelled) return
        const nextOptions = modelOptions(instances)
        setOptions(nextOptions)
        // Read the selection at resolve time instead of depending on it:
        // storing the freshly built option object would change `selected`
        // and re-run this effect, fetching the instance list in a loop.
        // `currentModel` below already resolves the stored key against the
        // latest options, so a retained selection needs no store write.
        const current = useAppStore.getState().selectedModels[threadId]
        const retained = current
          ? nextOptions.some((option) => option.key === current.key)
          : false
        if (!retained) {
          const choice = preferredModel(thread, effectiveMessages, nextOptions)
          if (choice) setSelectedModel(threadId, choice)
        }
        setModelError(
          nextOptions.length ? null : "No ready provider for this project."
        )
      })
      .catch((error) => {
        if (!cancelled)
          setModelError(
            error instanceof Error ? error.message : "Failed to load models."
          )
      })
    return () => {
      cancelled = true
    }
    // Message model ids are only needed for initial preference, not every streamed update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, setSelectedModel, thread?.id, threadId, threadRoot])

  const currentModel = useMemo(
    () =>
      options.find((option) => option.key === selected?.key) ??
      preferredModel(
        thread ?? emptyThread(threadId ?? ""),
        effectiveMessages,
        options
      ),
    [effectiveMessages, options, selected, thread, threadId]
  )

  if (!profile) return <Redirect href="/pair" />
  if (!threadId) return <Redirect href="/(tabs)" />

  const submit = async () => {
    const content = draft.trim()
    if (!content || !thread || !currentModel) return
    setDraft("")
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(
      () => undefined
    )
    try {
      await send(profile, thread.id, content, currentModel)
    } catch (error) {
      setDraft(content)
      Alert.alert(
        "Message not sent",
        error instanceof Error ? error.message : "Unknown error"
      )
    }
  }

  const stop = async () => {
    try {
      await interrupt(profile, threadId)
      await Haptics.notificationAsync(
        Haptics.NotificationFeedbackType.Warning
      ).catch(() => undefined)
    } catch (error) {
      Alert.alert(
        "Failed to stop",
        error instanceof Error ? error.message : "Unknown error"
      )
    }
  }

  return (
    <Screen edges={["top", "bottom"]}>
      <View style={styles.header}>
        <IconButton
          icon={ArrowLeft}
          label="Back"
          onPress={() => router.back()}
        />
        <View style={styles.headerCopy}>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {thread?.title ?? "Chat"}
          </Text>
          <View style={styles.headerMeta}>
            <Text style={styles.project} numberOfLines={1}>
              {thread?.projectName ?? "Project"}
            </Text>
            {thread?.branch ? (
              <>
                <Text style={styles.metaDot}>·</Text>
                <GitBranch size={11} color={colors.textMuted} />
                <Text style={styles.branch} numberOfLines={1}>
                  {thread.branch}
                </Text>
              </>
            ) : null}
          </View>
        </View>
        <IconButton
          icon={GitCompareArrows}
          label="Show changes"
          onPress={() =>
            router.push({
              pathname: "/chat/[id]/changes",
              params: { id: threadId },
            })
          }
        />
        <IconButton
          icon={FolderTree}
          label="Show files"
          onPress={() =>
            router.push({
              pathname: "/chat/[id]/files",
              params: { id: threadId },
            })
          }
        />
      </View>

      {connectionState === "offline" ? (
        <View style={styles.offlineBanner}>
          <WifiOff size={16} color={colors.warning} />
          <Text style={styles.offlineText}>
            Desktop offline — history stays readable.
          </Text>
        </View>
      ) : null}
      {modelError ? (
        <Pressable
          onPress={() => setPickerOpen(true)}
          style={styles.modelError}
        >
          <Text style={styles.modelErrorText}>{modelError}</Text>
        </Pressable>
      ) : null}

      {!thread && !threads.length ? (
        <StateView
          loading
          title="Loading chat"
          message="Fetching thread data from the desktop."
        />
      ) : (
        <FlatList
          ref={listRef}
          data={effectiveMessages}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => <MessageItem message={item} />}
          contentContainerStyle={[
            styles.messages,
            !effectiveMessages.length && !stream && styles.messagesEmpty,
          ]}
          refreshControl={
            <RefreshControl
              refreshing={Boolean(loading)}
              tintColor={colors.mint}
              colors={[colors.mint]}
              onRefresh={() =>
                void Promise.allSettled([
                  loadMessages(profile, threadId),
                  loadActivities(profile, threadId),
                ])
              }
            />
          }
          ListEmptyComponent={
            !stream ? (
              <StateView
                title="Ready for the first prompt"
                message="Write a message below. The desktop agent handles execution and persistence."
              />
            ) : null
          }
          ListFooterComponent={
            <View>
              {stream ? <StreamingMessage stream={stream} /> : null}
              {requests.map((request) => (
                <PendingRequestCard
                  key={request.id}
                  request={request}
                  busy={busyRequest === request.id}
                  onRespond={(response) => {
                    setBusyRequest(request.id)
                    void resolveRequest(profile, request, response)
                      .catch((error) =>
                        Alert.alert(
                          "Response failed",
                          error instanceof Error
                            ? error.message
                            : "Unknown error"
                        )
                      )
                      .finally(() => setBusyRequest(null))
                  }}
                />
              ))}
              <View style={styles.footerSpace} />
            </View>
          }
          onContentSizeChange={() => {
            if (isRunning || effectiveMessages.length < 4) {
              listRef.current?.scrollToEnd({
                animated: effectiveMessages.length > 0,
              })
            }
          }}
        />
      )}

      {thread?.goal ? (
        <View style={styles.goalCard} accessibilityLabel="Thread goal">
          <Text style={styles.headerTitle}>
            {thread.goal.status === "achieved"
              ? "Goal achieved"
              : `Goal: ${thread.goal.status}`}
          </Text>
          <Text style={styles.project}>{thread.goal.objective}</Text>
          {thread.goal.lastReason ? (
            <Text style={styles.branch}>{thread.goal.lastReason}</Text>
          ) : null}
          {thread.goal.source === "betterc0de" ? (
            <View style={styles.goalActions}>
              {[
                {
                  label: "Edit",
                  command: `/goal edit ${thread.goal.objective}`,
                },
                {
                  label: thread.goal.status === "active" ? "Pause" : "Resume",
                  command:
                    thread.goal.status === "active"
                      ? "/goal pause"
                      : "/goal resume",
                },
                { label: "Clear", command: "/goal clear" },
              ].map((action) => (
                <Pressable
                  key={action.label}
                  accessibilityRole="button"
                  accessibilityLabel={`${action.label} goal`}
                  disabled={!currentModel || connectionState === "offline"}
                  onPress={() => {
                    if (action.label === "Edit") {
                      setDraft(action.command)
                      return
                    }
                    if (currentModel)
                      void send(
                        profile,
                        threadId,
                        action.command,
                        currentModel
                      ).catch((error) =>
                        Alert.alert(
                          "Goal update failed",
                          error instanceof Error ? error.message : String(error)
                        )
                      )
                  }}
                >
                  <Text style={styles.headerTitle}>{action.label}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}
        </View>
      ) : null}
      <ChatComposer
        value={draft}
        onChange={setDraft}
        onSend={() => void submit()}
        onStop={() => void stop()}
        onChooseModel={() => setPickerOpen(true)}
        model={currentModel}
        running={isRunning}
        disabled={connectionState === "offline" || !thread}
        thinkingMode={turnOptions?.thinkingMode ?? null}
        onThinkingModeChange={(mode) =>
          setTurnOptions(threadId, { thinkingMode: mode })
        }
        fastMode={turnOptions?.fastMode ?? false}
        onFastModeChange={(fastMode) => setTurnOptions(threadId, { fastMode })}
      />
      <ModelPicker
        visible={pickerOpen}
        options={options}
        selected={currentModel}
        onSelect={(option) => setSelectedModel(threadId, option)}
        onClose={() => setPickerOpen(false)}
      />
    </Screen>
  )
}

function emptyThread(id: string) {
  const now = new Date().toISOString()
  return {
    id,
    title: "",
    projectName: "",
    projectPath: "",
    messages: [],
    createdAt: now,
    updatedAt: now,
  }
}

const styles = StyleSheet.create({
  goalCard: {
    padding: spacing.md,
    gap: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  goalActions: { flexDirection: "row", gap: spacing.lg },
  header: {
    minHeight: 56,
    paddingHorizontal: spacing.xxs,
    paddingVertical: spacing.xxs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    backgroundColor: colors.canvas,
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
  },
  headerCopy: { flex: 1, minWidth: 0, marginHorizontal: spacing.xs },
  headerTitle: {
    color: colors.text,
    fontFamily: font.semibold,
    fontSize: 15,
    letterSpacing: -0.2,
  },
  headerMeta: {
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: 2,
  },
  project: {
    flexShrink: 1,
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 11,
  },
  metaDot: { color: colors.textMuted, fontSize: 11 },
  branch: {
    flexShrink: 1,
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 11,
  },
  offlineBanner: {
    minHeight: 38,
    paddingHorizontal: spacing.md,
    backgroundColor: "rgba(251,191,36,0.08)",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(251,191,36,0.2)",
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
  },
  offlineText: {
    color: colors.warning,
    fontFamily: font.medium,
    fontSize: type.micro,
  },
  modelError: {
    minHeight: 38,
    paddingHorizontal: spacing.md,
    justifyContent: "center",
    backgroundColor: "rgba(248,113,113,0.07)",
  },
  modelErrorText: {
    color: colors.danger,
    fontFamily: font.regular,
    fontSize: type.micro,
  },
  messages: { paddingTop: spacing.lg, paddingBottom: spacing.md },
  messagesEmpty: { flexGrow: 1 },
  footerSpace: { height: spacing.sm },
})
