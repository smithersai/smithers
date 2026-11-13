import * as Effect from "effect/Effect"
import { API, type APIOptions } from "typescript/unstable/sync"
import { describe, expect, it } from "vitest"
import * as Ts from "../src/internal/Ts.ts"

describe("compiler isolation and cleanup", () => {
  it.each(["project", "source", "snapshot"] as const)("closes the compiler on %s failure", async (failure) => {
    const events: Array<string> = []
    const compiler: Ts.CompilerService = {
      open: (options) => {
        const api = new API(options)
        events.push("open")
        return {
          clearSourceFileCache: () => api.clearSourceFileCache(),
          updateSnapshot: (options) => {
            if (failure === "snapshot") throw new Error("compiler failed")
            const snapshot = api.updateSnapshot(options)
            return {
              getProject: () => failure === "project" ? undefined : { program: { getSourceFile: () => undefined } },
              dispose: () => {
                snapshot.dispose()
                events.push("dispose")
              }
            }
          },
          close: () => {
            api.close()
            events.push("close")
          }
        }
      }
    }
    await expect(Effect.runPromise(
      Effect.gen(function*() {
        const parse = yield* Ts.session
        return parse("flow.ts", "")
      }).pipe(Effect.scoped, Effect.provideService(Ts.Compiler, compiler))
    )).rejects.toThrow(failure === "snapshot" ? "compiler failed" : "did not return a syntax tree")
    expect(events).toEqual(failure === "snapshot" ? ["open", "close"] : ["open", "dispose", "close"])
  })

  it("supplies only source text and a closed configuration, never filesystem fallback", async () => {
    let captured: APIOptions | undefined
    const compiler: Ts.CompilerService = {
      open: (options) => {
        captured = options
        return new API(options)
      }
    }
    await Effect.runPromise(
      Effect.gen(function*() {
        const parse = yield* Ts.session
        expect(parse("../../outside.tsx", "const view = <Task />").statements[0]?.getText()).toContain("<Task />")
      }).pipe(Effect.scoped, Effect.provideService(Ts.Compiler, compiler))
    )
    const { cwd, fs } = captured!
    expect(fs!.readFile!(`${cwd}/input.tsx`)).toBe("const view = <Task />")
    expect(fs!.fileExists!(`${cwd}/input.tsx`)).toBe(true)
    expect(fs!.directoryExists!(cwd!)).toBe(true)
    expect(JSON.parse(fs!.readFile!(`${cwd}/tsconfig.json`)!)).toEqual({
      files: ["input.tsx"],
      compilerOptions: { noLib: true, noResolve: true, allowJs: true, types: [] }
    })
    for (const path of ["/tsconfig.json", "/private/source", `${cwd}/node_modules/lib.d.ts`]) {
      expect(fs!.readFile!(path)).toBeNull()
      expect(fs!.fileExists!(path)).toBe(false)
      expect(fs!.directoryExists!(path)).toBe(false)
      expect(fs!.getAccessibleEntries!(path)).toEqual({ files: [], directories: [] })
      expect(fs!.realpath!(path)).toBe(path)
    }
  })
})
