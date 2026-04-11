import type { AgentCapabilityRegistry } from "../capability-registry";
import type {
  CliAgentCapabilityDoctorReport,
  CliAgentCapabilityIssue,
} from "./CliAgentCapabilityDoctorReport";
import { getCliAgentCapabilityReport } from "./getCliAgentCapabilityReport";

function diagnoseCapabilityRegistry(
  registry: AgentCapabilityRegistry,
): CliAgentCapabilityIssue[] {
  const issues: CliAgentCapabilityIssue[] = [];

  if (registry.version !== 1) {
    issues.push({
      code: "registry-version",
      message: `Expected capability registry version 1, received ${registry.version}.`,
      severity: "error",
    });
  }

  if (!registry.skills.supportsSkills) {
    if (registry.skills.installMode) {
      issues.push({
        code: "skills-install-mode-without-support",
        message: "Skills install mode is set even though the adapter declares no skills support.",
        severity: "error",
      });
    }
    if (registry.skills.smithersSkillIds.length > 0) {
      issues.push({
        code: "skills-listed-without-support",
        message: "Smithers skills are listed even though the adapter declares no skills support.",
        severity: "error",
      });
    }
  } else if (!registry.skills.installMode) {
    issues.push({
      code: "missing-skills-install-mode",
      message: "Adapters that support skills must declare an install mode.",
      severity: "error",
    });
  }

  if (!registry.humanInteraction.supportsUiRequests) {
    if (registry.humanInteraction.methods.length > 0) {
      issues.push({
        code: "ui-methods-without-support",
        message: "UI request methods are listed even though the adapter declares no UI request support.",
        severity: "error",
      });
    }
  } else if (registry.humanInteraction.methods.length === 0) {
    issues.push({
      code: "missing-ui-methods",
      message: "Adapters that support UI requests must declare at least one method.",
      severity: "error",
    });
  }

  if (registry.mcp.bootstrap === "unsupported") {
    if (registry.mcp.supportsProjectScope || registry.mcp.supportsUserScope) {
      issues.push({
        code: "unsupported-mcp-with-scope",
        message: "Unsupported MCP adapters cannot advertise project or user scope support.",
        severity: "error",
      });
    }
  } else if (!registry.mcp.supportsProjectScope && !registry.mcp.supportsUserScope) {
    issues.push({
      code: "mcp-bootstrap-without-scope",
      message: "Supported MCP adapters should advertise at least one supported scope.",
      severity: "warning",
    });
  }

  return issues;
}

export function getCliAgentCapabilityDoctorReport(): CliAgentCapabilityDoctorReport {
  const agents = getCliAgentCapabilityReport().map((entry) => {
    const issues = diagnoseCapabilityRegistry(entry.capabilities);
    return {
      ...entry,
      ok: issues.length === 0,
      issues,
    };
  });

  const issueCount = agents.reduce((count, entry) => count + entry.issues.length, 0);
  return {
    ok: issueCount === 0,
    issueCount,
    agents,
  };
}
