// Visual replies: the chat frames apps/ui/public/visual-reply-frame.html in a
// sandbox, and it shows an agent's page in a nested sandboxed frame. The shell
// keeps the host frame on that page (urlPolicy.cjs `isAllowedFrameNavigation`,
// wired into every app window by app-windows.cjs).
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { test } from "node:test"
import { pathToFileURL } from "node:url"

const require = createRequire(import.meta.url)
const {
  isAllowedFrameNavigation,
  isVisualReplyFrameUrl,
} = require("../apps/shell/shared/urlPolicy.cjs")

const dist = path.resolve("/fixture/app/apps/ui/dist")
const packaged = {
  isPackaged: true,
  packagedRendererRoot: dist,
  trustedWebContentsIds: new Set(),
}
const dev = {
  isPackaged: false,
  devRendererOrigin: "http://localhost:49123",
  trustedWebContentsIds: new Set(),
}
const replyPage = pathToFileURL(path.join(dist, "visual-reply-frame.html")).href
const appPage = pathToFileURL(path.join(dist, "index.html")).href

function navigate(from, to, policy = packaged) {
  return isAllowedFrameNavigation({ isMainFrame: false, url: to, frame: { url: from } }, policy)
}

test("the host page ships with the renderer under the name the shell expects", () => {
  assert.ok(existsSync(new URL("../apps/ui/public/visual-reply-frame.html", import.meta.url)))
})

test("only the renderer's own host page counts as a visual reply frame", () => {
  assert.equal(isVisualReplyFrameUrl(replyPage, packaged), true)
  assert.equal(isVisualReplyFrameUrl(`${replyPage}?reload=1`, packaged), true)
  assert.equal(isVisualReplyFrameUrl(appPage, packaged), false)
  const elsewhere = pathToFileURL(path.resolve("/elsewhere/visual-reply-frame.html")).href
  assert.equal(isVisualReplyFrameUrl(elsewhere, packaged), false)
  assert.equal(isVisualReplyFrameUrl("http://localhost:49123/visual-reply-frame.html", dev), true)
  assert.equal(isVisualReplyFrameUrl("https://attacker.example/visual-reply-frame.html", dev), false)
  assert.equal(isVisualReplyFrameUrl("not a url", dev), false)
})

test("a visual reply frame may reload its page but never leave it", () => {
  assert.equal(navigate(replyPage, replyPage), true)
  assert.equal(navigate(replyPage, appPage), false)
  assert.equal(navigate(replyPage, "https://attacker.example/"), false)
  assert.equal(navigate(replyPage, "about:blank"), false)
  assert.equal(navigate(replyPage, "blob:null/0b1c"), false)
  assert.equal(navigate(replyPage, pathToFileURL(path.resolve("/etc/hosts")).href), false)
  assert.equal(
    navigate("http://localhost:49123/visual-reply-frame.html", "http://localhost:49123/", dev),
    false,
  )
})

test("other frames, new frames and the main frame are left to their own checks", () => {
  assert.equal(navigate("about:blank", replyPage), true)
  assert.equal(navigate("", replyPage), true)
  assert.equal(navigate(appPage, "blob:file:///0b1c"), true)
  assert.equal(
    isAllowedFrameNavigation({ isMainFrame: true, url: "https://example.com/", frame: { url: replyPage } }, packaged),
    true,
  )
  assert.equal(isAllowedFrameNavigation({ isMainFrame: false, url: appPage, frame: null }, packaged), true)
  const disposed = {
    isMainFrame: false,
    url: appPage,
    get frame() {
      throw new Error("Render frame was disposed")
    },
  }
  assert.equal(isAllowedFrameNavigation(disposed, packaged), true)
})
