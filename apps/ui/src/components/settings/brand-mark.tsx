import { providerBrand } from "@/lib/provider-brand"
import { cn } from "@/lib/utils"

const BRAND_NAMES: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  "grok-cli": "Grok CLI",
  grok_cli: "Grok CLI",
  anthropic: "Anthropic API",
  openai: "OpenAI API",
  grok: "xAI API",
  openrouter: "OpenRouter",
  lmstudio: "LM Studio",
}

/**
 * A provider's brand mark at text size, for settings rows that refer to a
 * specific CLI or API (CLAUDE.md, Codex skills, "Used by" strips). Unknown
 * ids render nothing. Pass `label` to show the name beside the mark.
 */
export function BrandMark({
  id,
  label = false,
  className,
}: {
  id: string
  label?: boolean
  className?: string
}) {
  const brand = providerBrand(id)
  if (!brand) return null
  const name = BRAND_NAMES[id] ?? id
  return (
    <span
      className={cn("inline-flex shrink-0 items-center gap-1.5", className)}
      title={name}
    >
      <img
        src={brand.logo}
        alt={label ? "" : name}
        className={cn(
          "size-3.5 shrink-0 object-contain",
          brand.invertDark && "dark:invert"
        )}
      />
      {label ? <span>{name}</span> : null}
    </span>
  )
}

/** Several marks in a row, e.g. which providers use a setting. */
export function BrandMarks({
  ids,
  className,
}: {
  ids: readonly string[]
  className?: string
}) {
  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      {ids.map((id) => (
        <BrandMark key={id} id={id} />
      ))}
    </span>
  )
}
