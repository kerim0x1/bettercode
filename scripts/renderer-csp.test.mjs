import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { runInNewContext } from "node:vm"

const html = readFileSync(new URL("../apps/ui/index.html", import.meta.url), "utf8")
const bootstrapSource = readFileSync(
  new URL("../apps/ui/public/csp-bootstrap.js", import.meta.url),
  "utf8",
)

function directives(policy) {
  return Object.fromEntries(
    policy
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [name, ...sources] = part.split(/\s+/)
        return [name, sources]
      }),
  )
}

const ceiling = directives(
  html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/)[1],
)

/** Run the bootstrap script and return the policy it appends. */
function bootstrapPolicy({ electron, protocol = "file:", storage = {} }) {
  const appended = []
  const window = electron ? { electronAPI: {} } : {}
  runInNewContext(bootstrapSource, {
    window,
    URL,
    location: { protocol, host: "127.0.0.1:3773", origin: `${protocol}//127.0.0.1:3773` },
    localStorage: { getItem: (key) => storage[key] ?? null },
    document: {
      createElement: () => ({}),
      head: { append: (element) => appended.push(element) },
    },
  })
  assert.equal(appended.length, 1)
  assert.equal(appended[0].httpEquiv, "Content-Security-Policy")
  return directives(appended[0].content)
}

test("no policy allows string evaluation; WebAssembly and the basics are pinned", () => {
  for (const policy of [ceiling, bootstrapPolicy({ electron: true }), bootstrapPolicy({ electron: false })]) {
    assert.equal(Object.values(policy).flat().includes("'unsafe-eval'"), false)
  }
  assert.ok(ceiling["script-src"].includes("'wasm-unsafe-eval'"))
  assert.deepEqual(ceiling["object-src"], ["'none'"])
  assert.deepEqual(ceiling["base-uri"], ["'none'"])
  assert.deepEqual(ceiling["form-action"], ["'none'"])
})

test("no policy allows inline script; the bootstrap is a same-origin file", () => {
  assert.deepEqual(ceiling["script-src"], ["'self'", "'wasm-unsafe-eval'"])
  // Inline styles stay allowed (style-src); inline scripts do not.
  assert.ok(ceiling["style-src"].includes("'unsafe-inline'"))
  // Comments mention <script> in prose; only real markup counts.
  const markup = html.replace(/<!--[\s\S]*?-->/g, "")
  const scripts = [...markup.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
  assert.ok(scripts.length >= 2)
  for (const [, attributes, body] of scripts) {
    assert.match(attributes, /\ssrc="/, "every script in index.html loads from a file")
    assert.equal(body.trim(), "")
  }
  // A parser-blocking script after the ceiling and before the app module.
  const bootstrapAt = markup.indexOf('<script src="/csp-bootstrap.js"></script>')
  assert.ok(bootstrapAt > markup.indexOf('http-equiv="Content-Security-Policy"'))
  assert.ok(bootstrapAt < markup.indexOf('type="module"'))
})

test("in the desktop app only bundled scripts run and only app content is framed", () => {
  const policy = bootstrapPolicy({ electron: true })
  assert.deepEqual(policy["script-src"], ["'self'", "'wasm-unsafe-eval'"])
  assert.deepEqual(policy["frame-src"], ["'self'", "blob:"])
  // Restated so blob: workers are not refused through the script-src fallback.
  assert.deepEqual(policy["worker-src"], ["'self'", "blob:"])
  assert.ok(policy["connect-src"].includes("http://127.0.0.1:*"))
  assert.equal(policy["connect-src"].includes("https:"), false)
})

test("a browser served by the backend gets no narrower script policy", () => {
  // Its runtime config arrives as an inline script carrying a per-response
  // nonce that the backend adds to the ceiling (apps/backend/src/remote/web.ts).
  const policy = bootstrapPolicy({ electron: false, protocol: "http:" })
  assert.equal(policy["script-src"], undefined)
  assert.equal(policy["frame-src"], undefined)
  assert.ok(policy["connect-src"].includes("ws://127.0.0.1:3773"))
})
