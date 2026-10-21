import { describe, expect, it } from "vitest"
import {
  PREPARED_TURN_TOKEN_TTL_MS,
  PreparedTurnTokens,
  preparedTurnTokensFor,
  type PreparedTurnSubject,
} from "./prepared-turns"

const message: PreparedTurnSubject = {
  thread_id: "thread-1",
  user_message_id: "message-1",
  message: "Plan the change",
  model_id: "claude-opus",
  provider_kind: "my-plugin",
}

describe("prepared-turn tokens", () => {
  it("are spent by the first send of the same message", () => {
    const tokens = new PreparedTurnTokens()
    const token = tokens.issue(message)!
    expect(token).toMatch(/^[\w-]{43}$/)
    expect(tokens.consume(token, { ...message })).toBe(true)
    expect(tokens.consume(token, message)).toBe(false)
    expect(tokens.size).toBe(0)
  })

  it("are bound to the chat, the message and its text, model and provider", () => {
    const tokens = new PreparedTurnTokens()
    for (const other of [
      { thread_id: "thread-2" },
      { user_message_id: "message-2" },
      { message: "Something else" },
      { model_id: "gpt-5" },
      { provider_kind: "another-plugin" },
    ]) {
      const token = tokens.issue(message)!
      expect(tokens.consume(token, { ...message, ...other })).toBe(false)
      // A mismatch spends it too.
      expect(tokens.consume(token, message)).toBe(false)
    }
  })

  it("expire after a few minutes", () => {
    let now = 1_000
    const tokens = new PreparedTurnTokens(() => now)
    const token = tokens.issue(message)!
    now += PREPARED_TURN_TOKEN_TTL_MS
    expect(tokens.consume(token, message)).toBe(false)
  })

  it("are not issued, and never accepted, without a message id", () => {
    const tokens = new PreparedTurnTokens()
    expect(tokens.issue({ ...message, user_message_id: null })).toBeNull()
    const token = tokens.issue(message)!
    expect(tokens.consume(token, { ...message, user_message_id: null })).toBe(
      false
    )
    expect(tokens.consume("", message)).toBe(false)
    expect(tokens.consume(null, message)).toBe(false)
  })

  it("keep at most a bounded number, dropping the oldest", () => {
    const tokens = new PreparedTurnTokens()
    const first = tokens.issue(message)!
    for (let index = 0; index < 300; index += 1) tokens.issue(message)
    expect(tokens.size).toBeLessThanOrEqual(256)
    expect(tokens.consume(first, message)).toBe(false)
  })

  it("belong to one backend", () => {
    const state = {}
    const token = preparedTurnTokensFor(state).issue(message)!
    expect(preparedTurnTokensFor({}).consume(token, message)).toBe(false)
    expect(preparedTurnTokensFor(state).consume(token, message)).toBe(true)
  })
})
