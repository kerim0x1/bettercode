import { describe, expect, it } from "@jest/globals"
import { fireEvent, screen } from "@testing-library/react-native"
import { renderRouter } from "expo-router/testing-library"
import { Text } from "react-native"
import { useSessionStore } from "@/store/session-store"
import PairScreen from "@/app/pair"

describe("pairing screen", () => {
  it("offers the demo, which starts without a desktop", async () => {
    const router = renderRouter(
      {
        pair: PairScreen,
        "(tabs)/index": () => <Text>Chats</Text>,
      },
      { initialUrl: "/pair" }
    )
    await router
    expect(screen.getByText("Scan QR")).toBeTruthy()
    await fireEvent.press(screen.getByTestId("pair-demo"))
    expect(useSessionStore.getState().mode).toBe("demo")
    expect(await screen.findByText("Chats")).toBeTruthy()
    expect(router.getPathname()).toBe("/")
    useSessionStore.getState().exitDemo()
  })

  it("explains why the phone was signed out", async () => {
    useSessionStore.setState({
      notice: {
        kind: "session_ended",
        message: "The desktop signed this phone out. Pair it again.",
      },
    })
    await renderRouter({ pair: PairScreen }, { initialUrl: "/pair" })
    expect(screen.getByTestId("pair-notice")).toBeTruthy()
    expect(
      screen.getByText("The desktop signed this phone out. Pair it again.")
    ).toBeTruthy()
  })

  it("refuses a bare code without the desktop address", async () => {
    useSessionStore.setState({ notice: null, error: null })
    await renderRouter({ pair: PairScreen }, { initialUrl: "/pair" })
    await fireEvent.press(screen.getByTestId("pair-manual-tab"))
    await fireEvent.changeText(
      screen.getByTestId("pair-input"),
      "ABCD-EFGH-JKLM"
    )
    await fireEvent.press(screen.getByTestId("pair-connect"))
    expect(
      await screen.findByText("A bare code also needs the desktop address.")
    ).toBeTruthy()
  })
})
