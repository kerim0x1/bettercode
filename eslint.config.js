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

  // The two rules below use `no-restricted-syntax` rather than
  // `no-restricted-imports` precisely so they compose with the blocks above
  // instead of overriding them. Their scopes are disjoint from each other.
  {
    // The legacy in-process provider stack (`provider/adapter.ts`,
    // `provider/adapters/`, `provider/service.ts`, `provider/registry.ts`) is
    // frozen — new work belongs in `provider/runtime/`. Today its only importers
    // are its own files, and that is the property worth keeping.
    files: ['apps/backend/src/**/*.ts'],
    ignores: [
      'apps/backend/src/provider/adapter.ts',
      'apps/backend/src/provider/adapters/**',
      'apps/backend/src/provider/registry.ts',
      'apps/backend/src/provider/service.ts',
      '**/*.test.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ImportDeclaration[source.value=/(^|\\/)adapter$/]',
          message:
            'This is the legacy provider adapter contract. New code targets provider/runtime/ (see AGENTS.md, "There are two provider stacks").',
        },
      ],
    },
  },
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
