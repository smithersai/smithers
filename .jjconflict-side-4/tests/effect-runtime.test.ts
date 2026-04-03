import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { runPromise, runSync } from "../src/effect/runtime";
import { ERROR_REFERENCE_URL, SmithersError } from "../src/utils/errors";

describe("effect runtime", () => {
  test("runPromise resolves successful effect", async () => {
    const result = await runPromise(Effect.succeed(42));
    expect(result).toBe(42);
  });

  test("runPromise rejects on failed effect", async () => {
    try {
      await runPromise(Effect.fail(new Error("test error")));
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err).toBeInstanceOf(SmithersError);
      expect(err.message).toBe(`test error See ${ERROR_REFERENCE_URL}`);
    }
  });

  test("runPromise rejects with Error for non-Error failure", async () => {
    try {
      await runPromise(Effect.fail("string failure" as any));
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err).toBeInstanceOf(Error);
    }
  });

  test("runPromise handles Effect.sync", async () => {
    const result = await runPromise(Effect.sync(() => "hello"));
    expect(result).toBe("hello");
  });

  test("runPromise handles mapped effects", async () => {
    const effect = Effect.succeed(10).pipe(Effect.map((n) => n * 2));
    const result = await runPromise(effect);
    expect(result).toBe(20);
  });

  test("runPromise handles flatMapped effects", async () => {
    const effect = Effect.succeed(5).pipe(
      Effect.flatMap((n) => Effect.succeed(n + 3)),
    );
    const result = await runPromise(effect);
    expect(result).toBe(8);
  });

  test("runSync resolves synchronous effect", () => {
    const result = runSync(Effect.succeed("sync value"));
    expect(result).toBe("sync value");
  });
});
