import {
  httpContracts,
  type HttpContractName,
} from "@betterc0de/schema/http-contracts"
import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import type { z } from "zod"
import { parseAndHandle, type ParseAndHandleOptions } from "./routeHelpers"

/**
 * What a handler may return for a contract: the response's input type
 * without the index signatures that `passthrough` objects add. Services
 * return named interfaces, and TypeScript never treats an interface as
 * indexable, so checking against the raw input type would reject them even
 * when every field matches. The response is still parsed before it is sent.
 */
export type ContractResult<T> = T extends readonly (infer Item)[]
  ? readonly ContractResult<Item>[]
  : T extends object
    ? {
        [K in keyof T as string extends K
          ? never
          : number extends K
            ? never
            : K]: ContractResult<T[K]>
      }
    : T

export function handleHttpContract<K extends HttpContractName>(
  c: Context,
  name: K,
  handler: (
    body: z.output<(typeof httpContracts)[K]["request"]>,
    c: Context
  ) => Promise<ContractResult<z.input<(typeof httpContracts)[K]["response"]>>>,
  options: ParseAndHandleOptions
): Promise<Response> {
  const contract = httpContracts[name]
  return parseAndHandle(
    c,
    contract.request,
    async (body) => {
      const result = contract.response.parse(
        await handler(body as z.output<(typeof httpContracts)[K]["request"]>, c)
      )
      return result === undefined ? c.body(null, 204) : c.json(result)
    },
    options
  )
}

/** Read models start as persistence data; validate them at the HTTP boundary. */
export function contractJson<K extends HttpContractName>(
  c: Context,
  name: K,
  value: unknown,
  status?: ContentfulStatusCode
): Response {
  return c.json(httpContracts[name].response.parse(value), status)
}

/**
 * A response the route builds itself: its type is checked against the
 * contract when the backend compiles and its value when it is sent. `status`
 * is for an answer that keeps the contract's shape but not a 200 (`{ ok:
 * false }` with a 404, say); errors still go out as `{ error, code? }`.
 */
export function contractResult<K extends HttpContractName>(
  c: Context,
  name: K,
  value: ContractResult<z.input<(typeof httpContracts)[K]["response"]>>,
  status?: ContentfulStatusCode
): Response {
  return contractJson(c, name, value, status)
}
