import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

import { parseFileOptions, resolveOptions, validateOptions } from "../src/config.ts";

test("parses a genuine leading option comment", () => {
  assert.deepEqual(
    parseFileOptions("//@ option safe-slice true\nconst value = 1;\n", "example.ts"),
    { "safe-slice": true },
  );
});

test("ignores directive-looking text in a template literal", () => {
  const source = "const help = `\n//@ option safe-slice true\n`;\n";
  assert.deepEqual(parseFileOptions(source, "example.ts"), {});
});

test("ignores directive-looking text in quoted strings and substitutions", () => {
  const source = [
    "const quoted = \"//@ option safe-slice true\";",
    "const templated = `value ${1}\n//@ safe-slice\n`;",
    "",
  ].join("\n");
  assert.deepEqual(parseFileOptions(source, "example.ts"), {});
});

test("does not mistake an escaped template backtick for the end of a literal", () => {
  const source = "const help = `before \\` after\n//@ option safe-slice true\n`;\n";
  assert.deepEqual(parseFileOptions(source, "example.ts"), {});
});

test("keeps actual block-comment directives compatible", () => {
  const source = "/*\n//@ option safe-slice true\n*/\nconst value = 1;\n";
  assert.deepEqual(parseFileOptions(source, "example.ts"), { "safe-slice": true });
});

test("still rejects a genuine directive after the first source statement", () => {
  const source = "const value = 1;\n//@ option safe-slice true\n";
  assert.throws(
    () => parseFileOptions(source, "example.ts"),
    /example\.ts:2: \/\/@ option directives must appear before the first source statement/,
  );
});

test("accepts a directive after a BOM and preserves CRLF input", () => {
  const source = "\uFEFF//@ option safe-slice true\r\nconst value = 1;\r\n";
  assert.deepEqual(parseFileOptions(source, "example.ts"), { "safe-slice": true });
});

test("only actual comments activate the legacy alias", () => {
  const source = "//@ safe-slice\nconst value = 1;\n";
  assert.deepEqual(parseFileOptions(source, "example.ts"), { "safe-slice": true });
});

for (const [name, source] of [
  ["template substitution", "const text = `value ${1}`;"],
  ["multiple substitutions", "const text = `${1} middle ${2} tail`;"],
  ["nested template", "const text = `${`nested ${1}`}`;"],
  ["template literal type", "type Label = `value ${string}`;"],
  ["regex with block-comment spelling", "const pattern = /[/*]/;"],
  ["regex with line-comment spelling", "const pattern = /[//]/;"],
  ["division", "const ratio = 4 / 2;"],
]) {
  test(`recognizes real directives after ${name}`, () => {
    assert.deepEqual(parseFileOptions(`${source}\n//@ safe-slice\n`, "example.ts"), { "safe-slice": true });
    assert.throws(
      () => parseFileOptions(`${source}\n//@ option safe-slice true\n`, "example.ts"),
      { message: "example.ts:2: //@ option directives must appear before the first source statement" },
    );
  });
}

test("ignores literal text throughout nested templates and substitutions", () => {
  const source = [
    'const text = `head',
    '//@ option unknown value',
    '${`nested',
    '//@ safe-slice',
    '${1}',
    '//@ option safe-slice invalid',
    '`} middle ${2}',
    '//@ option proof-dir elsewhere',
    '`;',
  ].join("\n");
  assert.deepEqual(parseFileOptions(source, "example.ts"), {});
});

test("recognizes actual comments inside template substitutions", () => {
  assert.throws(
    () => parseFileOptions("const text = `${\n//@ option safe-slice true\n1}`;", "example.ts"),
    { message: "example.ts:2: //@ option directives must appear before the first source statement" },
  );
  assert.deepEqual(
    parseFileOptions("const text = `${\n//@ safe-slice\n1}`;", "example.ts"),
    { "safe-slice": true },
  );
});

test("an incomplete template substitution does not stall option parsing", () => {
  // Run in a child so a scanner-progress regression fails within the timeout.
  const configUrl = new URL("../src/config.ts", import.meta.url).href;
  const source = "const text = `${1;\n//@ safe-slice\n";
  const script = `import { parseFileOptions } from ${JSON.stringify(configUrl)};
    console.log(JSON.stringify(parseFileOptions(${JSON.stringify(source)}, "example.ts")));`;
  const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    encoding: "utf8", timeout: 10_000,
  });
  assert.deepEqual(JSON.parse(output), { "safe-slice": true });
});

for (const prefix of ["", "\uFEFF", "#!/usr/bin/env node\n", "\uFEFF#!/usr/bin/env node\n", "/* license */\n\n// header\n"]) {
  test(`parses both option types after preamble ${JSON.stringify(prefix)}`, () => {
    const source = `${prefix}  //@ option safe-slice false\n\t//@ option extern-default impure\nconst value = 1;`;
    assert.deepEqual(parseFileOptions(source, "example.ts"), { "safe-slice": false, "extern-default": "impure" });
  });
}

test("accepts a file containing only comments", () => {
  assert.deepEqual(parseFileOptions("/* license */\n//@ option safe-slice true", "example.ts"), { "safe-slice": true });
});

test("code on a block comment's closing line ends the preamble", () => {
  const source = "/* license\n*/ const value = 1;\n/*\n//@ option safe-slice true\n*/";
  assert.throws(
    () => parseFileOptions(source, "example.ts"),
    { message: "example.ts:4: //@ option directives must appear before the first source statement" },
  );
});

test("preserves CRLF line numbers when ignoring template text", () => {
  const source = "\uFEFFconst text = `${1}\r\n//@ safe-slice\r\n`;\r\n//@ option safe-slice true\r\n";
  assert.throws(
    () => parseFileOptions(source, "example.ts"),
    { message: "example.ts:4: //@ option directives must appear before the first source statement" },
  );
});

test("preserves whole-line directive syntax", () => {
  const source = "/* //@ option safe-slice true */\nconst value = 1; //@ option safe-slice true\n";
  assert.deepEqual(parseFileOptions(source, "example.ts"), {});
});

for (const [directive, message] of [
  ["option", "expected //@ option <key> <value>"],
  ["option safe-slice", "expected //@ option <key> <value>"],
  ["option safe-slice true extra", "expected //@ option <key> <value>"],
  ["option missing true", "unknown option 'missing' (known options: extern-default, safe-slice, proof-dir, string-semantics, dafny-library, run-log)"],
  ["option safe-slice yes", "option 'safe-slice' must be true or false"],
  ["option extern-default invalid", "option 'extern-default' must be one of: pure, impure"],
  ["option proof-dir proofs", "option 'proof-dir' is config-only"],
  ["option run-log false", "option 'run-log' is config-only"],
]) {
  test(`still rejects invalid directive: ${directive}`, () => {
    assert.throws(
      () => parseFileOptions(`// header\n//@ ${directive}\nconst value = 1;`, "example.ts"),
      { message: `example.ts:2: ${message}` },
    );
  });
}

for (const directives of [
  "//@ option safe-slice true\n//@ option safe-slice false",
  "//@ safe-slice\n//@ option safe-slice false",
  "//@ option safe-slice false\n//@ safe-slice",
]) {
  test(`still rejects duplicate options: ${JSON.stringify(directives)}`, () => {
    assert.throws(
      () => parseFileOptions(directives, "example.ts"),
      { message: "example.ts:2: duplicate option 'safe-slice' (first set on line 1)" },
    );
  });
}

test("string-semantics is an enum whose default is today's Unicode-scalar model", () => {
  assert.equal(resolveOptions({}, "lemmascript.json")["string-semantics"], "unicode-scalar");
  assert.deepEqual(
    validateOptions({ "string-semantics": "javascript-utf16" }, "lemmascript.json"),
    { "string-semantics": "javascript-utf16" },
  );
  assert.throws(
    () => validateOptions({ "string-semantics": "utf16" }, "lemmascript.json"),
    /must be one of: unicode-scalar, javascript-utf16/,
  );
});

test("string and library directives override project defaults before compatibility checks", () => {
  const file = parseFileOptions("//@ option string-semantics javascript-utf16\n//@ option dafny-library local\n", "example.ts");
  const options = resolveOptions({ "string-semantics": "unicode-scalar", "dafny-library": "stdlib", ...file }, "example.ts");
  assert.equal(options["string-semantics"], "javascript-utf16");
  assert.equal(options["dafny-library"], "local");
  assert.throws(() => resolveOptions(parseFileOptions("//@ option string-semantics javascript-utf16\n", "example.ts"), "example.ts"),
    /incompatible/);
});

test("Dafny library defaults to stdlib and local works with scalar strings", () => {
  assert.equal(resolveOptions({}, "lemmascript.json")["dafny-library"], "stdlib");
  const options = resolveOptions(validateOptions({ "dafny-library": "local" }, "lemmascript.json"), "lemmascript.json");
  assert.equal(options["dafny-library"], "local");
  assert.equal(options["string-semantics"], "unicode-scalar");
  assert.ok(Object.isFrozen(options));
});

for (const library of [undefined, "stdlib"] as const) {
  test(`UTF-16 rejects ${library === undefined ? "the default" : "explicit"} stdlib choice`, () => {
    const explicit = library === undefined
      ? { "string-semantics": "javascript-utf16" }
      : { "string-semantics": "javascript-utf16", "dafny-library": library };
    assert.throws(() => resolveOptions(validateOptions(explicit, "lemmascript.json"), "lemmascript.json"),
      /lemmascript\.json:.*"string-semantics": "javascript-utf16".*"dafny-library": "stdlib".*"local" explicitly/);
  });
}

test("UTF-16 requires an explicit local library choice", () => {
  const explicit = validateOptions({ "string-semantics": "javascript-utf16", "dafny-library": "local" }, "lemmascript.json");
  assert.equal(resolveOptions(explicit, "lemmascript.json")["dafny-library"], "local");
});

test("Dafny library accepts only registered values in config and file directives", () => {
  for (const value of [true, "standard", null]) {
    assert.throws(() => validateOptions({ "dafny-library": value }, "lemmascript.json"), /must be one of: stdlib, local/);
  }
  assert.deepEqual(parseFileOptions("//@ option dafny-library local\n", "example.ts"), { "dafny-library": "local" });
  assert.throws(() => parseFileOptions("//@ option dafny-library standard\n", "example.ts"), /must be one of: stdlib, local/);
});

for (const [key, value] of [["string-semantics", "javascript-utf16"], ["dafny-library", "local"]]) {
  test(`${key} retains duplicate and placement checks`, () => {
    const directive = `//@ option ${key} ${value}\n`;
    assert.throws(() => parseFileOptions(directive + directive, "example.ts"), /duplicate option/);
    assert.throws(() => parseFileOptions("const value = 1;\n" + directive, "example.ts"), /before the first source statement/);
  });
}

test("run-log defaults on and can be turned off in lemmascript.json", () => {
  assert.equal(resolveOptions({}, "lemmascript.json")["run-log"], true);
  const options = resolveOptions(validateOptions({ "run-log": false }, "lemmascript.json"), "lemmascript.json");
  assert.equal(options["run-log"], false);
});
