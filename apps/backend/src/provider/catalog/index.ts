/**
 * Provider registry — single source of truth for every supported provider.
 * Each provider lives in its own file in this directory; this index just
 * aggregates them and exposes lookup helpers used by:
 *
 *   - apps/backend/src/auth/keyResolution.ts (resolves keys via the registry)
 *   - apps/backend/src/http/routes/providers.ts (lists providers via /api/v1/providers)
 *   - apps/ui/src/components/settings/providers-section.tsx (renders Settings UI)
 *
 * Adding a provider = create a new file here + import + push into PROVIDERS.
 * No other file in the codebase needs to change.
 */

import type { ProviderDefinition } from "./types";
import { anthropic } from "./anthropic";
import { openai } from "./openai";
import { grok } from "./grok";
import { openrouter } from "./openrouter";
import { deepseek } from "./deepseek";
import { lmstudio } from "./lmstudio";
import { claudeCli } from "./claude-cli";
import { codexCli } from "./codex-cli";
import { grokCli } from "./grok-cli";
import { cursorCli } from "./cursor-cli";
import { opencodeCli } from "./opencode-cli";

// Order shapes the Settings UI:
//   1. CLI-backed (claude, codex, grok, cursor, opencode) — most common "I already have a CLI logged in"
//   2. API-key-only providers (anthropic, openai, grok)
//   3. Aggregators (openrouter, deepseek)
//   4. Local servers (lmstudio)
// Google (Gemini) was removed 2026-09-02: it was listed here but no adapter
// was ever registered for it, so a chat turn on it could not work.
export const PROVIDERS: readonly ProviderDefinition[] = [
  claudeCli,
  codexCli,
  grokCli,
  cursorCli,
  opencodeCli,
  anthropic,
  openai,
  grok,
  openrouter,
  deepseek,
  lmstudio,
];

const BY_ID: ReadonlyMap<string, ProviderDefinition> = new Map(
  PROVIDERS.map((p) => [p.id, p]),
);

export function getProvider(id: string): ProviderDefinition | undefined {
  return BY_ID.get(id);
}

export function listProviders(): readonly ProviderDefinition[] {
  return PROVIDERS;
}

export type { ProviderDefinition, AuthMethod, AuthPrompt, ResolvedApiKey, KeySource } from "./types";
export { resolveProviderApiKey } from "./types";
