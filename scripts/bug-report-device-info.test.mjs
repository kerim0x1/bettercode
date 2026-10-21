import assert from "node:assert/strict"
import { createRequire } from "node:module"
import test from "node:test"

const { collectBugReportDeviceInfo, formatBugReportDeviceInfo } = createRequire(import.meta.url)("../apps/shell/shared/bug-report-device-info.cjs")
const GiB = 1024 ** 3
const runtime = { platform: "win32", versions: { electron: "40.0.0", chrome: "144.0", node: "24.0.0" } }
const system = {
  version: () => "Windows 11 Pro", release: () => "10.0.26100", arch: () => "x64",
  cpus: () => Array.from({ length: 16 }, () => ({ model: "  AMD Ryzen 7 7800X3D  ", speed: 4200 })),
  totalmem: () => 32 * GiB, freemem: () => 20 * GiB,
}
const app = {
  getAppMetrics: () => [
    { pid: 123, type: "Browser", memory: { workingSetSize: 102_400, privateBytes: 51_200 } },
    { pid: 456, type: "Tab", memory: { workingSetSize: 204_800, privateBytes: 102_400 } },
  ],
  getGPUInfo: async (kind) => {
    assert.equal(kind, "complete")
    return {
      gpuDevice: [
        { deviceString: "NVIDIA GeForce RTX 4080", vendorString: "NVIDIA", vendorId: 4318, deviceId: 9988,
          active: true, driverVendor: "NVIDIA", driverVersion: "32.0.15.8000", deviceIdentifier: "do-not-send" },
        { deviceString: "AMD Radeon Graphics", vendorId: 4098, deviceId: 1234, active: false },
      ],
      auxAttributes: { glRenderer: "ANGLE (NVIDIA, GeForce RTX 4080)", softwareRendering: false },
      machineModelName: "do-not-send", unrelatedField: "do-not-send",
    }
  },
}
const collect = (overrides = {}) => collectBugReportDeviceInfo({ app, system, runtime, ...overrides })

test("collects Windows edition/build, CPU details, RAM usage, all GPU adapters and drivers", async () => {
  const info = await collect()
  assert.deepEqual(info.os, { platform: "win32", version: "Windows 11 Pro", release: "10.0.26100", architecture: "x64" })
  assert.deepEqual(info.cpu, { model: "AMD Ryzen 7 7800X3D", logicalCores: 16, speedMHz: 4200 })
  assert.deepEqual(info.memory, { totalBytes: 32 * GiB, freeBytes: 20 * GiB, usedBytes: 12 * GiB, usedPercent: 37.5 })
  assert.equal(info.gpu.devices.length, 2)
  assert.equal(info.gpu.devices[0].name, "NVIDIA GeForce RTX 4080")
  assert.equal(info.gpu.devices[0].driverVersion, "32.0.15.8000")
  assert.equal(info.gpu.devices[1].active, false)
  assert.equal(info.gpu.softwareRendering, false)
  assert.equal(Number.isNaN(Date.parse(info.capturedAt)), false)
  assert.deepEqual(info.runtime, runtime.versions)
  assert.equal(JSON.stringify(info).includes("do-not-send"), false)
  assert.equal(JSON.stringify(info).includes('"pid"'), false)
})

test("converts Electron KiB metrics to bytes and labels the sum of process working sets", async () => {
  const info = await collect()
  assert.deepEqual(info.appMemory, {
    scope: "electron-processes", processCount: 2,
    workingSetBytesSum: 300 * 1024 ** 2, privateBytesSum: 150 * 1024 ** 2,
    byType: [
      { type: "Tab", processCount: 1, workingSetBytes: 200 * 1024 ** 2, privateBytes: 100 * 1024 ** 2 },
      { type: "Browser", processCount: 1, workingSetBytes: 100 * 1024 ** 2, privateBytes: 50 * 1024 ** 2 },
    ],
    largestProcesses: [
      { type: "Tab", name: null, workingSetBytes: 200 * 1024 ** 2, privateBytes: 100 * 1024 ** 2 },
      { type: "Browser", name: null, workingSetBytes: 100 * 1024 ** 2, privateBytes: 50 * 1024 ** 2 },
    ],
  })
  const readable = formatBugReportDeviceInfo(info)
  assert.match(readable, /Windows 11 Pro; release\/build: 10.0.26100/)
  assert.match(readable, /12.00 GiB used \/ 32.00 GiB total \(37.5%\)/)
  assert.match(readable, /300.0 MiB working set sum; 150.0 MiB private/)
  assert.match(readable, /App RAM by process type: Tab ×1: 200.0 MiB working set, 100.0 MiB private; Browser ×1/)
  assert.match(readable, /Largest processes: Tab 200.0 MiB; Browser 100.0 MiB/)
  assert.match(readable, /NVIDIA GeForce RTX 4080.*driver: NVIDIA 32.0.15.8000/)
})

test("groups many renderer and utility processes so a leaking type stands out", async () => {
  const metrics = [
    { type: "Browser", memory: { workingSetSize: 100 * 1024, privateBytes: 80 * 1024 } },
    ...Array.from({ length: 6 }, () => ({ type: "Tab", memory: { workingSetSize: 300 * 1024, privateBytes: 250 * 1024 } })),
    { type: "Utility", serviceName: "network.mojom.NetworkService", memory: { workingSetSize: 50 * 1024 } },
  ]
  const info = await collect({ app: { ...app, getAppMetrics: () => metrics } })
  assert.equal(info.appMemory.byType[0].type, "Tab")
  assert.equal(info.appMemory.byType[0].processCount, 6)
  assert.equal(info.appMemory.byType[0].workingSetBytes, 1800 * 1024 ** 2)
  assert.equal(info.appMemory.largestProcesses.length, 5)
  assert.ok(info.appMemory.largestProcesses.every((entry) => entry.type === "Tab"))
  const utility = info.appMemory.byType.find((group) => group.type === "Utility")
  assert.equal(utility.privateBytes, null)
  assert.doesNotMatch(formatBugReportDeviceInfo(info), /NaN|Infinity/)
})

test("takes a new RAM snapshot on each report", async () => {
  let free = 20 * GiB
  const liveSystem = { ...system, freemem: () => free }
  assert.equal((await collect({ system: liveSystem })).memory.usedBytes, 12 * GiB)
  free = 4 * GiB
  assert.equal((await collect({ system: liveSystem })).memory.usedBytes, 28 * GiB)
})

test("GPU rejection and missing metrics do not discard the other diagnostics", async () => {
  const info = await collect({ app: {
    getGPUInfo: async () => { throw new Error("GPU unavailable") },
    getAppMetrics: () => { throw new Error("Metrics unavailable") },
  } })
  assert.deepEqual(info.gpu, { status: "unavailable", devices: [] })
  assert.equal(info.appMemory, null)
  assert.equal(info.memory.totalBytes, 32 * GiB)
  assert.match(formatBugReportDeviceInfo(info), /GPU information: unavailable/)
})

test("a stalled GPU query times out while retaining CPU and RAM data", async () => {
  const info = await collect({ app: { ...app, getGPUInfo: () => new Promise(() => {}) }, gpuTimeoutMs: 5 })
  assert.deepEqual(info.gpu, { status: "timeout", devices: [] })
  assert.equal(info.cpu.logicalCores, 16)
  assert.equal(info.memory.usedPercent, 37.5)
})

test("supports non-Windows systems and marks unsupported private memory as unavailable", async () => {
  const info = await collect({
    runtime: { platform: "linux", versions: {} },
    system: { ...system, version: () => "#1 SMP Linux", release: () => "6.12.0", arch: () => "arm64" },
    app: { ...app, getAppMetrics: () => [{ memory: { workingSetSize: 1024 } }] },
  })
  assert.equal(info.os.platform, "linux")
  assert.equal(info.os.architecture, "arm64")
  assert.equal(info.appMemory.privateBytesSum, null)
  assert.equal(info.appMemory.workingSetBytesSum, 1024 ** 2)
})

test("missing CPU or invalid RAM values do not become misleading zeroes or NaN", async () => {
  const info = await collect({ system: { ...system, cpus: () => [], totalmem: () => NaN, freemem: () => -1 } })
  assert.deepEqual(info.cpu, { model: null, logicalCores: null, speedMHz: null })
  assert.deepEqual(info.memory, { totalBytes: null, freeBytes: null, usedBytes: null, usedPercent: null })
  assert.doesNotMatch(formatBugReportDeviceInfo(info), /NaN|Infinity/)
})
