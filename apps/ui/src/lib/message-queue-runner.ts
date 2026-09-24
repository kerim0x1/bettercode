/**
 * Sends queued messages when their chat is ready. The runner is shared with
 * the phone app (@betterc0de/schema/message-queue); this module keeps the
 * desktop's import path.
 */
export { startMessageQueueRunner } from "@betterc0de/schema/message-queue"
