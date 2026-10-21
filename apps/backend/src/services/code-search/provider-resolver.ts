import type { PortableMcpServerResolver } from "../../provider/runtime/acp/AcpMcpServers"
import { CODE_SEARCH_SERVER, type CodeSearchServerResolver } from "./contracts"

/** Reserve the built-in identity and put it before the generic MCP connection cap. */
export function withCodeSearchServer(
  configuredServers: PortableMcpServerResolver,
  resolveCodeSearch: CodeSearchServerResolver
): PortableMcpServerResolver {
  return async (cwd) => {
    const server = await resolveCodeSearch(cwd)
    const configured = (await configuredServers(cwd)).filter(
      (entry) =>
        entry.id !== CODE_SEARCH_SERVER && entry.name !== CODE_SEARCH_SERVER
    )
    return server
      ? [
          {
            id: CODE_SEARCH_SERVER,
            name: CODE_SEARCH_SERVER,
            transport: "http",
            url: server.url,
            headers: server.headers,
          },
          ...configured,
        ]
      : configured
  }
}
