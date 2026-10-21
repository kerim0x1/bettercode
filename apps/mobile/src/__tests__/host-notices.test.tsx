import { afterEach, describe, expect, it } from "@jest/globals"
import { screen } from "@testing-library/react-native"
import { renderRouter } from "expo-router/testing-library"
import type { RemoteAccessLevel } from "@betterc0de/schema/remote-protocol"
import SettingsScreen from "@/app/(tabs)/settings"
import { useSessionStore } from "@/store/session-store"
import { pairWithTestDesktop } from "./support/sessions"

afterEach(async () => {
  await useSessionStore.getState().forget()
})

/**
 * A phone paired with the test desktop at its plain `http://` LAN address.
 * The Host screen checks the connection when it opens; the desktop answers
 * with the same session and protocol it paired with.
 */
async function openHostScreen(accessLevel: RemoteAccessLevel) {
  pairWithTestDesktop({
    accessLevel,
    api: (demo) => ({
      bootstrap: async () => {
        const { profile, protocol } = useSessionStore.getState()
        return {
          ...(await demo.bootstrap()),
          session: profile?.session ?? null,
          protocol,
        }
      },
    }),
  })
  await renderRouter(
    { "(tabs)/settings": SettingsScreen },
    { initialUrl: "/settings" }
  )
}

describe("the Host screen on a plain HTTP address", () => {
  it("says a session paired over the local network is read-only for one hour", async () => {
    await openHostScreen("read_only")
    expect(await screen.findByTestId("read-only-notice")).toBeTruthy()
    expect(
      screen.getByText(/Pair it again over Tailscale or HTTPS/)
    ).toBeTruthy()
    expect(screen.getByTestId("plain-http-notice")).toBeTruthy()
    expect(
      screen.getByText(
        /gives this phone a read-only session that lasts one hour/
      )
    ).toBeTruthy()
    expect(screen.getByText("Watch only")).toBeTruthy()
  })

  it("tells a full session what plain HTTP would give it on Wi-Fi", async () => {
    await openHostScreen("full")
    expect(await screen.findByTestId("plain-http-notice")).toBeTruthy()
    expect(screen.queryByTestId("read-only-notice")).toBeNull()
    expect(
      screen.getByText(
        /Tailscale encrypts it; over Wi-Fi or another local network, the desktop gives a phone only a read-only session that lasts one hour/
      )
    ).toBeTruthy()
  })
})
