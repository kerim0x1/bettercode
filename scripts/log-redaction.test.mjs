import assert from "node:assert/strict"
import { createRequire } from "node:module"
import test from "node:test"

const { createLogRedactor, redactSensitiveText } = createRequire(import.meta.url)("../apps/shell/shared/log-redaction.cjs")

const windows = createLogRedactor({ homeDirs: ["C:\\Users\\Jane Doe"], platform: "win32" })
const mac = createLogRedactor({ homeDirs: ["/Users/jane"], platform: "darwin" })
const linux = createLogRedactor({ homeDirs: ["/home/jane"], platform: "linux" })

test("removes provider keys and tokens by their format", () => {
  const samples = [
    "sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345",
    "sk-proj-abcdefghijklmnopqrstuvwxyz012345",
    "sk-or-v1-0123456789abcdef0123456789abcdef",
    "xai-abcdefghijklmnopqrstuvwxyz0123",
    "gsk_abcdefghijklmnopqrstuvwxyz0123",
    "ghp_abcdefghijklmnopqrstuvwxyz0123",
    "github_pat_11ABCDEFG0123456789_abcdefghijklmnop",
    "AIzaSyA-abcdefghijklmnopqrstuvwxyz01234",
    "AKIAABCDEFGHIJKLMNOP",
    "bc_remote_abcdefghijkl",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
  ]
  for (const secret of samples) {
    const redacted = linux(`error: provider rejected ${secret} (401)`)
    assert.equal(redacted.includes(secret), false, secret)
    assert.match(redacted, /\[REDACTED\]/)
  }
})

test("keeps the authorization scheme but removes the credential", () => {
  assert.equal(
    linux("Authorization: Bearer abcdefghijklmnopqrstuvwxyz"),
    "Authorization: Bearer [REDACTED]",
  )
  assert.equal(linux("Authorization: Basic dXNlcjpwYXNzd29yZA=="), "Authorization: Basic [REDACTED]")
  assert.equal(linux("Basic authentication is required"), "Basic authentication is required")
})

test("redacts credential-named values in key=value, header and JSON forms", () => {
  assert.equal(linux("GET /cb?code=1&access_token=abc123def&state=x"), "GET /cb?code=1&access_token=[REDACTED]&state=x")
  assert.equal(linux('{"refresh_token":"abc.def","model":"o3"}'), '{"refresh_token":"[REDACTED]","model":"o3"}')
  assert.equal(linux("x-api-key: 12345678"), "x-api-key: [REDACTED]")
  assert.equal(linux("clientSecret = 'two words'"), "clientSecret = '[REDACTED]'")
  assert.equal(linux("password=hunter2"), "password=[REDACTED]")
})

test("leaves token counts and ordinary prose alone", () => {
  for (const line of [
    "usage max_tokens=4096 input_tokens: 12 tokenCount=3",
    "Turn finished in 12.3s with 2 tool calls",
    "@anthropic-ai/sdk@0.105.0 loaded from node_modules/@anthropic-ai/sdk",
  ]) {
    assert.equal(linux(line), line)
  }
})

test("removes URL credentials and email addresses", () => {
  assert.equal(linux("proxy https://user:pa55@proxy.example:8080 failed"), "proxy https://[REDACTED]@proxy.example:8080 failed")
  assert.equal(linux("signed in as jane.doe@example.com"), "signed in as [EMAIL]")
})

test("replaces the home directory, in either separator style, with ~", () => {
  assert.equal(windows("cwd=C:\\Users\\Jane Doe\\code\\app"), "cwd=~\\code\\app")
  assert.equal(windows("opened c:/users/jane doe/code"), "opened ~/code")
  assert.equal(windows('{"cwd":"C:\\\\Users\\\\Jane Doe\\\\code"}'), '{"cwd":"~\\\\code"}')
  assert.equal(mac("cwd=/Users/jane/project"), "cwd=~/project")
  assert.equal(linux("cwd=/home/jane"), "cwd=~")
  // A longer account name that only starts like the home directory.
  assert.equal(linux("cwd=/home/janet/x"), "cwd=/home/<user>/x")
})

test("hides other accounts' profile directories", () => {
  assert.equal(windows("D:\\x and C:\\Users\\bob\\file.txt"), "D:\\x and C:\\Users\\<user>\\file.txt")
  assert.equal(linux("path /Users/bob/file"), "path /Users/<user>/file")
})

test("never throws and stringifies non-strings", () => {
  assert.equal(linux(42), "42")
  assert.equal(linux(""), "")
  const hostile = { toString() { throw new Error("no") } }
  assert.equal(linux(hostile), "[unprintable]")
  assert.equal(typeof redactSensitiveText("plain"), "string")
})
