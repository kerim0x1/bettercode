import type {
  ChatMessage,
  ChatThread,
  ProjectSummary,
  ProviderInstance,
  ThreadDiffs,
} from "@/types/remote"
import { gitIsoDate, type DemoRepoSeed } from "./git"

/**
 * What the demo shows: two small projects and a few chats, written like a
 * real session. Timestamps are relative to "now" so the list reads as recent.
 */

export const DEMO_ENVIRONMENT_ID = "demo"
export const DEMO_PROVIDER = {
  kind: "demo",
  instanceId: "demo-agent",
  model: "demo-model",
} as const

export const DEMO_PROJECTS: ProjectSummary[] = [
  { name: "weather-app", path: "/Users/demo/code/weather-app" },
  { name: "api-server", path: "/Users/demo/code/api-server" },
]

export const DEMO_PROVIDER_INSTANCES: ProviderInstance[] = [
  {
    instanceId: DEMO_PROVIDER.instanceId,
    driver: DEMO_PROVIDER.kind,
    displayName: "Demo agent",
    enabled: true,
    configured: true,
    installed: true,
    status: "ready",
    availability: "available",
    models: [
      { slug: DEMO_PROVIDER.model, name: "Demo model", shortName: "Demo" },
    ],
  },
]

/** File trees of the demo projects: path relative to the project → contents (null for a folder). */
export const DEMO_FILES: Record<string, Record<string, string | null>> = {
  "/Users/demo/code/weather-app": {
    "README.md":
      "# Weather\n\nA small React Native app that shows the forecast for your saved cities.\n\n## Features\n\n- Five-day forecast for every saved city\n- Light, dark and system themes\n- The last forecast stays readable offline\n\n## Scripts\n\n- `npm test` runs the unit tests\n- `npm start` starts the dev server\n\n## License\n\nMIT, see LICENSE.\n",
    "package.json":
      '{\n  "name": "weather-app",\n  "version": "1.3.0",\n  "scripts": {\n    "start": "expo start",\n    "test": "vitest run"\n  }\n}\n',
    src: null,
    "src/App.tsx":
      'import { ThemeProvider } from "./theme"\nimport { Forecast } from "./screens/Forecast"\n\nexport default function App() {\n  return (\n    <ThemeProvider>\n      <Forecast />\n    </ThemeProvider>\n  )\n}\n',
    "src/theme.ts":
      'export const light = { background: "#ffffff", text: "#111111" }\nexport const dark = { background: "#0a0a0a", text: "#fafafa" }\n',
    "src/screens": null,
    "src/screens/Forecast.tsx":
      "export function Forecast() {\n  return null // five-day forecast list\n}\n",
    "src/screens/Radar.tsx":
      "export function Radar() {\n  return null // rain radar for the selected city\n}\n",
    "src/screens/Settings.tsx":
      'import { useTheme } from "../theme"\n\nexport function Settings() {\n  const { mode, setMode } = useTheme()\n  return null // theme picker: light, dark, system\n}\n',
  },
  "/Users/demo/code/api-server": {
    "README.md": "# API server\n\nREST API for the weather app.\n",
    src: null,
    "src/auth.ts":
      "export async function login(email: string, password: string) {\n  // checks the password hash and issues a session\n}\n",
    "src/auth.test.ts":
      'import { login } from "./auth"\n\ntest("rejects a wrong password", async () => {\n  await expect(login("a@example.com", "wrong")).rejects.toThrow()\n})\n',
  },
}

const WEATHER_APP = "/Users/demo/code/weather-app"
const API_SERVER = "/Users/demo/code/api-server"

/** A project's files (not its folders), relative path → contents. */
function filesOf(root: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(DEMO_FILES[root] ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== null
    )
  )
}

/**
 * The demo projects' git state; their working trees are DEMO_FILES.
 * weather-app has a staged version bump, a README with two separate
 * changes, a changed theme, a new file and one commit not yet pushed.
 * api-server is clean and one commit behind its remote.
 */
export function demoGitSeeds(now: Date): Record<string, DemoRepoSeed> {
  const at = (minutes: number) =>
    gitIsoDate(new Date(now.getTime() - minutes * 60_000))
  const weather = filesOf(WEATHER_APP)
  const { "src/screens/Radar.tsx": radar, ...tracked } = weather
  const readme = tracked["README.md"]!
  const theme = tracked["src/theme.ts"]!
  const manifest = tracked["package.json"]!
  return {
    [WEATHER_APP]: {
      branch: "main",
      branches: {
        main: { upstream: "origin/main", ahead: 1 },
        "release/1.4": { upstream: "origin/release/1.4" },
      },
      head: {
        ...tracked,
        "README.md": readme
          .replace("for your saved cities.", "for one city.")
          .replace("MIT, see LICENSE.", "MIT"),
        "src/theme.ts": theme.replace(
          'background: "#0a0a0a", text: "#fafafa"',
          'background: "#000000", text: "#ffffff"'
        ),
        "package.json": manifest.replace('"1.3.0"', '"1.2.0"'),
      },
      staged: { "package.json": manifest },
      changed: {
        "README.md": readme,
        "src/theme.ts": theme,
        "src/screens/Radar.tsx": radar!,
      },
      log: [
        {
          hash: "8f3c2a91d4e5b6a7c8d9e0f1a2b3c4d5e6f7a8b9",
          message: "Show the humidity on the forecast screen",
          author: "Demo User",
          date: at(35),
        },
        {
          hash: "2b7e4d1c9a8f6e5d4c3b2a1f0e9d8c7b6a5f4e3d",
          message: "Keep the last forecast for offline use",
          author: "Demo User",
          date: at(26 * 60),
        },
        {
          hash: "c41d8e2f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d",
          message: "Add the settings screen",
          author: "Demo User",
          date: at(2 * 24 * 60),
        },
        {
          hash: "e9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8",
          message: "Start the weather app",
          author: "Demo User",
          date: at(5 * 24 * 60),
        },
      ],
    },
    [API_SERVER]: {
      branch: "main",
      branches: {
        main: {
          upstream: "origin/main",
          behind: 1,
          incoming: [
            {
              hash: "7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e9d8c",
              message: "Rate-limit the login endpoint",
              author: "Sam Rivera",
              date: at(50),
            },
          ],
        },
      },
      head: filesOf(API_SERVER),
      log: [
        {
          hash: "5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b",
          message: "Give each login test its own user",
          author: "Demo User",
          date: at(150),
        },
        {
          hash: "0f1e2d3c4b5a69788796a5b4c3d2e1f0a9b8c7d6",
          message: "Start the API server",
          author: "Demo User",
          date: at(6 * 24 * 60),
        },
      ],
    },
  }
}

function minutesAgo(now: Date, minutes: number): string {
  return new Date(now.getTime() - minutes * 60_000).toISOString()
}

export function demoThreads(now: Date): ChatThread[] {
  const session = (status: string) => ({
    providerKind: DEMO_PROVIDER.kind,
    providerInstanceId: DEMO_PROVIDER.instanceId,
    status,
    activeTurnId: null,
  })
  return [
    {
      id: "demo-dark-mode",
      title: "Add dark mode to the settings screen",
      projectName: "weather-app",
      projectPath: "/Users/demo/code/weather-app",
      envMode: "local",
      messages: [],
      messageCount: 2,
      createdAt: minutesAgo(now, 42),
      updatedAt: minutesAgo(now, 6),
      session: session("ready"),
    },
    {
      id: "demo-flaky-login",
      title: "Fix the flaky login test",
      projectName: "api-server",
      projectPath: "/Users/demo/code/api-server",
      envMode: "local",
      messages: [],
      messageCount: 2,
      createdAt: minutesAgo(now, 180),
      updatedAt: minutesAgo(now, 150),
      session: session("ready"),
    },
    {
      id: "demo-release-notes",
      title: "Release notes for 1.4",
      projectName: "weather-app",
      projectPath: "/Users/demo/code/weather-app",
      envMode: "local",
      messages: [],
      messageCount: 0,
      createdAt: minutesAgo(now, 20),
      updatedAt: minutesAgo(now, 20),
      session: session("ready"),
    },
  ]
}

export function demoMessages(now: Date): Record<string, ChatMessage[]> {
  return {
    "demo-dark-mode": [
      {
        id: "demo-dark-mode-1",
        role: "user",
        content:
          "Add a dark mode option to the settings screen. It should follow the system setting by default.",
        createdAt: minutesAgo(now, 42),
      },
      {
        id: "demo-dark-mode-2",
        role: "assistant",
        content:
          "Done. The settings screen now has a **Theme** picker with *System*, *Light* and *Dark*.\n\n- `src/theme.ts` exports both palettes and a `useTheme()` hook\n- `src/screens/Settings.tsx` stores the choice and defaults to *System*\n\nAll 24 tests pass.",
        createdAt: minutesAgo(now, 6),
        modelId: DEMO_PROVIDER.model,
        toolCalls: [
          {
            id: "demo-tool-1",
            name: "Read",
            input: { path: "src/screens/Settings.tsx" },
            output: "export function Settings() { … }",
            state: "output-available",
          },
          {
            id: "demo-tool-2",
            name: "Bash",
            input: { command: "npm test" },
            output: "24 passed (1.8s)",
            state: "output-available",
          },
        ],
      },
    ],
    "demo-flaky-login": [
      {
        id: "demo-flaky-login-1",
        role: "user",
        content:
          "The login test fails about one run in ten. Can you find out why?",
        createdAt: minutesAgo(now, 180),
      },
      {
        id: "demo-flaky-login-2",
        role: "assistant",
        content:
          "The test shared a database row with the signup test, so the two raced when they ran in parallel. Each test now creates its own user, and the suite passed 50 runs in a row.",
        createdAt: minutesAgo(now, 150),
        modelId: DEMO_PROVIDER.model,
      },
    ],
    "demo-release-notes": [],
  }
}

export function demoDiffs(now: Date): ThreadDiffs {
  const diffText = [
    "diff --git a/src/theme.ts b/src/theme.ts",
    "--- a/src/theme.ts",
    "+++ b/src/theme.ts",
    "@@ -1,2 +1,8 @@",
    ' export const light = { background: "#ffffff", text: "#111111" }',
    ' export const dark = { background: "#0a0a0a", text: "#fafafa" }',
    '+export type ThemeMode = "system" | "light" | "dark"',
    "+",
    "+export function useTheme() {",
    '+  const [mode, setMode] = useStoredState<ThemeMode>("theme", "system")',
    "+  return { mode, setMode }",
    "+}",
  ].join("\n")
  return {
    turnDiffs: [
      {
        threadId: "demo-dark-mode",
        turnIndex: 0,
        diffText,
        filesChanged: 1,
        insertions: 6,
        deletions: 0,
        createdAt: minutesAgo(now, 6),
      },
    ],
    checkpointDiffs: [],
  }
}
