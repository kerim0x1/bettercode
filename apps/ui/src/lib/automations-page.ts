/**
 * Opening the Automations page (`components/automations`), which the app
 * shell renders in the main area. Kept apart from `lib/automations.ts` so
 * the sidebar and the shortcuts do not pull the editor's schemas into the
 * first bundle.
 */

/** The window event that opens the Automations page (`layout/app-shell.tsx`). */
export const OPEN_AUTOMATIONS_EVENT = "betterc0de:open-automations"

/** Opens the Automations page: the sidebar's Scheduled action and Ctrl+Shift+A. */
export function openAutomationsPage(): void {
  window.dispatchEvent(new CustomEvent(OPEN_AUTOMATIONS_EVENT))
}
