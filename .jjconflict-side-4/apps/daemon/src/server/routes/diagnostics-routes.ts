import { getDoctorSummary } from "@/services/diagnostics-service"

export function handleDiagnosticsRoutes(request: Request, pathname: string) {
  if (pathname === "/api/doctor" && request.method === "GET") {
    return Response.json(getDoctorSummary())
  }

  return null
}
