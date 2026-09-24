import { useEffect } from "react"
import { ActivityIndicator, View } from "react-native"
import { Redirect, useLocalSearchParams } from "expo-router"
import { colors } from "@/design/theme"
import { useSessionStore } from "@/store/session-store"

/**
 * `betterc0de://demo` opens the demo, which is how the end-to-end flows and
 * App Review reach it without tapping through the pairing screen.
 * `?speed=instant` streams replies without delays (tests only). A phone
 * that is paired with a desktop ignores the link.
 */
export default function DemoRoute() {
  const params = useLocalSearchParams<{ speed?: string }>()
  const mode = useSessionStore((state) => state.mode)
  const hydrating = useSessionStore((state) => state.state === "hydrating")
  const startDemo = useSessionStore((state) => state.startDemo)
  const instant = params.speed === "instant"

  useEffect(() => {
    if (!hydrating && mode === null)
      startDemo(instant ? { chunkDelayMs: 0 } : undefined)
  }, [hydrating, instant, mode, startDemo])

  if (mode !== null) return <Redirect href="/(tabs)" />
  return (
    <View
      style={{
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: colors.canvas,
      }}
    >
      <ActivityIndicator color={colors.textSecondary} />
    </View>
  )
}
