import * as fs from "node:fs"
import { expectTypeOf, it } from "vitest"
import type { SyncFsLike } from "../src/browser/WasiFs.ts"

it("accepts adapters with descriptor truncation and no path truncation", () => {
  const adapter = {
    openSync: fs.openSync,
    closeSync: fs.closeSync,
    readSync: fs.readSync,
    writeSync: fs.writeSync,
    fstatSync: fs.fstatSync,
    ftruncateSync: fs.ftruncateSync,
    futimesSync: fs.futimesSync,
    statSync: fs.statSync,
    lstatSync: fs.lstatSync,
    mkdirSync: fs.mkdirSync,
    readdirSync: fs.readdirSync,
    renameSync: fs.renameSync,
    unlinkSync: fs.unlinkSync,
    rmdirSync: fs.rmdirSync,
    readlinkSync: fs.readlinkSync,
    symlinkSync: fs.symlinkSync,
    utimesSync: fs.utimesSync
  } satisfies SyncFsLike

  expectTypeOf(adapter).toExtend<SyncFsLike>()
})
