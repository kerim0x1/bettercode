const os = require("node:os")

function read(callback, fallback = null) {
  try { return callback() } catch { return fallback }
}

function number(value) {
  return Number.isFinite(value) && value >= 0 ? value : null
}

function text(value) {
  return typeof value === "string" && value.trim()
    ? value.trim().replace(/\s+/g, " ").slice(0, 512)
    : null
}

function collectAppMemory(app) {
  const metrics = app.getAppMetrics()
  const sumBytes = (list, key) => {
    const values = list.map((metric) => number(metric.memory?.[key])).filter((value) => value !== null)
    // Electron reports these values in KiB; Node's OS memory values use bytes.
    return values.length ? values.reduce((sum, value) => sum + value, 0) * 1024 : null
  }
  // Per process type (Browser, Tab, GPU, Utility, …), so a leak in renderers
  // or webview guests is distinguishable from the main or GPU process.
  const groups = new Map()
  for (const metric of metrics) {
    const type = text(metric?.type) ?? "Unknown"
    const group = groups.get(type) ?? []
    group.push(metric)
    groups.set(type, group)
  }
  const byType = [...groups.entries()]
    .map(([type, list]) => ({
      type,
      processCount: list.length,
      workingSetBytes: sumBytes(list, "workingSetSize"),
      privateBytes: sumBytes(list, "privateBytes"),
    }))
    .sort((a, b) => (b.workingSetBytes ?? 0) - (a.workingSetBytes ?? 0))
  const largestProcesses = metrics
    .map((metric) => ({
      type: text(metric?.type) ?? "Unknown",
      // Utility processes carry a service name; it identifies the subsystem.
      name: text(metric?.serviceName) ?? text(metric?.name),
      workingSetBytes: number(metric.memory?.workingSetSize) === null ? null : metric.memory.workingSetSize * 1024,
      privateBytes: number(metric.memory?.privateBytes) === null ? null : metric.memory.privateBytes * 1024,
    }))
    .filter((entry) => entry.workingSetBytes !== null)
    .sort((a, b) => b.workingSetBytes - a.workingSetBytes)
    .slice(0, 5)
  return {
    scope: "electron-processes",
    processCount: metrics.length,
    // Summing working sets can count shared pages more than once.
    workingSetBytesSum: sumBytes(metrics, "workingSetSize"),
    privateBytesSum: sumBytes(metrics, "privateBytes"),
    byType,
    largestProcesses,
  }
}

async function collectGpu(app, timeoutMs) {
  let timer
  try {
    return await Promise.race([
      Promise.resolve().then(() => app.getGPUInfo("complete")).then((info) => ({
        status: "available",
        devices: (Array.isArray(info?.gpuDevice) ? info.gpuDevice : []).slice(0, 8).map((device) => ({
          name: text(device?.deviceString),
          vendor: text(device?.vendorString),
          vendorId: number(device?.vendorId),
          deviceId: number(device?.deviceId),
          active: typeof device?.active === "boolean" ? device.active : null,
          driverVendor: text(device?.driverVendor),
          driverVersion: text(device?.driverVersion),
        })),
        renderer: text(info?.auxAttributes?.glRenderer),
        softwareRendering: typeof info?.auxAttributes?.softwareRendering === "boolean"
          ? info.auxAttributes.softwareRendering : null,
      })).catch(() => ({ status: "unavailable", devices: [] })),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ status: "timeout", devices: [] }), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Collect for manual and automatic reports; omit machine IDs and raw GPU dumps. */
async function collectBugReportDeviceInfo({ app, system = os, runtime = process, gpuTimeoutMs = 2000 }) {
  const capturedAt = new Date().toISOString()
  const systemInfo = {
    platform: runtime.platform,
    version: read(() => text(system.version())),
    release: read(() => text(system.release())),
    architecture: read(() => text(system.arch())),
  }
  const cpu = read(() => {
    const cpus = system.cpus()
    return {
      model: text(cpus[0]?.model),
      logicalCores: cpus.length || null,
      speedMHz: cpus[0]?.speed > 0 ? number(cpus[0].speed) : null,
    }
  })
  const memory = read(() => {
    const totalBytes = number(system.totalmem())
    const available = number(system.freemem())
    const freeBytes = available !== null && totalBytes !== null ? Math.min(available, totalBytes) : available
    const usedBytes = totalBytes !== null && freeBytes !== null ? totalBytes - freeBytes : null
    return {
      totalBytes, freeBytes, usedBytes,
      usedPercent: totalBytes > 0 && usedBytes !== null ? Math.round(usedBytes / totalBytes * 1000) / 10 : null,
    }
  })
  const appMemory = read(() => collectAppMemory(app))
  const gpu = await collectGpu(app, gpuTimeoutMs)
  return {
    capturedAt,
    os: systemInfo,
    cpu,
    memory,
    appMemory,
    gpu,
    runtime: {
      electron: text(runtime.versions?.electron),
      chrome: text(runtime.versions?.chrome),
      node: text(runtime.versions?.node),
    },
  }
}

function formatBugReportDeviceInfo(info) {
  if (!info) return "## Device Info\nUnavailable"
  const value = (input) => input ?? "unavailable"
  const gib = (bytes) => bytes === null || bytes === undefined ? "unavailable" : `${(bytes / 1024 ** 3).toFixed(2)} GiB`
  const mib = (bytes) => bytes === null || bytes === undefined ? "unavailable" : `${(bytes / 1024 ** 2).toFixed(1)} MiB`
  const gpuLines = info.gpu.devices.map((gpu, index) =>
    `- GPU ${index + 1}: ${value(gpu.name)}; vendor: ${value(gpu.vendor)}; vendor/device ID: ${value(gpu.vendorId)}/${value(gpu.deviceId)}; active: ${value(gpu.active)}; driver: ${value(gpu.driverVendor)} ${value(gpu.driverVersion)}`)
  return [
    "## Device Info",
    `Captured: ${info.capturedAt}`,
    `- OS: ${value(info.os.version)}; release/build: ${value(info.os.release)}; ${value(info.os.architecture)} (${info.os.platform})`,
    `- CPU: ${value(info.cpu?.model)}; logical cores: ${value(info.cpu?.logicalCores)}; speed: ${value(info.cpu?.speedMHz)} MHz`,
    `- RAM: ${gib(info.memory?.usedBytes)} used / ${gib(info.memory?.totalBytes)} total (${value(info.memory?.usedPercent)}%); ${gib(info.memory?.freeBytes)} free`,
    `- App RAM (Electron processes): ${mib(info.appMemory?.workingSetBytesSum)} working set sum; ${mib(info.appMemory?.privateBytesSum)} private; process count: ${value(info.appMemory?.processCount)}`,
    ...(Array.isArray(info.appMemory?.byType) && info.appMemory.byType.length > 0
      ? [`- App RAM by process type: ${info.appMemory.byType
        .map((group) => `${group.type} ×${group.processCount}: ${mib(group.workingSetBytes)} working set, ${mib(group.privateBytes)} private`)
        .join("; ")}`]
      : []),
    ...(Array.isArray(info.appMemory?.largestProcesses) && info.appMemory.largestProcesses.length > 0
      ? [`- Largest processes: ${info.appMemory.largestProcesses
        .map((entry) => `${entry.type}${entry.name ? ` (${entry.name})` : ""} ${mib(entry.workingSetBytes)}`)
        .join("; ")}`]
      : []),
    `- GPU information: ${info.gpu.status}`,
    ...gpuLines,
    `- GPU renderer: ${value(info.gpu.renderer)}; software rendering: ${value(info.gpu.softwareRendering)}`,
    `- Runtime: Electron ${value(info.runtime.electron)}; Chromium ${value(info.runtime.chrome)}; Node ${value(info.runtime.node)}`,
  ].join("\n")
}

module.exports = { collectBugReportDeviceInfo, formatBugReportDeviceInfo }
