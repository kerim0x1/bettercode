import { createElement, type ComponentProps } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { expect, it, vi } from "vitest"
import { PlanListBody } from "./plan-list-body"
import { TooltipProvider } from "@/components/ui/tooltip"
const actions = vi.hoisted(() => [] as (() => void)[])
vi.mock("@/lib/chat-store", () => ({
  useThreadActivities: () => [],
  useThreadMessages: () => [],
}))
vi.mock("@/hooks/use-chat-streaming-state", () => ({
  useChatStreamingState: () => ({
    allPlans: [{ id: "legacy-plan", content: "# Existing plan" }],
    isPlanStreaming: false,
  }),
}))
vi.mock("@/components/ai-elements/message", () => ({
  MessageResponse: () => null,
}))
vi.mock("@/components/ui/button", () => ({
  Button: (props: ComponentProps<"button">) => {
    const text = renderToStaticMarkup(
      createElement("span", null, props.children)
    )
    if (props.onClick && /Open|Implement/.test(text))
      actions.push(() => props.onClick!({} as never))
    return null
  },
}))
it("pins both plan-tab actions to the owner even for legacy plans without a source reference", () => {
  actions.length = 0
  const open = vi.fn()
  renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(PlanListBody, {
        threadId: "owner",
        setPlanModalContent: open,
      })
    )
  )
  expect(actions).toHaveLength(2)
  for (const action of actions) action()
  expect(open).toHaveBeenCalledTimes(2)
  for (const [payload] of open.mock.calls)
    expect(payload).toMatchObject({
      threadId: "owner",
      content: "# Existing plan",
    })
})
