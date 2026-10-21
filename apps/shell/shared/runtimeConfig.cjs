/**
 * Runtime configuration the trusted renderer reads through
 * `electronAPI.getRuntimeConfig()` (IPC channel `runtime:config`). Port
 * changes after a backend restart arrive on the `backend:status` event.
 *
 * The backend bearer token intentionally never enters this payload. The
 * Electron main process adds it to trusted renderer network requests, so
 * application JavaScript cannot read or exfiltrate it.
 */
function buildRuntimeConfig({ port, electronPath, previewPartition }) {
  return {
    port: Number.isInteger(port) && port > 0 ? port : 0,
    mode: "local_sidecar",
    electronPath,
    previewPartition,
  }
}

module.exports = {
  buildRuntimeConfig,
}
