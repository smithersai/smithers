import * as TargetRuntime from "@smthrs/targets/Runtime"
import * as Vm from "node:vm"
import { describe, expect, it } from "vitest"
import { declaredToolchain, defaultToolchain, packageManagerEnvironment, runInstall } from "../src/engine.ts"

/** A workspace path the refusals below must reject before ever resolving. */
const absentWorkspace = "/path/need/not/exist"

/** A toolchain `runInstall` accepts, so each case varies exactly one field. */
const pnpmToolchain = {
  manager: "pnpm",
  managerVersion: ">=0.0.0",
  runtime: "node",
  runtimeVersion: ">=0.0.0"
}

/**
 * An object that is not a Proxy yet whose key enumeration throws: a contextified
 * global forwards `[[OwnPropertyKeys]]` to its sandbox, here a hostile Proxy.
 */
const contextGlobalWithThrowingKeys = (): object =>
  Vm.runInContext(
    "globalThis",
    Vm.createContext(
      new Proxy({}, {
        ownKeys: () => {
          throw new Error("keys are hostile")
        }
      })
    )
  ) as object

describe("sensitive environment name list", () => {
  it("refuses a value that is not an array", () => {
    expect(() => packageManagerEnvironment({}, "TOKEN" as never)).toThrow(
      "sensitiveEnvironment must be an inspectable array of at most 64 names"
    )
  })

  it("refuses an array whose length is reported as a non-number", () => {
    const array = new Proxy([] as Array<string>, {
      getOwnPropertyDescriptor: (target, key) =>
        key === "length"
          ? { value: "1", writable: true, enumerable: false, configurable: false }
          : Reflect.getOwnPropertyDescriptor(target, key)
    })
    expect(() => packageManagerEnvironment({}, array)).toThrow("inspectable array")
  })

  it("refuses an array whose entries cannot be inspected", () => {
    const array = new Proxy(["TOKEN"], {
      getOwnPropertyDescriptor: (target, key) => {
        if (key === "length") return Reflect.getOwnPropertyDescriptor(target, key)
        throw new Error("entry is hostile")
      }
    })
    expect(() => packageManagerEnvironment({}, array)).toThrow("could not be inspected safely")
  })

  it("refuses a sparse array and an accessor entry without reading it", () => {
    const sparse = new Array<string>(2)
    sparse[1] = "TOKEN"
    expect(() => packageManagerEnvironment({}, sparse)).toThrow(
      "must contain only data entries"
    )
    let reads = 0
    const accessor = Object.defineProperty([] as Array<string>, "0", {
      enumerable: true,
      get: () => {
        reads += 1
        return "TOKEN"
      }
    })
    expect(() => packageManagerEnvironment({}, accessor)).toThrow("must contain only data entries")
    expect(reads).toBe(0)
  })

  it("blocks every declared name and keeps the rest", () => {
    expect(packageManagerEnvironment({ PATH: "/bin", NPM_TOKEN: "secret", OTHER: "kept" }, ["NPM_TOKEN"], false))
      .toEqual({ PATH: "/bin", OTHER: "kept" })
  })
})

describe("package-manager environment source", () => {
  it("refuses a windows flag that is not a boolean", () => {
    expect(() => packageManagerEnvironment({}, [], "yes" as never)).toThrow("windows must be a boolean")
  })

  it("refuses a source that is not a record", () => {
    for (const source of [null, "PATH=/bin", ["PATH=/bin"]]) {
      expect(() => packageManagerEnvironment(source as never, [], false)).toThrow(
        "environment source must be an object"
      )
    }
  })

  it("refuses a source whose keys cannot be listed", () => {
    const source = new Proxy({}, {
      ownKeys: () => {
        throw new Error("keys are hostile")
      }
    })
    expect(() => packageManagerEnvironment(source, [], false)).toThrow(
      "environment source could not be inspected safely"
    )
  })

  it("refuses a source whose entries cannot be inspected", () => {
    const source = new Proxy({ PATH: "/bin" }, {
      getOwnPropertyDescriptor: () => {
        throw new Error("entry is hostile")
      }
    })
    expect(() => packageManagerEnvironment(source, [], false)).toThrow(
      "environment source could not be inspected safely"
    )
  })

  it("refuses a value a spawn cannot carry as text", () => {
    expect(() => packageManagerEnvironment({ NUL: "a\0b" }, [], false)).toThrow(
      "environment source NUL is not usable text"
    )
    expect(() => packageManagerEnvironment({ LONE: "\uD800" }, [], false)).toThrow(
      "environment source LONE is not usable text"
    )
  })

  it("omits an unset name but still holds it to the case-insensitive uniqueness rule", () => {
    expect(packageManagerEnvironment({ UNSET: undefined, PATH: "/bin" }, [], false)).toEqual({ PATH: "/bin" })
    expect(() => packageManagerEnvironment({ Path: undefined, PATH: "/bin" }, [], true)).toThrow(
      "repeats a case-insensitive name: PATH"
    )
  })
})

describe("declared toolchain fallback", () => {
  it("falls back to the default for attrs that are not a record", () => {
    for (const attrs of [undefined, null, "pnpm", new Proxy({}, {})]) {
      expect(declaredToolchain(attrs)).toBe(defaultToolchain)
    }
  })

  it("falls back for a manager that is unknown, unnamed or unversioned", () => {
    for (
      const packageManager of [
        { name: "npm", version: "10.0.0" },
        { name: 42, version: "10.0.0" },
        { name: "pnpm" }
      ]
    ) {
      expect(declaredToolchain({ packageManager })).toBe(defaultToolchain)
    }
  })

  it("keeps a valid direct runtime when the manager declaration is unusable", () => {
    const runtime = TargetRuntime.ResolvedNodeRuntime.make({ name: "node", version: "24.11.0", executable: "./node" })
    expect(declaredToolchain({ runtime, packageManager: { name: "npm", version: "10.0.0" } })).toEqual({
      ...defaultToolchain,
      runtimeVersion: "24.11.0",
      runtimeExecutable: "./node"
    })
  })

  it("defaults the runtime of a manager declared without one", () => {
    expect(declaredToolchain({ packageManager: { name: "bun", version: "1.2.0" } })).toEqual({
      manager: "bun",
      managerVersion: "1.2.0",
      managerExecutable: undefined,
      runtime: "node",
      runtimeVersion: ">=0.0.0",
      runtimeExecutable: undefined
    })
  })

  it("carries a manager's declared runtime", () => {
    expect(
      declaredToolchain({
        packageManager: {
          name: "bun",
          version: "1.4.1",
          executable: "./bun",
          runtime: { name: "bun", version: "1.4.1", executable: "./bun" }
        }
      })
    ).toEqual({
      manager: "bun",
      managerVersion: "1.4.1",
      managerExecutable: "./bun",
      runtime: "bun",
      runtimeVersion: "1.4.1",
      runtimeExecutable: "./bun"
    })
  })

  it("defaults an unknown or unversioned runtime and drops a non-text executable", () => {
    expect(
      declaredToolchain({
        packageManager: { name: "pnpm", version: "10.0.0", executable: 7, runtime: { name: "deno", executable: 7 } }
      })
    ).toEqual({
      manager: "pnpm",
      managerVersion: "10.0.0",
      managerExecutable: undefined,
      runtime: "node",
      runtimeVersion: ">=0.0.0",
      runtimeExecutable: undefined
    })
  })
})

describe("runInstall argument refusals", () => {
  it("refuses an empty or NUL-bearing workspace root", async () => {
    for (const root of ["", "/tmp/a\0b", 7]) {
      await expect(runInstall(root as never)).rejects.toThrow("install workspaceRoot must be non-empty usable text")
    }
  })

  it("refuses options that are not a plain record", async () => {
    for (const options of [null, [], "cache"]) {
      await expect(runInstall(absentWorkspace, options as never)).rejects.toThrow(
        "install options must be a plain object"
      )
    }
    await expect(runInstall(absentWorkspace, new URL("file:///") as never)).rejects.toThrow(
      "install options must be a plain object"
    )
  })

  it("refuses options whose keys or entries cannot be inspected", async () => {
    const hostileKeys = new Proxy({}, {
      ownKeys: () => {
        throw new Error("keys are hostile")
      }
    })
    await expect(runInstall(absentWorkspace, hostileKeys)).rejects.toThrow(
      "install options could not be inspected safely"
    )
    const hostileEntry = new Proxy({ cacheDirectory: ".flows" }, {
      getOwnPropertyDescriptor: () => {
        throw new Error("entry is hostile")
      }
    })
    await expect(runInstall(absentWorkspace, hostileEntry)).rejects.toThrow(
      "install option cacheDirectory could not be inspected safely"
    )
  })

  it("accepts a null-prototype options record and then reads the workspace", async () => {
    const options = Object.assign(Object.create(null) as object, { toolchain: pnpmToolchain })
    await expect(runInstall(absentWorkspace, options as never)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("refuses a cache directory that is not text", async () => {
    await expect(runInstall(absentWorkspace, { cacheDirectory: 7 as never })).rejects.toThrow(
      "install cacheDirectory must be a string"
    )
  })
})

describe("runInstall toolchain refusals", () => {
  const refuse = (toolchain: unknown) => runInstall(absentWorkspace, { toolchain: toolchain as never })

  it("refuses a toolchain that is not plain data", async () => {
    for (const toolchain of [null, [], new Map(), { ...pnpmToolchain, [Symbol("extra")]: "x" }]) {
      await expect(refuse(toolchain)).rejects.toThrow("install toolchain must be a plain object")
    }
  })

  it("refuses a toolchain whose keys cannot be listed", async () => {
    await expect(refuse(contextGlobalWithThrowingKeys())).rejects.toThrow("install toolchain must be a plain object")
  })

  it("accepts a null-prototype toolchain and then reads the workspace", async () => {
    const toolchain = Object.assign(Object.create(null) as object, pnpmToolchain)
    await expect(refuse(toolchain)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("refuses a field that is missing, empty or not usable text", async () => {
    await expect(refuse({ ...pnpmToolchain, managerVersion: "" })).rejects.toThrow(
      "install toolchain managerVersion must be non-empty usable text"
    )
    await expect(refuse({ ...pnpmToolchain, runtimeVersion: undefined })).rejects.toThrow(
      "install toolchain runtimeVersion must be non-empty usable text"
    )
    await expect(refuse({ ...pnpmToolchain, managerExecutable: "pn\0pm" })).rejects.toThrow(
      "install toolchain managerExecutable must be non-empty usable text"
    )
    await expect(refuse({ ...pnpmToolchain, runtimeExecutable: "\uDC00" })).rejects.toThrow(
      "install toolchain runtimeExecutable must be non-empty usable text"
    )
  })

  it("refuses a runtime that is not a runtime", async () => {
    await expect(refuse({ ...pnpmToolchain, runtime: "deno" })).rejects.toThrow(
      "install toolchain runtime is not a runtime: \"deno\""
    )
  })
})
