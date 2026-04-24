import { describe, expect, test } from "bun:test";
import { getCliAgentCapabilityReport } from "../src/cli-capabilities/getCliAgentCapabilityReport.js";

describe("getCliAgentCapabilityReport", () => {
  test("includes opencode in capability discovery", () => {
    const report = getCliAgentCapabilityReport();
    expect(report.map((entry) => entry.id)).toContain("opencode");
  });
});
