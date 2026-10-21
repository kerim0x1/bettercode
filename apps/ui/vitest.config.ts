import path from "path"
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // `.tsx` is included so components can be rendered in tests. This needs no
    // jsdom and no testing-library: `renderToStaticMarkup` produces HTML in
    // plain node, which is enough to assert on the things that actually
    // regressed here — theme classes, aria attributes, and whether a piece of
    // information is visible at all rather than hover-only.
    include: ["src/**/*.test.{ts,tsx}"],
    environment: "node",
    globals: true,
    // Opt-in: `npm run test:coverage` (needs @vitest/coverage-v8). No
    // thresholds yet; the report establishes the baseline to ratchet from.
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "html", "lcov"],
      reportsDirectory: "coverage",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.test.{ts,tsx}", "src/**/*.d.ts"],
    },
  },
  resolve: {
    alias: {
      // `@betterc0de/schema` resolves through npm workspaces — no explicit
      // alias needed. `@/*` stays for renderer-internal imports.
      "@": path.resolve(__dirname, "./src"),
    },
  },
})
