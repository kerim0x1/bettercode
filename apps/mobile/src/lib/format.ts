/**
 * Dates and sizes in the phone's own locale and time zone (the app used to
 * mix German and British formats). `locale` is for tests only.
 */

function valid(value: string | null | undefined): Date | null {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

/** "24 Sept 2026, 14:05" in the device's format; "–" when unknown. */
export function formatDateTime(
  value: string | null | undefined,
  locale?: string
): string {
  const date = valid(value)
  if (!date) return "–"
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date)
}

/** "24 Sept, 14:05": for recent events where the year is noise. */
export function formatShortDateTime(
  value: string | null | undefined,
  locale?: string
): string {
  const date = valid(value)
  if (!date) return ""
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date)
}

/** "14:05" for messages. */
export function formatTime(
  value: string | null | undefined,
  locale?: string
): string {
  const date = valid(value)
  if (!date) return ""
  return new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date)
}

/** "24 Sept" for chat rows. */
export function formatDay(
  value: string | null | undefined,
  locale?: string
): string {
  const date = valid(value)
  if (!date) return ""
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
  }).format(date)
}

export function formatBytes(size: number | null | undefined): string {
  if (size === null || size === undefined || !Number.isFinite(size) || size < 0)
    return ""
  if (size < 1024) return `${size} B`
  if (size < 1024 ** 2)
    return `${(size / 1024).toFixed(size < 10_240 ? 1 : 0)} KB`
  if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(1)} MB`
  return `${(size / 1024 ** 3).toFixed(1)} GB`
}
