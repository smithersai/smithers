import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/lsc.ts", import.meta.url));
const loader = createRequire(import.meta.url).resolve("tsx");
const utf16 = "//@ option string-semantics javascript-utf16\n//@ option dafny-library local\n";
const header = "// lsc options: string-semantics=javascript-utf16\n";
const posixOnly = { skip: process.platform === "win32" };

function fixture(source: string, useFakeVerifier: boolean, run: (f: {
  dir: string; proof: string; gen: string; marker: string;
  cli: (args: string[]) => { status: number | null; output: string };
}) => void): void {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "lsc-string-profile-")));
  try {
    writeFileSync(join(dir, "source.ts"), source);
    const marker = join(dir, "verifier-called");
    const env = { ...process.env, LSC_TEST_VERIFIER_MARKER: marker };
    if (useFakeVerifier) {
      const bin = join(dir, "bin");
      mkdirSync(bin);
      const verifier = join(bin, "dafny");
      writeFileSync(verifier, '#!/bin/sh\nprintf "called\\n" > "$LSC_TEST_VERIFIER_MARKER"\nexit 0\n');
      chmodSync(verifier, 0o755);
      env.PATH = `${bin}${delimiter}${env.PATH ?? ""}`;
    }
    run({ dir, proof: join(dir, "source.dfy"), gen: join(dir, "source.dfy.gen"), marker,
      cli(args) {
        const result = spawnSync(process.execPath, ["--import", loader, cli,
          ...args, "--backend=dafny", "--time-limit=10", "source.ts"], {
          cwd: dir, env, encoding: "utf8", timeout: 60_000,
        });
        assert.ifError(result.error);
        return { status: result.status, output: result.stdout + result.stderr };
      },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const lengthSource = "export function codeUnitLength(value: string): number { return value.length; }\n";
for (const command of [["check"], ["gen-check"], ["regen"], ["regen", "--no-verify"]]) {
  for (const profile of ["javascript-utf16", "unicode-scalar"]) {
    test(`${command.join(" ")}: proof additions cannot change the generated ${profile} model`, posixOnly, () => {
      fixture("//@ backend dafny\n" + (profile === "javascript-utf16" ? utf16 : "") + lengthSource, true, f => {
        const generated = f.cli(["gen"]);
        assert.equal(generated.status, 0, generated.output);
        const original = readFileSync(f.proof, "utf8");
        const override = profile === "javascript-utf16"
          ? "// lsc options: string-semantics=unicode-scalar\n"
          : header;
        const claim = profile === "javascript-utf16"
          ? 'lemma WrongLength() ensures codeUnitLength("😀") == 1 {}\n'
          : 'lemma ChangedModel() ensures codeUnitLength("\\uD83D\\uDE00") == 2 {}\n';
        writeFileSync(f.proof, override + original + "\n" + claim);
        const result = f.cli(command);
        assert.equal(result.status, 1, result.output);
        assert.match(result.output, /string-semantics|duplicate lsc options header/);
        assert.equal(existsSync(f.marker), false, "the model guard must reject the proof before invoking Dafny");
        assert.equal(readFileSync(f.gen, "utf8"), original);
      });
    });
  }
}

test("ordinary UTF-16 proof additions still reach the verifier", posixOnly, () => {
  fixture("//@ backend dafny\n" + utf16 + lengthSource, true, f => {
    const generated = f.cli(["gen"]);
    assert.equal(generated.status, 0, generated.output);
    writeFileSync(f.proof, readFileSync(f.proof, "utf8")
      + '\nlemma CorrectLength() ensures codeUnitLength("😀") == 2 {}\n');
    const result = f.cli(["check"]);
    assert.equal(result.status, 0, result.output);
    assert.equal(existsSync(f.marker), true);
  });
});

test("numeric-returning surrogate operations verify through the frontend in UTF-16 mode", () => {
  const source = "//@ backend dafny\n" + utf16 + `export function surrogateCode(): number {
  //@ verify
  //@ ensures \\result === 0xD800
  return String.fromCharCode(0xD800).charCodeAt(0);
}
`;
  assert.equal(String.fromCharCode(0xD800).charCodeAt(0), 0xD800);
  fixture(source, false, f => {
    const result = f.cli(["check"]);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /0 errors/);
    assert.ok(readFileSync(f.gen, "utf8").includes(header));
  });
});
