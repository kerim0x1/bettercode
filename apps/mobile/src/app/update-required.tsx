import { useState } from "react"
import {
  ActivityIndicator,
  Alert,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native"
import { useRouter } from "expo-router"
import { Download, LogOut, RefreshCw } from "lucide-react-native"
import { BrandMark, Screen } from "@/components/layout"
import {
  colors,
  font,
  minTouchTarget,
  radius,
  spacing,
  type,
} from "@/design/theme"
import { APP_VERSION } from "@/lib/app-info"
import { useSessionStore } from "@/store/session-store"

/** Android builds are published with each desktop release. */
const ANDROID_DOWNLOAD =
  "https://github.com/kerim0x1/bettercode/releases/latest"
/** iOS builds arrive through TestFlight, which installs updates itself. */
const TESTFLIGHT = "itms-beta://"
const TESTFLIGHT_STORE = "https://apps.apple.com/app/testflight/id899247664"

/**
 * The desktop needs a newer app, or this app a newer desktop. The pairing
 * stays valid: after the update the app connects again without a new
 * pairing code.
 */
export default function UpdateRequiredScreen() {
  const router = useRouter()
  const compatibility = useSessionStore((state) => state.compatibility)
  const check = useSessionStore((state) => state.check)
  const logout = useSessionStore((state) => state.logout)
  const forget = useSessionStore((state) => state.forget)
  const [checking, setChecking] = useState(false)
  const minimum =
    compatibility.kind === "app_update_required"
      ? compatibility.minClientVersion
      : null
  const desktopTooOld = compatibility.kind === "desktop_update_required"

  const openUpdate = async () => {
    try {
      await Linking.openURL(
        Platform.OS === "ios" ? TESTFLIGHT : ANDROID_DOWNLOAD
      )
    } catch {
      await Linking.openURL(
        Platform.OS === "ios" ? TESTFLIGHT_STORE : ANDROID_DOWNLOAD
      ).catch(() => undefined)
    }
  }

  const checkAgain = async () => {
    setChecking(true)
    try {
      await check()
    } finally {
      setChecking(false)
    }
  }

  const signOut = async () => {
    const result = await logout()
    if (!result.revoked) {
      Alert.alert("The desktop could not be told", result.error, [
        { text: "Keep", style: "cancel" },
        {
          text: "Forget on this phone",
          style: "destructive",
          onPress: () => void forget(),
        },
      ])
      return
    }
    router.replace("/pair")
  }

  return (
    <Screen edges={["top", "bottom"]}>
      <View style={styles.wrap} testID="update-required">
        <BrandMark />
        <Text style={styles.title}>
          {desktopTooOld
            ? "Update BetterC0de on the desktop"
            : "Update BetterC0de Remote"}
        </Text>
        <Text style={styles.message}>
          {desktopTooOld
            ? `This version of the app (${APP_VERSION}) needs a newer BetterC0de desktop app. Update BetterC0de on your computer, then check again.`
            : minimum
              ? `This desktop needs version ${minimum} or newer of the app. This is ${APP_VERSION}.`
              : `This desktop needs a newer version of the app. This is ${APP_VERSION}.`}{" "}
          Your pairing stays: after the update the app connects again by itself.
        </Text>
        {desktopTooOld ? null : (
          <Pressable
            accessibilityRole="button"
            onPress={() => void openUpdate()}
            style={({ pressed }) => [styles.primary, pressed && styles.pressed]}
          >
            <Download size={17} color={colors.primaryForeground} />
            <Text style={styles.primaryText}>
              {Platform.OS === "ios"
                ? "Open TestFlight"
                : "Download the update"}
            </Text>
          </Pressable>
        )}
        <Pressable
          accessibilityRole="button"
          disabled={checking}
          onPress={() => void checkAgain()}
          style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}
        >
          {checking ? (
            <ActivityIndicator color={colors.text} />
          ) : (
            <RefreshCw size={16} color={colors.text} />
          )}
          <Text style={styles.secondaryText}>Check again</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={() => void signOut()}
          style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}
        >
          <LogOut size={16} color={colors.danger} />
          <Text style={[styles.secondaryText, styles.danger]}>
            Sign out this phone
          </Text>
        </Pressable>
      </View>
    </Screen>
  )
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    justifyContent: "center",
    padding: spacing.lg,
    gap: spacing.md,
  },
  title: {
    color: colors.text,
    fontFamily: font.bold,
    fontSize: 26,
    letterSpacing: -0.6,
  },
  message: {
    color: colors.textSecondary,
    fontFamily: font.regular,
    fontSize: type.body,
    lineHeight: type.lineHeight,
  },
  primary: {
    minHeight: 48,
    marginTop: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.primary,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.xs,
  },
  primaryText: {
    color: colors.primaryForeground,
    fontFamily: font.semibold,
    fontSize: type.small,
  },
  secondary: {
    minHeight: minTouchTarget,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.xs,
  },
  secondaryText: {
    color: colors.text,
    fontFamily: font.semibold,
    fontSize: type.small,
  },
  danger: { color: colors.danger },
  pressed: { opacity: 0.7 },
})
