import { forwardRef, useCallback, useImperativeHandle, useRef } from "react"
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
  const waiting = useRef(new Map<string, (text: string) => void>())

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
          waiting.current.set(requestId, (text) => {
            clearTimeout(timer)
            resolve(text)
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
        const resolve = waiting.current.get(event.requestId)
        waiting.current.delete(event.requestId)
        resolve?.(event.text)
        return
      }
      onEvent(event)
    },
    [onEvent]
  )

  return (
    <View style={styles.wrap} testID="code-editor">
      <WebView
        ref={webview}
        source={{ html: EDITOR_HTML }}
        originWhitelist={["about:*"]}
        // The page itself, and nothing it might try to open.
        onShouldStartLoadWithRequest={(request) =>
          request.url.startsWith("about:")
        }
        onMessage={onMessage}
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
