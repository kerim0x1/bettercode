import { z } from "zod"

/**
 * The building blocks of the shared HTTP contract table (`http-contracts.ts`).
 * They live apart from the table so a group of routes can declare its
 * contracts in a module of its own (`provider-contracts.ts`, …) that the
 * table spreads in.
 */

export type HttpContractMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE"

/** One route: the request a client sends and the response it reads. */
export function endpoint<I extends z.ZodType, O extends z.ZodType>(
  method: HttpContractMethod,
  path: string,
  request: I,
  response: O
) {
  return { method, path, request, response }
}

/** A request without a body. */
export const noBody = z.undefined()

/**
 * The body of a POST whose route reads nothing from it. Clients send `{}` or
 * nothing at all; both are accepted.
 */
export const ignoredBody = z.unknown()

/** A schema whose parsed value and accepted input are both `T`. */
export type RecordSchema<T> = z.ZodType<T, T>

/**
 * A nested value that is declared, not checked: model capabilities, a
 * provider's catalog metadata, a metrics sample. Its producer owns the shape
 * and clients read it defensively, so a richer value from a newer desktop is
 * passed along instead of refused. Use it only below a record whose own
 * fields are checked.
 */
export function unchecked<T>(): RecordSchema<T> {
  return z.custom<T>()
}

/**
 * A record whose `Checked` fields are validated (and typed for the backend
 * that writes them) while the rest passes through untouched, read by clients
 * as the fuller `Read` model. For records with a large provider-specific part
 * that the reader already normalizes, such as a provider instance snapshot.
 */
export function readAs<Read, Checked>(
  checked: RecordSchema<Checked>
): z.ZodType<Read, Checked> {
  return checked as unknown as z.ZodType<Read, Checked>
}
