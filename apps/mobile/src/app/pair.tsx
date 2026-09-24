import { useEffect, useState } from "react"
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native"
import { CameraView, useCameraPermissions } from "expo-camera"
import * as Linking from "expo-linking"
import { useRouter } from "expo-router"
import {
  FlaskConical,
  Info,
  Keyboard,
  Link2,
  LockKeyhole,
  QrCode,
  ScanLine,
  X,
} from "lucide-react-native"
import { SafeAreaView } from "react-native-safe-area-context"
import { BrandMark, Screen } from "@/components/layout"
import {
  colors,
  font,
  minTouchTarget,
  radius,
  spacing,
  type,
} from "@/design/theme"
import { parsePairingInput } from "@/lib/endpoint"
import { useSessionStore } from "@/store/session-store"

type Mode = "scan" | "manual"

/**
 * Pairing flow, mirroring the desktop's "Pair a device" card: the desktop
 * (Settings → Remote Access) shows a one-time QR code + link, and this
 * screen offers the two matching entry paths as an explicit choice — scan
 * the QR with the camera, or enter the link / address + code manually.
 * A successful scan pairs immediately; manual entry pairs on Connect.
 */
export default function PairScreen() {
  const router = useRouter()
  const pair = useSessionStore((store) => store.pair)
  const startDemo = useSessionStore((store) => store.startDemo)
  const state = useSessionStore((store) => store.state)
  const storeError = useSessionStore((store) => store.error)
  const notice = useSessionStore((store) => store.notice)
  const [mode, setMode] = useState<Mode>("scan")
  const [input, setInput] = useState("")
  const [host, setHost] = useState("")
  const [label, setLabel] = useState("")
  const [splitEntry, setSplitEntry] = useState(false)
  const [scannerOpen, setScannerOpen] = useState(false)
  const [scanned, setScanned] = useState(false)
  const [permission, requestPermission] = useCameraPermissions()
  const incomingUrl = Linking.useURL()
  const pairing = state === "pairing"
  const cameraBlocked =
    permission && !permission.granted && !permission.canAskAgain

  useEffect(() => {
    if (!incomingUrl || state !== "unpaired") return
    try {
      parsePairingInput(incomingUrl)
      setInput(incomingUrl)
      setMode("manual")
    } catch {
      // A normal web-preview URL is not a pairing link.
    }
  }, [incomingUrl, state])

  const submit = async (override?: string) => {
    const value = override ?? input
    try {
      await pair(value, splitEntry && !override ? host : undefined, label)
      router.replace("/(tabs)")
    } catch {
      // The store provides the actionable error directly below the form.
    }
  }

  const openScanner = async () => {
    const granted = permission?.granted || (await requestPermission()).granted
    if (!granted) return
    setScanned(false)
    setScannerOpen(true)
  }

  const manualIncomplete = !input.trim() || (splitEntry && !host.trim())

  const tryDemo = () => {
    startDemo()
    router.replace("/(tabs)")
  }

  return (
    <Screen edges={["top", "bottom"]} testID="pair-screen">
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.hero}>
            <BrandMark />
            <Text style={styles.heading}>
              Your agent.{"\n"}Now in your pocket.
            </Text>
            <Text style={styles.lead}>
              Pair once with your running BetterC0de desktop app. Chats,
              approvals and project files stay under your control.
            </Text>
          </View>

          {notice ? (
            <View style={styles.notice} testID="pair-notice">
              <Info size={17} color={colors.warning} />
              <Text style={styles.noticeText}>{notice.message}</Text>
            </View>
          ) : null}

          <View style={styles.panel}>
            {/* Scan vs manual — the same two paths the desktop QR card offers. */}
            <View style={styles.modeSwitch}>
              <ModeTab
                active={mode === "scan"}
                icon={<ScanLine size={14} color={modeColor(mode === "scan")} />}
                label="Scan QR"
                testID="pair-scan-tab"
                onPress={() => setMode("scan")}
              />
              <ModeTab
                active={mode === "manual"}
                icon={
                  <Keyboard size={14} color={modeColor(mode === "manual")} />
                }
                label="Enter manually"
                testID="pair-manual-tab"
                onPress={() => setMode("manual")}
              />
            </View>

            {mode === "scan" ? (
              <View style={styles.scanPane}>
                <View style={styles.qrHint}>
                  <QrCode size={40} color={colors.textSecondary} />
                </View>
                <Text style={styles.scanExplain}>
                  On your desktop, open{" "}
                  <Text style={styles.scanExplainStrong}>
                    Settings → Remote Access → Pair a device
                  </Text>{" "}
                  and point your camera at the QR code.
                </Text>
                <Pressable
                  accessibilityRole="button"
                  onPress={openScanner}
                  disabled={Boolean(cameraBlocked)}
                  style={({ pressed }) => [
                    styles.primaryButton,
                    pressed && styles.pressed,
                    cameraBlocked && styles.disabled,
                  ]}
                >
                  <ScanLine size={17} color={colors.primaryForeground} />
                  <Text style={styles.primaryButtonText}>Open camera</Text>
                </Pressable>
                {cameraBlocked ? (
                  <Text style={styles.warning}>
                    Camera access is disabled. Enable it in system settings or
                    enter the code manually.
                  </Text>
                ) : null}
              </View>
            ) : (
              <View style={styles.manualPane}>
                <Text style={styles.fieldLabel}>
                  {splitEntry ? "One-time code" : "Pairing link"}
                </Text>
                <View style={styles.inputShell}>
                  <Link2 size={16} color={colors.textMuted} />
                  <TextInput
                    accessibilityLabel="Pairing link or code"
                    testID="pair-input"
                    value={input}
                    onChangeText={setInput}
                    placeholder={
                      splitEntry
                        ? "ABCD-EFGH-JKLM"
                        : "http://192.168.1.20:3773/#token=…"
                    }
                    placeholderTextColor={colors.textMuted}
                    autoCapitalize="none"
                    autoCorrect={false}
                    style={styles.input}
                  />
                </View>
                {splitEntry ? (
                  <>
                    <Text style={styles.fieldLabel}>Desktop address</Text>
                    <TextInput
                      accessibilityLabel="Desktop address"
                      value={host}
                      onChangeText={setHost}
                      placeholder="192.168.1.20:3773"
                      placeholderTextColor={colors.textMuted}
                      autoCapitalize="none"
                      autoCorrect={false}
                      keyboardType="url"
                      style={styles.advancedInput}
                    />
                    <Text style={styles.fieldLabel}>Device name</Text>
                    <TextInput
                      accessibilityLabel="Device name"
                      value={label}
                      onChangeText={setLabel}
                      placeholder="Device name (optional)"
                      placeholderTextColor={colors.textMuted}
                      style={styles.advancedInput}
                    />
                  </>
                ) : null}
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setSplitEntry(!splitEntry)}
                  style={styles.splitToggle}
                >
                  <Text style={styles.splitToggleText}>
                    {splitEntry
                      ? "Use the full pairing link instead"
                      : "Enter address and code separately"}
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  testID="pair-connect"
                  accessibilityState={{
                    disabled: pairing || manualIncomplete,
                  }}
                  disabled={pairing || manualIncomplete}
                  onPress={() => void submit()}
                  style={({ pressed }) => [
                    styles.primaryButton,
                    pressed && styles.pressed,
                    (pairing || manualIncomplete) && styles.disabled,
                  ]}
                >
                  {pairing ? (
                    <ActivityIndicator color={colors.primaryForeground} />
                  ) : (
                    <LockKeyhole size={17} color={colors.primaryForeground} />
                  )}
                  <Text style={styles.primaryButtonText}>
                    {pairing ? "Pairing…" : "Connect securely"}
                  </Text>
                </Pressable>
              </View>
            )}
            {storeError ? (
              <Text style={styles.error} testID="pair-error">
                {storeError}
              </Text>
            ) : null}
          </View>

          <Pressable
            accessibilityRole="button"
            accessibilityHint="Explore the app with sample chats and files. Nothing connects to a computer."
            testID="pair-demo"
            onPress={tryDemo}
            style={({ pressed }) => [
              styles.demoButton,
              pressed && styles.pressed,
            ]}
          >
            <FlaskConical size={16} color={colors.text} />
            <Text style={styles.demoButtonText}>Try the demo</Text>
          </Pressable>
          <Text style={styles.demoHint}>
            No desktop at hand? The demo shows the app with sample chats and
            files, without connecting to anything.
          </Text>

          <Text style={styles.footnote}>
            The code is single-use. Afterwards only a revocable session token is
            stored encrypted on this device.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>

      <Modal
        visible={scannerOpen}
        animationType="fade"
        onRequestClose={() => setScannerOpen(false)}
      >
        <SafeAreaView style={styles.scanner} edges={["top", "bottom"]}>
          <CameraView
            style={StyleSheet.absoluteFill}
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={
              scanned
                ? undefined
                : ({ data }) => {
                    setScanned(true)
                    setScannerOpen(false)
                    setInput(data)
                    void submit(data)
                  }
            }
          />
          <View style={styles.scannerOverlay}>
            <View style={styles.scannerHeader}>
              <Text style={styles.scannerTitle}>Scan pairing QR</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close scanner"
                onPress={() => setScannerOpen(false)}
                style={styles.scannerClose}
              >
                <X size={20} color={colors.text} />
              </Pressable>
            </View>
            {/* Corner-bracket viewfinder */}
            <View style={styles.scanFrame}>
              <View style={[styles.corner, styles.cornerTL]} />
              <View style={[styles.corner, styles.cornerTR]} />
              <View style={[styles.corner, styles.cornerBL]} />
              <View style={[styles.corner, styles.cornerBR]} />
            </View>
            <View style={styles.scannerFooter}>
              <Text style={styles.scannerHelp}>
                Point the frame at the QR code shown on your desktop under
                Settings → Remote Access.
              </Text>
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  setScannerOpen(false)
                  setMode("manual")
                }}
                style={({ pressed }) => [
                  styles.scannerManual,
                  pressed && styles.pressed,
                ]}
              >
                <Keyboard size={15} color={colors.text} />
                <Text style={styles.scannerManualText}>
                  Enter code manually
                </Text>
              </Pressable>
            </View>
          </View>
        </SafeAreaView>
      </Modal>
    </Screen>
  )
}

function ModeTab({
  active,
  icon,
  label,
  testID,
  onPress,
}: {
  active: boolean
  icon: React.ReactNode
  label: string
  testID?: string
  onPress: () => void
}) {
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      testID={testID}
      onPress={onPress}
      style={[styles.modeTab, active && styles.modeTabActive]}
    >
      {icon}
      <Text style={[styles.modeTabText, active && styles.modeTabTextActive]}>
        {label}
      </Text>
    </Pressable>
  )
}

function modeColor(active: boolean): string {
  return active ? colors.text : colors.textMuted
}

const FRAME = 250
const CORNER = 34

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.xl },
  hero: { paddingTop: spacing.md, gap: spacing.md },
  heading: {
    color: colors.text,
    fontSize: 30,
    lineHeight: 38,
    fontFamily: font.bold,
    letterSpacing: -1.2,
  },
  lead: {
    color: colors.textSecondary,
    fontFamily: font.regular,
    fontSize: 15,
    lineHeight: 23,
    maxWidth: 520,
  },
  panel: {
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    padding: spacing.sm,
    gap: spacing.sm,
  },
  modeSwitch: {
    flexDirection: "row",
    gap: 4,
    borderRadius: radius.md,
    backgroundColor: colors.canvas,
    padding: 4,
  },
  modeTab: {
    flex: 1,
    minHeight: 38,
    borderRadius: radius.sm,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  modeTabActive: { backgroundColor: colors.surfaceActive },
  modeTabText: {
    color: colors.textMuted,
    fontSize: 13,
    fontFamily: font.medium,
  },
  modeTabTextActive: { color: colors.text, fontFamily: font.semibold },

  scanPane: {
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: spacing.sm,
  },
  qrHint: {
    width: 72,
    height: 72,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceActive,
    alignItems: "center",
    justifyContent: "center",
  },
  scanExplain: {
    color: colors.textSecondary,
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 19,
    textAlign: "center",
    paddingHorizontal: spacing.sm,
  },
  scanExplainStrong: { color: colors.text, fontFamily: font.semibold },

  manualPane: { gap: spacing.xs, paddingTop: spacing.xxs },
  fieldLabel: {
    color: colors.textMuted,
    fontSize: 10,
    fontFamily: font.semibold,
    letterSpacing: 0.6,
    textTransform: "uppercase",
    marginTop: 4,
  },
  inputShell: {
    minHeight: 48,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.canvas,
    paddingHorizontal: spacing.sm,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
  },
  input: {
    flex: 1,
    minHeight: 46,
    color: colors.text,
    fontSize: 14,
    fontFamily: type.mono,
  },
  advancedInput: {
    minHeight: 46,
    color: colors.text,
    fontFamily: font.regular,
    fontSize: 14,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.canvas,
    paddingHorizontal: spacing.sm,
  },
  splitToggle: {
    minHeight: minTouchTarget,
    alignSelf: "flex-start",
    justifyContent: "center",
  },
  splitToggleText: {
    color: colors.textSecondary,
    fontSize: 12,
    fontFamily: font.medium,
    textDecorationLine: "underline",
  },

  primaryButton: {
    alignSelf: "stretch",
    minHeight: 48,
    borderRadius: radius.md,
    backgroundColor: colors.primary,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.xs,
  },
  primaryButtonText: {
    color: colors.primaryForeground,
    fontSize: 14,
    fontFamily: font.semibold,
  },
  error: {
    color: colors.danger,
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 19,
    paddingHorizontal: 4,
  },
  warning: {
    color: colors.warning,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 18,
    textAlign: "center",
  },
  disabled: { opacity: 0.38 },
  notice: {
    padding: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: "rgba(251,191,36,0.25)",
    backgroundColor: "rgba(251,191,36,0.06)",
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.xs,
  },
  noticeText: {
    flex: 1,
    color: colors.textSecondary,
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 19,
  },
  demoButton: {
    minHeight: 48,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.xs,
  },
  demoButtonText: {
    color: colors.text,
    fontSize: 14,
    fontFamily: font.semibold,
  },
  demoHint: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 18,
    textAlign: "center",
    marginTop: -spacing.sm,
  },
  pressed: { opacity: 0.72, transform: [{ scale: 0.99 }] },
  footnote: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 11,
    lineHeight: 17,
    textAlign: "center",
    paddingHorizontal: spacing.lg,
  },

  scanner: { flex: 1, backgroundColor: colors.canvas },
  scannerOverlay: {
    flex: 1,
    padding: spacing.lg,
    backgroundColor: "rgba(0,0,0,0.35)",
    justifyContent: "space-between",
    alignItems: "center",
  },
  scannerHeader: {
    width: "100%",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  scannerTitle: {
    color: colors.text,
    fontSize: 18,
    fontFamily: font.semibold,
  },
  scannerClose: {
    width: minTouchTarget,
    height: minTouchTarget,
    borderRadius: radius.pill,
    backgroundColor: colors.overlay,
    alignItems: "center",
    justifyContent: "center",
  },
  scanFrame: { width: FRAME, height: FRAME },
  corner: {
    position: "absolute",
    width: CORNER,
    height: CORNER,
    borderColor: colors.text,
  },
  cornerTL: {
    top: 0,
    left: 0,
    borderTopWidth: 3,
    borderLeftWidth: 3,
    borderTopLeftRadius: 14,
  },
  cornerTR: {
    top: 0,
    right: 0,
    borderTopWidth: 3,
    borderRightWidth: 3,
    borderTopRightRadius: 14,
  },
  cornerBL: {
    bottom: 0,
    left: 0,
    borderBottomWidth: 3,
    borderLeftWidth: 3,
    borderBottomLeftRadius: 14,
  },
  cornerBR: {
    bottom: 0,
    right: 0,
    borderBottomWidth: 3,
    borderRightWidth: 3,
    borderBottomRightRadius: 14,
  },
  scannerFooter: { width: "100%", gap: spacing.sm, alignItems: "center" },
  scannerHelp: {
    color: colors.text,
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 19,
    textAlign: "center",
    backgroundColor: colors.overlay,
    borderRadius: radius.md,
    padding: spacing.sm,
  },
  scannerManual: {
    minHeight: 42,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    backgroundColor: colors.overlay,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
  },
  scannerManualText: {
    color: colors.text,
    fontSize: 13,
    fontFamily: font.medium,
  },
})
