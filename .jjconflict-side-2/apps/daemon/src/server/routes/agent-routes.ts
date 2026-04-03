import { listInstalledAgentClis } from "@/services/agent-cli-service"

export function handleAgentRoutes(request: Request, pathname: string) {
  if (pathname === "/api/agents/clis" && request.method === "GET") {
    return Response.json(listInstalledAgentClis())
  }

  return null
}
