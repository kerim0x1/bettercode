// @ts-check
/**
 * Redaction for diagnostic text that may leave the process: the in-memory
 * crash-report ring, the persistent application log, and every bug report
 * payload. Applied to main-process console lines, forwarded backend output
 * and renderer console messages alike, so a future log line that happens to
 * contain a credential is scrubbed before it is buffered, written or sent.
 *
 * The patterns are deliberately conservative: they remove known credential
 * shapes, values of credential-named keys, URL user info, email addresses and
 * the user's home directory (which usually carries the OS account name).
 */

const os = require("node:os")

const REDACTED = "[REDACTED]"

/**
 * Credential formats with a recognisable prefix.
 * @type {Array<[RegExp, string]>}
 */
const TOKEN_PATTERNS = [
  // Authorization header values. Keep the scheme so the line stays readable.
  // Case-sensitive on purpose: "basic authentication" in prose is not a header.
  [/\b(Bearer|bearer|BEARER)\s+[A-Za-z0-9._~+/=-]{8,}/g, `$1 ${REDACTED}`],
  [/\b(Basic)\s+(?=[A-Za-z0-9+/=]*[0-9+/=])[A-Za-z0-9+/]{8,}={0,2}(?=$|[\s"',;])/g, `$1 ${REDACTED}`],
  [/\bsk-ant-[A-Za-z0-9_-]{10,}/g, REDACTED],
  // OpenAI (sk-, sk-proj-) and OpenRouter (sk-or-v1-) keys.
  [/\bsk-[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\bxai-[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\bgsk_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\bbc_remote_[A-Za-z0-9_-]{8,}/g, REDACTED],
  // JSON Web Tokens (OAuth access and ID tokens).
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
]

/**
 * `key=value`, `key: value` and `"key":"value"` where the key names a
 * credential. The key must END in the credential word, so `max_tokens=4096`
 * or `tokenCount: 3` stay intact while `access_token=…`, `x-api-key: …` and
 * `"clientSecret": "…"` are redacted.
 */
const SECRET_ASSIGNMENT =
  /(["']?)([A-Za-z0-9_.-]*?(?:token|secret|password|passwd|pwd|passphrase|api[_-]?key|access[_-]?key|private[_-]?key|authorization|cookie|credentials?))\1(\s*[:=]\s*)("[^"\r\n]*"|'[^'\r\n]*'|(?!\[REDACTED\]|(?:Bearer|Basic)\s)[^\s"',;&}<>]+)/gi

const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:"']+:[^\s/@"']+@/gi
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g
// Another account's profile directory, after the current home was replaced.
const WINDOWS_PROFILE_PATH = /\b([A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/])[^\\/\s"'<>|:*?]+/gi
const POSIX_PROFILE_PATH = /(^|[\s"'`(=:[,])(\/(?:Users|home)\/)[^/\s"'`)]+/g

/**
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * One case-appropriate pattern for every spelling of the home directories.
 * @param {readonly unknown[]} homeDirs
 * @param {string} platform
 * @returns {RegExp | null}
 */
function homeDirectoryPattern(homeDirs, platform) {
  /** @type {Set<string>} */
  const variants = new Set()
  for (const raw of homeDirs) {
    if (typeof raw !== "string") continue
    const trimmed = raw.replace(/[\\/]+$/, "")
    // A root or one-segment home would redact half of every path.
    if (trimmed.length < 4) continue
    variants.add(trimmed)
    variants.add(trimmed.replace(/\\/g, "/"))
    variants.add(trimmed.replace(/\\/g, "\\\\"))
  }
  if (variants.size === 0) return null
  const alternatives = [...variants]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join("|")
  // Windows and macOS file systems are case-insensitive by default.
  const flags = platform === "linux" ? "g" : "gi"
  return new RegExp(`(?:${alternatives})(?=$|[\\\\/\\s"'\`),;:\\]])`, flags)
}

/**
 * Build a redactor bound to the current user's home directory. The returned
 * function never throws; a non-string input is stringified first.
 * @param {object} [options]
 * @param {readonly unknown[]} [options.homeDirs]
 * @param {string} [options.platform]
 * @returns {(input: unknown) => string}
 */
function createLogRedactor({
  homeDirs = [safeHomeDir()],
  platform = process.platform,
} = {}) {
  const homePattern = homeDirectoryPattern(homeDirs, platform)
  return function redactSensitiveText(input) {
    /** @type {string} */
    let text
    try {
      text = typeof input === "string" ? input : String(input)
    } catch {
      return "[unprintable]"
    }
    if (!text) return text
    try {
      text = text.replace(URL_USERINFO, `$1${REDACTED}@`)
      for (const [pattern, replacement] of TOKEN_PATTERNS) {
        text = text.replace(pattern, replacement)
      }
      text = text.replace(
        SECRET_ASSIGNMENT,
        (_match, keyQuote, key, separator, value) => {
          const quote = value[0] === '"' || value[0] === "'" ? value[0] : ""
          return `${keyQuote}${key}${keyQuote}${separator}${quote}${REDACTED}${quote}`
        },
      )
      text = text.replace(EMAIL, "[EMAIL]")
      if (homePattern) text = text.replace(homePattern, "~")
      text = text.replace(WINDOWS_PROFILE_PATH, "$1<user>")
      text = text.replace(POSIX_PROFILE_PATH, "$1$2<user>")
      return text
    } catch {
      // Redaction must never take the logger down; drop the line instead of
      // risking an unredacted copy.
      return "[unredactable log line]"
    }
  }
}

/** @returns {string} */
function safeHomeDir() {
  try {
    return os.homedir()
  } catch {
    return ""
  }
}

/** @type {((input: unknown) => string) | null} */
let defaultRedactor = null
/**
 * Redact with the current user's home directory.
 * @param {unknown} input
 * @returns {string}
 */
function redactSensitiveText(input) {
  defaultRedactor ??= createLogRedactor()
  return defaultRedactor(input)
}

module.exports = { REDACTED, createLogRedactor, redactSensitiveText }
