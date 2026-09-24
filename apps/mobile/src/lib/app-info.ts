import type { RemoteClientInfo } from "@betterc0de/schema/remote-protocol"
import Constants from "expo-constants"
import * as Device from "expo-device"
import { Platform } from "react-native"

/**
 * The release this build belongs to: the desktop version it shipped with
 * (app.config.ts puts it in `extra.releaseVersion`). iOS only knows the
 * numeric part, so the full version comes from here.
 */
export const APP_VERSION: string =
  (Constants.expoConfig?.extra?.releaseVersion as string | undefined) ??
  Constants.expoConfig?.version ??
  "0.0.0"

/** What the app tells the desktop it is (`X-BetterC0de-Client`). */
export const CLIENT_INFO: RemoteClientInfo = {
  name: "betterc0de-remote",
  version: APP_VERSION,
  platform: Platform.OS,
}

/**
 * The device's name in the desktop's "Paired devices" list, e.g.
 * "iPad Pro 11-inch · BetterC0de". The model, not the owner's device name,
 * so no personal name leaves the phone unasked.
 */
export function defaultDeviceLabel(): string {
  const fallback =
    Platform.OS === "ios"
      ? "iPhone"
      : Platform.OS === "android"
        ? "Android phone"
        : "Browser"
  return `${Device.modelName?.trim() || fallback} · BetterC0de`
}
