/** A destructive action waiting for the shared "Are you sure?" dialog. */
export type ConfirmAction = {
  title: string
  description: string
  action: () => void
}
