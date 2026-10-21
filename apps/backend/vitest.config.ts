import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    // Tests open real SQLite files in temp dirs — parallelism is fine, but
    // keep the fork pool so each worker has its own better-sqlite3 binding
    // (avoids "database is locked" flakes from shared WAL handles).
    pool: "forks",
    // Well above the default 5s. A large part of this suite spawns real
    // processes (git, the ACP stdio client, shell helpers), and on Windows a
    // spawn under parallel load routinely takes several seconds — long enough
    // that ~18 tests failed as a group while every one of them passed when run
    // alone. A timeout that fires on machine load rather than on a hang is a
    // false alarm, and false alarms are how a red suite stops being read. A
    // genuine hang still fails, just later.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Opt-in: `npm run test:coverage` (needs @vitest/coverage-v8). No
    // thresholds yet; the report establishes the baseline to ratchet from.
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "html", "lcov"],
      reportsDirectory: "coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/testUtils/**"],
    },
  },
})
