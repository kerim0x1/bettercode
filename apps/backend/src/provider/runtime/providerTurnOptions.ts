import {
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
  type ProviderSendTurnInput,
} from "./contracts"
import { normalizeModelSlug } from "@betterc0de/schema"

export function resolveTurnModelId(input: ProviderSendTurnInput): string {
  const rawModel = input.modelSelection?.model ?? input.modelId
  const providerHint =
    input.modelSelection?.instanceId ?? input.providerInstanceId ?? undefined
  return normalizeModelSlug(rawModel, providerHint) ?? rawModel
}

export function resolveTurnStringOption(
  input: ProviderSendTurnInput,
  optionId: string | ReadonlyArray<string>,
  legacyValue?: string | null
): string | null | undefined {
  for (const id of asOptionIds(optionId)) {
    const value = getModelSelectionStringOptionValue(input.modelSelection, id)
    if (value !== undefined) return value
  }
  return legacyValue
}

export function resolveTurnBooleanOption(
  input: ProviderSendTurnInput,
  optionId: string | ReadonlyArray<string>,
  legacyValue?: boolean | null
): boolean | null | undefined {
  for (const id of asOptionIds(optionId)) {
    const value = getModelSelectionBooleanOptionValue(input.modelSelection, id)
    if (value !== undefined) return value
  }
  return legacyValue
}

function asOptionIds(
  optionId: string | ReadonlyArray<string>
): ReadonlyArray<string> {
  return typeof optionId === "string" ? [optionId] : optionId
}

export function runtimeModeForTurn(
  input: Pick<ProviderSendTurnInput, "chatMode" | "permissionLevel">
): string | undefined {
  switch ((input.chatMode ?? "").trim().toLowerCase()) {
    case "plan":
      return "plan"
    case "ask":
      return "read-only"
    case "security":
      return "security"
  }
  switch ((input.permissionLevel ?? "").trim().toLowerCase()) {
    case "bypass":
    case "full-access":
      return "full-access"
    case "full":
    case "allow-edits":
    case "auto-accept-edits":
      return "auto-accept-edits"
    case "read-only":
    case "read":
      return "read-only"
    case "ask":
    case "ask-on-edit":
    case "approval-required":
      return "approval-required"
    default:
      return undefined
  }
}

export function normalizeRuntimeMode(
  value: string | null | undefined
): string | null {
  if (typeof value !== "string") return null
  switch (value.trim().toLowerCase()) {
    case "plan":
      return "plan"
    case "security":
      return "security"
    case "bypass":
    case "full-access":
      return "full-access"
    case "full":
    case "allow-edits":
    case "auto-accept-edits":
      return "auto-accept-edits"
    case "read-only":
    case "read":
      return "read-only"
    case "ask":
    case "ask-on-edit":
    case "approval-required":
      return "approval-required"
    default:
      return null
  }
}
