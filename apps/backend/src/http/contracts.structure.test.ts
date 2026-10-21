import { httpContracts } from "@betterc0de/schema/http-contracts"
import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

/**
 * Ratchet for the shared HTTP contracts (`@betterc0de/schema/http-contracts`).
 *
 * A route with a contract parses its request and validates its response with
 * one schema the renderer and the phone also use (`handleHttpContract`,
 * `contractJson`); a route without one is only cast on the client side. Route
 * groups move to contracts one at a time, so this pins the count of routes
 * still without one: a new route must come with a contract, or the count
 * goes up and this fails. The routes are read from the source text, like
 * `bootstrap.structure.test.ts` does, so the rule holds without a server.
 */

const backendSrc = path.resolve(__dirname, "..")
const routesDir = path.join(__dirname, "routes")
/**
 * Route files outside `http/routes` that the ratchet counts as well. Every
 * remote access route has a contract (`remote-contracts.ts`). `remote/web.ts`
 * is left out: its catch-all serves the web UI's files, not an API route.
 */
const ratchetedRouteFiles = [path.join(backendSrc, "remote", "http.ts")]

/**
 * Ratchet: lower it when a route group gets contracts, never raise it to
 * pass. The two left have no JSON contract to give: `GET /health` is the
 * unauthenticated probe mounted beside `/api/v1`, and
 * `GET /shell/output/:archiveId` streams a plain-text download.
 */
const MAX_ROUTES_WITHOUT_CONTRACT = 2

/**
 * Contracts whose route cannot go through `handleHttpContract` or
 * `contractJson`, with the reason. Everything else that has a contract must
 * name it in its route file.
 */
const CONTRACTS_THE_ROUTE_DOES_NOT_VALIDATE: Readonly<Record<string, string>> =
  {
    deleteThread:
      "a DELETE without a body, answered with 204: nothing to parse or validate",
  }

interface RouteRegistration {
  readonly file: string
  readonly method: string
  readonly path: string
}

/**
 * Every `api.<method>("<path>"` registration in `source`. Prettier wraps a
 * long registration across lines, so whitespace between the call and the
 * path is allowed; comments are stripped first so a mention in a note is
 * not counted. Only comments that start a line are stripped: a route
 * pattern such as `"/threads/:id/*"` would otherwise open a block comment
 * that swallows every route up to the next `*\/`.
 */
export function routeRegistrations(
  file: string,
  source: string
): RouteRegistration[] {
  const withoutComments = source
    .replace(/^[ \t]*\/\*[\s\S]*?\*\//gmu, "")
    .replace(/^[ \t]*\/\/.*$/gmu, "")
  const registration =
    /\b(?:api|app)\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/gu
  return [...withoutComments.matchAll(registration)].map((match) => ({
    file,
    method: match[1]!.toUpperCase(),
    path: match[2]!,
  }))
}

function sourcesIn(dir: string, recursive: boolean): Map<string, string> {
  const sources = new Map<string, string>()
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (recursive) {
        for (const [file, source] of sourcesIn(fullPath, true)) {
          sources.set(file, source)
        }
      }
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts")
    ) {
      sources.set(
        path.relative(backendSrc, fullPath).split(path.sep).join("/"),
        fs.readFileSync(fullPath, "utf8")
      )
    }
  }
  return sources
}

function sourcesOf(files: readonly string[]): Map<string, string> {
  return new Map(
    files.map((file): [string, string] => [
      path.relative(backendSrc, file).split(path.sep).join("/"),
      fs.readFileSync(file, "utf8"),
    ])
  )
}

/** `GET /threads/:id`; a route mounted with its `/api/v1` prefix reads the same. */
const routeKey = (route: { method: string; path: string }) =>
  `${route.method} ${route.path.replace(/^\/api\/v1(?=\/)/u, "")}`

function registrationsIn(sources: Map<string, string>): RouteRegistration[] {
  return [...sources].flatMap(([file, source]) =>
    routeRegistrations(file, source)
  )
}

describe("routeRegistrations", () => {
  it("sees wrapped registrations and ignores commented ones", () => {
    const source = [
      'api.use("/a/*", fence)',
      'api.get("/a", (c) => c.json({}))',
      "api.post(",
      '  "/b",',
      "  (c) => handle(c)",
      ")",
      '// api.delete("/commented", handler)',
      '/* app.put("/blocked", handler) */',
      'state.cache.get("/not-a-route")',
      "/**",
      ' * api.patch("/documented", handler)',
      " */",
      'api.delete("/c", handler)',
    ].join("\n")
    expect(routeRegistrations("x.ts", source).map(routeKey)).toEqual([
      "GET /a",
      "POST /b",
      "DELETE /c",
    ])
  })
})

describe("shared HTTP contracts", () => {
  // The ratchet counts the route groups in `http/routes` and the remote
  // access routes (`remote/http.ts`); whether a contract has a route, and
  // validates with it, is checked wherever the backend registers routes.
  const routes = registrationsIn(
    new Map([...sourcesIn(routesDir, false), ...sourcesOf(ratchetedRouteFiles)])
  )
  const backend = sourcesIn(backendSrc, true)
  const everyRoute = registrationsIn(backend)
  const contractByRoute = new Map(
    Object.entries(httpContracts).map(([name, contract]): [string, string] => [
      routeKey(contract),
      name,
    ])
  )

  it("reads the route table", () => {
    // A scan that silently finds nothing would make every rule below hollow.
    expect(routes.length).toBeGreaterThan(150)
  })

  it("counts the remote access routes, each with its contract", () => {
    const remote = routes.filter((route) => route.file === "remote/http.ts")
    // Bootstrap, both pairings, status, Tailscale, links, sessions, logout.
    expect(remote.length).toBeGreaterThanOrEqual(15)
    expect(
      remote
        .filter((route) => !contractByRoute.has(routeKey(route)))
        .map(routeKey)
    ).toEqual([])
  })

  it(`keeps routes without a shared contract at or under ${MAX_ROUTES_WITHOUT_CONTRACT}`, () => {
    const uncovered = routes
      .filter((route) => !contractByRoute.has(routeKey(route)))
      .map((route) => `${route.file}: ${routeKey(route)}`)
    expect(uncovered.length, uncovered.join("\n")).toBeLessThanOrEqual(
      MAX_ROUTES_WITHOUT_CONTRACT
    )
  })

  it("validates every route that has a contract with that contract", () => {
    const unvalidated = everyRoute.flatMap((route) => {
      const name = contractByRoute.get(routeKey(route))
      if (!name || name in CONTRACTS_THE_ROUTE_DOES_NOT_VALIDATE) return []
      return backend.get(route.file)!.includes(`"${name}"`)
        ? []
        : [`${route.file}: ${routeKey(route)} (${name})`]
    })
    expect(unvalidated).toEqual([])
  })

  it("has a registered route for every contract and every exception", () => {
    const registered = new Set(everyRoute.map(routeKey))
    const orphaned = Object.entries(httpContracts)
      .filter(([, contract]) => !registered.has(routeKey(contract)))
      .map(([name]) => name)
    expect(orphaned).toEqual([])
    for (const name of Object.keys(CONTRACTS_THE_ROUTE_DOES_NOT_VALIDATE)) {
      expect(Object.keys(httpContracts), name).toContain(name)
    }
  })
})
