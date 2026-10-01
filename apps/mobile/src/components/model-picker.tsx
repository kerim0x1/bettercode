import { useMemo, useState } from "react"
import { StyleSheet, TextInput, View } from "react-native"
import { Search } from "lucide-react-native"
import type { ModelOption } from "@/types/remote"
import { colors, font, radius, spacing } from "@/design/theme"
import {
  DropdownRow,
  DropdownSectionLabel,
  DropdownSheet,
} from "./dropdown-sheet"
import { ProviderLogo } from "./provider-logo"

/**
 * Model dropdown, mirroring the desktop composer's model menu: models grouped
 * under their provider (section label + count) with a primary check on the
 * active row, rendered as a bottom-sheet dropdown instead of a full-screen
 * modal. A filter box appears once the list is long enough to need one. Each
 * 9Router connection is its own group, and its models show their 9Router
 * group ("Claude Code", "Combos") beside the id.
 */
export function ModelPicker({
  visible,
  options,
  selected,
  onSelect,
  onClose,
}: {
  visible: boolean
  options: ModelOption[]
  selected: ModelOption | null
  onSelect: (option: ModelOption) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState("")
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return options
    return options.filter((option) =>
      [
        option.providerLabel,
        option.modelLabel,
        option.modelId,
        option.modelGroup ?? "",
      ]
        .join(" ")
        .toLowerCase()
        .includes(needle)
    )
  }, [options, query])

  const groups = useMemo(() => {
    const byProvider = new Map<string, ModelOption[]>()
    for (const option of filtered) {
      const existing = byProvider.get(option.providerLabel) ?? []
      existing.push(option)
      byProvider.set(option.providerLabel, existing)
    }
    return [...byProvider.entries()]
  }, [filtered])

  return (
    <DropdownSheet visible={visible} onClose={onClose} title="Model">
      {options.length > 6 ? (
        <View style={styles.search}>
          <Search size={14} color={colors.textMuted} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="Filter provider or model"
            accessibilityLabel="Filter provider or model"
            testID="model-filter"
            placeholderTextColor={colors.textMuted}
            style={styles.searchInput}
          />
        </View>
      ) : null}
      {groups.length === 0 ? (
        <DropdownSectionLabel>No models found</DropdownSectionLabel>
      ) : (
        groups.map(([providerLabel, providerOptions]) => (
          <View key={providerLabel}>
            <DropdownSectionLabel>{providerLabel}</DropdownSectionLabel>
            {providerOptions.map((option) => (
              <DropdownRow
                key={option.key}
                icon={<ProviderLogo kind={option.providerKind} size={15} />}
                label={option.modelLabel}
                sublabel={
                  option.modelGroup
                    ? `${option.modelGroup} · ${option.modelId}`
                    : option.modelId
                }
                active={option.key === selected?.key}
                onPress={() => {
                  onSelect(option)
                  onClose()
                }}
              />
            ))}
          </View>
        ))
      )}
    </DropdownSheet>
  )
}

const styles = StyleSheet.create({
  search: {
    marginHorizontal: spacing.xs,
    marginTop: spacing.xs,
    height: 36,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.canvas,
    paddingHorizontal: spacing.sm,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
  },
  searchInput: {
    flex: 1,
    height: "100%",
    color: colors.text,
    fontFamily: font.regular,
    fontSize: 13,
  },
})
