import { useMemo, useState } from "react"
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native"
import {
  Check,
  CheckCheck,
  HelpCircle,
  ShieldAlert,
  X,
} from "lucide-react-native"
import type { PermissionUpdate } from "@betterc0de/schema"
import {
  ALWAYS_ALLOW_DESTINATIONS,
  alwaysAllowRules,
  buildAlwaysAllowUpdate,
  describeAlwaysAllowRules,
} from "@betterc0de/schema/always-allow"
import type { PendingRequest } from "@/types/remote"
import {
  colors,
  font,
  minTouchTarget,
  radius,
  spacing,
  type,
} from "@/design/theme"
import { DropdownRow, DropdownSheet } from "./dropdown-sheet"
import { MarkdownText } from "./markdown-text"

export function PendingRequestCard({
  request,
  busy,
  readOnly = false,
  alwaysAllow = true,
  onRespond,
}: {
  request: PendingRequest
  busy: boolean
  /** A watch-only session sees the request but must answer it on the desktop. */
  readOnly?: boolean
  /** Offered as on the desktop: not while the chat's preset is Read-only. */
  alwaysAllow?: boolean
  onRespond: (response: {
    decision?: "approve" | "deny"
    answers?: Record<string, unknown>
    message?: string
    updatedPermissions?: PermissionUpdate[]
  }) => void
}) {
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({})
  const [feedback, setFeedback] = useState("")
  const [scopesOpen, setScopesOpen] = useState(false)
  // `null` when no rule is narrow enough to remember safely: the option is
  // hidden then, as on the desktop, instead of storing a broader grant.
  const alwaysAllowRule = useMemo(() => {
    if (request.kind !== "approval") return null
    const rules = alwaysAllowRules(request)
    return rules ? describeAlwaysAllowRules(rules) : null
  }, [request])
  const questions = useMemo(() => request.questions ?? [], [request.questions])
  const canAnswer = useMemo(
    () =>
      questions.length > 0 &&
      questions.every((question) => {
        const answer = answers[question.id]
        return Array.isArray(answer)
          ? answer.length > 0
          : Boolean(answer?.trim())
      }),
    [answers, questions]
  )

  return (
    <View style={styles.card} testID={`request-${request.id}`}>
      <View style={styles.header}>
        {request.kind === "user-input" ? (
          <HelpCircle size={19} color={colors.info} />
        ) : (
          <ShieldAlert size={19} color={colors.warning} />
        )}
        <View style={styles.headerCopy}>
          <Text style={styles.eyebrow}>
            {request.kind === "user-input" ? "QUESTION" : "APPROVAL REQUIRED"}
          </Text>
          <Text style={styles.title}>{request.title}</Text>
        </View>
      </View>
      {request.detail && request.detail !== request.title ? (
        request.kind === "plan" ? (
          <View style={styles.planPreview}>
            <MarkdownText content={request.detail} />
          </View>
        ) : (
          <Text style={styles.detail}>{request.detail}</Text>
        )
      ) : null}
      {request.input !== undefined ? (
        <Text selectable style={styles.inputPreview} numberOfLines={6}>
          {formatInput(request.input)}
        </Text>
      ) : null}
      {readOnly ? (
        <Text style={styles.readOnlyNote}>
          This phone can only watch. Answer this on the desktop.
        </Text>
      ) : request.kind === "user-input" ? (
        <View style={styles.questions}>
          {questions.map((question) => (
            <View key={question.id} style={styles.question}>
              {question.header ? (
                <Text style={styles.questionHeader}>{question.header}</Text>
              ) : null}
              <Text style={styles.questionText}>{question.question}</Text>
              {question.options.length ? (
                <View style={styles.options}>
                  {question.options.map((option) => {
                    const answer = answers[question.id]
                    const selected = Array.isArray(answer)
                      ? answer.includes(option.label)
                      : answer === option.label
                    return (
                      <Pressable
                        key={option.label}
                        accessibilityRole={
                          question.multiSelect ? "checkbox" : "radio"
                        }
                        accessibilityState={{ checked: selected }}
                        onPress={() =>
                          setAnswers((current) => {
                            if (!question.multiSelect) {
                              return { ...current, [question.id]: option.label }
                            }
                            const currentAnswer = current[question.id]
                            const selectedValues: string[] = Array.isArray(
                              currentAnswer
                            )
                              ? currentAnswer
                              : []
                            return {
                              ...current,
                              [question.id]: selectedValues.includes(
                                option.label
                              )
                                ? selectedValues.filter(
                                    (value) => value !== option.label
                                  )
                                : [...selectedValues, option.label],
                            }
                          })
                        }
                        style={({ pressed }) => [
                          styles.option,
                          selected && styles.optionSelected,
                          pressed && styles.pressed,
                        ]}
                      >
                        <Text
                          style={[
                            styles.optionLabel,
                            selected && styles.optionLabelSelected,
                          ]}
                        >
                          {option.label}
                        </Text>
                        {option.description ? (
                          <Text style={styles.optionDescription}>
                            {option.description}
                          </Text>
                        ) : null}
                      </Pressable>
                    )
                  })}
                </View>
              ) : (
                <TextInput
                  value={textAnswer(answers[question.id])}
                  onChangeText={(value) =>
                    setAnswers((current) => ({
                      ...current,
                      [question.id]: value,
                    }))
                  }
                  placeholder="Enter answer"
                  placeholderTextColor={colors.textMuted}
                  style={styles.answerInput}
                  multiline
                />
              )}
            </View>
          ))}
          <View style={styles.actions}>
            <ActionButton
              label="Deny"
              icon="deny"
              testID="request-deny"
              disabled={busy}
              onPress={() => onRespond({ decision: "deny" })}
            />
            <ActionButton
              label="Send answer"
              icon="approve"
              testID="request-answer"
              disabled={busy || !canAnswer}
              onPress={() => onRespond({ answers })}
              primary
            />
          </View>
        </View>
      ) : (
        <>
          {request.kind === "plan" ? (
            <TextInput
              value={feedback}
              onChangeText={setFeedback}
              placeholder="Feedback when denying (optional)"
              placeholderTextColor={colors.textMuted}
              style={styles.answerInput}
              multiline
            />
          ) : null}
          <View style={styles.actions}>
            <ActionButton
              label="Deny"
              icon="deny"
              testID="request-deny"
              disabled={busy}
              onPress={() =>
                onRespond({
                  decision: "deny",
                  message: feedback.trim() || undefined,
                })
              }
            />
            <ActionButton
              label={request.kind === "plan" ? "Implement plan" : "Approve"}
              icon="approve"
              testID="request-approve"
              disabled={busy}
              onPress={() => onRespond({ decision: "approve" })}
              primary
            />
          </View>
          {alwaysAllow && alwaysAllowRule ? (
            <View style={styles.actions}>
              <ActionButton
                label="Always allow"
                icon="always"
                testID="request-always-allow"
                disabled={busy}
                onPress={() => setScopesOpen(true)}
              />
            </View>
          ) : null}
        </>
      )}
      {alwaysAllowRule ? (
        <DropdownSheet
          visible={scopesOpen}
          onClose={() => setScopesOpen(false)}
          title="Always allow"
        >
          <Text style={styles.scopeNote}>
            Approves this call, and the desktop stores the rule below: later
            calls that match it run without asking.
          </Text>
          {ALWAYS_ALLOW_DESTINATIONS.map((destination) => (
            <DropdownRow
              key={destination.id}
              label={destination.label}
              sublabel={alwaysAllowRule}
              onPress={() => {
                setScopesOpen(false)
                const update = buildAlwaysAllowUpdate(request, destination.id)
                onRespond({
                  decision: "approve",
                  updatedPermissions: update ? [update] : undefined,
                })
              }}
            />
          ))}
        </DropdownSheet>
      ) : null}
    </View>
  )
}

function ActionButton({
  label,
  icon,
  testID,
  disabled,
  primary = false,
  onPress,
}: {
  label: string
  icon: "approve" | "deny" | "always"
  testID: string
  disabled: boolean
  primary?: boolean
  onPress: () => void
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      testID={testID}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.action,
        primary && styles.actionPrimary,
        pressed && styles.pressed,
        disabled && styles.disabled,
      ]}
    >
      {icon === "approve" ? (
        <Check
          size={17}
          color={primary ? colors.primaryForeground : colors.text}
        />
      ) : icon === "always" ? (
        <CheckCheck size={17} color={colors.text} />
      ) : (
        <X size={17} color={colors.danger} />
      )}
      <Text
        style={[
          styles.actionText,
          primary && styles.actionTextPrimary,
          icon === "deny" && styles.actionTextDeny,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  )
}

function formatInput(value: unknown): string {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function textAnswer(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : ""
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: spacing.md,
    marginBottom: spacing.md,
    padding: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    gap: spacing.sm,
  },
  header: { flexDirection: "row", alignItems: "flex-start", gap: spacing.sm },
  readOnlyNote: {
    color: colors.textSecondary,
    fontFamily: font.medium,
    fontSize: 13,
    lineHeight: 19,
  },
  headerCopy: { flex: 1, minWidth: 0 },
  eyebrow: {
    color: colors.textSecondary,
    fontFamily: font.semibold,
    fontSize: 10,
    letterSpacing: 1.1,
  },
  title: {
    color: colors.text,
    fontFamily: font.semibold,
    fontSize: 16,
    marginTop: 3,
  },
  detail: {
    color: colors.textSecondary,
    fontFamily: font.regular,
    fontSize: type.small,
    lineHeight: 20,
  },
  planPreview: {
    padding: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.canvas,
    overflow: "hidden",
  },
  inputPreview: {
    color: "#D4D4D4",
    fontFamily: type.mono,
    fontSize: 12,
    lineHeight: 18,
    padding: spacing.sm,
    backgroundColor: colors.canvas,
    borderRadius: radius.sm,
  },
  questions: { gap: spacing.md },
  question: { gap: spacing.xs },
  questionHeader: {
    color: colors.textMuted,
    fontFamily: font.semibold,
    fontSize: type.micro,
    textTransform: "uppercase",
  },
  questionText: {
    color: colors.text,
    fontFamily: font.semibold,
    fontSize: type.body,
    lineHeight: type.lineHeight,
  },
  options: { gap: spacing.xs },
  option: {
    minHeight: minTouchTarget,
    padding: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
  },
  optionSelected: {
    borderColor: colors.mint,
    backgroundColor: colors.surfaceActive,
  },
  optionLabel: {
    color: colors.text,
    fontFamily: font.semibold,
    fontSize: type.small,
  },
  optionLabelSelected: { color: colors.text },
  optionDescription: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: type.micro,
    lineHeight: 17,
    marginTop: 3,
  },
  answerInput: {
    minHeight: 52,
    maxHeight: 130,
    color: colors.text,
    fontFamily: font.regular,
    fontSize: type.body,
    lineHeight: 22,
    padding: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
    textAlignVertical: "top",
  },
  actions: { flexDirection: "row", gap: spacing.xs },
  scopeNote: {
    color: colors.textSecondary,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
    paddingHorizontal: spacing.sm,
    paddingBottom: spacing.xs,
  },
  action: {
    flex: 1,
    minHeight: minTouchTarget,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
  },
  actionPrimary: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  actionText: {
    color: colors.text,
    fontFamily: font.semibold,
    fontSize: type.small,
  },
  actionTextPrimary: { color: colors.primaryForeground },
  actionTextDeny: { color: colors.danger },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.4 },
})
