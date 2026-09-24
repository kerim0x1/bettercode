import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals"
import { act, fireEvent, screen } from "@testing-library/react-native"
import { renderRouter } from "expo-router/testing-library"
import { Alert, type AlertButton, Text } from "react-native"
import SettingsScreen from "@/app/(tabs)/settings"
import UpdateRequiredScreen from "@/app/update-required"
import { useSessionStore } from "@/store/session-store"
import { RemoteApiError } from "@/transport/live/http"
import { pairWithTestDesktop } from "./support/sessions"

let alert: jest.SpiedFunction<typeof Alert.alert>

beforeEach(() => {
  alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined)
})

afterEach(async () => {
  alert.mockRestore()
  await useSessionStore.getState().forget()
})

const unreachable = () =>
  jest.fn(async (): Promise<{ loggedOut: boolean }> => {
    throw new RemoteApiError(
      "The desktop did not answer in time.",
      0,
      "timeout"
    )
  })

/** Presses a button of the alert that is showing. */
async function pressAlertButton(title: string, button: string) {
  const call = alert.mock.calls.findLast(([shown]) => shown === title)
  expect(call).toBeDefined()
  const buttons = (call?.[2] ?? []) as AlertButton[]
  const target = buttons.find((candidate) => candidate.text === button)
  expect(target).toBeDefined()
  await act(async () => {
    target?.onPress?.()
  })
}

const routes = {
  "(tabs)/settings": SettingsScreen,
  "update-required": UpdateRequiredScreen,
  pair: () => <Text>Pairing screen</Text>,
}

describe("signing out on the Host screen", () => {
  it("revokes the session on the desktop, then leaves", async () => {
    const logout = jest.fn(async () => ({ loggedOut: true }))
    pairWithTestDesktop({ api: { logout } })
    await renderRouter(routes, { initialUrl: "/settings" })
    await fireEvent.press(await screen.findByText("Sign out this phone"))
    await pressAlertButton("Sign out this phone?", "Sign out")
    expect(logout).toHaveBeenCalledTimes(1)
    expect(await screen.findByText("Pairing screen")).toBeTruthy()
    expect(useSessionStore.getState().profile).toBeNull()
  })

  it("keeps the pairing when the desktop cannot be told, unless the user forgets it", async () => {
    const logout = unreachable()
    pairWithTestDesktop({ api: { logout } })
    await renderRouter(routes, { initialUrl: "/settings" })
    await fireEvent.press(await screen.findByText("Sign out this phone"))
    await pressAlertButton("Sign out this phone?", "Sign out")
    expect(logout).toHaveBeenCalledTimes(1)
    expect(alert).toHaveBeenLastCalledWith(
      "The desktop could not be told",
      expect.stringContaining("the session stays listed on the desktop"),
      expect.any(Array)
    )
    expect(useSessionStore.getState().profile).not.toBeNull()

    await pressAlertButton(
      "The desktop could not be told",
      "Forget on this phone"
    )
    expect(await screen.findByText("Pairing screen")).toBeTruthy()
    expect(useSessionStore.getState().profile).toBeNull()
  })
})

describe("update required", () => {
  it("names the version the desktop needs", async () => {
    pairWithTestDesktop()
    useSessionStore.setState({
      compatibility: { kind: "app_update_required", minClientVersion: "9.0.0" },
    })
    await renderRouter(routes, { initialUrl: "/update-required" })
    expect(screen.getByTestId("update-required")).toBeTruthy()
    expect(
      screen.getByText(
        /This desktop needs version 9\.0\.0 or newer of the app\./
      )
    ).toBeTruthy()
    expect(screen.getByText(/Your pairing stays/)).toBeTruthy()
    expect(
      screen.getByText(/^(?:Open TestFlight|Download the update)$/)
    ).toBeTruthy()
  })

  it("asks for a newer desktop when the desktop is too old for the app", async () => {
    pairWithTestDesktop()
    useSessionStore.setState({
      compatibility: { kind: "desktop_update_required" },
    })
    await renderRouter(routes, { initialUrl: "/update-required" })
    expect(screen.getByText("Update BetterC0de on the desktop")).toBeTruthy()
    expect(
      screen.getByText(/needs a newer BetterC0de desktop app/)
    ).toBeTruthy()
    // The app's own download is not the fix here.
    expect(screen.queryByText("Download the update")).toBeNull()
    expect(screen.queryByText("Open TestFlight")).toBeNull()
    expect(screen.getByText("Check again")).toBeTruthy()
  })

  it("connects again once the desktop accepts this app", async () => {
    pairWithTestDesktop()
    useSessionStore.setState({
      compatibility: { kind: "app_update_required", minClientVersion: "9.0.0" },
    })
    await renderRouter(routes, { initialUrl: "/update-required" })
    await fireEvent.press(screen.getByText("Check again"))
    expect(useSessionStore.getState().compatibility).toEqual({ kind: "ok" })
    expect(useSessionStore.getState().profile).not.toBeNull()
  })

  it("keeps the pairing when signing out fails", async () => {
    const logout = unreachable()
    pairWithTestDesktop({ api: { logout } })
    useSessionStore.setState({
      compatibility: { kind: "app_update_required", minClientVersion: "9.0.0" },
    })
    await renderRouter(routes, { initialUrl: "/update-required" })
    await fireEvent.press(screen.getByText("Sign out this phone"))
    expect(logout).toHaveBeenCalledTimes(1)
    expect(useSessionStore.getState().profile).not.toBeNull()
    await pressAlertButton(
      "The desktop could not be told",
      "Forget on this phone"
    )
    expect(useSessionStore.getState().profile).toBeNull()
  })
})
