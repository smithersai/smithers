import { expect, test } from "bun:test";
import { createTempRepo, runSmithers } from "./e2e-helpers";

test("help surface does not advertise the removed ui command", () => {
  const repo = createTempRepo();
  const result = runSmithers(["--help"], {
    cwd: repo.dir,
    format: null,
  });

  expect(result.exitCode).toBe(0);
  expect(result.stdout).not.toContain("\n  ui ");
});
