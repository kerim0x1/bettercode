import assert from "node:assert/strict"
import { createRequire } from "node:module"
import path from "node:path"
import { test } from "node:test"
import { pathToFileURL } from "node:url"

const require = createRequire(import.meta.url)
const {
  denyAllPermissions,
  installDefaultSessionPermissionHandlers,
} = require("../apps/shell/shared/web-contents-policy.cjs")

function fakeSession() {
  const session = {
    setPermissionRequestHandler: callback => { session.request = callback },
    setPermissionCheckHandler: callback => { session.check = callback },
  }
  return session
}

function handlers(isPackaged = false) {
  const policy = {
    isPackaged, devRendererOrigin: "http://localhost:49123",
    packagedRendererRoot: path.resolve("apps/ui/dist"), trustedWebContentsIds: new Set([1]),
  }
  const url = isPackaged ? pathToFileURL(path.join(policy.packagedRendererRoot, "index.html")).href : `${policy.devRendererOrigin}/`
  const contents = { id: 1, getURL: () => url, isDestroyed: () => false }
  const session = fakeSession()
  installDefaultSessionPermissionHandlers(session, () => policy)
  return { session, contents, details: { isMainFrame: true, requestingUrl: url, mediaTypes: ["audio"] } }
}

test("media requests admit only a registered app main frame requesting audio", () => {
  for (const packaged of [false, true]) {
    const { session, contents, details } = handlers(packaged)
    const request = (sender, permission, value) => {
      let result
      session.request(sender, permission, allowed => { result = allowed }, value)
      return result
    }
    assert.equal(request(contents, "media", details), true)
    for (const override of [{ isMainFrame: false }, { requestingUrl: "https://untrusted.example" }, { mediaTypes: ["video"] }, { mediaTypes: ["audio", "video"] }, { mediaTypes: [] }, { mediaTypes: undefined }]) {
      assert.equal(request(contents, "media", { ...details, ...override }), false)
    }
    assert.equal(request({ ...contents, id: 2 }, "media", details), false)
    assert.equal(request(null, "media", details), false)
    assert.equal(request(contents, "geolocation", details), false)
  }
})

test("permission checks apply the same microphone and frame boundary", () => {
  const { session, contents, details } = handlers()
  assert.equal(typeof session.check, "function")
  const check = value => session.check(contents, "media", "http://localhost:49123", { ...details, mediaTypes: undefined, ...value })
  assert.equal(check({ mediaType: "audio" }), true)
  for (const value of [{ mediaType: "video" }, { mediaType: "unknown" }, {}, { mediaType: "audio", isMainFrame: false }]) assert.equal(check(value), false)
  assert.equal(session.check(null, "media", "http://localhost:49123", { ...details, mediaType: "audio" }), false)
})

test("system notifications are allowed for a registered app main frame only", () => {
  const { session, contents, details } = handlers()
  const request = (sender, value) => {
    let result
    session.request(sender, "notifications", allowed => { result = allowed }, value)
    return result
  }
  const notificationDetails = { isMainFrame: true, requestingUrl: details.requestingUrl }
  assert.equal(request(contents, notificationDetails), true)
  assert.equal(request(contents, { ...notificationDetails, isMainFrame: false }), false)
  assert.equal(request(contents, { ...notificationDetails, requestingUrl: "https://untrusted.example" }), false)
  assert.equal(request({ ...contents, id: 2 }, notificationDetails), false)
  assert.equal(request(null, notificationDetails), false)
  assert.equal(session.check(contents, "notifications", "http://localhost:49123", notificationDetails), true)
  assert.equal(session.check(contents, "notifications", "http://localhost:49123", { ...notificationDetails, isMainFrame: false }), false)
  assert.equal(session.check(null, "notifications", "http://localhost:49123", notificationDetails), false)
})

test("preview sessions grant no permission, not even to a trusted-looking request", () => {
  const session = fakeSession()
  denyAllPermissions(session)
  let granted = null
  session.request({ id: 1 }, "media", allowed => { granted = allowed }, { isMainFrame: true, mediaTypes: ["audio"] })
  assert.equal(granted, false)
  assert.equal(session.check({ id: 1 }, "media", "http://localhost:49123", { mediaType: "audio" }), false)
})
