import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"

import {
  PAGE_CSP,
  PAGES,
  buildPageHtml,
  pageModuleSource,
} from "./build-mobile-pages.mjs"

for (const page of PAGES) {
  test(`the committed ${page.name} page is built from its source`, async () => {
    const committed = fs
      .readFileSync(page.module, "utf8")
      .replace(/\r\n/g, "\n")
    assert.equal(
      committed,
      await pageModuleSource(page),
      `${path.basename(page.module)} no longer matches apps/mobile/${page.name}: run npm run mobile:pages`
    )
  })

  test(`the ${page.name} page may load nothing`, async () => {
    const html = await buildPageHtml(page)
    assert.ok(html.includes(`content="${PAGE_CSP}"`))
    assert.match(PAGE_CSP, /^default-src 'none';/)
    // Everything is inline: no script, style sheet or frame from anywhere,
    // and the style sheet imports nothing and points at no address.
    assert.doesNotMatch(html, /<script[^>]*\bsrc=|<link\b|<iframe\b/i)
    const styles = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? ""
    assert.doesNotMatch(styles, /@import|url\(\s*["']?(?:https?:)?\/\//i)
    // One script element and one style sheet: the bundle cannot end them early.
    assert.equal(html.match(/<\/script>/gi)?.length, 1)
    assert.equal(html.match(/<\/style>/gi)?.length, 1)
  })
}
