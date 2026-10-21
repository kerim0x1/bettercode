import { compareReleaseVersions } from "@betterc0de/schema"

/**
 * Versions printed by provider CLIs, compared in one place. CLIs wrap the
 * version in text ("2.1.111 (Claude Code)", "codex-cli 0.50.0", "v1.14.19")
 * and some omit the patch, so the first `major.minor[.patch]` run is read
 * (a bare number such as the 0 in "betterc0de" is not a version); order is
 * semantic-version order, a prerelease sorting before its release.
 */

const CLI_VERSION =
  /(?:^|[^\d.])v?(\d+)\.(\d+)(?:\.(\d+))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?/

/**
 * The first version in a CLI's output as `major.minor.patch[-prerelease]`,
 * missing parts as 0; null when there is none.
 */
export function normalizeCliVersion(
  output: string | null | undefined
): string | null {
  const match = CLI_VERSION.exec(output ?? "")
  if (!match) return null
  const core = [match[1], match[2], match[3]]
    .map((part) => String(Number(part ?? 0)))
    .join(".")
  return match[4] ? `${core}-${match[4]}` : core
}

/**
 * Order of two CLI versions (negative, 0, positive), or null when either has
 * no readable version, so the caller decides what an unknown version means.
 */
export function compareCliVersions(
  left: string | null | undefined,
  right: string | null | undefined
): number | null {
  const a = normalizeCliVersion(left)
  const b = normalizeCliVersion(right)
  if (!a || !b) return null
  const order = compareReleaseVersions(a, b)
  if (order !== null) return order
  // A prerelease tag outside semver (leading zeros): compare the release only.
  return compareReleaseVersions(a.split("-", 1)[0]!, b.split("-", 1)[0]!)
}

/**
 * True when `version` is at least `minimum`; an unreadable version is not.
 * With `prereleaseMeetsRelease`, a prerelease counts as its release
 * (`0.140.0-alpha.2` meets `0.140.0`), for checks against CLIs that ship
 * alpha builds of the release that added a feature.
 */
export function cliVersionAtLeast(
  version: string | null | undefined,
  minimum: string,
  options: { readonly prereleaseMeetsRelease?: boolean } = {}
): boolean {
  const normalized = normalizeCliVersion(version)
  const candidate =
    normalized && options.prereleaseMeetsRelease
      ? normalized.split("-", 1)[0]!
      : normalized
  const order = compareCliVersions(candidate, minimum)
  return order !== null && order >= 0
}
