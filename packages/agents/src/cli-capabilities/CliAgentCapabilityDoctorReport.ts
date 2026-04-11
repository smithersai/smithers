import type { CliAgentCapabilityReportEntry } from "./CliAgentCapabilityReportEntry";

export type CliAgentCapabilityIssue = {
  code: string;
  message: string;
  severity: "error" | "warning";
};

export type CliAgentCapabilityDoctorEntry = CliAgentCapabilityReportEntry & {
  ok: boolean;
  issues: CliAgentCapabilityIssue[];
};

export type CliAgentCapabilityDoctorReport = {
  ok: boolean;
  issueCount: number;
  agents: CliAgentCapabilityDoctorEntry[];
};
