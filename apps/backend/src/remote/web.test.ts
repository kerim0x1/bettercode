import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { Hono } from "hono"
import type { ServerConfig } from "../config"
import {
  addScriptNonceToPolicy,
  injectRuntimeConfig,
  registerRemoteWebRoutes,
} from "./web"

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

function fixture() {
  const root = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "betterc0de-remote-web-"))
  )
  directories.push(root)
  fs.mkdirSync(path.join(root, "assets"))
  fs.writeFileSync(
    path.join(root, "index.html"),
    "<html><head></head><body>app</body></html>"
  )
  fs.writeFileSync(path.join(root, "assets", "app.js"), "console.log('app')")
  const app = new Hono()
  registerRemoteWebRoutes(
    app,
    { host: "0.0.0.0", port: 4773 } as ServerConfig,
    root
  )
  return app
}

describe("remote web host", () => {
  it("serves the SPA with same-origin runtime configuration", async () => {
    const response = await fixture().request("/")
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("referrer-policy")).toBe("no-referrer")
    expect(html).toContain('"mode":"remote_http"')
    expect(html).toContain("baseUrl:window.location.origin")
  })

  it("lets only its own runtime-config script through the page CSP, with a fresh nonce per response", async () => {
    const app = fixture()
    const root = directories.at(-1)!
    fs.writeFileSync(
      path.join(root, "index.html"),
      `<html><head><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline';" /><script src="/csp-bootstrap.js"></script></head><body>app</body></html>`
    )

    const nonces: string[] = []
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const html = await (await app.request("/")).text()
      const script = html.match(
        /<script nonce="([^"]+)">window\.__BETTERC0DE__=/
      )
      expect(script).not.toBeNull()
      const nonce = script![1]!
      const policy = html.match(
        /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/
      )![1]!
      expect(policy).toContain(
        `script-src 'self' 'wasm-unsafe-eval' 'nonce-${nonce}';`
      )
      // Inline script stays refused for everything else.
      expect(policy.split(";")[1]).not.toContain("'unsafe-inline'")
      expect(policy).toContain("style-src 'self' 'unsafe-inline'")
      nonces.push(nonce)
    }
    expect(nonces[0]).not.toBe(nonces[1])
    expect(Buffer.from(nonces[0]!, "base64")).toHaveLength(16)
  })

  it("adds the nonce to default-src when a policy has no script-src", () => {
    expect(
      addScriptNonceToPolicy("default-src 'self'; img-src data:", "abc")
    ).toBe("default-src 'self' 'nonce-abc'; img-src data:")
    expect(addScriptNonceToPolicy("img-src data:", "abc")).toBe("img-src data:")
    const html = injectRuntimeConfig(
      `<head><meta http-equiv="Content-Security-Policy" content="script-src 'self'" /></head>`,
      { host: "0.0.0.0", port: 4773 } as ServerConfig,
      "fixed"
    )
    expect(html).toContain(`content="script-src 'self' 'nonce-fixed'"`)
    expect(html).toContain('<script nonce="fixed">')
  })

  it("uses immutable asset caching, SPA fallback, and real missing-asset 404s", async () => {
    const app = fixture()
    const asset = await app.request("/assets/app.js")
    expect(asset.status).toBe(200)
    expect(asset.headers.get("content-type")).toContain("text/javascript")
    expect(asset.headers.get("cache-control")).toContain("immutable")
    expect(asset.headers.get("content-length")).toBe(
      String(Buffer.byteLength("console.log('app')"))
    )
    expect(await asset.text()).toBe("console.log('app')")

    const navigation = await app.request("/chat/thread-1")
    expect(navigation.status).toBe(200)
    expect(await navigation.text()).toContain("baseUrl:window.location.origin")

    expect((await app.request("/assets/missing.js")).status).toBe(404)
  })
})
