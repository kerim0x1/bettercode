/**
 * Guards for direct-API model turns that stopped at the output token limit.
 *
 * A tool call that was still streaming when the limit hit carries partial
 * input. The Anthropic SDK partial-parses it and silently drops an
 * unterminated string together with its key, and OpenAI-compatible endpoints
 * leave invalid JSON. Running such a call could empty or truncate a file, so
 * the agent loops answer it with an error tool result and let the model retry
 * with a smaller call instead.
 */

/** Visible output reserve for direct-API turns that advertise tools. File
 *  writes and edits arrive as tool input, so the 4k reserve used for plain
 *  chat cuts off ordinary source files mid-call. */
export const TOOL_TURN_OUTPUT_RESERVE_TOKENS = 16_384

/** Visible output reserve for plain chat turns without tools. */
export const CHAT_TURN_OUTPUT_RESERVE_TOKENS = 4_096

export function truncatedToolCallError(toolName: string): string {
  return (
    `The response reached the output token limit before the ${toolName} call ` +
    "was complete, so it was not run. Retry with smaller input, for example " +
    "by splitting a large file into several smaller Write or Edit calls."
  )
}

export function malformedToolArgumentsError(toolName: string): string {
  return (
    `The arguments for the ${toolName} call were not valid JSON, so it was ` +
    "not run. Retry the call with a complete JSON object."
  )
}
