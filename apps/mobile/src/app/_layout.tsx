import { useEffect } from "react"
import { Stack } from "expo-router"
import * as SplashScreen from "expo-splash-screen"
import { StatusBar } from "expo-status-bar"
import {
  Figtree_400Regular,
  Figtree_500Medium,
  Figtree_600SemiBold,
  Figtree_700Bold,
  useFonts,
} from "@expo-google-fonts/figtree"
import { AppRuntime } from "@/components/app-runtime"
import { colors } from "@/design/theme"
import { needsUpdate } from "@/lib/compat"
import { useSessionStore } from "@/store/session-store"

// The native splash stays until the fonts are ready; the start screen then
// shows its own progress while the stored pairing is restored.
void SplashScreen.preventAutoHideAsync().catch(() => undefined)

export default function RootLayout() {
  // Figtree is the desktop app's UI font — block first paint until it's
  // ready so nothing flashes in the platform default font.
  const [fontsLoaded] = useFonts({
    Figtree_400Regular,
    Figtree_500Medium,
    Figtree_600SemiBold,
    Figtree_700Bold,
  })
  const paired = useSessionStore((state) => state.profile !== null)
  const updateRequired = useSessionStore((state) =>
    needsUpdate(state.compatibility)
  )
  useEffect(() => {
    if (fontsLoaded) void SplashScreen.hideAsync().catch(() => undefined)
  }, [fontsLoaded])
  if (!fontsLoaded) return null
  return (
    <>
      <StatusBar style="light" />
      <AppRuntime />
      {/* Which screens exist follows the session: leaving a guarded group
          (signed out, update required) lands on the start screen, which
          routes onwards. No screen redirects on its own. */}
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.canvas },
          animation: "slide_from_right",
        }}
      >
        <Stack.Screen name="index" options={{ animation: "none" }} />
        <Stack.Screen name="demo" options={{ animation: "none" }} />
        <Stack.Protected guard={!paired}>
          <Stack.Screen name="pair" options={{ animation: "fade" }} />
        </Stack.Protected>
        <Stack.Protected guard={paired && !updateRequired}>
          <Stack.Screen name="(tabs)" options={{ animation: "fade" }} />
          <Stack.Screen name="chat/[id]" />
          <Stack.Screen name="chat/[id]/files" />
          <Stack.Screen name="chat/[id]/file" />
          <Stack.Screen name="chat/[id]/changes" />
          <Stack.Screen name="chat/[id]/diff" />
          <Stack.Screen name="git/index" />
          <Stack.Screen name="git/diff" />
          <Stack.Screen name="git/history" />
        </Stack.Protected>
        <Stack.Protected guard={paired && updateRequired}>
          <Stack.Screen
            name="update-required"
            options={{ animation: "fade" }}
          />
        </Stack.Protected>
      </Stack>
    </>
  )
}
