import { createHash } from "node:crypto"
import {
  ORCHESTRATOR_PROVIDER_LABELS,
  type OrchestratorMember,
  type OrchestratorProvider,
} from "@betterc0de/schema"
import type {
  ProviderHub,
  ProviderRuntimeInstanceSnapshot,
} from "../../provider/runtime/ProviderHub"
import {
  isRuntimeProviderAllowedByProjectPolicy,
  isRuntimeModelAllowedByProjectPolicy,
  type ProjectProviderPolicy,
} from "../../provider/runtime/projectProviderPolicy"
import { canonicalProviderKindAlias } from "../../provider/runtime/providerKindAliases"
import { listProjectProviders } from "../workspace"
import { HttpError } from "../../errors"

/** Native CLI models only: these adapters carry the scoped orchestration MCP server. */
export async function orchestrationModelCatalog(
  hub: Pick<ProviderHub, "listInstances">,
  cwd: string,
  allowed: readonly OrchestratorProvider[]
): Promise<OrchestratorMember[]> {
  const [instances, policy] = await Promise.all([
    hub.listInstances({ cwd }),
    listProjectProviders(cwd),
  ])
  return selectOrchestrationModels(instances, policy, allowed)
}

type CatalogInstance = Pick<
  ProviderRuntimeInstanceSnapshot,
  | "instanceId"
  | "driver"
  | "displayName"
  | "enabled"
  | "configured"
  | "availability"
  | "models"
>

export function selectOrchestrationModels(
  instances: readonly CatalogInstance[],
  policy: ProjectProviderPolicy | null,
  allowed: readonly OrchestratorProvider[]
): OrchestratorMember[] {
  const members: OrchestratorMember[] = []
  for (const instance of instances) {
    // Runtime drivers keep their settings spelling (`grok-cli`); workers are
    // addressed by provider kind (`grok_cli`).
    const kind = canonicalProviderKindAlias(instance.driver)
    if (
      (kind !== "claude" && kind !== "codex" && kind !== "grok_cli") ||
      !allowed.includes(kind) ||
      !instance.enabled ||
      !instance.configured ||
      instance.availability !== "available" ||
      !isRuntimeProviderAllowedByProjectPolicy(instance, policy)
    )
      continue
    for (const model of instance.models) {
      if (!isRuntimeModelAllowedByProjectPolicy(instance, model, policy))
        continue
      const id = `model_${createHash("sha256")
        .update(JSON.stringify([kind, instance.instanceId, model.slug]))
        .digest("hex")
        .slice(0, 32)}`
      if (members.some((member) => member.id === id)) continue
      members.push({
        id,
        name: (model.name || model.slug).slice(0, 80),
        role: "Task and role chosen by the main model",
        providerKind: kind,
        providerInstanceId: instance.instanceId,
        modelId: model.slug,
        ...(model.capabilities ? { capabilities: model.capabilities } : {}),
      })
    }
  }
  for (const provider of allowed)
    if (!members.some((member) => member.providerKind === provider))
      throw new HttpError(
        409,
        `No available ${ORCHESTRATOR_PROVIDER_LABELS[provider]} worker models in this project. Configure that provider or deselect it in + → Orchestration.`
      )
  return members
}
