import type { CliAgentCapabilityDoctorReport } from "./CliAgentCapabilityDoctorReport";

export function formatCliAgentCapabilityDoctorReport(
  report: CliAgentCapabilityDoctorReport,
): string {
  if (report.ok) {
    return `All ${report.agents.length} built-in CLI agent capability registries passed.`;
  }

  const lines = [
    `Capability issues found: ${report.issueCount}`,
  ];

  for (const agent of report.agents) {
    if (agent.issues.length === 0) {
      continue;
    }
    lines.push(`${agent.id} (${agent.capabilities.engine})`);
    for (const issue of agent.issues) {
      lines.push(`  - [${issue.severity}] ${issue.code}: ${issue.message}`);
    }
  }

  return lines.join("\n");
}
