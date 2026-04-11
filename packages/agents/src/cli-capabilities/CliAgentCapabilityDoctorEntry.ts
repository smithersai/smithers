import type { CliAgentCapabilityReportEntry } from "./CliAgentCapabilityReportEntry";

type CapabilityIssue = {
  code: string;
  message: string;
  severity: "error" | "warning";
};

export type CliAgentCapabilityDoctorEntry = CliAgentCapabilityReportEntry & {
  ok: boolean;
  issues: CapabilityIssue[];
};
