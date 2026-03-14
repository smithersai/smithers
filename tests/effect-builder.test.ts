import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Context, Effect, Layer, Schema } from "effect";
import { Model } from "@effect/sql";
import { Smithers } from "../src";
import { approveNode } from "../src/engine/approvals";
import { SmithersDb } from "../src/db/adapter";

class EmptyInput extends Schema.Class<EmptyInput>("EmptyInput")({}) {}

function makeDbPath(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return {
    dir,
    dbPath: join(dir, "smithers.db"),
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    },
  };
}

describe("Effect builder API", () => {
  test("executes typed steps with Effect services", async () => {
    class Input extends Schema.Class<Input>("BuilderInput")({
      topic: Schema.String,
    }) {}

    class Research extends Model.Class<Research>("BuilderResearch")({
      summary: Schema.String,
    }) {}

    class Report extends Model.Class<Report>("BuilderReport")({
      title: Schema.String,
      body: Schema.String,
    }) {}

    class Researcher extends Context.Tag("Researcher")<
      Researcher,
      {
        readonly research: (topic: string) => Effect.Effect<Research>;
      }
    >() {}

    class Writer extends Context.Tag("Writer")<
      Writer,
      {
        readonly write: (research: Research) => Effect.Effect<Report>;
      }
    >() {}

    const workflow = Smithers.workflow({
      name: "research-report",
      input: Input,
    }).build(($) => {
      const research = $.step("research", {
        output: Research,
        run: ({ input }) =>
          Effect.gen(function* () {
            const researcher = yield* Researcher;
            return yield* researcher.research((input as Input).topic);
          }),
      });

      const report = $.step("report", {
        output: Report,
        needs: { research },
        run: ({ research }) =>
          Effect.gen(function* () {
            const writer = yield* Writer;
            return yield* writer.write(research as Research);
          }),
      });

      return $.sequence(research, report);
    });

    const db = makeDbPath("smithers-effect-builder-");
    try {
      const result = await Effect.runPromise(
        workflow.execute({ topic: "Zig" }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Smithers.sqlite({ filename: db.dbPath }),
              Layer.succeed(Researcher, {
                research: (topic) =>
                  Effect.succeed(
                    new Research({ summary: `${topic} is explicit.` }),
                  ),
              }),
              Layer.succeed(Writer, {
                write: (research) =>
                  Effect.succeed(
                    new Report({
                      title: "Summary",
                      body: research.summary,
                    }),
                  ),
              }),
            ),
          ),
        ),
      );

      expect(result).toBeInstanceOf(Report);
      expect((result as Report).title).toBe("Summary");
      expect((result as Report).body).toBe("Zig is explicit.");
    } finally {
      db.cleanup();
    }
  });

  test("supports parallel nodes and typed downstream dependencies", async () => {
    class Finding extends Model.Class<Finding>("ParallelFinding")({
      value: Schema.String,
    }) {}

    class Combined extends Model.Class<Combined>("ParallelCombined")({
      values: Schema.Array(Schema.String),
    }) {}

    const workflow = Smithers.workflow({
      name: "parallel-findings",
      input: EmptyInput,
    }).build(($) => {
      const a = $.step("research-a", {
        output: Finding,
        run: () => Effect.succeed(new Finding({ value: "a" })),
      });

      const b = $.step("research-b", {
        output: Finding,
        run: () => Effect.succeed(new Finding({ value: "b" })),
      });

      const combine = $.step("combine", {
        output: Combined,
        needs: { a, b },
        run: ({ a, b }) =>
          Effect.succeed(
            new Combined({
              values: [(a as Finding).value, (b as Finding).value],
            }),
          ),
      });

      return $.sequence($.parallel(a, b, { maxConcurrency: 2 }), combine);
    });

    const db = makeDbPath("smithers-effect-parallel-");
    try {
      const result = await Effect.runPromise(
        workflow.execute({}).pipe(
          Effect.provide(Smithers.sqlite({ filename: db.dbPath })),
        ),
      );

      expect(result).toBeInstanceOf(Combined);
      expect((result as Combined).values).toEqual(["a", "b"]);
    } finally {
      db.cleanup();
    }
  });

  test("supports loops and exposes loop iteration in step context", async () => {
    class Review extends Model.Class<Review>("LoopReview")({
      approved: Schema.Boolean,
      feedback: Schema.String,
    }) {}

    class Draft extends Model.Class<Draft>("LoopDraft")({
      content: Schema.String,
    }) {}

    class Final extends Model.Class<Final>("LoopFinal")({
      approved: Schema.Boolean,
      feedback: Schema.String,
    }) {}

    const workflow = Smithers.workflow({
      name: "review-loop",
      input: EmptyInput,
    }).build(($) => {
      const review = $.step("review", {
        output: Review,
        run: ({ iteration }) =>
          Effect.succeed(
            new Review({
              approved: iteration >= 1,
              feedback: `review-${iteration}`,
            }),
          ),
      });

      const revise = $.step("revise", {
        output: Draft,
        needs: { review },
        skipIf: ({ review }) => (review as Review).approved,
        run: ({ iteration }) =>
          Effect.succeed(new Draft({ content: `draft-${iteration}` })),
      });

      const final = $.step("final", {
        output: Final,
        needs: { review },
        run: ({ review }) =>
          Effect.succeed(
            new Final({
              approved: (review as Review).approved,
              feedback: (review as Review).feedback,
            }),
          ),
      });

      return $.sequence(
        $.loop({
          id: "review-loop",
          children: $.sequence(review, revise),
          until: (outputs) => Boolean((outputs.review as Review | undefined)?.approved),
          maxIterations: 3,
        }),
        final,
      );
    });

    const db = makeDbPath("smithers-effect-loop-");
    try {
      const result = await Effect.runPromise(
        workflow.execute({}).pipe(
          Effect.provide(Smithers.sqlite({ filename: db.dbPath })),
        ),
      );

      expect(result).toBeInstanceOf(Final);
      expect((result as Final).approved).toBe(true);
      expect((result as Final).feedback).toBe("review-1");
    } finally {
      db.cleanup();
    }
  });

  test("supports explicit approval nodes and resume", async () => {
    class Build extends Model.Class<Build>("ApprovalBuild")({
      version: Schema.String,
    }) {}

    class Deploy extends Model.Class<Deploy>("ApprovalDeploy")({
      url: Schema.String,
    }) {}

    const workflow = Smithers.workflow({
      name: "approval-workflow",
      input: EmptyInput,
    }).build(($) => {
      const build = $.step("build", {
        output: Build,
        run: () => Effect.succeed(new Build({ version: "1.2.0" })),
      });

      const approval = $.approval("approve-deploy", {
        needs: { build },
        request: ({ build }) => ({
          title: `Deploy ${(build as Build).version}?`,
          summary: "Ready for production.",
        }),
        onDeny: "continue",
      });

      const deploy = $.step("deploy", {
        output: Deploy,
        needs: { build, approval },
        run: ({ build, approval }) =>
          Effect.succeed(
            new Deploy({
              url: (approval as any).approved
                ? `https://app.example.com/${(build as Build).version}`
                : "https://app.example.com/skipped",
            }),
          ),
      });

      return $.sequence(build, approval, deploy);
    });

    const db = makeDbPath("smithers-effect-approval-");
    try {
      const layer = Smithers.sqlite({ filename: db.dbPath });
      const first = await Effect.runPromise(
        workflow.execute({}).pipe(Effect.provide(layer)),
      );

      expect((first as any).status).toBe("waiting-approval");
      const runId = (first as any).runId as string;

      const sqlite = new Database(db.dbPath);
      const drizzleDb = drizzle(sqlite);
      try {
        await approveNode(
          new SmithersDb(drizzleDb as any),
          runId,
          "approve-deploy",
          0,
          "ship it",
          "tester",
        );
      } finally {
        sqlite.close();
      }

      const second = await Effect.runPromise(
        workflow.execute({}, { runId, resume: true }).pipe(
          Effect.provide(layer),
        ),
      );

      expect(second).toBeInstanceOf(Deploy);
      expect((second as Deploy).url).toBe("https://app.example.com/1.2.0");
    } finally {
      db.cleanup();
    }
  });

  test("supports match branches", async () => {
    class Classification extends Model.Class<Classification>("MatchClassification")({
      severity: Schema.String,
    }) {}

    class Outcome extends Model.Class<Outcome>("MatchOutcome")({
      action: Schema.String,
    }) {}

    const workflow = Smithers.workflow({
      name: "match-workflow",
      input: EmptyInput,
    }).build(($) => {
      const classify = $.step("classify", {
        output: Classification,
        run: () => Effect.succeed(new Classification({ severity: "high" })),
      });

      return $.sequence(
        classify,
        $.match(classify, {
          when: (result) => (result as Classification).severity === "high",
          then: () =>
            $.step("escalate", {
              output: Outcome,
              run: () => Effect.succeed(new Outcome({ action: "escalate" })),
            }),
          else: () =>
            $.step("auto-fix", {
              output: Outcome,
              run: () => Effect.succeed(new Outcome({ action: "auto-fix" })),
            }),
        }),
      );
    });

    const db = makeDbPath("smithers-effect-match-");
    try {
      const result = await Effect.runPromise(
        workflow.execute({}).pipe(
          Effect.provide(Smithers.sqlite({ filename: db.dbPath })),
        ),
      );

      expect(result).toBeInstanceOf(Outcome);
      expect((result as Outcome).action).toBe("escalate");
    } finally {
      db.cleanup();
    }
  });
});
