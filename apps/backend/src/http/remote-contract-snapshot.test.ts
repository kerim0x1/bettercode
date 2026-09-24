import { httpContracts } from "@betterc0de/schema/http-contracts"
import {
  REMOTE_API_VERSION,
  remoteProtocolSchema,
} from "@betterc0de/schema/remote-protocol"
import { describe, expect, it } from "vitest"
import { z } from "zod"

// The phone app (apps/mobile) compiles these response schemas in, and an
// installed app can be older than the desktop it pairs with. A change that
// shows up here is either additive, which old apps tolerate, or breaking,
// which needs REMOTE_API_VERSION raised so old apps are told to update.

const SNAPSHOT = "./__snapshots__/remote-contracts.json"

function wireSchema(schema: z.ZodType): unknown {
  return z.toJSONSchema(schema, { io: "input", unrepresentable: "any" })
}

describe("response contracts the phone app compiles in", () => {
  it("change only together with a decision about REMOTE_API_VERSION", async () => {
    const contracts = Object.fromEntries(
      Object.entries(httpContracts)
        // Orchestration is desktop-only; paired devices get a 403.
        .filter(([name]) => !name.startsWith("orchestrator"))
        .map(([name, contract]) => [
          name,
          {
            method: contract.method,
            path: contract.path,
            response: wireSchema(contract.response),
          },
        ])
    )
    const snapshot = {
      apiVersion: REMOTE_API_VERSION,
      protocol: wireSchema(remoteProtocolSchema),
      contracts,
    }
    await expect(
      `${JSON.stringify(snapshot, null, 2)}\n`,
      [
        "A response contract changed. Installed phone apps parse these responses.",
        "Additive (new optional field, new endpoint): update the snapshot with `vitest -u`.",
        "Breaking (removed or renamed field, new value in a response enum, changed type):",
        "raise REMOTE_API_VERSION in packages/schema/src/remote-protocol.ts, then update the snapshot.",
      ].join("\n")
    ).toMatchFileSnapshot(SNAPSHOT)
  })
})
