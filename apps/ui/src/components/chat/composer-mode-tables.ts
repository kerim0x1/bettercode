/**
 * Shared data tables for composer picker menus.
 *
 * Both `composer-full-footer.tsx` and `composer-minimal-footer.tsx`
 * used to inline the permission-levels list with slight description
 * drift between them. The table now lives in
 * `@betterc0de/schema/chat-controls`, which the phone app's composer reads
 * too, so a wording change or a new level reaches every client from one
 * edit. This module keeps the desktop's import path.
 *
 * Not every picker has a static table — thinking-mode options are
 * provider-aware (Opus 4.7 vs Claude vs non-Claude have different
 * labels), so they stay inline where they're computed. Chat-mode and
 * special-mode menus also include per-option rich tooltips with
 * provider-conditional styling, which is easier to read co-located
 * with their renderer than routed through a config file.
 */

export {
  BYPASS_CONFIRM_BODY,
  BYPASS_CONFIRM_TITLE,
  PERMISSION_LEVELS,
  permissionLevelLabel,
  type PermissionLevelOption,
} from "@betterc0de/schema/chat-controls"
