import { describe, expect, it } from "vitest"
import {
  PairingInputError,
  normalizeBaseUrl,
  parsePairingInput,
  relativePathWithinRoot,
  websocketUrl,
} from "./endpoint"

describe("mobile endpoint parsing", () => {
  it("parses the desktop-generated hash pairing link", () => {
    expect(
      parsePairingInput("http://192.168.1.44:3773/#token=ABCD-EFGH-JKLM")
    ).toEqual({
      baseUrl: "http://192.168.1.44:3773",
      credential: "ABCD-EFGH-JKLM",
    })
  })

  it("accepts a manual host and one-time code", () => {
    expect(
      parsePairingInput("ABCD-EFGH-JKLM", "192.168.1.44:3773/api/v1")
    ).toEqual({
      baseUrl: "http://192.168.1.44:3773",
      credential: "ABCD-EFGH-JKLM",
    })
  })

  it("supports explicit BetterC0de deep links", () => {
    const result = parsePairingInput(
      "betterc0de://pair?endpoint=https%3A%2F%2Fremote.example.com&token=one-time"
    )
    expect(result).toEqual({
      baseUrl: "https://remote.example.com",
      credential: "one-time",
    })
  })

  it("rejects unsafe schemes and credentials in host URLs", () => {
    expect(() => normalizeBaseUrl("ftp://server.test")).toThrow(
      PairingInputError
    )
    expect(() => normalizeBaseUrl("http://user:secret@server.test")).toThrow(
      PairingInputError
    )
  })

  it("builds the websocket endpoint and confines file paths", () => {
    expect(websocketUrl("https://remote.example.com")).toBe(
      "wss://remote.example.com/ws"
    )
    expect(
      relativePathWithinRoot("C:\\work\\repo", "C:\\work\\repo\\src\\app.ts")
    ).toBe("src/app.ts")
    expect(() =>
      relativePathWithinRoot("C:\\work\\repo", "C:\\work\\other\\secret.txt")
    ).toThrow("outside")
    expect(() =>
      relativePathWithinRoot("/repo", "/repo/../private/key")
    ).toThrow("outside")
    expect(() =>
      relativePathWithinRoot("C:\\repo", "C:\\repo\\..\\private\\key")
    ).toThrow("outside")
  })
})
