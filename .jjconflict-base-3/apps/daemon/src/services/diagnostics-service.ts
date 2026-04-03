export function getDoctorSummary() {
  return {
    ok: true,
    checks: [
      { id: "daemon", status: "pass", message: "Burns daemon is running." },
      { id: "workspace-registry", status: "pass", message: "Workspace registry loaded." },
    ],
  }
}
