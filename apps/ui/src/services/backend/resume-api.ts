/**
 * Chat resume transport: `POST /chat/resume`, nothing else. The backend
 * resumes a chat a usage limit or a restart stopped
 * (apps/backend services/chat/resume-runtime.ts); the renderer sends the
 * user's choice and mirrors the record (`@/lib/chat-resume`). Keep store and
 * hook imports out of this module, as in `chatApi.ts`.
 */
import type { ChatResumeAction } from "@betterc0de/schema"
import { invokeContract } from "./contracts"

/** "Resume now" sends a turn; it may wait as long as `/chat/send`. */
export const postChatResume = (threadId: string, action: ChatResumeAction) =>
  invokeContract("chatResume", {
    method: "POST",
    body: { threadId, action },
    ...(action === "now" ? { timeoutMs: 210_000 } : {}),
  })
