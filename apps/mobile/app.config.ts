import fs from "node:fs"
import path from "node:path"

import type { ConfigContext, ExpoConfig } from "expo/config"

import { androidVersionCode, iosMarketingVersion } from "./config/version.cjs"

/**
 * The published app's Expo project. These are public identifiers, not
 * secrets: EAS builds and push tokens need them. A fork builds against its
 * own project by setting BETTERC0DE_EAS_PROJECT_ID and BETTERC0DE_EXPO_OWNER.
 */
const PUBLISHED_EAS_PROJECT_ID: string | null = null
const PUBLISHED_EXPO_OWNER: string | null = null

/** Matches the desktop's --background and the app canvas (src/design/theme.ts). */
const CANVAS = "#0A0A0A"

/**
 * The app ships with every desktop release and carries its version (see
 * config/version.cjs for how that maps onto the stores' formats).
 */
function desktopReleaseVersion(): string {
  const rootManifest = path.join(__dirname, "..", "..", "package.json")
  const { version } = JSON.parse(fs.readFileSync(rootManifest, "utf8")) as {
    version?: unknown
  }
  if (typeof version !== "string") {
    throw new Error("The root package.json has no version.")
  }
  return version
}

function optionalEnv(name: string): string | null {
  const value = process.env[name]?.trim()
  return value ? value : null
}

export default function appConfig({ config }: ConfigContext): ExpoConfig {
  const releaseVersion = desktopReleaseVersion()
  const projectId =
    optionalEnv("BETTERC0DE_EAS_PROJECT_ID") ?? PUBLISHED_EAS_PROJECT_ID
  const owner = optionalEnv("BETTERC0DE_EXPO_OWNER") ?? PUBLISHED_EXPO_OWNER
  // Firebase's Android config is injected by the release build from a
  // secret; the repository is public and test builds run without it.
  const googleServicesFile = optionalEnv("BETTERC0DE_GOOGLE_SERVICES_JSON")

  return {
    ...config,
    name: "BetterC0de Remote",
    slug: "betterc0de-remote",
    ...(owner ? { owner } : {}),
    version: releaseVersion,
    orientation: "portrait",
    icon: "./assets/icon.png",
    scheme: "betterc0de",
    userInterfaceStyle: "dark",
    backgroundColor: CANVAS,
    plugins: [
      "expo-router",
      "expo-secure-store",
      [
        "expo-camera",
        {
          cameraPermission:
            "BetterC0de Remote uses the camera only to scan the pairing QR code shown by the desktop app.",
          microphonePermission: false,
          recordAudioAndroid: false,
          barcodeScannerEnabled: true,
        },
      ],
      [
        "expo-splash-screen",
        {
          image: "./assets/splash-icon.png",
          imageWidth: 160,
          resizeMode: "contain",
          backgroundColor: CANVAS,
        },
      ],
      [
        "expo-build-properties",
        {
          android: {
            // The desktop is reached by LAN or Tailscale IP address, which
            // Android's network security config cannot allow by range. See
            // docs/remote-access.md ("Plain HTTP on the phone").
            usesCleartextTraffic: true,
            // Covers phones (arm64, 32-bit ARM) and the x86_64 emulator that
            // tests the exact APK that ships.
            buildArchs: ["arm64-v8a", "armeabi-v7a", "x86_64"],
            // Compressed native libraries roughly halve the universal APK.
            useLegacyPackaging: true,
          },
        },
      ],
      "./plugins/with-android-release-signing.cjs",
    ],
    experiments: {
      typedRoutes: true,
    },
    ios: {
      version: iosMarketingVersion(releaseVersion),
      supportsTablet: true,
      bundleIdentifier: "com.betterc0de.remote",
      infoPlist: {
        NSLocalNetworkUsageDescription:
          "BetterC0de Remote connects to the BetterC0de desktop app on your local network or tailnet.",
        NSAppTransportSecurity: {
          // Plain HTTP to .local and unqualified host names. IP addresses
          // (LAN, Tailscale 100.x) are not subject to ATS. Tailscale's
          // MagicDNS names are full host names and need their own exception.
          NSAllowsLocalNetworking: true,
          NSExceptionDomains: {
            "ts.net": {
              NSIncludesSubdomains: true,
              NSExceptionAllowsInsecureHTTPLoads: true,
            },
          },
        },
        ITSAppUsesNonExemptEncryption: false,
      },
    },
    android: {
      version: releaseVersion,
      versionCode: androidVersionCode(releaseVersion),
      package: "com.betterc0de.remote",
      adaptiveIcon: {
        foregroundImage: "./assets/adaptive-foreground.png",
        monochromeImage: "./assets/adaptive-monochrome.png",
        backgroundColor: CANVAS,
      },
      permissions: ["android.permission.CAMERA"],
      ...(googleServicesFile ? { googleServicesFile } : {}),
    },
    web: {
      bundler: "metro",
    },
    extra: {
      router: {},
      /** The full desktop version, which the app reports to the desktop. */
      releaseVersion,
      ...(projectId ? { eas: { projectId } } : {}),
    },
  }
}
