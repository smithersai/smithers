import type { CliAgentCapabilityDoctorEntry } from "./CliAgentCapabilityDoctorEntry";

export type CliAgentCapabilityDoctorReport = {
  ok: boolean;
  issueCount: number;
  agents: CliAgentCapabilityDoctorEntry[];
};
