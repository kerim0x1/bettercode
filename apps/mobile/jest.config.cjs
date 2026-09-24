// Component and screen tests (`*.test.tsx`) run in Jest with Expo's preset,
// which mocks the native modules React Native needs. Logic tests
// (`*.test.ts`) stay in Vitest (vitest.config.ts); the extension decides.

// The preset resolves packages with the "react-native" export condition,
// which gives the icon set's ES-module build; Jest runs its CommonJS build
// (what Node's `require` resolves to).
const lucideCommonJs = require.resolve("lucide-react-native")

/** @type {import("jest").Config} */
module.exports = {
  preset: "jest-expo",
  testMatch: ["<rootDir>/src/**/*.test.tsx"],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/src/$1",
    "^lucide-react-native$": lucideCommonJs,
  },
  setupFilesAfterEnv: ["<rootDir>/jest.setup.cjs"],
  // A test's first render loads the app's routes, and with them React
  // Native and Expo through Babel. On a CI runner with a cold transform
  // cache that alone can take longer than Jest's default of 5 s.
  testTimeout: 30_000,
}
