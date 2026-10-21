import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

// ---------------------------------------------------------------------------
// Layering boundaries.
//
// The intended dependency direction in the backend is
// `http -> services -> provider -> persistence`, and the renderer is supposed to
// reach the backend only through `services/backend`. Until now that was
// convention only, which is why `http/routes/chat.ts` was able to grow into an
// orchestration layer without anything objecting.
//
// Every rule below was measured before being switched on and has ZERO
// violations today (the one exception is listed with its reason). They cost
// nothing now; their job is to make the next violation a failed lint instead of
// a fact discovered a year later. Do not add an allowlist entry without writing
// down why the boundary should bend.
//
// Note on flat config: rules merge last-wins *by rule name*, so two blocks that
// both set `no-restricted-imports` and match the same file will clobber each
// other rather than combine. That is why the file scopes below are disjoint and
// each one spreads in the shared groups it still needs.
// ---------------------------------------------------------------------------

/**
 * Local reference material is outside the application dependency graph.
 * Keep it out of runtime imports, bundles and installation packages.
 */
const NO_VENDORED_REFERENCE = {
  group: ['**/Example/**', '**/Another_Example/**'],
  message:
    'Local reference material must not be imported into application code.',
}

const BROWSER_DIALOG_MESSAGE =
  'Browser dialogs do not belong in the renderer: prompt() throws in Electron, alert()/confirm() block and ignore the theme. Use usePrompt() / useConfirm() from components/dialogs, or a sonner toast.'

/** persistence is below http/services/provider, not beside them. */
const NO_UPWARD_BACKEND_IMPORT = {
  group: [
    '../http/**',
    '../../http/**',
    '../provider/**',
    '../../provider/**',
    '../services/**',
    '../../services/**',
  ],
  message:
    'This layer sits below http, provider and services and may not import from them. Pass what it needs in as an argument.',
}

// ---------------------------------------------------------------------------
// The legacy in-process provider stack (`provider/adapter.ts`,
// `provider/adapters/`, `provider/registry.ts`, `provider/service.ts`) is
// frozen: the API-key providers still run on it, but new work belongs in
// `provider/runtime/`. The rule below keeps every other module from importing
// it (static, re-export, dynamic and `import("…")` type imports alike).
//
// Outside `provider/` an import names the folder (`../provider/service`), so
// one pattern covers every depth. Inside `provider/` the same modules are
// reached by relative paths (`./service`, `../adapters/x`), and a bare
// `./service` elsewhere is an unrelated module (`remote/service`), so each
// directory depth below `provider/` gets its own block with an exact
// `./` or `../`×N prefix. The scopes are disjoint, as flat config requires.
//
// The allowlist is the stack's legitimate importers today. Shrink it as the
// API-key adapters move onto the provider hub; do not grow it.
// ---------------------------------------------------------------------------
const LEGACY_PROVIDER_MODULE = '(adapter|adapters\\/.+|registry|service)'

const LEGACY_PROVIDER_STACK_FILES = [
  'apps/backend/src/provider/adapter.ts',
  'apps/backend/src/provider/adapters/**',
  'apps/backend/src/provider/registry.ts',
  'apps/backend/src/provider/service.ts',
]

const LEGACY_PROVIDER_STACK_ALLOWLIST = [
  // The composition root constructs the legacy registry, service and adapters.
  'apps/backend/src/bootstrap/providers.ts',
  // `ProvidersContext` hands the legacy service and registry to later phases.
  'apps/backend/src/bootstrap/context.ts',
  // `AppState.providers` / `providerRegistry` are the direct-API stack's handle.
  'apps/backend/src/appState.ts',
  // Reads `anthropicThinkingAlwaysOn` from `adapters/modelFamilies`. Move that
  // helper out of `adapters/` together with the next ClaudeAdapter change.
  'apps/backend/src/provider/runtime/claude/ClaudeAdapter.ts',
]

function legacyProviderImportRule(sourcePattern) {
  const message =
    'This is the frozen legacy provider stack (provider/adapter, adapters/, registry, service). New provider work targets provider/runtime/ and the ProviderHub; see the allowlist in eslint.config.js.'
  return [
    'error',
    ...[
      'ImportDeclaration',
      'ExportNamedDeclaration',
      'ExportAllDeclaration',
      'ImportExpression',
      'TSImportType',
    ].map((node) => ({
      selector: `${node}[source.value=/${sourcePattern}/]`,
      message,
    })),
  ]
}

const LEGACY_PROVIDER_STACK_BLOCKS = [
  {
    files: ['apps/backend/src/**/*.ts'],
    ignores: [
      'apps/backend/src/provider/**',
      ...LEGACY_PROVIDER_STACK_ALLOWLIST,
      '**/*.test.ts',
    ],
    rules: {
      'no-restricted-syntax': legacyProviderImportRule(
        `(^|\\/)provider\\/${LEGACY_PROVIDER_MODULE}$`
      ),
    },
  },
  // provider/*.ts, provider/*/*.ts, … — the deepest directory today is 3.
  ...[0, 1, 2, 3, 4, 5].map((depth) => ({
    files: [`apps/backend/src/provider/${'*/'.repeat(depth)}*.ts`],
    ignores: [
      ...LEGACY_PROVIDER_STACK_FILES,
      ...LEGACY_PROVIDER_STACK_ALLOWLIST,
      '**/*.test.ts',
    ],
    rules: {
      'no-restricted-syntax': legacyProviderImportRule(
        `^${depth === 0 ? '\\.\\/' : `(\\.\\.\\/){${depth}}`}${LEGACY_PROVIDER_MODULE}$`
      ),
    },
  })),
]

// ---------------------------------------------------------------------------
// Renderer layering. The intended direction is components/hooks -> lib ->
// services: `services/` is transport and must not drive zustand stores or
// run hooks, and `lib/` must not depend on React hooks modules. The
// `@/services/backend` barrel is gone; import the module that defines a
// function (`@/services/backend/gitApi`, …) so a file pulls in only what it
// uses. Chat turn orchestration lives in `lib/chat/send-message.ts`.
// ---------------------------------------------------------------------------
const NO_BACKEND_BARREL = {
  name: '@/services/backend',
  message:
    'Import the defining module instead (e.g. @/services/backend/chatApi); the barrel pulled the whole store graph into every importer.',
}

const RENDERER_LAYERING_BLOCKS = [
  {
    files: ['apps/ui/src/**/*.{ts,tsx}'],
    ignores: [
      'apps/ui/src/services/**',
      'apps/ui/src/lib/**',
      '**/*.test.{ts,tsx}',
    ],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'warn',
        { paths: [NO_BACKEND_BARREL] },
      ],
    },
  },
  {
    files: ['apps/ui/src/services/**/*.{ts,tsx}'],
    ignores: ['**/*.test.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'warn',
        {
          paths: [NO_BACKEND_BARREL],
          patterns: [
            {
              group: ['@/lib/*-store', '@/hooks/**'],
              message:
                'services/ is the transport layer: no zustand stores or hooks. Take the value as an argument, or move the orchestration to lib/ (see lib/chat/send-message.ts).',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/ui/src/lib/**/*.{ts,tsx}'],
    ignores: ['**/*.test.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'warn',
        {
          paths: [NO_BACKEND_BARREL],
          patterns: [
            {
              group: ['@/hooks/**', '../hooks/**', '../../hooks/**'],
              message:
                'lib/ sits below hooks/: move the shared code or type into lib/ and import it from there.',
            },
          ],
        },
      ],
    },
  },
]

/**
 * The same rules at "warn". Used to introduce a rule set on code that was
 * never linted with it: the findings show up in `npm run lint` without
 * failing it, and individual rules are raised to "error" once clean.
 */
function warnOnly(rules) {
  return Object.fromEntries(
    Object.entries(rules).map(([name, setting]) => {
      const [severity, ...options] = Array.isArray(setting) ? setting : [setting]
      return [name, severity === 'off' || severity === 0 ? setting : ['warn', ...options]]
    })
  )
}

export default defineConfig([
  globalIgnores([
    'dist',
    '.tmp/**', // Ignored local build and verification artifacts.
    'release/**', // Packaged builds and their temporary dependency copies.
    'apps/ui/dist/**',
    'apps/backend/dist/**',
    'apps/backend/node_modules/**',
    'apps/*/node_modules/**',
    'apps/*/.expo/**',
    // Generated native projects and build output of the mobile app.
    'apps/mobile/android/**',
    'apps/mobile/ios/**',
    'apps/mobile/build/**',
    'packages/*/dist/**',
    'packages/*/node_modules/**',
    '**/coverage/**', // `npm run test:coverage` reports.
    'Example/**',
    'Another_Example/**',
    'vscode-main/**',
    'BetterC0de-dev/**',
    // Tool-managed git worktrees (Kilo) are copies of this repo, not part of it.
    '.kilo/**',
  ]),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      // Underscore-prefixed identifiers are the conventional signal for
      // "intentionally unused" (arguments kept for signature parity, stubs
      // waiting for implementation, caught errors we only want to log).
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
      // The repository is not compiled with React Compiler yet. These
      // compiler-adoption diagnostics flag many established, valid state and
      // ref patterns and would turn a dependency upgrade into a broad UI
      // rewrite. Keep the correctness-critical rules-of-hooks and
      // exhaustive-deps checks from the recommended preset enabled.
      'react-hooks/refs': 'off',
      'react-hooks/globals': 'off',
      'react-hooks/immutability': 'off',
      'react-hooks/incompatible-library': 'off',
      'react-hooks/purity': 'off',
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/static-components': 'off',
      // Component modules intentionally co-locate small hooks/constants.
      // Fast Refresh still works for the component exports; this convention
      // should not fail source verification.
      'react-refresh/only-export-components': 'off',
    },
  },

  // Type-aware promise checks for the backend sidecar. An unhandled rejection
  // there triggers the fatal-shutdown path and ends every running agent turn,
  // so a promise that is neither awaited, returned, caught nor explicitly
  // `void`ed is a crash waiting for its first failure. Starts as a warning so
  // the existing call sites can be fixed incrementally; raise it to "error"
  // once `npm run lint` reports none.
  {
    files: ['apps/backend/src/**/*.ts'],
    ignores: ['**/*.test.ts', 'apps/backend/src/**/testUtils/**'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'warn',
    },
  },

  // Core rules (js.configs.recommended: no-undef, no-unused-vars,
  // no-dupe-keys, …) for the Electron shell and the repository scripts, which
  // are plain CommonJS / ESM run by Node and were linted only for imports.
  // Every rule is a warning until the existing findings are fixed, so `npm run
  // lint` (release:check) cannot start failing; raise rules to "error" once
  // they are clean.
  {
    files: ['apps/shell/**/*.cjs', 'scripts/**/*.cjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: globals.node,
    },
    rules: warnOnly(js.configs.recommended.rules),
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.nodeBuiltin,
    },
    rules: warnOnly(js.configs.recommended.rules),
  },
  {
    // The preloads run in the (sandboxed) renderer.
    files: ['apps/shell/preload.cjs', 'apps/shell/browser-preview-preload.cjs'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
  },

  // Baseline for every file the vendored-reference ban applies to. The three
  // scoped blocks below override this rule for their own files and therefore
  // spread `NO_VENDORED_REFERENCE` back in.
  {
    files: ['**/*.{ts,tsx,js,cjs,mjs}'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [NO_VENDORED_REFERENCE] },
      ],
    },
  },
  {
    files: ['apps/backend/src/persistence/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [NO_VENDORED_REFERENCE, NO_UPWARD_BACKEND_IMPORT] },
      ],
    },
  },
  {
    // These services were extracted from routes without transport imports.
    // Freeze that boundary so orchestration cannot migrate back into HTTP.
    files: [
      'apps/backend/src/services/chat/**/*.ts',
      'apps/backend/src/services/workspace/**/*.ts',
      'apps/backend/src/services/checkpoint-recovery-fence.ts',
    ],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [
        NO_VENDORED_REFERENCE,
        { group: ['**/http/**', 'hono', 'hono/*'], message: 'Services must not depend on HTTP. Keep transport concerns in http/routes and domain errors in errors.ts.' },
      ] }],
    },
  },
  {
    // The renderer is a browser document. A node builtin here is either a
    // packaging accident or a security boundary being crossed; either way it
    // belongs behind the shell's IPC or the backend's HTTP API.
    files: ['apps/ui/src/**/*.{ts,tsx}'],
    // Tests are exempt because they run in node, and several of them exist
    // precisely to read the shell's `.cjs` files off disk and assert they stay
    // in sync with their TypeScript twins.
    ignores: ['**/*.test.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: ['fs', 'path', 'os', 'child_process', 'net', 'http', 'https'].map(
            (name) => ({
              name,
              message:
                'The renderer has no node builtins. Go through the shell IPC (apps/shell) or the backend HTTP API.',
            })
          ),
          patterns: [
            NO_VENDORED_REFERENCE,
            {
              group: ['node:*'],
              message:
                'The renderer has no node builtins. Go through the shell IPC (apps/shell) or the backend HTTP API.',
            },
          ],
        },
      ],
    },
  },

  {
    // Very long functions hide closure and dependency mistakes until late;
    // the slash command runtime grew a 3,700-line function before anyone
    // noticed. A warning keeps new growth visible without failing CI on the
    // functions that are already longer.
    files: ['apps/ui/src/**/*.{ts,tsx}'],
    ignores: ['**/*.test.{ts,tsx}'],
    rules: {
      'max-lines-per-function': [
        'warn',
        { max: 300, skipBlankLines: true, skipComments: true },
      ],
    },
  },

  // Renderer layering: components/hooks -> lib -> services. These use
  // `@typescript-eslint/no-restricted-imports`, a separate rule name from the
  // node-builtin ban above, so the two compose instead of clobbering each
  // other; the three scopes below are disjoint. Warnings only, so `npm run
  // lint` cannot start failing on the violations that remain; raise them to
  // "error" once `npm run lint` reports none.
  ...RENDERER_LAYERING_BLOCKS,
  {
    // The preload bridge is reached through `services/ipc-facade.ts`
    // (`getElectronApi()` / `ipcApi`), so the IPC surface the UI depends on
    // can be found and typed in one place.
    files: ['apps/ui/src/**/*.{ts,tsx}'],
    ignores: ['apps/ui/src/services/**', '**/*.test.{ts,tsx}'],
    rules: {
      'no-restricted-properties': [
        'warn',
        {
          object: 'window',
          property: 'electronAPI',
          message:
            'Reach the desktop bridge through apps/ui/src/services/ipc-facade.ts (getElectronApi() or a typed ipcApi method).',
        },
      ],
    },
  },

  // The two rules below use `no-restricted-syntax` rather than
  // `no-restricted-imports` precisely so they compose with the blocks above
  // instead of overriding them. Their scopes are disjoint from each other.
  ...LEGACY_PROVIDER_STACK_BLOCKS,
  {
    // Transport construction belongs in `services/backend`, which owns the auth
    // token, port resolution, reconnect backoff and the replay cursor. A socket
    // opened anywhere else silently skips all four.
    files: ['apps/ui/src/**/*.{ts,tsx}'],
    ignores: [
      'apps/ui/src/services/backend/**',
      // Deepgram is a third-party streaming-transcription endpoint, not our
      // backend, so none of the machinery above applies to it.
      'apps/ui/src/lib/deepgram-session.ts',
      '**/*.test.{ts,tsx}',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='WebSocket']",
          message:
            'Open sockets through apps/ui/src/services/backend (wsClient), which owns auth, port resolution, backoff and replay.',
        },
        // The explicit `window.` spelling. The bare identifiers are handled by
        // `no-restricted-globals` below, which understands scope — this repo
        // has locals genuinely named `prompt` and `confirm` (the results of
        // `usePrompt()` and `useConfirm()`), and a syntax rule cannot tell
        // those apart from the globals.
        {
          selector:
            "CallExpression[callee.object.name='window'][callee.property.name=/^(prompt|alert|confirm)$/]",
          message: BROWSER_DIALOG_MESSAGE,
        },
      ],
      // Electron's renderer does not implement `prompt()` — calling it throws
      // "prompt() is not supported" and takes the click handler down with it.
      // Three separate Rename buttons were built on it, so renaming a thread
      // was broken everywhere it was offered. `alert()` and `confirm()` do
      // work, but they block the renderer and ignore the theme.
      'no-restricted-globals': [
        'error',
        { name: 'prompt', message: BROWSER_DIALOG_MESSAGE },
        { name: 'alert', message: BROWSER_DIALOG_MESSAGE },
        { name: 'confirm', message: BROWSER_DIALOG_MESSAGE },
      ],
    },
  },
])
