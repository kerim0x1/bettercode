import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react"
import { AccessibilityInfo, StyleSheet, View } from "react-native"
import { WebView, type WebViewMessageEvent } from "react-native-webview"
import {
  parseTerminalPageEvent,
  type TerminalPageCommand,
  type TerminalPageEvent,
} from "@/terminal/page-protocol"
import { TERMINAL_HTML } from "@/terminal/terminal-html"

export interface TerminalViewHandle {
  send(command: TerminalPageCommand): void
}

/**
 * The terminal (xterm.js) in a WebView that shows nothing but its own page:
 * no navigation, no files, no storage, no other windows, and a CSP that
 * lets it load nothing (scripts/build-mobile-pages.mjs). Events the page
 * sends are checked before they reach `onEvent`. When the system ends the
 * page's process, a new WebView starts it again, and it says ready again.
 *
 * The page learns whether VoiceOver or TalkBack runs, when it is ready and
 * whenever that changes: only then does xterm read the terminal out, since
 * its screen reader mode takes a phone keyboard's typing on a path that
 * lost characters on a slow device.
 */
export const TerminalView = forwardRef<
  TerminalViewHandle,
  { onEvent: (event: TerminalPageEvent) => void }
>(function TerminalView({ onEvent }, ref) {
  const webview = useRef<WebView>(null)
  const [generation, setGeneration] = useState(0)
  const screenReader = useRef(false)
  const pageReady = useRef(false)

  const send = useCallback((command: TerminalPageCommand) => {
    webview.current?.postMessage(JSON.stringify(command))
  }, [])

  useImperativeHandle(ref, () => ({ send }), [send])

  useEffect(() => {
    let active = true
    const tell = (enabled: boolean) => {
      if (!active) return
      screenReader.current = enabled
      if (pageReady.current) send({ type: "screenReader", enabled })
    }
    void AccessibilityInfo.isScreenReaderEnabled().then(tell, () => undefined)
    const subscription = AccessibilityInfo.addEventListener(
      "screenReaderChanged",
      tell
    )
    return () => {
      active = false
      subscription.remove()
    }
  }, [send])

  const onMessage = useCallback(
    (message: WebViewMessageEvent) => {
      const event = parseTerminalPageEvent(message.nativeEvent.data)
      if (!event) return
      if (event.type === "ready") {
        pageReady.current = true
        send({ type: "screenReader", enabled: screenReader.current })
      }
      onEvent(event)
    },
    [onEvent, send]
  )

  // Android would end the app with the page's process unless this is
  // handled; iOS leaves a blank page.
  const restart = useCallback(() => {
    pageReady.current = false
    setGeneration((value) => value + 1)
  }, [])

  return (
    <View style={styles.wrap} testID="terminal-view">
      <WebView
        key={generation}
        ref={webview}
        source={{ html: TERMINAL_HTML }}
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
