/**
 * Readable names for model ids that arrive without one — mainly OpenRouter's
 * `vendor/model` slugs ("google/gemini-4-argon" → "Gemini 4 Argon"). The id
 * stays the identity everywhere; this is presentation only.
 */

/** Words with a fixed spelling, keyed by their lower-case form. */
const SPELLINGS: Readonly<Record<string, string>> = {
  ai: "AI",
  chatgpt: "ChatGPT",
  deepseek: "DeepSeek",
  gemini: "Gemini",
  gemma: "Gemma",
  glm: "GLM",
  gpt: "GPT",
  grok: "Grok",
  kimi: "Kimi",
  llama: "Llama",
  minimax: "MiniMax",
  mistral: "Mistral",
  openai: "OpenAI",
  oss: "OSS",
  qwen: "Qwen",
  qwq: "QwQ",
  r1: "R1",
  vl: "VL",
}

function capitalize(word: string): string {
  return word ? word.charAt(0).toUpperCase() + word.slice(1) : word
}

/** One slug word, cased the way its maker writes it. */
function caseWord(word: string): string {
  const lower = word.toLowerCase()
  if (SPELLINGS[lower]) return SPELLINGS[lower]
  // Sizes: 70b → 70B, 128k → 128K.
  if (/^\d+(?:\.\d+)?[bkm]$/.test(lower)) return lower.toUpperCase()
  // Versions: v3 → V3. OpenAI's reasoning line stays lower case: o3, o4.
  if (/^v\d/.test(lower)) return lower.toUpperCase()
  if (/^o\d/.test(lower)) return lower
  // A name fused with its version: qwen3.8 → Qwen3.8, gpt4o → GPT4o.
  const fused = /^([a-z]+)(\d.*)$/.exec(lower)
  if (fused) return (SPELLINGS[fused[1]] ?? capitalize(fused[1])) + fused[2]
  if (/^\d/.test(lower)) return lower
  return capitalize(lower)
}

/**
 * "google/gemini-4-argon" → "Gemini 4 Argon",
 * "anthropic/claude-3-5-sonnet" → "Claude 3.5 Sonnet",
 * "meta-llama/llama-3.1-70b-instruct:free" → "Llama 3.1 70B Instruct (Free)".
 */
export function prettyModelId(id: string): string {
  let slug = id.trim()
  const slash = slug.lastIndexOf("/")
  if (slash >= 0) slug = slug.slice(slash + 1)
  let variant = ""
  const colon = slug.indexOf(":")
  if (colon >= 0) {
    const tag = slug.slice(colon + 1).trim()
    slug = slug.slice(0, colon)
    if (tag) variant = ` (${capitalize(tag)})`
  }
  const words: string[] = []
  for (const part of slug.split(/[-_\s]+/).filter(Boolean)) {
    const previous = words.at(-1)
    // Split versions: "3-5" after a number reads "3.5".
    if (/^\d$/.test(part) && previous && /^\d+$/.test(previous)) {
      words[words.length - 1] = `${previous}.${part}`
      continue
    }
    words.push(caseWord(part))
  }
  return words.length > 0 ? words.join(" ") + variant : id
}

/**
 * The name to show for a model: its own name when it has a real one,
 * otherwise a readable form of a `vendor/model` id, otherwise the id.
 */
export function displayModelName(id: string, name?: string | null): string {
  const own = name?.trim()
  if (own && own !== id && !own.includes("/")) return own
  if (id.includes("/")) return prettyModelId(id)
  return own || id
}
