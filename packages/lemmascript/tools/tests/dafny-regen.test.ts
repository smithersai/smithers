import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { dafnyRegen } from "../src/dafny-commands.ts";

class ExitSignal extends Error {
  constructor(readonly code: number | undefined) { super(`process.exit(${code})`); }
}
const generation = (n: number): string => `method M() {\n  var value := ${n};\n}\n`;
const addition = "\nlemma AddedProof() {}\n";

function fixture(run: (f: { gen: string; proof: string; base: string; dir: string }) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "lsc-regen-review-"));
  const bin = join(dir, "bin");
  const originalExit = process.exit;
  const originalPath = process.env.PATH;
  try {
    mkdirSync(bin);
    const verifier = join(bin, "dafny");
    writeFileSync(verifier, "#!/bin/sh\nexit 1\n");
    chmodSync(verifier, 0o755);
    process.env.PATH = `${bin}${delimiter}${originalPath ?? ""}`;
    process.exit = ((code?: number) => { throw new ExitSignal(code); }) as typeof process.exit;
    const f = { gen: join(dir, "x.dfy.gen"), proof: join(dir, "x.dfy"), base: join(dir, "x.dfy.base"), dir };
    writeFileSync(f.gen, generation(0));
    writeFileSync(f.proof, generation(0) + addition);
    run(f);
  } finally {
    process.exit = originalExit;
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    rmSync(dir, { recursive: true, force: true });
  }
}
function fails(run: () => void): void {
  assert.throws(run, (e) => e instanceof ExitSignal && e.code === 1);
}
const posixOnly = { skip: process.platform === "win32" };

test("failed verification anchors the generation already merged into the proof", posixOnly, () => fixture(f => {
  fails(() => dafnyRegen(f.gen, f.proof, f.base, generation(1), f.dir));
  assert.equal(readFileSync(f.base, "utf8"), generation(1));
  assert.equal(readFileSync(f.proof, "utf8"), generation(1) + addition);
}));

test("repeated failure and a subsequent source change preserve each declaration once", posixOnly, () => fixture(f => {
  fails(() => dafnyRegen(f.gen, f.proof, f.base, generation(1), f.dir));
  fails(() => dafnyRegen(f.gen, f.proof, f.base, generation(1), f.dir));
  fails(() => dafnyRegen(f.gen, f.proof, f.base, generation(2), f.dir));
  assert.equal(readFileSync(f.base, "utf8"), generation(2));
  assert.equal(readFileSync(f.proof, "utf8"), generation(2) + addition);
  dafnyRegen(f.gen, f.proof, f.base, generation(2), f.dir, undefined, undefined, true);
  assert.equal(existsSync(f.base), false);
  assert.equal(readFileSync(f.proof, "utf8"), generation(2) + addition);
}));

test("conflicts preserve the original proof and pre-merge anchor", posixOnly, () => fixture(f => {
  const original = generation(99) + addition;
  writeFileSync(f.proof, original);
  fails(() => dafnyRegen(f.gen, f.proof, f.base, generation(1), f.dir));
  assert.equal(readFileSync(f.proof, "utf8"), original);
  assert.equal(readFileSync(f.base, "utf8"), generation(0));
  assert.match(readFileSync(f.proof + ".merged", "utf8"), /<<<<<<</);
}));

test("additions-only failure does not advance an unaccepted anchor", posixOnly, () => fixture(f => {
  writeFileSync(f.base, generation(0));
  writeFileSync(f.proof, generation(99));
  fails(() => dafnyRegen(f.gen, f.proof, f.base, generation(0), f.dir));
  assert.equal(readFileSync(f.base, "utf8"), generation(0));
  assert.equal(readFileSync(f.proof, "utf8"), generation(99));
}));

test("a failed first verification can be followed by a clean generation", posixOnly, () => fixture(f => {
  rmSync(f.proof);
  fails(() => dafnyRegen(f.gen, f.proof, f.base, generation(1), f.dir));
  assert.equal(readFileSync(f.proof, "utf8"), generation(1));
  dafnyRegen(f.gen, f.proof, f.base, generation(2), f.dir, undefined, undefined, true);
  assert.equal(readFileSync(f.proof, "utf8"), generation(2));
  assert.equal(existsSync(f.base), false);
}));
