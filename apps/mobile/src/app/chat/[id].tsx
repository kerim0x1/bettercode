import { useEffect, useMemo, useRef, useState } from "react"
import {
  ActivityIndicator,
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
import type { PermissionLevel } from "@betterc0de/schema/chat-controls"
import {
  ArrowLeft,
  Eye,
  FolderTree,
  GitCompareArrows,
  GitBranch,
  Info,
  WifiOff,
  X,
} from "lucide-react-native"
import type { ChatMessage, ModelOption, PendingRequest } from "@/types/remote"
import { Screen, StateView } from "@/components/layout"
import { IconButton } from "@/components/icon-button"
import { ChatComposer } from "@/components/chat-composer"
import { MessageItem, StreamingMessage } from "@/components/message-item"
import { ModelPicker } from "@/components/model-picker"
import { PendingRequestCard } from "@/components/pending-request-card"
import { QueuedMessages } from "@/components/queued-messages"
import { SendFailure } from "@/components/send-failure"
import { colors, font, radius, spacing, type } from "@/design/theme"
import { effectiveThreadRoot } from "@/lib/endpoint"
import { modelOptions, preferredModel } from "@/lib/provider-selection"
import { remoteErrorMessage } from "@/lib/remote-errors"
import {
  useAppStore,
  type PermissionNotice,
  type SendOutcome,
} from "@/store/app-store"
import {
  DEFAULT_COMPOSER_SETTINGS,
  useComposerSettings,
} from "@/store/composer-settings-store"
import { useQueueStore } from "@/store/queue-store"
import { useSessionStore } from "@/store/session-store"
import type { RemoteApi } from "@/transport/types"
import { useReadOnly, useRemoteApi } from "@/transport/use-transport"

const EMPTY_REQUESTS: PendingRequest[] = []
/** Goal commands run at once, even while a reply runs; they never queue. */
const GOAL_COMMAND = /^\/goal(?:\s|$)/i

export default function ChatScreen() {
  const params = useLocalSearchParams<{ id: string | string[] }>()
  const threadId = Array.isArray(params.id) ? params.id[0] : params.id
  const router = useRouter()
  const api = useRemoteApi()
  const readOnly = useReadOnly()
  const connectionState = useSessionStore((state) => state.state)
  const threads = useAppStore((state) => state.threads)
  const messagesError = useAppStore((state) =>
    threadId ? (state.messagesErrorByThread[threadId] ?? null) : null
  )
  const hasEarlier = useAppStore((state) =>
    threadId ? Boolean(state.earlierMessagesByThread[threadId]) : false
  )
  const loadEarlierMessages = useAppStore((state) => state.loadEarlierMessages)
  const ensureThread = useAppStore((state) => state.ensureThread)
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
  const outbox = useAppStore((state) => state.outbox)
  const retrySend = useAppStore((state) => state.retrySend)
  const sendAgainAsNew = useAppStore((state) => state.sendAgainAsNew)
  const discardFailed = useAppStore((state) => state.discardFailed)
  const changePermissionLevel = useAppStore(
    (state) => state.changePermissionLevel
  )
  const composerSettings =
    useComposerSettings((state) =>
      threadId ? state.byThread[threadId] : undefined
    ) ?? DEFAULT_COMPOSER_SETTINGS
  const hasQueued = useQueueStore((state) =>
    threadId
      ? state.messages.some((message) => message.threadId === threadId)
      : false
  )
  const [notice, setNotice] = useState<PermissionNotice | null>(null)
  const [draft, setDraft] = useState("")
  const [options, setOptions] = useState<ModelOption[]>([])
  const [pickerOpen, setPickerOpen] = useState(false)
  const [modelError, setModelError] = useState<string | null>(null)
  const [busyRequest, setBusyRequest] = useState<string | null>(null)
  /** Looking up a chat that is not in the loaded pages: idle, loading, missing, or an error text. */
  const [lookup, setLookup] = useState<string>("idle")
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const listRef = useRef<FlatList<ChatMessage>>(null)
  const thread = threads.find((candidate) => candidate.id === threadId)
  const threadRoot = thread ? effectiveThreadRoot(thread) : ""
  const isRunning = Boolean(stream?.running || thread?.session?.activeTurnId)
  const effectiveMessages = useMemo(
    () => messages ?? thread?.messages ?? [],
    [messages, thread?.messages]
  )

  useEffect(() => {
    if (!api || !threadId) return
    void Promise.allSettled([
      loadMessages(api, threadId),
      loadActivities(api, threadId),
    ])
  }, [api, loadActivities, loadMessages, threadId])

  // A chat from a link or notification may not be in the loaded pages yet.
  const known = Boolean(thread)
  useEffect(() => {
    if (!api || !threadId || known) return
    let cancelled = false
    setLookup("loading")
    ensureThread(api, threadId)
      .then((found) => {
        if (!cancelled) setLookup(found ? "idle" : "missing")
      })
      .catch((error) => {
        if (!cancelled) setLookup(remoteErrorMessage(error))
      })
    return () => {
      cancelled = true
    }
  }, [api, ensureThread, known, threadId])

  useEffect(() => {
    if (!api || !thread || !threadId) return
    let cancelled = false
    void api
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
        if (!cancelled) setModelError(remoteErrorMessage(error))
      })
    return () => {
      cancelled = true
    }
    // Message model ids are only needed for initial preference, not every streamed update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, setSelectedModel, thread?.id, threadId, threadRoot])

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

  if (!threadId) return <Redirect href="/(tabs)" />

  const reload = () => {
    if (!api) return
    void Promise.allSettled([
      loadMessages(api, threadId),
      loadActivities(api, threadId),
    ])
  }

  const queue = (content: string) => {
    if (!thread || !currentModel) return false
    try {
      useQueueStore.getState().enqueue(thread.id, {
        text: content,
        selection: currentModel,
        thinkingMode: turnOptions?.thinkingMode ?? null,
        fastMode: turnOptions?.fastMode ?? false,
      })
      return true
    } catch (error) {
      Alert.alert(
        "Message not queued",
        error instanceof Error ? error.message : String(error)
      )
      return false
    }
  }

  const submit = async () => {
    const content = draft.trim()
    if (!api || !content || !thread || !currentModel) return
    // As on the desktop, a message goes behind the ones already queued.
    if (hasQueued && !GOAL_COMMAND.test(content)) {
      if (queue(content)) setDraft("")
      return
    }
    setDraft("")
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(
      () => undefined
    )
    try {
      // A message that fails stays in the chat with its reason and Retry.
      await send(api, thread.id, content, currentModel)
    } catch (error) {
      setDraft(content)
      Alert.alert("Message not sent", remoteErrorMessage(error))
    }
  }

  const queueDraft = () => {
    const content = draft.trim()
    if (content && queue(content)) setDraft("")
  }

  const onFailure =
    (action: (api: RemoteApi, messageId: string) => Promise<SendOutcome>) =>
    (messageId: string) => {
      if (!api) return
      action(api, messageId).catch((error) =>
        Alert.alert("Message not sent", remoteErrorMessage(error))
      )
    }
  const retry = onFailure(retrySend)
  const sendAsNew = onFailure(sendAgainAsNew)

  const choosePermission = (level: PermissionLevel) => {
    setNotice(null)
    if (!api) {
      useComposerSettings
        .getState()
        .update(threadId, { permissionLevel: level })
      return
    }
    void changePermissionLevel(api, threadId, level).then(setNotice)
  }

  const stop = async () => {
    if (!api) return
    try {
      await interrupt(api, threadId)
      await Haptics.notificationAsync(
        Haptics.NotificationFeedbackType.Warning
      ).catch(() => undefined)
    } catch (error) {
      Alert.alert("Could not stop the agent", remoteErrorMessage(error))
    }
  }

  const showEarlier = async () => {
    if (!api) return
    setLoadingEarlier(true)
    try {
      await loadEarlierMessages(api, threadId)
    } catch (error) {
      Alert.alert("Could not load earlier messages", remoteErrorMessage(error))
    } finally {
      setLoadingEarlier(false)
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

      {connectionState === "offline" ||
      connectionState === "remote_disabled" ? (
        <View style={styles.offlineBanner}>
          <WifiOff size={16} color={colors.warning} />
          <Text style={styles.offlineText}>
            {connectionState === "remote_disabled"
              ? "Remote Access is off on the desktop."
              : "Desktop offline. The loaded history stays readable."}
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

      {!thread && lookup !== "idle" && lookup !== "loading" ? (
        <StateView
          title={lookup === "missing" ? "Chat not found" : "Chat unavailable"}
          message={
            lookup === "missing"
              ? "It was deleted on the desktop, or it belongs to a different desktop."
              : lookup
          }
          actionLabel="Back to chats"
          onAction={() => router.replace("/(tabs)")}
        />
      ) : !thread ? (
        <StateView
          loading
          title="Loading chat"
          message="Fetching the chat from the desktop."
        />
      ) : (
        <FlatList
          ref={listRef}
          data={effectiveMessages}
          keyExtractor={(item) => item.id}
          extraData={outbox}
          renderItem={({ item }) => {
            const failure = outbox[item.id]
            return (
              <>
                <MessageItem message={item} />
                {failure?.error && failure.owner === "chat" ? (
                  <SendFailure
                    entry={failure}
                    onRetry={() => retry(item.id)}
                    onSendAsNew={() => sendAsNew(item.id)}
                    onDelete={() => discardFailed(item.id)}
                  />
                ) : null}
              </>
            )
          }}
          contentContainerStyle={[
            styles.messages,
            !effectiveMessages.length && !stream && styles.messagesEmpty,
          ]}
          refreshControl={
            <RefreshControl
              refreshing={Boolean(loading)}
              tintColor={colors.mint}
              colors={[colors.mint]}
              onRefresh={reload}
            />
          }
          ListHeaderComponent={
            hasEarlier ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Load earlier messages"
                disabled={loadingEarlier}
                onPress={() => void showEarlier()}
                style={styles.earlier}
              >
                {loadingEarlier ? (
                  <ActivityIndicator color={colors.textSecondary} />
                ) : (
                  <Text style={styles.earlierText}>Load earlier messages</Text>
                )}
              </Pressable>
            ) : null
          }
          ListEmptyComponent={
            stream ? null : loading ? (
              <StateView loading title="Loading messages" message="" />
            ) : messagesError ? (
              <StateView
                title="Messages unavailable"
                message={messagesError}
                actionLabel="Try again"
                onAction={reload}
              />
            ) : (
              <StateView
                title={
                  readOnly ? "No messages yet" : "Ready for the first prompt"
                }
                message={
                  readOnly
                    ? "Messages sent from the desktop appear here."
                    : "Write a message below. The desktop agent runs it and keeps the history."
                }
              />
            )
          }
          ListFooterComponent={
            <View>
              {stream ? <StreamingMessage stream={stream} /> : null}
              {requests.map((request) => (
                <PendingRequestCard
                  key={request.id}
                  request={request}
                  busy={busyRequest === request.id}
                  readOnly={readOnly}
                  onRespond={(response) => {
                    if (!api) return
                    setBusyRequest(request.id)
                    void resolveRequest(api, request, response)
                      .catch((error) =>
                        Alert.alert(
                          "Response failed",
                          remoteErrorMessage(error)
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
                  disabled={
                    !currentModel || connectionState === "offline" || readOnly
                  }
                  onPress={() => {
                    if (action.label === "Edit") {
                      setDraft(action.command)
                      return
                    }
                    if (api && currentModel)
                      void send(
                        api,
                        threadId,
                        action.command,
                        currentModel
                      ).catch((error) =>
                        Alert.alert(
                          "Goal update failed",
                          remoteErrorMessage(error)
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
      {notice ? (
        <View style={styles.notice} testID="permission-notice">
          <Info size={15} color={colors.textSecondary} />
          <View style={styles.noticeCopy}>
            <Text style={styles.noticeTitle}>{notice.title}</Text>
            <Text style={styles.noticeText}>{notice.description}</Text>
          </View>
          <IconButton
            icon={X}
            label="Dismiss"
            onPress={() => setNotice(null)}
          />
        </View>
      ) : null}
      {readOnly ? null : <QueuedMessages threadId={threadId} />}
      {readOnly ? (
        <View style={styles.readOnly} testID="read-only-banner">
          <Eye size={16} color={colors.textSecondary} />
          <Text style={styles.readOnlyText}>
            This phone can only watch: it paired over plain HTTP from outside
            your network. Pair it over Wi-Fi, Tailscale or HTTPS to send
            messages.
          </Text>
        </View>
      ) : (
        <ChatComposer
          value={draft}
          onChange={setDraft}
          onSend={() => void submit()}
          onQueue={queueDraft}
          onStop={() => void stop()}
          onChooseModel={() => setPickerOpen(true)}
          model={currentModel}
          running={isRunning}
          disabled={connectionState !== "online" || !thread}
          thinkingMode={turnOptions?.thinkingMode ?? null}
          onThinkingModeChange={(mode) =>
            setTurnOptions(threadId, { thinkingMode: mode })
          }
          fastMode={turnOptions?.fastMode ?? false}
          onFastModeChange={(fastMode) =>
            setTurnOptions(threadId, { fastMode })
          }
          permissionLevel={composerSettings.permissionLevel}
          onPermissionLevelChange={choosePermission}
          chatMode={composerSettings.chatMode}
          onChatModeChange={(chatMode) =>
            useComposerSettings.getState().update(threadId, { chatMode })
          }
        />
      )}
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
  earlier: {
    minHeight: 44,
    marginBottom: spacing.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  earlierText: {
    color: colors.textSecondary,
    fontFamily: font.medium,
    fontSize: type.small,
  },
  readOnly: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.xs,
  },
  readOnlyText: {
    flex: 1,
    color: colors.textSecondary,
    fontFamily: font.regular,
    fontSize: type.small,
    lineHeight: 20,
  },
  notice: {
    marginHorizontal: spacing.sm,
    marginBottom: spacing.xxs,
    paddingLeft: spacing.sm,
    paddingVertical: spacing.xxs,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
  },
  noticeCopy: { flex: 1, minWidth: 0, paddingVertical: spacing.xxs },
  noticeTitle: { color: colors.text, fontFamily: font.medium, fontSize: 13 },
  noticeText: {
    marginTop: 2,
    color: colors.textSecondary,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
  },
  messagesEmpty: { flexGrow: 1 },
  footerSpace: { height: spacing.sm },
})
