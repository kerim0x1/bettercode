export interface ReleaseVersion {
  readonly major: number
  readonly minor: number
  readonly patch: number
  readonly prerelease: { readonly label: "alpha" | "beta" | "rc"; readonly number: number } | null
}

export declare const MAX_VERSION_CODE: number
export declare function parseReleaseVersion(version: unknown): ReleaseVersion
export declare function androidVersionCode(version: unknown): number
export declare function iosMarketingVersion(version: unknown): string
