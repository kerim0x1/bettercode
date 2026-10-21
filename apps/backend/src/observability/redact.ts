/**
 * Best-effort redaction for free-form diagnostic text (error messages and
 * stacks) before it is written to a log. Structured fields should still be
 * omitted at the source; this only catches credentials that ended up inside
 * an error string, such as an upstream response echoing an Authorization
 * header or a URL with an embedded password. A provider key prefix
 * (`sk-or-`, `sk-ant-`, `sk-proj-`, …) marks a key at any length, so a short
 * or revoked key quoted in an upstream error is caught too.
 */
export function redactSensitiveText(value: string): string {
  return value
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, "sk-[REDACTED]")
    .replace(
      /\bsk-(?:or|ant|proj|svcacct|admin)-[A-Za-z0-9_-]+/g,
      "sk-[REDACTED]"
    )
    .replace(/\bxox[a-z]-[A-Za-z0-9-]{12,}/gi, "xox-[REDACTED]")
    .replace(/\b(gh[pousr]_)[A-Za-z0-9]{20,}/g, "$1[REDACTED]")
    .replace(/\b(AIza)[A-Za-z0-9_-]{30,}/g, "$1[REDACTED]")
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(
      /\b([A-Z][A-Z0-9_]*(?:API_KEY|TOKEN|PASSWORD|SECRET))=([^\s]+)/g,
      "$1=[REDACTED]"
    )
    .replace(
      /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|password|secret|token)(["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi,
      "$1$2[REDACTED]"
    )
}

/** Redact and bound a diagnostic string so one log line stays readable. */
export function boundedRedactedText(value: string, maxChars: number): string {
  const redacted = redactSensitiveText(value)
  return redacted.length > maxChars
    ? `${redacted.slice(0, maxChars)}… [truncated ${redacted.length - maxChars} chars]`
    : redacted
}
