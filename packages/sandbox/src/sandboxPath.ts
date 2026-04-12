import { resolve, isAbsolute, sep, dirname } from "node:path";
import { realpath } from "node:fs/promises";
import { Effect } from "effect";
import { toSmithersError } from "@smithers/errors/toSmithersError";
import { SmithersError } from "@smithers/errors/SmithersError";

export function resolveSandboxPath(rootDir: string, inputPath: string): string {
  if (!inputPath || typeof inputPath !== "string") {
    throw new SmithersError("TOOL_PATH_INVALID", "Path must be a string");
  }
  const resolved = isAbsolute(inputPath)
    ? resolve(inputPath)
    : resolve(rootDir, inputPath);
  const root = resolve(rootDir);
  if (!resolved.startsWith(root + sep) && resolved !== root) {
    throw new SmithersError("TOOL_PATH_ESCAPE", "Path escapes sandbox root");
  }
  return resolved;
}

export function assertPathWithinRootEffect(
  rootDir: string,
  resolvedPath: string,
) {
  return Effect.gen(function* () {
    const root = yield* Effect.tryPromise({
      try: () => realpath(resolve(rootDir)),
      catch: (cause) => toSmithersError(cause, "realpath root"),
    });
    let current = resolvedPath;
    while (true) {
      const result = yield* Effect.either(
        Effect.tryPromise({
          try: () => realpath(current),
          catch: (cause) => toSmithersError(cause, "realpath check"),
        }),
      );
      if (result._tag === "Right") {
        const target = result.right;
        if (target !== root && !target.startsWith(root + sep)) {
          return yield* Effect.fail(
            new SmithersError("TOOL_PATH_ESCAPE", "Path escapes sandbox root (via symlink)"),
          );
        }
        return;
      }
      const err = result.left;
      const cause = (err as any)?.cause ?? err;
      const code = (cause as any)?.code;
      if (code && code !== "ENOENT" && code !== "ENOTDIR") {
        return yield* Effect.fail(err);
      }
      const parent = dirname(current);
      if (parent === current) {
        return yield* Effect.fail(
          new SmithersError("TOOL_PATH_ESCAPE", "Path escapes sandbox root (via symlink)"),
        );
      }
      current = parent;
    }
  });
}

export async function assertPathWithinRoot(
  rootDir: string,
  resolvedPath: string,
) {
  return Effect.runPromise(assertPathWithinRootEffect(rootDir, resolvedPath));
}
