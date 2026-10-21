import assert from "node:assert/strict"
import { createRequire } from "node:module"
import test from "node:test"

const { createBugReportSender } = createRequire(import.meta.url)("../apps/shell/shared/bug-report.cjs")
const report = { message: "Error opening project", stack: "Error: failed\n  at openProject" }
const deviceInfo = {
  capturedAt: "2026-09-20T12:00:00.000Z",
  os: { platform: "win32", version: "Windows 11 Pro", release: "10.0.26100", architecture: "x64" },
  cpu: { model: "Test CPU", logicalCores: 8, speedMHz: 3200 },
  memory: { totalBytes: 32 * 1024 ** 3, freeBytes: 20 * 1024 ** 3, usedBytes: 12 * 1024 ** 3, usedPercent: 37.5 },
  appMemory: null, gpu: { status: "unavailable", devices: [] }, runtime: {},
}

function setup(fetchImpl = async () => new Response(null, { status: 204 })) {
  let time = 100_000
  const calls = []
  const send = createBugReportSender({
    appVersion: "1.2.3", os: "win32", arch: "x64", installId: "test-installation", now: () => time,
    getDeviceInfo: async () => deviceInfo,
    fetchImpl: (...args) => { calls.push(args); return fetchImpl(...args) },
  })
  return { send, calls, advance: (ms) => { time += ms } }
}

test("posts only the report and host metadata to the fixed endpoint, accepting 204", async () => {
  const { send, calls } = setup()
  assert.deepEqual(await send({ ...report, logs: "Renderer log", installId: "spoofed", arch: "spoofed", appVersion: "spoofed", os: "spoofed", deviceInfo: { cpu: "spoofed" }, url: "https://example.com" }), { ok: true, retryAfterMs: 10_000 })
  const [url, options] = calls[0]
  assert.equal(url, "https://betterc0de.com/api/bug/report")
  assert.equal(options.method, "POST")
  assert.deepEqual(options.headers, { "Content-Type": "application/json" })
  assert.equal(options.redirect, "error")
  const payload = JSON.parse(options.body)
  assert.equal(payload.stack, report.stack)
  assert.equal(payload.appVersion, "1.2.3")
  assert.equal(payload.os, "win32")
  assert.equal(payload.arch, "x64")
  assert.equal(payload.installId, "test-installation")
  assert.equal(payload.logs, "Renderer log")
  assert.deepEqual(payload.deviceInfo, deviceInfo)
  assert.ok(payload.message.startsWith(report.message))
  assert.match(payload.message, /## Device Info/)
  assert.match(payload.message, /Windows 11 Pro/)
  assert.match(payload.message, /12.00 GiB used \/ 32.00 GiB total/)
  assert.equal(payload.url, undefined)
})

test("rejects repeated attempts until the exact ten-second boundary", async () => {
  const { send, calls, advance } = setup()
  await send(report)
  advance(9999)
  assert.deepEqual(await send(report), { ok: false, error: "Please wait before sending another report.", retryAfterMs: 1 })
  assert.equal(calls.length, 1)
  advance(1)
  assert.equal((await send(report)).ok, true)
  assert.equal(calls.length, 2)
})

test("a slow in-flight request still prevents a second upload after ten seconds", async () => {
  let finish
  let signalStarted
  const started = new Promise((resolve) => { signalStarted = resolve })
  const { send, calls, advance } = setup(() => new Promise((resolve) => { finish = resolve; signalStarted() }))
  const first = send(report)
  await started
  advance(11_000)
  assert.equal((await send(report)).ok, false)
  assert.equal(calls.length, 1)
  finish(new Response(null, { status: 204 }))
  assert.equal((await first).ok, true)
})

test("appends readable diagnostics to a full report without exceeding the message limit", async () => {
  const { send, calls } = setup()
  await send({ message: "x".repeat(128_000), stack: "" })
  const payload = JSON.parse(calls[0][1].body)
  assert.ok(payload.message.length <= 128_000)
  assert.match(payload.message, /\[truncated\]/)
  assert.match(payload.message, /## Device Info/)
  assert.match(payload.message, /Windows 11 Pro/)
})

test("the report still sends if diagnostic collection fails", async () => {
  let payload
  const send = createBugReportSender({
    appVersion: "1.2.3", os: "win32",
    getDeviceInfo: () => { throw new Error("System API unavailable") },
    fetchImpl: async (_url, options) => { payload = JSON.parse(options.body); return new Response(null, { status: 204 }) },
  })
  assert.equal((await send(report)).ok, true)
  assert.equal(payload.deviceInfo, null)
  assert.match(payload.message, /## Device Info\nUnavailable/)
})

test("validation and cooldown reject requests before collecting device information", async () => {
  let collected = 0
  const send = createBugReportSender({
    appVersion: "1.2.3", os: "win32", now: () => 100_000,
    getDeviceInfo: async () => { collected += 1; return deviceInfo },
    fetchImpl: async () => new Response(null, { status: 204 }),
  })
  await send(null)
  assert.equal(collected, 0)
  await send(report)
  await send(report)
  assert.equal(collected, 1)
})

test("HTTP failures keep the cooldown and do not report success", async () => {
  const { send, calls } = setup(async () => new Response("Unavailable", { status: 503 }))
  const result = await send(report)
  assert.equal(result.ok, false)
  assert.match(result.error, /HTTP 503/)
  assert.equal(result.retryAfterMs, 10_000)
  await send(report)
  assert.equal(calls.length, 1)
})

test("network failures allow a later manual retry without automatically retrying", async () => {
  const { send, calls, advance } = setup(async () => { throw new Error("offline") })
  assert.match((await send(report)).error, /connection/)
  advance(10_000)
  assert.equal(calls.length, 1)
  await send(report)
  assert.equal(calls.length, 2)
})

test("invalid or oversized input does not consume the cooldown or send a request", async () => {
  const { send, calls } = setup()
  for (const input of [null, {}, { message: "  ", stack: "" }, { message: "x", stack: 1 },
    { message: "x".repeat(128_001), stack: "" }, { message: "x", stack: "x".repeat(32_001) },
    { message: "x", stack: "", logs: [] }, { message: "x", stack: "", logs: "x".repeat(64_001) }]) {
    assert.deepEqual(await send(input), { ok: false, error: "Invalid bug report.", retryAfterMs: 0 })
  }
  assert.equal(calls.length, 0)
  assert.equal((await send({ message: "No errors captured", stack: "" })).ok, true)
})

test("aborts a stalled upload and returns a recoverable timeout", async () => {
  const send = createBugReportSender({
    appVersion: "1.2.3", os: "win32", timeoutMs: 5,
    fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true })
    }),
  })
  const result = await send(report)
  assert.equal(result.ok, false)
  assert.match(result.error, /timed out/)
  assert.ok(result.retryAfterMs > 0)
})

test("the message, stack and every log source are redacted right before upload", async () => {
  let payload
  const send = createBugReportSender({
    appVersion: "1.2.3", os: "win32",
    redact: (text) => text.replaceAll("secret-value", "[REDACTED]"),
    getLogs: () => "main log with secret-value",
    fetchImpl: async (_url, options) => { payload = JSON.parse(options.body); return new Response(null, { status: 204 }) },
  })
  assert.equal((await send({ message: "failed with secret-value", stack: "at secret-value", logs: "renderer secret-value" })).ok, true)
  assert.equal(JSON.stringify(payload).includes("secret-value"), false)
  assert.match(payload.logs, /renderer \[REDACTED\]\nmain log with \[REDACTED\]/)
})

test("the installation ID is asked for per report and omitted without one", async () => {
  const bodies = []
  let installId = null
  let time = 0
  const send = createBugReportSender({
    appVersion: "1.2.3", os: "win32", now: () => time, getInstallId: () => installId,
    fetchImpl: async (_url, options) => { bodies.push(JSON.parse(options.body)); return new Response(null, { status: 204 }) },
  })
  await send(report)
  installId = "opted-in"
  time += 10_000
  await send(report)
  assert.equal(bodies[0].installId, null)
  assert.equal(bodies[1].installId, "opted-in")
})
