import { useCallback, useEffect, useRef, useState } from "react"
import { KeyboardAvoidingView, StyleSheet, Text, View } from "react-native"
import { useLocalSearchParams, useRouter } from "expo-router"
import { ArrowLeft, Power } from "lucide-react-native"
import { REMOTE_FEATURES } from "@betterc0de/schema/remote-protocol"
import {
  TERMINAL_METHODS,
  terminalListResultSchema,
  type TerminalSummary,
} from "@betterc0de/schema/remote-terminal"
import { ActionButton } from "@/components/action-button"
import { IconButton } from "@/components/icon-button"
import { Screen, StateView } from "@/components/layout"
import { TerminalKeys } from "@/components/terminal-keys"
import {
  TerminalView,
  type TerminalViewHandle,
} from "@/components/terminal-view"
import { colors, font, radius, spacing, type } from "@/design/theme"
import { effectiveThreadRoot } from "@/lib/endpoint"
import { useAppStore } from "@/store/app-store"
import { useSessionStore } from "@/store/session-store"
import { withModifiers, type Modifiers } from "@/terminal/modifiers"
import type { TerminalKey, TerminalPageEvent } from "@/terminal/page-protocol"
import { TerminalClient } from "@/terminal/terminal-client"
import {
  onTerminalFrame,
  rememberedTerminal,
  rememberTerminal,
  terminalCall,
} from "@/terminal/terminal-link"
import {
  TERMINAL_SETTING,
  terminalClosedMessage,
  terminalProblem,
} from "@/terminal/terminal-problems"
import { useFeature, useReadOnly } from "@/transport/use-transport"

function firstParam(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? ""
}

/** Output kept on the phone, for a page that starts over. */
const KEPT_OUTPUT_CHARS = 256 * 1024

/** A note of the app's own in the terminal, dimmed. */
const note = (text: string) => `\r\n\u001b[2m${text}\u001b[0m\r\n`

type Phase = "waiting" | "opening" | "running" | "exited" | "ended"

const NO_MODIFIERS: Modifiers = { ctrl: false, alt: false }

/**
 * A terminal on the desktop, in the chat's folder (its worktree, if it has
 * one), over the desktop's stream (@betterc0de/schema/remote-terminal).
 * Going back leaves it running: it is taken up again, with its output,
 * the next time the terminal opens here. It ends with End, with its
 * program, or on the desktop.
 */
export default function TerminalScreen() {
  const params = useLocalSearchParams<{ id: string | string[] }>()
  const threadId = firstParam(params.id)
  const router = useRouter()
  const readOnly = useReadOnly()
  const supported = useFeature(REMOTE_FEATURES.terminal)
  const granted = useSessionStore(
    (state) => state.protocol?.capabilities?.terminalGranted === true
  )
  const live = useSessionStore((state) => state.socketState === "live")
  const thread = useAppStore((state) =>
    state.threads.find((item) => item.id === threadId)
  )
  const root = thread ? effectiveThreadRoot(thread) : ""
  const available = !readOnly && supported && granted && Boolean(root)

  const view = useRef<TerminalViewHandle>(null)
  const client = useRef<TerminalClient | null>(null)
  /** What the page showed, for a page that starts over. */
  const kept = useRef("")
  const size = useRef({ cols: 80, rows: 24 })
  const pageStarted = useRef(false)
  const away = useRef(false)
  const modifiers = useRef<Modifiers>(NO_MODIFIERS)
  const [pageShown, setPageShown] = useState(false)
  const [phase, setPhase] = useState<Phase>("waiting")
  const [problem, setProblem] = useState<string | null>(null)
  const [held, setHeld] = useState<Modifiers>(NO_MODIFIERS)

  const show = useCallback((data: string) => {
    kept.current = (kept.current + data).slice(-KEPT_OUTPUT_CHARS)
    view.current?.send({ type: "output", data })
  }, [])

  /** Opens a terminal here, or takes up the one the phone left running. */
  const start = useCallback(
    async (fresh: boolean) => {
      client.current?.stop()
      const terminals: TerminalClient = new TerminalClient(terminalCall, {
        output: show,
        gap: () =>
          show(
            note(
              "Some output was more than the desktop keeps for the phone, and is not shown."
            )
          ),
        exit: (exitCode) => {
          if (client.current !== terminals) return
          rememberTerminal(root, null)
          setPhase("exited")
          show(
            note(
              exitCode === null
                ? "The program ended."
                : `The program ended with ${exitCode}.`
            )
          )
        },
        closed: (reason) => {
          if (client.current !== terminals) return
          rememberTerminal(root, null)
          setPhase("ended")
          setProblem(terminalClosedMessage(reason))
        },
        failed: (error) => {
          if (client.current !== terminals) return
          setPhase("ended")
          setProblem(terminalProblem(error))
        },
      })
      client.current = terminals
      setPhase("opening")
      setProblem(null)
      try {
        const left = fresh ? undefined : rememberedTerminal(root)
        const running = left
          ? terminalListResultSchema
              .parse(await terminalCall(TERMINAL_METHODS.list, {}))
              .terminals.find(
                (terminal) =>
                  terminal.terminalId === left && terminal.status === "running"
              )
          : undefined
        if (client.current !== terminals) return
        const summary: TerminalSummary = running
          ? await terminals.adopt(running)
          : await terminals.open(root, size.current.cols, size.current.rows)
        if (client.current !== terminals) return
        rememberTerminal(root, summary.terminalId)
        setPhase("running")
        view.current?.send({ type: "focus" })
      } catch (error) {
        if (client.current !== terminals) return
        terminals.stop()
        setPhase("ended")
        setProblem(terminalProblem(error))
      }
    },
    [root, show]
  )

  const type = useCallback((data: string) => {
    const terminals = client.current
    if (!terminals || terminals.isEnded) return
    terminals.write(withModifiers(data, modifiers.current))
    if (modifiers.current.ctrl || modifiers.current.alt) {
      modifiers.current = NO_MODIFIERS
      setHeld(NO_MODIFIERS)
    }
  }, [])

  const onEvent = useCallback(
    (event: TerminalPageEvent) => {
      switch (event.type) {
        case "ready":
          size.current = { cols: event.cols, rows: event.rows }
          if (pageStarted.current) {
            // The page started over: what it showed goes back on it.
            if (kept.current)
              view.current?.send({ type: "output", data: kept.current })
          } else {
            pageStarted.current = true
            setPageShown(true)
          }
          return
        case "input":
          type(event.data)
          return
        case "resize":
          size.current = { cols: event.cols, rows: event.rows }
          void client.current
            ?.resize(event.cols, event.rows)
            .catch(() => undefined)
          return
        case "error":
          return
      }
    },
    [type]
  )

  // The page is there and the desktop offers a terminal: open one.
  useEffect(() => {
    if (!available || !pageShown || client.current) return
    void start(false)
  }, [available, pageShown, start])

  // Without a connection the terminal waits; with the next one it goes on
  // after the output the phone has, and input the desktop did not apply
  // goes again.
  useEffect(() => {
    const terminals = client.current
    if (!terminals || terminals.isEnded || !terminals.id) return
    if (!live) {
      if (!away.current) {
        away.current = true
        terminals.detached()
      }
      return
    }
    if (!away.current) return
    away.current = false
    terminals.attach().catch((error: unknown) => {
      if (client.current !== terminals) return
      terminals.stop()
      setPhase("ended")
      setProblem(terminalProblem(error))
    })
  }, [live])

  useEffect(
    () => onTerminalFrame((frame) => client.current?.receive(frame) ?? false),
    []
  )

  // Going back leaves the terminal running on the desktop.
  useEffect(
    () => () => {
      client.current?.stop()
      client.current = null
    },
    []
  )

  const end = async () => {
    const terminals = client.current
    if (!terminals) return
    rememberTerminal(root, null)
    setPhase("ended")
    setProblem(terminalClosedMessage("closed"))
    await terminals.close().catch(() => undefined)
  }

  const openNew = () => {
    kept.current = ""
    view.current?.send({ type: "reset" })
    void start(true)
  }

  const hold = (modifier: keyof Modifiers) => {
    modifiers.current = {
      ...modifiers.current,
      [modifier]: !modifiers.current[modifier],
    }
    setHeld(modifiers.current)
  }

  const unavailable = readOnly
    ? "This phone can only watch; a terminal needs a full session."
    : !supported
      ? "Update the desktop to use its terminal from the phone."
      : !granted
        ? `The desktop does not allow terminals from paired devices: turn on ${TERMINAL_SETTING}.`
        : "This chat has no folder on the desktop."
  const folder =
    root.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ?? "Terminal"

  return (
    <Screen edges={["top", "bottom"]}>
      <View style={styles.header}>
        <IconButton
          icon={ArrowLeft}
          label="Back"
          onPress={() => router.back()}
        />
        <View style={styles.headerCopy}>
          <Text style={styles.eyebrow}>
            TERMINAL
            {available && !live
              ? " · RECONNECTING"
              : phase === "opening"
                ? " · OPENING"
                : ""}
          </Text>
          <Text style={styles.title} numberOfLines={1}>
            {folder}
          </Text>
        </View>
        {phase === "running" ? (
          <IconButton
            icon={Power}
            label="End the terminal"
            tone="danger"
            testID="terminal-end"
            onPress={() => void end()}
          />
        ) : null}
      </View>
      {!available ? (
        <StateView title="No terminal here" message={unavailable} />
      ) : (
        // Padding on Android too: the app is edge to edge, so the window no
        // longer shrinks for the keyboard, which would cover the key row.
        <KeyboardAvoidingView behavior="padding" style={styles.body}>
          {problem || phase === "exited" ? (
            <View style={styles.banner} testID="terminal-ended">
              {problem ? (
                <Text style={styles.bannerText}>{problem}</Text>
              ) : null}
              <ActionButton
                label="Open a new terminal"
                testID="terminal-new"
                onPress={openNew}
              />
            </View>
          ) : null}
          <TerminalView ref={view} onEvent={onEvent} />
          {phase === "running" ? (
            <TerminalKeys
              ctrl={held.ctrl}
              alt={held.alt}
              onKey={(key: TerminalKey) =>
                view.current?.send({ type: "key", key })
              }
              onText={type}
              onModifier={hold}
            />
          ) : null}
        </KeyboardAvoidingView>
      )}
    </Screen>
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
  body: { flex: 1 },
  banner: {
    margin: spacing.sm,
    padding: spacing.sm,
    gap: spacing.xs,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  bannerText: {
    color: colors.textSecondary,
    fontFamily: font.regular,
    fontSize: type.small,
  },
})
