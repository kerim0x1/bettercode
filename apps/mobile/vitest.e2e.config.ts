import { defineConfig } from "vitest/config"
import { fileURLToPath } from "node:url"

// The app's network client against a real desktop backend, started in this
// process from its build output (npm run build:backend).
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["e2e/**/*.e2e.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // One backend per file; files must not share ports or data directories.
    fileParallelism: false,
  },
})
