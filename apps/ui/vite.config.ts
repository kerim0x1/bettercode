import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import fs from "fs"
import path from "path"
import { defineConfig, type Plugin } from "vite"

// ─────────────────────────────────────────────────────────────────────
// Vendor chunk routing. Each entry lists the EXACT npm package names
// (top-level or scope) that should land in that chunk.
//
// Why this is a table + a strict regex (instead of `id.includes(name)`):
// substring matching has caused three production crashes by accidentally
// catching unrelated packages whose names share a prefix or substring:
//
//   • `react`/`/react/`        ← also matched `@tiptap/react`, `react-icons`
//   • `katex`                  ← also matched `rehype-katex`
//   • `color/`                 ← also matched `supports-color`, `d3-color`
//   • `monaco-editor`          ← also matched `@monaco-editor/react`
//   • `lowlight`               ← also matched `@tiptap/extension-code-block-lowlight`
//   • `zod`                    ← also matched `zod-validation-error`
//
// Putting code from a foreign package into the wrong chunk creates
// inter-chunk circular imports between Rollup chunks. ESM evaluates
// those bindings in TDZ until the cycle resolves — accessing them
// mid-init throws at runtime as
//   "Cannot access 'X' before initialization"
// or
//   "Cannot read properties of undefined (reading '...')".
//
// The regex below uses a lookahead that requires a path separator
// after the name, so `react` cannot match `react-dom`, `katex` cannot
// match `rehype-katex`, etc. ANY new chunk rule MUST go into this map
// — not as a free-form `id.includes(...)` — to keep the bug class dead.
// ─────────────────────────────────────────────────────────────────────
const VENDOR_CHUNK_MAP: Record<string, readonly string[]> = {
  "vendor-react": [
    "react",
    "react-dom",
    "scheduler",
    "use-sync-external-store",
    "use-sync-external-store-shim",
  ],
  "vendor-monaco": ["monaco-editor", "@monaco-editor"],
  "vendor-ui": [
    // Radix uses Floating UI, while cmdk imports Radix. Keep that dependency
    // cycle inside one chunk so its initialization stays under Rollup's control.
    "@radix-ui",
    "radix-ui",
    "class-variance-authority",
    "clsx",
    "tailwind-merge",
    "lucide-react",
    "@floating-ui",
    "cmdk",
    "embla-carousel",
    "embla-carousel-react",
    "embla-carousel-reactive-utils",
  ],
  "vendor-motion": ["motion", "framer-motion"],
  // Streamdown core + every @streamdown plugin together, so the cycle
  // between core and plugins lives inside one chunk (Rollup handles
  // intra-chunk cycles correctly; only inter-chunk cycles cause TDZ).
  // katex stays separate because it's a true one-way leaf — streamdown
  // imports it, it imports nothing back.
  //
  // `mermaid` is NO LONGER co-bundled. The renderer uses
  // `await import("mermaid")` inside `MermaidDiagram` (message.tsx), so
  // Rollup auto-splits mermaid into its own async chunk that only loads
  // when a message actually contains a ```mermaid fence. Before this
  // change, vendor-markdown was ~22 MB because mermaid + its deps rode
  // the eager critical-path bundle for everyone — including users who
  // never looked at a diagram. audit-chunks verifies no cycles between
  // the auto-split mermaid chunk and vendor-markdown.
  //
  // `shiki` follows the same pattern as of the startup-time work: it used
  // to be pinned here because auto-splitting a STATICALLY imported shiki
  // produced a vendor-markdown ↔ vendor-shiki cycle through their shared
  // hast-util-* helpers. `code-block.tsx` now does `await import("shiki")`,
  // so Rollup gives it an async chunk — an async boundary is not a cycle —
  // and its ~290 TextMate grammars leave the critical path.
  // `@streamdown/code` and `@streamdown/math` are deliberately NOT listed.
  // They are the only consumers of shiki and katex respectively, and
  // `streamdown-plugins.ts` imports both dynamically so Rollup can give them
  // (and shiki's grammars, and katex) async chunks. Listing either — or the
  // `@streamdown` scope as a whole — pins it back into this eager chunk and
  // undoes that.
  "vendor-markdown": ["streamdown", "@streamdown/cjk", "@streamdown/mermaid"],
  // Reached only through the deferred math plugin, so this resolves to an
  // async chunk rather than a preloaded one.
  "vendor-math": ["katex"],
  // No rules for remotion, lowlight/highlight.js, fuse.js or the provider
  // SDKs: the renderer imports none of them, so those chunks were never
  // emitted and only suggested that the libraries ship.
  "vendor-zod": ["zod"],
  "vendor-tanstack": ["@tanstack"],
  "vendor-color": ["color"],
  "vendor-sanitize": ["dompurify"],
}

// Pre-compile one regex per chunk. The `(?=[\\/])` lookahead requires a
// path separator after the package name, which is what makes
// `react` / `katex` / `color` / `monaco-editor` etc. NOT match their
// look-alike neighbors (`react-dom`, `rehype-katex`, `supports-color`,
// `@monaco-editor/react` — the latter routes via `@monaco-editor`).
const VENDOR_CHUNK_MATCHERS: ReadonlyArray<readonly [string, RegExp]> =
  Object.entries(VENDOR_CHUNK_MAP).map(([chunk, names]) => {
    const alt = names
      .map((n) => n.replace(/[.+*?^${}()|[\]\\]/g, "\\$&"))
      .join("|")
    return [
      chunk,
      new RegExp(`[\\\\/]node_modules[\\\\/](?:${alt})(?=[\\\\/])`),
    ] as const
  })

function pickVendorChunk(id: string): string | undefined {
  if (!id.includes("node_modules")) return
  for (const [chunk, regex] of VENDOR_CHUNK_MATCHERS) {
    if (regex.test(id)) return chunk
  }
  return undefined
}

// Write the dev server port to a file so Electron can find it.
//
// After the apps/ migration the renderer lives at `apps/ui/`. The shell
// reads the port file from the repo root (two levels up) — keeping the
// file at the repo root makes the dev orchestration boundary symmetric
// for any future workspace that wants to coordinate with the running
// Vite server.
function writePortFile(): Plugin {
  return {
    name: "write-port-file",
    configureServer(server) {
      server.httpServer?.once("listening", () => {
        const addr = server.httpServer?.address()
        if (addr && typeof addr === "object") {
          fs.writeFileSync(
            path.join(__dirname, "..", "..", ".vite-port"),
            String(addr.port)
          )
        }
      })
    },
  }
}

export default defineConfig({
  // Pin Vite's `root` to this config's directory (`apps/ui/`) so the
  // build + dev commands find `index.html` regardless of which workspace
  // the npm script was invoked from. Without this, running
  // `npm run build:frontend` from the repo root makes Vite look for
  // `index.html` next to the cwd (the workspace root) and fail.
  root: __dirname,
  base: "./",
  plugins: [react(), tailwindcss(), writePortFile()],
  resolve: {
    alias: {
      // Renderer-internal alias. The legacy `@betterc0de/contracts` alias
      // is gone — schemas live in the workspace package
      // `@betterc0de/schema` (`packages/schema/`) and resolve through
      // npm-workspaces without an explicit Vite alias.
      "@": path.resolve(__dirname, "./src"),
    },
    // `@streamdown/code` depends on shiki 3 and installs its own copy, which
    // shipped every TextMate grammar a second time (~12 MB of async
    // chunks). It uses only `createHighlighter`, `bundledLanguages`,
    // `bundledLanguagesInfo` and the JavaScript regex engine, which the app's
    // shiki 4 provides unchanged, so both resolve to the one copy.
    dedupe: ["shiki"],
  },
  optimizeDeps: {
    // Pin dep-scan entries so the scanner doesn't crawl nested HTML files
    // from unrelated local reference folders and fail on unresolved imports.
    entries: ["index.html"],
    include: ["monaco-editor"],
  },
  worker: {
    format: "es" as const,
  },
  build: {
    target: "esnext",
    minify: "esbuild",
    cssMinify: "esbuild",
    // Hidden sourcemaps sit beside the renderer build for local symbolication.
    // The bundles do not reference them, and electron-builder's `!**/*.map`
    // filter strips them from the packaged app.
    sourcemap: "hidden",
    rollupOptions: {
      output: {
        // Fine-grained manual chunks so heavy subsystems don't ride on the
        // critical-path bundle. The chunk routing table lives at the top of
        // this file (`VENDOR_CHUNK_MAP`) — read the comment there before
        // adding new rules; substring matchers are forbidden.
        manualChunks(id) {
          return pickVendorChunk(id)
        },
      },
    },
    chunkSizeWarningLimit: 1500,
  },
  clearScreen: false,
  server: {
    port: 0,
    strictPort: false,
    watch: {
      ignored: [
        "**/.codex/**",
        "**/.claude/**",
        "**/apps/backend/dist/**",
        "**/apps/backend/node_modules/**",
        "**/.betterc0de/**",
        "**/.betterc0de-dev/**",
      ],
    },
  },
  envPrefix: ["VITE_"],
})
