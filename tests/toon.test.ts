import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { Smithers } from "../src";
import { Greeter } from "./fixtures/toon-services";
import { getCounter, resetCounter } from "./fixtures/toon-cache-handler";

function makeTempDb() {
  const dir = mkdtempSync(join(tmpdir(), "smithers-toon-"));
  return join(dir, "smithers.db");
}

test("loadToon executes run steps and components", async () => {
  const dbPath = makeTempDb();
  const workflow = Smithers.loadToon("tests/fixtures/toon-basic.toon");
  const result = await Effect.runPromise(
    workflow
      .execute({ name: "World" })
      .pipe(Effect.provide(Smithers.sqlite({ filename: dbPath }))),
  );
  expect(result).toEqual({ wrapped: "<<Hello World>>" });
});

test("loadToon executes prompt steps with imported agents", async () => {
  const dbPath = makeTempDb();
  const workflow = Smithers.loadToon("tests/fixtures/toon-prompt.toon");
  const result = await Effect.runPromise(
    workflow
      .execute({ name: "Ada" })
      .pipe(Effect.provide(Smithers.sqlite({ filename: dbPath }))),
  );
  expect(result).toEqual({ message: expect.stringContaining("Hello Ada") });
});

test("loadToon executes quickstart-style research and report steps", async () => {
  const dbPath = makeTempDb();
  const workflow = Smithers.loadToon(
    "tests/fixtures/toon-research-report.toon",
  );
  const result = await Effect.runPromise(
    workflow
      .execute({ topic: "Zig" })
      .pipe(Effect.provide(Smithers.sqlite({ filename: dbPath }))),
  );
  expect(result).toEqual({
    title: expect.stringContaining("Report"),
    body: expect.stringContaining("Zig"),
    wordCount: expect.any(Number),
  });
});

test("loadToon supports loop nodes with skipIf logic", async () => {
  const dbPath = makeTempDb();
  const workflow = Smithers.loadToon("tests/fixtures/toon-review-loop.toon");
  const result = await Effect.runPromise(
    workflow
      .execute({ draft: "Draft v1" })
      .pipe(Effect.provide(Smithers.sqlite({ filename: dbPath }))),
  );
  expect(result).toEqual({
    approved: true,
    content: expect.stringContaining("Draft v1"),
  });
});

test("loadToon imports component libraries", async () => {
  const dbPath = makeTempDb();
  const workflow = Smithers.loadToon(
    "tests/fixtures/toon-components-workflow.toon",
  );
  const result = await Effect.runPromise(
    workflow
      .execute({ brief: "Ship the hotfix" })
      .pipe(Effect.provide(Smithers.sqlite({ filename: dbPath }))),
  );
  expect(result).toEqual({
    summary: expect.stringContaining("Ship the hotfix"),
    tags: expect.arrayContaining(["ship", "the"]),
  });
});

test("loadToon imports Effect services for run blocks", async () => {
  const dbPath = makeTempDb();
  const workflow = Smithers.loadToon("tests/fixtures/toon-services.toon");
  const result = await Effect.runPromise(
    workflow
      .execute({ name: "Sam" })
      .pipe(
        Effect.provide(
          Layer.mergeAll(
            Smithers.sqlite({ filename: dbPath }),
            Layer.succeed(Greeter, {
              greet: (name) => Effect.succeed(`Hello ${name}`),
            }),
          ),
        ),
      ),
  );
  expect(result).toEqual({ message: "Hello Sam" });
});

test("loadToon supports workflow imports", async () => {
  const dbPath = makeTempDb();
  const workflow = Smithers.loadToon(
    "tests/fixtures/toon-workflow-import.toon",
  );
  const result = await Effect.runPromise(
    workflow
      .execute({ topic: "Bun" })
      .pipe(Effect.provide(Smithers.sqlite({ filename: dbPath }))),
  );
  expect(result).toEqual({
    report: expect.stringContaining("Researching Bun"),
  });
});

test("loadToon supports plugin-defined node kinds", async () => {
  const dbPath = makeTempDb();
  const workflow = Smithers.loadToon(
    "tests/fixtures/toon-plugin-workflow.toon",
  );
  const result = await Effect.runPromise(
    workflow
      .execute({ name: "Ignored" })
      .pipe(Effect.provide(Smithers.sqlite({ filename: dbPath }))),
  );
  expect(result).toEqual({ value: "HELLO!" });
});

test("loadToon caches steps using cache.by and cache.version", async () => {
  resetCounter();
  const dbPath = makeTempDb();
  const workflow = Smithers.loadToon("tests/fixtures/toon-cache.toon");
  const run = (key: string) =>
    Effect.runPromise(
      workflow
        .execute({ key })
        .pipe(Effect.provide(Smithers.sqlite({ filename: dbPath }))),
    );

  const first = await run("alpha");
  expect(first).toEqual({ count: 1, key: "alpha" });
  expect(getCounter()).toBe(1);

  const second = await run("alpha");
  expect(second).toEqual({ count: 1, key: "alpha" });
  expect(getCounter()).toBe(1);

  const third = await run("beta");
  expect(third).toEqual({ count: 2, key: "beta" });
  expect(getCounter()).toBe(2);
});

test("loadToon respects retry backoff delays", async () => {
  const dbPath = makeTempDb();
  const workflow = Smithers.loadToon("tests/fixtures/toon-retry.toon");
  const result = await Effect.runPromise(
    workflow
      .execute({ name: "Retry" })
      .pipe(Effect.provide(Smithers.sqlite({ filename: dbPath }))),
  );
  expect(result).toEqual({ ok: true });

  const sqlite = new Database(dbPath);
  try {
    const rows = sqlite
      .query(
        "select attempt, started_at_ms as startedAtMs, finished_at_ms as finishedAtMs from _smithers_attempts where node_id = ? order by attempt asc",
      )
      .all("flaky") as Array<{
      attempt: number;
      startedAtMs: number;
      finishedAtMs: number;
    }>;
    expect(rows.length).toBe(3);
    const first = rows[0]!;
    const second = rows[1]!;
    const third = rows[2]!;
    expect(typeof first.finishedAtMs).toBe("number");
    expect(typeof second.startedAtMs).toBe("number");
    const delay1 = second.startedAtMs - first.finishedAtMs;
    const delay2 = third.startedAtMs - second.finishedAtMs;
    expect(delay1).toBeGreaterThanOrEqual(20);
    expect(delay2).toBeGreaterThanOrEqual(20);
  } finally {
    sqlite.close();
  }
});

test("loadToon evaluates JS expressions in skipIf and component with", async () => {
  const dbPath = makeTempDb();
  const workflow = Smithers.loadToon("tests/fixtures/toon-expressions.toon");

  // score=8 > 7, so skipIf ternary evaluates true → skippable is skipped
  const highScore = await Effect.runPromise(
    workflow
      .execute({ score: 8, tags: ["fast", "clean"] })
      .pipe(Effect.provide(Smithers.sqlite({ filename: dbPath }))),
  );
  expect(highScore).toEqual({ label: "pass" });

  // score=3 <= 7, so skipIf ternary evaluates false → skippable runs
  const dbPath2 = makeTempDb();
  const lowScore = await Effect.runPromise(
    workflow
      .execute({ score: 3, tags: ["slow"] })
      .pipe(Effect.provide(Smithers.sqlite({ filename: dbPath2 }))),
  );
  expect(lowScore).toEqual({ label: "fail" });
});
