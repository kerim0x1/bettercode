import { WS_METHODS, asRecord } from "@betterc0de/schema"
import type { AppState } from "../appState"
import type { ServerConfig } from "../config"
import {
  observeAsync,
  RPC_REQUEST_DURATION_MS,
  RPC_REQUESTS_TOTAL,
} from "../observability/metrics"
import {
  decodeThreadActivityCursor,
  encodeThreadActivityCursor,
  type ThreadActivityCursor,
} from "../persistence/projections"
import type { RpcHandler } from "./server"

const KNOWN_WS_METHODS = new Set<string>(Object.values(WS_METHODS))
const READ_ONLY_REMOTE_WS_METHODS = new Set<string>([
  WS_METHODS.providersListInstances,
  WS_METHODS.providersModelsForInstance,
  WS_METHODS.threadsListActivities,
])

function requireStringParam(params: unknown, key: string): string {
  const record = asRecord(params)
  const value = record[key]
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing required string parameter: ${key}`)
  }
  return value
}

function invalidActivityPagination(message: string): never {
  throw Object.assign(new Error(message), {
    statusCode: 400,
    code: "INVALID_ACTIVITY_PAGINATION",
  })
}

function parseActivityPagination(params: unknown): {
  limit: number | undefined
  before: ThreadActivityCursor | undefined
  beforeSequence: number | undefined
  includePage: boolean
} {
  const record = asRecord(params)
  const rawLimit = record.limit
  let limit: number | undefined
  if (rawLimit !== undefined) {
    if (
      typeof rawLimit !== "number" ||
      !Number.isSafeInteger(rawLimit) ||
      rawLimit < 1 ||
      rawLimit > 1_000
    ) {
      invalidActivityPagination(
        "Activity limit must be an integer from 1 to 1000"
      )
    }
    limit = rawLimit
  }

  const rawBeforeSequence = record.beforeSequence
  let beforeSequence: number | undefined
  if (rawBeforeSequence !== undefined) {
    if (
      typeof rawBeforeSequence !== "number" ||
      !Number.isSafeInteger(rawBeforeSequence) ||
      rawBeforeSequence < 0
    ) {
      invalidActivityPagination(
        "Activity beforeSequence must be a non-negative safe integer"
      )
    }
    beforeSequence = rawBeforeSequence
  }

  const rawCursor = record.cursor
  let before: ThreadActivityCursor | undefined
  if (rawCursor !== undefined && rawCursor !== "") {
    if (typeof rawCursor !== "string") {
      invalidActivityPagination("Activity cursor must be a string")
    }
    const decoded = decodeThreadActivityCursor(rawCursor)
    if (decoded === false || decoded === null) {
      invalidActivityPagination("Invalid activity pagination cursor")
    }
    before = decoded
  }
  if (before && beforeSequence !== undefined) {
    invalidActivityPagination(
      "Activity cursor and beforeSequence cannot be used together"
    )
  }

  const rawIncludePage = record.includePage
  if (rawIncludePage !== undefined && typeof rawIncludePage !== "boolean") {
    invalidActivityPagination("Activity includePage must be a boolean")
  }
  return {
    limit,
    before,
    beforeSequence,
    includePage: rawIncludePage === true,
  }
}

function toThreadActivityWire(
  activity: ReturnType<AppState["threadActivities"]["listByThread"]>[number]
) {
  return {
    id: activity.activity_id,
    threadId: activity.thread_id,
    turnId: activity.turn_id,
    providerInstanceId: activity.provider_instance_id ?? null,
    kind: activity.kind,
    tone: activity.tone,
    summary: activity.summary,
    payload: activity.payload,
    sequence: activity.sequence ?? null,
    createdAt: activity.created_at,
  }
}

export function createWsRpcHandler(
  state: AppState,
  config: ServerConfig
): RpcHandler {
  return async (method, params, principal) => {
    if (state.taintedRef?.() || state.drainingRef?.()) {
      throw Object.assign(new Error("Backend is shutting down"), {
        statusCode: 503,
        code: "SHUTTING_DOWN",
      })
    }
    if (
      principal.kind === "remote" &&
      principal.accessLevel === "read_only" &&
      !READ_ONLY_REMOTE_WS_METHODS.has(method)
    ) {
      throw Object.assign(
        new Error("Remote session is restricted to read-only monitoring"),
        { statusCode: 403, code: "REMOTE_READ_ONLY" }
      )
    }
    const metricMethod = KNOWN_WS_METHODS.has(method) ? method : "unknown"
    return observeAsync(
      {
        counterName: RPC_REQUESTS_TOTAL,
        timerName: RPC_REQUEST_DURATION_MS,
        attributes: { method: metricMethod },
      },
      async () => {
        switch (method) {
          case WS_METHODS.serverGetConfig:
            return {
              host: config.host,
              port: config.port,
              // The host data directory is a desktop-only detail; a paired
              // device has no use for it and must not learn host paths.
              ...(principal.kind === "local"
                ? { dataDir: config.dataDir }
                : {}),
              providerInstances: await state.providerHub.listInstances(),
            }

          case WS_METHODS.providersListInstances:
            return await state.providerHub.listInstances()

          case WS_METHODS.providersModelsForInstance: {
            const instanceId = requireStringParam(params, "instanceId")
            const instance = state.providerHub.getInstance(instanceId)
            if (!instance)
              throw new Error(`Provider instance not found: ${instanceId}`)
            if (!instance.enabled)
              throw new Error(`Provider instance disabled: ${instanceId}`)
            return state.providerHub.modelsForInstance(instanceId)
          }

          case WS_METHODS.threadsListActivities: {
            const pagination = parseActivityPagination(params)
            const page = state.threadActivities.listByThreadPage(
              requireStringParam(params, "threadId"),
              {
                limit: pagination.limit,
                before: pagination.before,
                beforeSequence: pagination.beforeSequence,
              }
            )
            const items = page.items.map(toThreadActivityWire)
            return pagination.includePage
              ? {
                  items,
                  nextCursor: page.next
                    ? encodeThreadActivityCursor(page.next)
                    : null,
                }
              : items
          }

          default:
            throw new Error("Unknown RPC method")
        }
      }
    )
  }
}
