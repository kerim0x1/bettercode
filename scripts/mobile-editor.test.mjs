import assert from "node:assert/strict"
import fs from "node:fs"
import test from "node:test"

import {
  EDITOR_CSP,
  EDITOR_MODULE,
  buildEditorHtml,
  editorModuleSource,
} from "./build-mobile-editor.mjs"

test("the committed code editor is built from its source", async () => {
  const committed = fs.readFileSync(EDITOR_MODULE, "utf8").replace(/\r\n/g, "\n")
  assert.equal(
    committed,
    await editorModuleSource(),
    "apps/mobile/src/editor/editor-html.ts no longer matches apps/mobile/editor: run npm run mobile:editor"
  )
})

test("the code editor's page may load nothing", async () => {
  const html = await buildEditorHtml()
  assert.ok(html.includes(`content="${EDITOR_CSP}"`))
  assert.match(EDITOR_CSP, /^default-src 'none';/)
  // Everything is inline: no script, style sheet or frame from anywhere.
  assert.doesNotMatch(html, /<script[^>]*\bsrc=|<link\b|<iframe\b/i)
  // One script element: the bundle cannot end it early.
  assert.equal(html.match(/<\/script>/gi)?.length, 1)
})
