/**
 * The system instruction builder, from @betterc0de/schema/system-instruction.
 * The backend builds each turn's instruction with it (`prepareTurn`, see
 * apps/backend services/chat/turn-preparation.ts); the renderer uses it only
 * for previews and size estimates.
 */
export * from "@betterc0de/schema/system-instruction"
