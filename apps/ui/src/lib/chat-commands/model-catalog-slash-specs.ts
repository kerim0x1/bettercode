import {
  type ProviderOptionSelection,
  getProviderOptionCurrentValue,
} from "@betterc0de/schema"
import type { UiProvider } from "@/lib/provider-types"
import {
  applyModelVariantCycleCommand,
  readActiveProviderComposerSelection,
} from "./model-actions"
import {
  buildBetterC0deModelsTerminalCommand,
  buildProviderCatalogOutput,
  selectedOptionValue,
} from "./provider-commands"
import { dispatchPrefilledTerminalCommand } from "./slash-command-actions"
import type { SlashCommandRunSpec, SlashCommandRuntimeRun } from "./slash-run"

function buildVariantsOutput(
  provider: UiProvider | undefined,
  selectedModel: string,
  optionSelections?: ReadonlyArray<ProviderOptionSelection> | null
): string {
  const model = provider?.models.find((entry) => entry.id === selectedModel)
  const descriptors = model?.capabilities?.optionDescriptors ?? []
  const variantDescriptors = descriptors.filter(
    (descriptor) => descriptor.type === "select"
  )
  if (!provider || !model || variantDescriptors.length === 0) {
    return [
      "# Model Variants\n",
      "> This provider/model does not expose native variant controls yet.",
      "",
      provider
        ? `Selected: **${provider.name}** / \`${selectedModel}\``
        : "No provider selected.",
    ].join("\n")
  }
  const rows = variantDescriptors.flatMap((descriptor) =>
    descriptor.options.map((option) => {
      const current = selectedOptionValue(
        optionSelections,
        descriptor.id,
        descriptor.options.map((entry) => entry.id)
      )
      const fallback = getProviderOptionCurrentValue(descriptor)
      const currentValue =
        current ?? (typeof fallback === "string" ? fallback : undefined)
      return `| ${descriptor.label ?? descriptor.id} | \`${option.id}\` | ${option.label} | ${option.id === currentValue ? "Yes" : "-"} |`
    })
  )
  return [
    "# Model Variants\n",
    `Selected: **${provider.name}** / \`${model.name}\``,
    "",
    "| Option | Value | Label | Current |",
    "|:-------|:------|:------|:--------|",
    ...rows,
  ].join("\n")
}

/** Model variants and the provider model catalog (`/models <query>` lands here). */
export const MODEL_CATALOG_SLASH_SPECS: readonly SlashCommandRunSpec<SlashCommandRuntimeRun>[] =
  [
    {
      names: ["variants", "variant.list", "variant-list"],
      run: (run) => {
        const { selectedProvider, selectedModel, threadId } = run
        run.output = buildVariantsOutput(
          selectedProvider,
          selectedModel,
          readActiveProviderComposerSelection(selectedProvider?.id, threadId)
            ?.optionSelections
        )
      },
    },
    {
      names: [
        "variant.cycle",
        "variant-cycle",
        "model.variant.cycle",
        "model-variant-cycle",
      ],
      run: (run) => {
        const { args, selectedProvider, selectedModel, threadId } = run
        run.output = applyModelVariantCycleCommand({
          threadId,
          provider: selectedProvider,
          selectedModel,
          requestedOptionId: args[0],
        })
      },
    },
    {
      names: [
        "catalog",
        "model-catalog",
        "model-info",
        "models",
        "models.list",
        "models-list",
        "catalog.model.list",
        "catalog.model.get",
        "v2.model.list",
        "v2-model-list",
      ],
      run: (run) => {
        const { args, providers, activeThread } = run
        const terminalCommand = buildBetterC0deModelsTerminalCommand(
          args,
          providers
        )
        if (terminalCommand.shouldOpen && terminalCommand.command) {
          dispatchPrefilledTerminalCommand(
            activeThread,
            terminalCommand.command
          )
        }
        run.output = buildProviderCatalogOutput(providers, args)
      },
    },
  ]
