import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useRef,
  useState,
} from "react"
import { StyleSheet, View } from "react-native"
import { WebView, type WebViewMessageEvent } from "react-native-webview"
import { EDITOR_HTML } from "@/editor/editor-html"
import {
  parseEditorEvent,
  type EditorCommand,
  type EditorEvent,
} from "@/editor/protocol"
import { createId } from "@/lib/ids"

export interface CodeEditorHandle {
  send(command: EditorCommand): void
  /** The editor's text as it is now. */
  text(): Promise<string>
}

/** How long the editor may take to hand over its text. */
const TEXT_TIMEOUT_MS = 5_000

interface Waiter {
  resolve(text: string): void
  reject(error: Error): void
}

/**
 * The code editor (CodeMirror 6) in a WebView that shows nothing but its
 * own page: no navigation, no files, no storage, no other windows. The
 * page's CSP lets it load nothing either (scripts/build-mobile-editor.mjs).
 * Events the page sends are checked before they reach `onEvent`.
 */
export const CodeEditor = forwardRef<
  CodeEditorHandle,
  { onEvent: (event: Exclude<EditorEvent, { type: "text" }>) => void }
>(function CodeEditor({ onEvent }, ref) {
  const webview = useRef<WebView>(null)
  const waiting = useRef(new Map<string, Waiter>())
  /** A new WebView, when the system ended the last one's page. */
  const [generation, setGeneration] = useState(0)

  useImperativeHandle(
    ref,
    () => ({
      send: (command) => webview.current?.postMessage(JSON.stringify(command)),
      text: () =>
        new Promise<string>((resolve, reject) => {
          const requestId = createId("text")
          const timer = setTimeout(() => {
            waiting.current.delete(requestId)
            reject(new Error("The editor did not hand over its text."))
          }, TEXT_TIMEOUT_MS)
          waiting.current.set(requestId, {
            resolve: (text) => {
              clearTimeout(timer)
              resolve(text)
            },
            reject: (error) => {
              clearTimeout(timer)
              reject(error)
            },
          })
          webview.current?.postMessage(
            JSON.stringify({ type: "requestText", requestId })
          )
        }),
    }),
    []
  )

  const onMessage = useCallback(
    (message: WebViewMessageEvent) => {
      const event = parseEditorEvent(message.nativeEvent.data)
      if (!event) return
      if (event.type === "text") {
        const waiter = waiting.current.get(event.requestId)
        waiting.current.delete(event.requestId)
        if (event.text === null) {
          waiter?.reject(new Error("The editor has no text to hand over."))
        } else waiter?.resolve(event.text)
        return
      }
      onEvent(event)
    },
    [onEvent]
  )

  // The system can end the page's process: for memory, or while the app is
  // in the background. Android would end the app with it unless this is
  // handled. A new WebView starts the page again, which says ready again.
  const restart = useCallback(() => {
    for (const waiter of waiting.current.values()) {
      waiter.reject(new Error("The editor started over."))
    }
    waiting.current.clear()
    setGeneration((value) => value + 1)
  }, [])

  return (
    <View style={styles.wrap} testID="code-editor">
      <WebView
        key={generation}
        ref={webview}
        source={{ html: EDITOR_HTML }}
        originWhitelist={["about:*"]}
        // The page itself, and nothing it might try to open.
        onShouldStartLoadWithRequest={(request) =>
          request.url.startsWith("about:")
        }
        onMessage={onMessage}
        onRenderProcessGone={restart}
        onContentProcessDidTerminate={restart}
        javaScriptEnabled
        domStorageEnabled={false}
        cacheEnabled={false}
        incognito
        allowFileAccess={false}
        allowFileAccessFromFileURLs={false}
        allowUniversalAccessFromFileURLs={false}
        setSupportMultipleWindows={false}
        mixedContentMode="never"
        keyboardDisplayRequiresUserAction={false}
        hideKeyboardAccessoryView
        automaticallyAdjustContentInsets={false}
        contentInsetAdjustmentBehavior="never"
        bounces={false}
        overScrollMode="never"
        style={styles.webview}
      />
    </View>
  )
})

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: "#0A0A0A" },
  webview: { flex: 1, backgroundColor: "#0A0A0A" },
})
