import { z } from "zod"
import type * as ClaudeAgentSdk from "@anthropic-ai/claude-agent-sdk"
import {
  IMAGEGEN_REASONING_EFFORT,
  resolveImageGenerationModel,
  type ImageGenerationRunner,
} from "../../../services/image-generation"
import { IMAGEGEN_TOOL_NAME } from "../../shared/chat-mode-tools"

/**
 * In-process SDK MCP server exposing BetterC0de's image-generation tool to
 * Claude Agent SDK sessions. The handler runs inside the backend process —
 * no stdio child, no extra transport — and shells out to the local Codex
 * CLI with the configured image model at xhigh (settings
 * `image_generation_model`; see services/image-generation.ts).
 *
 * Server name "betterc0de" + tool name "generate_image" must stay in sync
 * with IMAGEGEN_TOOL_NAME (`mcp__betterc0de__generate_image`) — that string
 * is routed through BetterC0de's central tool policy.
 */

/** The part of @anthropic-ai/claude-agent-sdk the server needs; the
 *  dynamically imported SDK module is passed straight through. */
export type SdkMcpCapableModule = Pick<
  typeof ClaudeAgentSdk,
  "createSdkMcpServer" | "tool"
>

export const IMAGEGEN_MCP_SERVER_NAME = "betterc0de"

/** Appended to the system prompt in agentish modes so Claude reaches for
 *  the tool instead of shipping placeholder rectangles. */
export const IMAGEGEN_SYSTEM_HINT = [
  `When you build UI that needs bitmap image assets (hero images, illustrations, placeholder photos, textures, bitmap logos), call the ${IMAGEGEN_TOOL_NAME} tool instead of shipping solid-color placeholder boxes, ad-hoc SVG stand-ins, or hot-linked stock-photo URLs.`,
  "Pass a relative .png save path inside the project and reference that path from your code.",
  "Generation takes 1-5 minutes per image, so fire independent generate_image calls in parallel and continue other work while they run.",
].join(" ")

/** The tool description names the model this server will actually use. */
export function imagegenToolDescription(model: string): string {
  return [
    "Generate a real PNG image asset for the project: hero images, illustrations, placeholder photos, textures, backgrounds, bitmap logos.",
    `Renders via ${model} at ${IMAGEGEN_REASONING_EFFORT} reasoning effort with native image generation (local Codex CLI, ChatGPT login).`,
    "Slow (1-5 minutes per image) — make independent calls in parallel. Generates exactly one image per call.",
  ].join(" ")
}

export function buildImagegenMcpServer(
  sdk: SdkMcpCapableModule,
  ctx: {
    workspaceDir: string
    /** Configured image model (settings `image_generation_model`), read when the server is built. */
    model?: string | null
    /**
     * The backend's image generations (bootstrap's `ImageGenerationService`).
     * Without them the tool answers with a failure instead of running.
     */
    imageGeneration?: ImageGenerationRunner
  }
): ClaudeAgentSdk.McpSdkServerConfigWithInstance {
  const model = resolveImageGenerationModel(ctx.model)
  const generateImageTool = sdk.tool(
    "generate_image",
    imagegenToolDescription(model),
    {
      prompt: z
        .string()
        .min(1)
        .describe(
          "Detailed description of the image: subject, composition, colors, mood, background."
        ),
      save_path: z
        .string()
        .min(1)
        .describe(
          "Target file relative to the project root, must end in .png (e.g. public/assets/hero.png)."
        ),
      size: z
        .enum(["1024x1024", "1536x1024", "1024x1536", "auto"])
        .optional()
        .describe("Image size/aspect. Defaults to auto."),
      style_hint: z
        .string()
        .optional()
        .describe(
          "Art direction, e.g. 'flat vector illustration', 'photorealistic', 'soft 3D render'."
        ),
      overwrite: z
        .boolean()
        .optional()
        .describe(
          "Replace an existing regular PNG. Defaults to false; symlink targets are always rejected."
        ),
    },
    async (args, extra) => {
      const input = args as {
        prompt: string
        save_path: string
        size?: string
        style_hint?: string
        overwrite?: boolean
      }
      const signal = (extra as { signal?: AbortSignal } | undefined)?.signal
      if (!ctx.imageGeneration) {
        const unavailable = {
          ok: false,
          code: "generation_failed",
          message: "Image generation is not available in this backend.",
        } as const
        return {
          content: [{ type: "text", text: JSON.stringify(unavailable) }],
          isError: true,
        }
      }
      const result = await ctx.imageGeneration.generate({
        prompt: input.prompt,
        savePath: input.save_path,
        workspaceDir: ctx.workspaceDir,
        model,
        ...(input.size ? { size: input.size } : {}),
        ...(input.style_hint ? { styleHint: input.style_hint } : {}),
        ...(input.overwrite !== undefined
          ? { overwrite: input.overwrite }
          : {}),
        ...(signal ? { signal } : {}),
      })
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        isError: !result.ok,
      }
    }
  )
  return sdk.createSdkMcpServer({
    name: IMAGEGEN_MCP_SERVER_NAME,
    version: "1.0.0",
    tools: [generateImageTool],
  })
}
