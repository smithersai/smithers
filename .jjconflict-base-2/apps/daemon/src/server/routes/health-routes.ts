export const DAEMON_HEALTH_PATH = "/api/health"

export function handleHealthRequest() {
  return Response.json({
    ok: true,
    service: "burns-daemon",
  })
}
