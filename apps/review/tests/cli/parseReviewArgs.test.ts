import { describe, expect, test } from "bun:test";
import { normalizeOpenCodeReviewInput } from "../../src/workflow/normalizeOpenCodeReviewInput.ts";
import { parseReviewArgs } from "../../src/cli/parseReviewArgs.ts";

describe("parseReviewArgs", () => {
  test("returns defaults for empty argv", () => {
    const args = parseReviewArgs([]);
    expect(args.repo).toBe(".");
    expect(args.from).toBe("");
    expect(args.to).toBe("");
    expect(args.commit).toBe("");
    expect(args.background).toBe("");
    expect(args.title).toBe("");
    expect(args.out).toBe("");
    expect(args.db).toBe("");
    expect(args.review).toBe(true);
    expect(args.narrate).toBe(true);
    expect(args.concurrency).toBe(8);
    expect(args.timeout).toBe(10);
    expect(args.split).toBe(false);
    expect(args.publish).toBe(false);
    expect(args.pr).toBe("");
    expect(args.open).toBe(false);
    expect(args.help).toBe(false);
    expect(args.version).toBe(false);
    expect(args.verify).toBe(true);
    expect(args.quiz).toBe("auto");
  });

  test("--execution-id selects the durable run in --db", () => {
    expect(parseReviewArgs([]).executionId).toBe("");
    const args = parseReviewArgs(["--execution-id", "review-recovery", "--db", "review.db"]);
    expect(args.executionId).toBe("review-recovery");
    expect(args.db).toBe("review.db");
  });

  test.each([undefined, "", "   ", "--db"])("--execution-id rejects a missing or empty value %j", (value) => {
    expect(() => parseReviewArgs(value === undefined ? ["--execution-id"] : ["--execution-id", value])).toThrow("--execution-id requires a non-empty value");
  });

  test("--quiz accepts off, auto, on", () => {
    expect(parseReviewArgs(["--quiz", "off"]).quiz).toBe("off");
    expect(parseReviewArgs(["--quiz", "auto"]).quiz).toBe("auto");
    expect(parseReviewArgs(["--quiz", "on"]).quiz).toBe("on");
  });

  test("--quiz rejects other values", () => {
    expect(() => parseReviewArgs(["--quiz", "always"])).toThrow('--quiz must be one of off, auto, on (got "always")');
    expect(() => parseReviewArgs(["--quiz", ""])).toThrow("--quiz must be one of off, auto, on");
    expect(() => parseReviewArgs(["--quiz", "ON"])).toThrow("--quiz must be one of off, auto, on");
  });

  test("--quiz requires a value", () => {
    expect(() => parseReviewArgs(["--quiz"])).toThrow("--quiz requires a value");
  });

  test("--no-verify disables the verification pass", () => {
    expect(parseReviewArgs(["--no-verify"]).verify).toBe(false);
  });

  test("--version sets version=true", () => {
    expect(parseReviewArgs(["--version"]).version).toBe(true);
  });

  test("new flags combine with existing ones", () => {
    const args = parseReviewArgs(["--quiz", "on", "--no-verify", "--no-review", "--pr", "42"]);
    expect(args.quiz).toBe("on");
    expect(args.verify).toBe(false);
    expect(args.review).toBe(false);
    expect(args.pr).toBe("42");
  });

  test("--help sets help=true", () => {
    expect(parseReviewArgs(["--help"]).help).toBe(true);
    expect(parseReviewArgs(["-h"]).help).toBe(true);
  });

  test("positional argument sets repo", () => {
    const args = parseReviewArgs(["/some/path"]);
    expect(args.repo).toBe("/some/path");
  });

  test("--from and --to set the range", () => {
    const args = parseReviewArgs(["--from", "main", "--to", "HEAD"]);
    expect(args.from).toBe("main");
    expect(args.to).toBe("HEAD");
  });

  test("--commit sets the commit", () => {
    const args = parseReviewArgs(["--commit", "abc123"]);
    expect(args.commit).toBe("abc123");
  });

  test("--background, --title, --out, --db are forwarded", () => {
    const args = parseReviewArgs([
      "--background",
      "requirement text",
      "--title",
      "my title",
      "--out",
      "out.html",
      "--db",
      "review.db",
    ]);
    expect(args.background).toBe("requirement text");
    expect(args.title).toBe("my title");
    expect(args.out).toBe("out.html");
    expect(args.db).toBe("review.db");
  });

  test("--no-review and --no-narrate disable those agents", () => {
    const args = parseReviewArgs(["--no-review", "--no-narrate"]);
    expect(args.review).toBe(false);
    expect(args.narrate).toBe(false);
  });

  test("--concurrency parses as a positive integer", () => {
    const args = parseReviewArgs(["--concurrency", "4"]);
    expect(args.concurrency).toBe(4);
  });

  test("--timeout parses as a positive integer", () => {
    const args = parseReviewArgs(["--timeout", "30"]);
    expect(args.timeout).toBe(30);
  });

  test.each([1, 1.5, 99])("--timeout preserves %s minutes through input decoding", (timeout) => {
    const args = parseReviewArgs(["--timeout", String(timeout)]);
    expect(normalizeOpenCodeReviewInput(args).timeout).toBe(timeout);
  });

  test.each([0, -1, 0.5, NaN, Infinity, -Infinity])("refuses invalid timeout %s at both input boundaries", (timeout) => {
    expect(() => parseReviewArgs(["--timeout", String(timeout)])).toThrow("--timeout");
    expect(() => normalizeOpenCodeReviewInput({ timeout })).toThrow();
  });

  test("--split, --publish, --open set boolean flags", () => {
    const args = parseReviewArgs(["--split", "--publish", "--open"]);
    expect(args.split).toBe(true);
    expect(args.publish).toBe(true);
    expect(args.open).toBe(true);
  });

  test("--pr sets the pr field", () => {
    const args = parseReviewArgs(["--pr", "42"]);
    expect(args.pr).toBe("42");
  });

  test("throws on unknown option", () => {
    expect(() => parseReviewArgs(["--bogus"])).toThrow("Unknown option: --bogus");
  });

  test("throws when --from has no value", () => {
    expect(() => parseReviewArgs(["--from"])).toThrow("--from requires a value");
  });

  test("throws when --to has no value", () => {
    expect(() => parseReviewArgs(["--to"])).toThrow("--to requires a value");
  });

  test("throws when --concurrency is zero", () => {
    expect(() => parseReviewArgs(["--concurrency", "0"])).toThrow("--concurrency must be a positive number");
  });

  test("throws when --concurrency is not a number", () => {
    expect(() => parseReviewArgs(["--concurrency", "abc"])).toThrow("--concurrency must be a positive number");
  });

  test("throws when --timeout is not a number", () => {
    expect(() => parseReviewArgs(["--timeout", "abc"])).toThrow("--timeout must be a positive number");
  });

  test("throws when --timeout is below 1", () => {
    expect(() => parseReviewArgs(["--timeout", "0"])).toThrow("--timeout must be a positive number");
  });

  test("last positional wins as repo path", () => {
    const args = parseReviewArgs(["first", "second"]);
    expect(args.repo).toBe("second");
  });

  describe("conflicting review targets", () => {
    test("--commit with --from/--to throws", () => {
      expect(() => parseReviewArgs(["--commit", "abc", "--from", "main"])).toThrow(
        "conflicting review targets: --commit and --from/--to cannot be combined — pick one",
      );
      expect(() => parseReviewArgs(["--commit", "abc", "--to", "HEAD"])).toThrow("conflicting review targets");
    });

    test("--commit with --pr throws", () => {
      expect(() => parseReviewArgs(["--commit", "abc", "--pr", "42"])).toThrow(
        "conflicting review targets: --commit and --pr cannot be combined — pick one",
      );
    });

    test("--from/--to with --pr throws", () => {
      expect(() => parseReviewArgs(["--from", "main", "--to", "HEAD", "--pr", "42"])).toThrow(
        "conflicting review targets: --from/--to and --pr cannot be combined — pick one",
      );
    });

    test("all three together throws", () => {
      expect(() => parseReviewArgs(["--commit", "abc", "--from", "main", "--pr", "42"])).toThrow(
        "conflicting review targets: --commit and --from/--to and --pr cannot be combined — pick one",
      );
    });

    test("each target alone is fine", () => {
      expect(parseReviewArgs(["--commit", "abc"]).commit).toBe("abc");
      expect(parseReviewArgs(["--from", "main", "--to", "HEAD"]).from).toBe("main");
      expect(parseReviewArgs(["--pr", "42"]).pr).toBe("42");
    });
  });
});
