// Native pieces Jest cannot run. Each mock stands in for a device feature,
// not for app logic.

jest.mock("expo-camera", () => ({
  CameraView: () => null,
  useCameraPermissions: () => [{ granted: false, canAskAgain: true }, jest.fn(async () => ({ granted: false }))],
}))

jest.mock("expo-haptics", () => ({
  impactAsync: jest.fn(async () => undefined),
  notificationAsync: jest.fn(async () => undefined),
  ImpactFeedbackStyle: { Light: "light" },
  NotificationFeedbackType: { Warning: "warning" },
}))

jest.mock("expo-device", () => ({ modelName: "Test Phone" }))

// The keychain: an in-memory map per test file.
jest.mock("expo-secure-store", () => {
  const values = new Map()
  return {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1,
    getItemAsync: jest.fn(async (key) => values.get(key) ?? null),
    setItemAsync: jest.fn(async (key, value) => {
      values.set(key, value)
    }),
    deleteItemAsync: jest.fn(async (key) => {
      values.delete(key)
    }),
  }
})

// Any real network access from a component test is a bug.
global.fetch = jest.fn(() => Promise.reject(new Error("Component tests must not use the network.")))
global.WebSocket = jest.fn(() => {
  throw new Error("Component tests must not open sockets.")
})
