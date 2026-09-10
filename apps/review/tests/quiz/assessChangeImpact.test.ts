import { describe, expect, test } from "bun:test";
import { assessChangeImpact, type ImpactFile, type ImpactFinding } from "../../src/quiz/assessChangeImpact.ts";
import { shouldAutoQuiz } from "../../src/quiz/shouldAutoQuiz.ts";

function file(path: string, overrides: Partial<ImpactFile> = {}): ImpactFile {
  return { path, status: "modified", insertions: 5, deletions: 2, diff: "", ...overrides };
}

function finding(overrides: Partial<ImpactFinding> = {}): ImpactFinding {
  return { severity: "minor", category: "correctness", path: "src/app.ts", ...overrides };
}

describe("assessChangeImpact", () => {
  test("boring change stays low with no reasons", () => {
    const impact = assessChangeImpact(
      [file("docs/readme.md"), file("src/renderGreeting.ts", { diff: "+const hi = 1;\n" })],
      [],
    );
    expect(impact.level).toBe("low");
    expect(impact.score).toBe(0);
    expect(impact.reasons).toEqual([]);
  });

  test("empty change set is low", () => {
    const impact = assessChangeImpact([], []);
    expect(impact.level).toBe("low");
    expect(impact.score).toBe(0);
  });

  describe("path signals", () => {
    test.each([
      ["src/auth/login.ts", "security-sensitive path (auth)"],
      ["src/tokens/mintToken.ts", "security-sensitive path (token)"],
      ["config/secrets.ts", "security-sensitive path (secret)"],
      ["lib/crypto/hash.ts", "security-sensitive path (crypto)"],
      ["src/password-reset.ts", "security-sensitive path (password)"],
      ["src/sessions/store.ts", "security-sensitive path (session)"],
      ["src/acl.ts", "security-sensitive path (acl)"],
      ["src/permissions/grant.ts", "security-sensitive path (permission)"],
      ["src/payments/charge.ts", "security-sensitive path (payment)"],
      ["src/billing/invoice.ts", "security-sensitive path (billing)"],
      ["src/checkout/cart.ts", "security-sensitive path (checkout)"],
    ])("security path %s", (path, signal) => {
      const impact = assessChangeImpact([file(path)], []);
      expect(impact.reasons).toContainEqual({ signal, path });
      expect(impact.level).toBe("moderate");
    });

    test("camelCase security segment matches without substring false positives", () => {
      const hit = assessChangeImpact([file("src/authMiddleware.ts")], []);
      expect(hit.reasons).toContainEqual({ signal: "security-sensitive path (auth)", path: "src/authMiddleware.ts" });
      // "capital" contains "api" and "author" contains "auth" as substrings; token matching must not fire.
      const miss = assessChangeImpact([file("src/capital.ts"), file("docs/authors.md")], []);
      expect(miss.score).toBe(0);
    });

    test.each([
      ["db/migrations/001-add-users.ts", "data schema or migration path (migration)"],
      ["src/schema.ts", "data schema or migration path (schema)"],
      ["db/backfill.sql", "data schema or migration path (sql)"],
    ])("data path %s", (path, signal) => {
      const impact = assessChangeImpact([file(path)], []);
      expect(impact.reasons).toContainEqual({ signal, path });
    });

    test.each([
      [".github/workflows/ci.yml", "github workflow"],
      ["Dockerfile", "dockerfile"],
      ["docker-compose.yml", "docker-compose"],
      ["scripts/deploy.sh", "deploy"],
      ["infra/main.tf", "infra"],
      ["terraform/vpc.tf", "terraform"],
    ])("supply chain path %s", (path, keyword) => {
      const impact = assessChangeImpact([file(path)], []);
      expect(
        impact.reasons.some((reason) => reason.signal === `ci or deployment path (${keyword})` && reason.path === path),
      ).toBe(true);
    });

    test.each([
      ["src/api/users.ts", "api"],
      ["src/handlers/upload.ts", "handler"],
      ["src/routes/index.ts", "route"],
      ["src/controllers/UserController.ts", "controller"],
    ])("user-facing surface path %s", (path, keyword) => {
      const impact = assessChangeImpact([file(path)], []);
      expect(impact.reasons).toContainEqual({ signal: `user-facing surface path (${keyword})`, path });
      expect(impact.level).toBe("low");
    });
  });

  describe("diff-content signals (added lines only)", () => {
    test.each([
      ["eval(", "+const out = eval(code);"],
      ["child_process", '+import { spawn } from "node:child_process";'],
      ["exec(", "+exec(cmd);"],
      ["innerHTML", "+el.innerHTML = userInput;"],
      ["dangerouslySetInnerHTML", "+<div dangerouslySetInnerHTML={{ __html: raw }} />"],
      ["DROP TABLE", "+await db.query('DROP TABLE users');"],
      ["DELETE FROM", "+await db.query('DELETE FROM sessions');"],
      ["chmod", "+chmodSync(path, 0o777);"],
    ])("marker %s in added lines is a reason", (marker, addedLine) => {
      const impact = assessChangeImpact([file("src/renderGreeting.ts", { diff: `${addedLine}\n` })], []);
      expect(impact.reasons).toContainEqual({
        signal: `risky added content (${marker})`,
        path: "src/renderGreeting.ts",
      });
    });

    test("markers only on removed or context lines do not fire", () => {
      const diff = ["-const out = eval(code);", " const ok = process.env.HOME;", "+const clean = 1;"].join("\n");
      const impact = assessChangeImpact([file("src/renderGreeting.ts", { diff })], []);
      expect(impact.score).toBe(0);
    });

    test("+++ header line does not count as an added line", () => {
      const diff = ["+++ b/src/chmodish.ts", "+const clean = 1;"].join("\n");
      const impact = assessChangeImpact([file("src/renderGreeting.ts", { diff })], []);
      expect(impact.score).toBe(0);
    });

    test.each([
      ["process.env", "+const key = process.env.SECRET_KEY;"],
      ["crypto.", "+const digest = crypto.createHash('md5');"],
      ["timing", "+// timing sensitive comparison"],
    ])("ordinary-code marker %s no longer fires", (_marker, addedLine) => {
      const impact = assessChangeImpact([file("src/renderGreeting.ts", { diff: `${addedLine}\n` })], []);
      expect(impact.score).toBe(0);
      expect(impact.reasons).toEqual([]);
    });

    test("the same marker repeated in one file counts once", () => {
      const diff = ["+eval(a);", "+eval(b);", "+eval(c);"].join("\n");
      const impact = assessChangeImpact([file("src/renderGreeting.ts", { diff })], []);
      expect(impact.score).toBe(2);
      expect(impact.reasons).toHaveLength(1);
    });

    test("riskyContent contribution is capped at 2 hits per file", () => {
      const diff = ["+eval(code);", "+exec(cmd);", "+el.innerHTML = raw;", "+chmodSync(p, 0o777);"].join("\n");
      const impact = assessChangeImpact([file("src/renderGreeting.ts", { diff })], []);
      expect(impact.score).toBe(4);
      expect(impact.reasons).toHaveLength(2);
      // 4 points is moderate: one file's markers alone can never reach critical.
      expect(impact.level).toBe("moderate");
    });
  });

  describe("finding signals", () => {
    test("critical finding of any category escalates", () => {
      const impact = assessChangeImpact(
        [file("src/renderGreeting.ts")],
        [finding({ severity: "critical", category: "correctness" })],
      );
      expect(impact.reasons).toContainEqual({ signal: "critical finding", path: "src/app.ts" });
      expect(impact.level).toBe("moderate");
    });

    test("major security finding escalates; minor security finding does not", () => {
      const major = assessChangeImpact([], [finding({ severity: "major", category: "security" })]);
      expect(major.reasons).toContainEqual({ signal: "security finding at major severity", path: "src/app.ts" });
      const minor = assessChangeImpact([], [finding({ severity: "minor", category: "security" })]);
      expect(minor.score).toBe(0);
    });

    test("major data-loss finding escalates", () => {
      const impact = assessChangeImpact([], [finding({ severity: "major", category: "data-loss" })]);
      expect(impact.reasons).toContainEqual({ signal: "data-loss finding at major severity", path: "src/app.ts" });
    });

    test("critical security finding records both the critical and category reasons", () => {
      const impact = assessChangeImpact([], [finding({ severity: "critical", category: "security" })]);
      expect(impact.reasons.map((reason) => reason.signal).sort()).toEqual([
        "critical finding",
        "security finding at critical severity",
      ]);
      expect(impact.score).toBe(7);
      expect(impact.level).toBe("high");
    });
  });

  describe("deletion signal", () => {
    test("test file deleted while sibling source changed", () => {
      const impact = assessChangeImpact([file("src/parse.test.ts", { status: "deleted" }), file("src/parse.ts")], []);
      expect(impact.reasons).toContainEqual({
        signal: "test file deleted while sibling source changed",
        path: "src/parse.test.ts",
      });
    });

    test("an e2e-directory file counts as a test for the deletion signal", () => {
      const impact = assessChangeImpact([file("e2e/parse.ts", { status: "deleted" }), file("src/parse.ts")], []);
      expect(impact.reasons).toContainEqual({
        signal: "test file deleted while sibling source changed",
        path: "e2e/parse.ts",
      });
    });

    test("test deletion without a changed sibling source does not fire", () => {
      const impact = assessChangeImpact([file("src/parse.test.ts", { status: "deleted" }), file("src/render.ts")], []);
      expect(impact.score).toBe(0);
    });

    test("test deleted alongside its deleted source does not fire", () => {
      const impact = assessChangeImpact(
        [file("src/parse.test.ts", { status: "deleted" }), file("src/parse.ts", { status: "deleted" })],
        [],
      );
      expect(impact.score).toBe(0);
    });
  });

  describe("size bump and thresholds", () => {
    test("churn above 800 lines bumps one level step with a reason", () => {
      const impact = assessChangeImpact([file("src/big.ts", { insertions: 700, deletions: 200 })], []);
      expect(impact.level).toBe("moderate");
      expect(impact.score).toBe(0);
      expect(impact.reasons).toContainEqual({ signal: "large change (900 lines across 1 files)", path: "" });
    });

    test("more than 25 files bumps one level step", () => {
      const files = Array.from({ length: 26 }, (_, i) => file(`src/mod${i}.ts`, { insertions: 1, deletions: 0 }));
      const impact = assessChangeImpact(files, []);
      expect(impact.level).toBe("moderate");
    });

    test("exactly 25 files and 800 churn lines do not bump", () => {
      const files = Array.from({ length: 25 }, (_, i) => file(`src/mod${i}.ts`, { insertions: 32, deletions: 0 }));
      const impact = assessChangeImpact(files, []);
      expect(impact.level).toBe("low");
    });

    test("score thresholds map to levels: 3 moderate, 6 high, 10 critical", () => {
      const moderate = assessChangeImpact([file("src/auth/login.ts")], []);
      expect(moderate.score).toBe(3);
      expect(moderate.level).toBe("moderate");

      const high = assessChangeImpact([file("src/auth/login.ts"), file("db/migrations/one.ts")], []);
      expect(high.score).toBe(6);
      expect(high.level).toBe("high");

      const critical = assessChangeImpact(
        [file("src/auth/login.ts"), file("db/migrations/one.ts")],
        [finding({ severity: "critical" })],
      );
      expect(critical.score).toBe(10);
      expect(critical.level).toBe("critical");
    });

    test("size bump on top of a scored level can reach critical", () => {
      const impact = assessChangeImpact(
        [file("src/auth/login.ts", { insertions: 900 }), file("db/migrations/one.ts")],
        [],
      );
      expect(impact.level).toBe("critical");
    });
  });

  test("auto quiz mode triggers at high or critical only", () => {
    expect(shouldAutoQuiz("low")).toBe(false);
    expect(shouldAutoQuiz("moderate")).toBe(false);
    expect(shouldAutoQuiz("high")).toBe(true);
    expect(shouldAutoQuiz("critical")).toBe(true);
  });
});
