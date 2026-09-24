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
}
