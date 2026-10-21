import { primeLoginShellPath } from "./loginShellPath"

/**
 * Process-wide settings applied once at backend start, before any child
 * process is spawned.
 *
 *  - Windows: `NoDefaultCurrentDirectoryInExePath=1` makes the executable
 *    search of this process (libuv's for bare names, `CreateProcess` without
 *    an application name) skip the current directory. Every spawn already
 *    passes an absolute path (see executablePath.ts); this is the defence
 *    in depth for one that does not.
 *  - macOS: merge the login shell's PATH when the app was started with
 *    launchd's minimal one (see loginShellPath.ts). Runs in the background.
 */
export function hardenBackendProcessEnvironment(): void {
  if (process.platform === "win32") {
    process.env.NoDefaultCurrentDirectoryInExePath = "1"
  }
  void primeLoginShellPath()
}
