
/** @typedef {import("./CliAgentCapabilityDoctorReport.ts").CliAgentCapabilityDoctorReport} CliAgentCapabilityDoctorReport */
/**
 * @param {CliAgentCapabilityDoctorReport} report
 * @returns {string}
 */
export function formatCliAgentCapabilityDoctorReport(report) {
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
