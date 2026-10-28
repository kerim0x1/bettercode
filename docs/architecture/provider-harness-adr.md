# ADR: Provider harness boundary

Status: accepted for the 0.1 public beta.

## Decision

BetterC0de owns the outer provider control plane: routing, permissions,
approvals, timeouts, recovery, persistence, observability, and UI delivery.
Provider SDKs and CLIs own their native inner model/tool loop. Every provider
crosses the same canonical adapter and event contracts.

## Drivers

- Preserve provider-native sessions, tools, and authentication.
- Enforce one application security and durability boundary.
- Keep Codex, Claude SDK, Claude Terminal, Cursor and OpenCode ACP, BetterC0de
  compatibility, and API-key providers first-class without duplicating
  orchestration logic.

## Consequences

- Native messages are translated at adapter ingress.
- Provider-native allowlists never replace BetterC0de approval policy.
- Legacy HTTP, WebSocket, provider aliases, and persisted events remain
  readable through boundary codecs while internal code uses canonical types.
- Provider upgrades require fixture, contract, and release-smoke verification.

## Presentation and provider metadata

`runtime/tool-name-category.ts` holds the ordered naming rules for Claude,
Claude Terminal and the compatibility adapter. Their differing priorities are
explicit. These categories describe activities; approval decisions continue
through the permission policy. ACP status merging preserves fields omitted by
partial updates and retains the provider's raw input and output.

`packages/schema/src/tool-activity.ts` interprets activity evidence for all
consumers. Action selection uses ordered rules; command extraction follows the
provider field precedence, and path lookup uses a bounded depth-first traversal.
It stops after finding the first usable path. Protocol field names and exported
contracts remain stable for desktop, mobile and persisted activity records.

Text generation builds task documents from response keys, constraints and
bounded context sections. Generated JSON is scanned as quoted spans and object
delimiters, so braces inside escaped strings cannot terminate the result early.
