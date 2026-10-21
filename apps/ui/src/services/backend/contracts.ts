import type {
  HttpContractName,
  HttpContractRequest,
  HttpContractResponse,
} from "@betterc0de/schema/http-contracts"
import { invoke } from "./runtime"

export async function invokeContract<K extends HttpContractName>(
  name: K,
  options: {
    body?: unknown
    args?: Record<string, unknown>
    id?: string
    /** Path parameters other than `:id`, e.g. `{ messageId }`. */
    params?: Readonly<Record<string, string>>
    query?: string
    method?: string
    signal?: AbortSignal
    timeoutMs?: number
    silentStatuses?: number[]
    /** Extra request headers (e.g. `clientInstanceRequestOptions()`). */
    headers?: Record<string, string>
  } = {}
): Promise<HttpContractResponse<K>> {
  // Keep validation schemas off the first-frame path; load them on the first request.
  const { httpContracts, requestHttpContract } =
    await import("@betterc0de/schema/http-contracts")
  const body =
    httpContracts[name].method === "GET"
      ? undefined
      : (options.body ?? options.args)
  // Persistence callers may start with imported JSON; the shared helper validates it.
  return requestHttpContract(
    name,
    ({ path, method, body }) =>
      invoke<unknown>(path, { ...options, args: undefined, method, body }),
    {
      ...options,
      body: body as HttpContractRequest<K>,
    }
  )
}
