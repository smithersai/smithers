#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Fixture runs use temp dirs outside any git repo, so the run log would land in
# the current directory. Keep it off; the run-log section turns it on locally.
export LSC_RUN_LOG=false

# Run executable tests before the Dafny fixture checks.
npx tsx --test tools/tests/*.test.ts

expect_failure() {
  local message="$1"
  shift
  if "$@"; then
    echo "ERROR: $message"
    exit 1
  fi
}

expect_absent() {
  if [ -e "$1" ]; then
    echo "ERROR: failed generation wrote $1"
    exit 1
  fi
}

expect_failure \
  "Dafny accepted an unsupported declaration" \
  npx tsx tools/src/lsc.ts gen --backend=dafny tools/fixtures/unsupported-dafny-emission.ts

expect_failure \
  "Lean accepted an unsupported declaration" \
  npx tsx tools/src/lsc.ts gen --backend=lean tools/fixtures/unsupported-extraction.ts

expect_absent tools/fixtures/unsupported-dafny-emission.dfy.gen
expect_absent tools/fixtures/unsupported-dafny-emission.dfy
expect_absent tools/fixtures/unsupported-extraction.types.lean
expect_absent tools/fixtures/unsupported-extraction.def.lean

# A deterministic extern remains extensional, while `//@ impure` makes the two
# call results independent and therefore invalidates the equality proof. Copy
# to a temporary directory so expected generated artifacts never enter fixtures.
fixture_dir=$(mktemp -d)
trap 'rm -rf "$fixture_dir"' EXIT
cp tools/fixtures/deterministic-extern-equality.ts "$fixture_dir/deterministic.ts"
cp tools/fixtures/impure-extern-equality.ts "$fixture_dir/impure.ts"
cp tools/fixtures/negated-array-ternary.ts "$fixture_dir/negated-array-ternary.ts"
cp tools/fixtures/string-search-positions.ts "$fixture_dir/string-search-positions.ts"
cp examples/safeSlice.ts "$fixture_dir/legacy-safe-slice.ts"
cp -R tools/fixtures/utf16-project "$fixture_dir/utf16-project"
cp tools/fixtures/optional-binder-collisions.ts "$fixture_dir/optional-binder-collisions.ts"
cp tools/fixtures/unpaired-surrogate.ts "$fixture_dir/unpaired.ts"
cp tools/fixtures/optional-guard-order.ts "$fixture_dir/optional-guard-order.ts"
cp tools/fixtures/optional-comparison-order.ts "$fixture_dir/optional-comparison-order.ts"

npx tsx tools/src/lsc.ts gen --backend=dafny "$fixture_dir/impure.ts"
if ! grep -Fq 'method {:axiom} rollDie' "$fixture_dir/impure.dfy.gen"; then
  echo "ERROR: impure extern did not emit as a body-less method"
  exit 1
fi

npx tsx tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/deterministic.ts"
npx tsx tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/negated-array-ternary.ts"
npx tsx tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/string-search-positions.ts"
expect_failure \
  "Dafny equated two calls to an impure extern" \
  npx tsx tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/impure.ts"
npx tsx tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/optional-guard-order.ts"
npx tsx tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/optional-comparison-order.ts"

npx tsx tools/src/lsc.ts gen --backend=dafny "$fixture_dir/legacy-safe-slice.ts"
if ! grep -Fq 'function SafeSlice' "$fixture_dir/legacy-safe-slice.dfy.gen"; then
  echo "ERROR: legacy //@ safe-slice no longer enables safe slice emission"
  exit 1
fi
npx tsx tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/optional-binder-collisions.ts"

# Object spreads of conditionals and field subsets, and exhaustive tagged-message tables.
for name in object-spread-conditional object-spread-partial tagged-match spec-record-spread empty-string-union safe-slice-suffix map-index real-field generic-record quantifier-names; do
  cp "tools/fixtures/$name.ts" "$fixture_dir/$name.ts"
  npx tsx tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/$name.ts"
done
cp tools/fixtures/tagged-match-wrong-arm.ts "$fixture_dir/tagged-match-wrong-arm.ts"
expect_failure \
  "a tagged-match arm contradicted its contract and verified" \
  npx tsx tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/tagged-match-wrong-arm.ts"
cp tools/fixtures/spec-record-spread-wrong.ts "$fixture_dir/spec-record-spread-wrong.ts"
expect_failure \
  "a spread frame in a contract accepted a changed field" \
  npx tsx tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/spec-record-spread-wrong.ts"
cp tools/fixtures/empty-string-union-wrong.ts "$fixture_dir/empty-string-union-wrong.ts"
expect_failure \
  "an empty union member verified as a different member" \
  npx tsx tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/empty-string-union-wrong.ts"

# A string-literal union widens to `string` and to a superset union; a constant
# imported from another module keeps its declared value; a Foldkit `defineMessageUnion` is read as a `_tag`
# union and its `match` table proved. Each wrong twin must
# fail on a proof obligation, not on a resolution error.
expect_proof_failure() {
  local message="$1"
  shift
  local log="$fixture_dir/proof-failure.log"
  if "$@" >"$log" 2>&1; then
    echo "ERROR: $message"
    exit 1
  fi
  if grep -q "resolution/type errors" "$log" || ! grep -q "could not be proved" "$log"; then
    cat "$log"
    echo "ERROR: $message (failed before reaching a proof obligation)"
    exit 1
  fi
}
for name in union-to-string string-union-subset generic-bound-array message-union sort-membership filter-index string-case flat-map spec-array-spread; do
  cp "tools/fixtures/$name.ts" "tools/fixtures/$name-wrong.ts" "$fixture_dir/"
  npx tsx tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/$name.ts"
  expect_proof_failure \
    "a wrong twin verified ($name)" \
    npx tsx tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/$name-wrong.ts"
done
# Unicode case mapping changes non-ASCII text and its length; the model must not prove otherwise.
cp tools/fixtures/string-case-length-wrong.ts "$fixture_dir/"
expect_proof_failure \
  "a case mapping proved a non-ASCII string keeps its length" \
  npx tsx tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/string-case-length-wrong.ts"
# A tagged union declared in a project's own `.d.ts` (a module's emitted declaration) and imported with `import type`.
cp -R tools/fixtures/declared-union "$fixture_dir/"
npx tsx tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/declared-union/use.ts"
expect_proof_failure \
  "a wrong twin verified (declared-union)" \
  npx tsx tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/declared-union/use-wrong.ts"
cp -R tools/fixtures/imported-const tools/fixtures/imported-const-wrong tools/fixtures/imported-const-collision tools/fixtures/imported-nullish tools/fixtures/imported-nullish-wrong "$fixture_dir/"
# A contract may read an optional with ??, locally and through an import; a wrong default is a proof failure.
cp tools/fixtures/spec-nullish.ts tools/fixtures/spec-nullish-wrong.ts "$fixture_dir/"
npx tsx tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/spec-nullish.ts"
expect_proof_failure \
  "Dafny accepted a contract whose ?? names the wrong default" \
  npx tsx tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/spec-nullish-wrong.ts"
npx tsx tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/imported-nullish/use.ts"
expect_proof_failure \
  "Dafny accepted more than an imported ?? contract says" \
  npx tsx tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/imported-nullish-wrong/use.ts"
npx tsx tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/imported-const/use.ts"
expect_proof_failure \
  "an imported constant verified against a value it does not have" \
  npx tsx tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/imported-const-wrong/use.ts"
expect_failure \
  "an imported constant was merged with a local constant of the same name" \
  npx tsx tools/src/lsc.ts gen --backend=dafny "$fixture_dir/imported-const-collision/use.ts"

# `//@ opaque` hides a measure's body from every proof but its contract lemma and `//@ reveal`.
cp tools/fixtures/opaque-measure.ts tools/fixtures/opaque-measure-wrong.ts tools/fixtures/opaque-reveal-unknown.ts "$fixture_dir/"
npx tsx tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/opaque-measure.ts"
if ! grep -Fq 'opaque function sumTo' "$fixture_dir/opaque-measure.dfy.gen" || [ "$(grep -c 'reveal sumTo();' "$fixture_dir/opaque-measure.dfy.gen")" != 2 ]; then
  echo "ERROR: //@ opaque did not emit an opaque function revealed in its lemma and the revealing method"
  exit 1
fi
expect_proof_failure \
  "a loop followed an opaque measure it never revealed" \
  npx tsx tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/opaque-measure-wrong.ts"
expect_failure \
  "//@ reveal accepted a function that is not opaque" \
  npx tsx tools/src/lsc.ts gen --backend=dafny "$fixture_dir/opaque-reveal-unknown.ts"

# A contract copied from another module keeps each constant it names there; a same-named local one is refused.
cp -R tools/fixtures/imported-contract-const tools/fixtures/imported-contract-const-wrong tools/fixtures/imported-contract-const-collision "$fixture_dir/"
npx tsx tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/imported-contract-const/use.ts"
expect_proof_failure \
  "a copied contract's constant verified against a value it does not have" \
  npx tsx tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/imported-contract-const-wrong/use.ts"
expect_failure \
  "a copied contract's constant was merged with a local constant of the same name" \
  npx tsx tools/src/lsc.ts gen --backend=dafny "$fixture_dir/imported-contract-const-collision/use.ts"

cp -R tools/fixtures/imported-contract-const-cross-collision "$fixture_dir/"
expect_failure \
  "two copied contracts conflated constants that have different values" \
  npx tsx tools/src/lsc.ts gen --backend=dafny "$fixture_dir/imported-contract-const-cross-collision/use.ts"

cp tools/fixtures/safe-slice-suffix-wrong.ts "$fixture_dir/safe-slice-suffix-wrong.ts"
expect_failure \
  "a clamped suffix past the end verified as nonempty" \
  npx tsx tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/safe-slice-suffix-wrong.ts"
cp tools/fixtures/map-index-wrong.ts "$fixture_dir/map-index-wrong.ts"
expect_failure \
  "a map callback's index verified as the element" \
  npx tsx tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/map-index-wrong.ts"
cp tools/fixtures/real-field-wrong.ts "$fixture_dir/real-field-wrong.ts"
expect_failure \
  "a real record field verified an integer-only claim" \
  npx tsx tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/real-field-wrong.ts"
cp tools/fixtures/generic-record-wrong.ts "$fixture_dir/generic-record-wrong.ts"
expect_failure \
  "a generic record verified a replaced element as kept" \
  npx tsx tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/generic-record-wrong.ts"
cp tools/fixtures/tagged-match-missing-arm.ts "$fixture_dir/tagged-match-missing-arm.ts"
expect_failure \
  "a non-exhaustive handler table was read as a tagged match" \
  npx tsx tools/src/lsc.ts gen --backend=dafny "$fixture_dir/tagged-match-missing-arm.ts"

# Project configuration: nearest-ancestor discovery, generic file overrides,
# extern defaults, safe-slice, and mirrored Dafny artifact routing. Work from a
# copy because proof-dir generation intentionally creates companion files.
config_fixture="$fixture_dir/config-project"
cp -R tools/fixtures/config-project "$config_fixture"
configured="$config_fixture/src/configured.ts"

config_report=$(npx tsx tools/src/lsc.ts config "$configured")
for expected in \
  "\"configFile\": \"$config_fixture/lemmascript.json\"" \
  '"extern-default": "impure"' \
  '"safe-slice": false' \
  '"proof-dir": "proofs"' \
  "\"artifactDir\": \"$config_fixture/proofs/src\""; do
  if ! grep -Fq "$expected" <<<"$config_report"; then
    echo "ERROR: lsc config report missing: $expected"
    exit 1
  fi
done

npx tsx tools/src/lsc.ts gen --backend=dafny "$configured"
configured_gen="$config_fixture/proofs/src/configured.dfy.gen"
if [ ! -e "$configured_gen" ] || [ ! -e "$config_fixture/proofs/src/configured.dfy" ]; then
  echo "ERROR: proof-dir did not create the Dafny pair in the mirrored directory"
  exit 1
fi
expect_absent "$config_fixture/src/configured.dfy.gen"
expect_absent "$config_fixture/src/configured.dfy"
if ! grep -Fq 'method {:axiom} rollDie' "$configured_gen"; then
  echo "ERROR: extern-default=impure did not emit an unmarked extern as a method"
  exit 1
fi
if grep -Fq 'function SafeSlice' "$configured_gen"; then
  echo "ERROR: file-level safe-slice=false did not override project config"
  exit 1
fi
printf '\n// retained proof addition\n' >> "$config_fixture/proofs/src/configured.dfy"
npx tsx tools/src/lsc.ts regen --backend=dafny --no-verify "$configured"
if ! grep -Fq '// retained proof addition' "$config_fixture/proofs/src/configured.dfy"; then
  echo "ERROR: regen did not preserve a proof addition under proof-dir"
  exit 1
fi

npx tsx tools/src/lsc.ts gen --backend=dafny "$config_fixture/src/safe.ts"
if ! grep -Fq 'function SafeSlice' "$config_fixture/proofs/src/safe.dfy.gen"; then
  echo "ERROR: safe-slice=true from lemmascript.json was not consumed"
  exit 1
fi

npx tsx tools/src/lsc.ts gen --backend=dafny "$config_fixture/src/pure-override.ts"
if ! grep -Fq 'function {:axiom} rollDie' "$config_fixture/proofs/src/pure-override.dfy.gen"; then
  echo "ERROR: file-level extern-default=pure did not override project config"
  exit 1
fi

npx tsx tools/src/lsc.ts gen --backend=dafny "$config_fixture/src/cross-file.ts"
cross_file_gen="$config_fixture/proofs/src/cross-file.dfy.gen"
if ! grep -Fq 'method {:axiom} defaultRoll' "$cross_file_gen"; then
  echo "ERROR: extern-default=impure did not apply to a cross-file auto-extern"
  exit 1
fi
if ! grep -Fq 'function {:axiom} stableRoll' "$cross_file_gen"; then
  echo "ERROR: //@ pure on a cross-file const arrow did not override extern-default"
  exit 1
fi

typed_report=$(npx tsx tools/src/lsc.ts info --typed "$configured")
if ! grep -Fq '"options"' <<<"$typed_report" || ! grep -Fq '"extern-default": "impure"' <<<"$typed_report"; then
  echo "ERROR: lsc info --typed did not report effective options"
  exit 1
fi

defaults_report=$(npx tsx tools/src/lsc.ts config --config="$config_fixture/lemmascript.json")
if ! grep -Fq '"proof-dir": "proofs"' <<<"$defaults_report" || grep -Fq '"artifactDir"' <<<"$defaults_report"; then
  echo "ERROR: file-less lsc config did not report project defaults correctly"
  exit 1
fi

expect_failure \
  "Lean accepted an extern made impure by project config" \
  npx tsx tools/src/lsc.ts gen --backend=lean "$configured"
expect_failure \
  "an extern was accepted with both //@ pure and //@ impure" \
  npx tsx tools/src/lsc.ts gen --backend=dafny "$config_fixture/src/conflicting-extern.ts"

expect_failure \
  "unknown file option was accepted" \
  npx tsx tools/src/lsc.ts config "$config_fixture/src/bad-option.ts"
expect_failure \
  "duplicate file option was accepted" \
  npx tsx tools/src/lsc.ts config "$config_fixture/src/duplicate-option.ts"
expect_failure \
  "config-only proof-dir was accepted in a source directive" \
  npx tsx tools/src/lsc.ts config "$config_fixture/src/proof-dir-option.ts"
expect_failure \
  "late file option was accepted" \
  npx tsx tools/src/lsc.ts config "$config_fixture/src/late-option.ts"

expect_failure \
  "unknown lemmascript.json key was accepted" \
  npx tsx tools/src/lsc.ts config tools/fixtures/config-invalid-unknown/source.ts
expect_failure \
  "bad lemmascript.json value was accepted" \
  npx tsx tools/src/lsc.ts config tools/fixtures/config-invalid-value/source.ts
expect_failure \
  "proof-dir accepted a source outside the pinned config directory" \
  npx tsx tools/src/lsc.ts config --config="$config_fixture/lemmascript.json" "$fixture_dir/deterministic.ts"

expect_failure \
  "proof-dir silently bypassed a sibling hand-written proof" \
  npx tsx tools/src/lsc.ts gen --backend=dafny "$config_fixture/src/legacy.ts"
expect_absent "$config_fixture/proofs/src/legacy.dfy"

# ── String profile and collection library ─────────────────────────────────
# The ordinary example selects both options in source, without a JSON config.
cp examples/utf16.ts "$fixture_dir/utf16-example.ts"
npx tsx tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/utf16-example.ts"
grep -Fq '// lsc options: string-semantics=javascript-utf16' "$fixture_dir/utf16-example.dfy.gen"

# Under "string-semantics": "javascript-utf16" a JavaScript string is a UTF-16
# code-unit sequence: astral characters occupy two Dafny chars and lone
# surrogates stay representable. The header token is what dafnyVerify maps to
# --unicode-char:false --allow-deprecation.
utf16="$fixture_dir/utf16-project/src/utf16.ts"
utf16_gen="$fixture_dir/utf16-project/src/utf16.dfy.gen"
if ! npx tsx tools/src/lsc.ts config "$utf16" | grep -Fq '"string-semantics": "javascript-utf16"'; then
  echo "ERROR: lsc config did not report string-semantics=javascript-utf16"
  exit 1
fi
if ! npx tsx tools/src/lsc.ts config "$utf16" | grep -Fq '"dafny-library": "local"'; then
  echo "ERROR: lsc config did not report the explicit local library choice"
  exit 1
fi
npx tsx tools/src/lsc.ts check --backend=dafny --time-limit=10 "$utf16"
grep -Fq '// lsc options: string-semantics=javascript-utf16' "$utf16_gen"
grep -Fq '"\uD83D\uDE00"' "$utf16_gen"
grep -Fq '"\uD83D"' "$utf16_gen"
if grep -Fq 'Std.Collections' "$utf16_gen"; then
  echo "ERROR: javascript-utf16 emitted a Dafny standard-library call"
  exit 1
fi

# The library has a fixed stdlib default; UTF-16 never silently changes it.
cp -R tools/fixtures/config-incompatible-strings "$fixture_dir/incompatible-strings"
incompatible="$fixture_dir/incompatible-strings/source.ts"
expect_failure "UTF-16 silently changed the default library" \
  npx tsx tools/src/lsc.ts gen --backend=dafny "$incompatible"
expect_failure "UTF-16 accepted an explicit stdlib choice" \
  npx tsx tools/src/lsc.ts gen --backend=dafny \
    --config="$fixture_dir/incompatible-strings/stdlib.json" "$incompatible"
expect_absent "$fixture_dir/incompatible-strings/source.dfy.gen"
expect_absent "$fixture_dir/incompatible-strings/source.dfy"

# Prove the same collection contracts with default stdlib, scalar/local, and
# UTF-16/local. All generated artifacts stay in the temporary fixture directory.
cp -R tools/fixtures/collection-library-project "$fixture_dir/local-collections"
cp tools/fixtures/collection-library-project/collections.ts "$fixture_dir/standard-collections.ts"
cp tools/fixtures/collection-library-project/collections.ts "$fixture_dir/utf16-project/collections.ts"
npx tsx tools/src/lsc.ts gen --backend=dafny "$fixture_dir/standard-collections.ts"
# Standard Filter is opaque. Add proof steps that expose its definition and
# unfold the three input elements plus the empty tail; check enforces additions-only.
node --input-type=module - "$fixture_dir/standard-collections.dfy" <<'JS'
import { readFileSync, writeFileSync } from "node:fs";
const path = process.argv[2];
let proof = readFileSync(path, "utf8");
for (const [name, type, expected] of [
  ["positiveNumbers", "int", "[1, 2]"],
  ["nonemptyStrings", "string", '["a", "bc"]'],
]) {
  const start = new RegExp(`lemma ${name}_ensures\\(\\)[\\s\\S]*?\\{\\n`);
  if (!start.test(proof)) throw new Error(`Missing proof body for ${name}`);
  proof = proof.replace(start, "$&  reveal Std.Collections.Seq.Filter();\n"
    + `  assert {:fuel Std.Collections.Seq.Filter<${type}>, 4, 5} ${name}() == ${expected};\n`);
}
writeFileSync(path, proof);
JS
npx tsx tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/standard-collections.ts"
for helper in Filter All FoldLeft; do
  grep -Fq "Std.Collections.Seq.$helper(" "$fixture_dir/standard-collections.dfy.gen"
done
for source in "$fixture_dir/local-collections/collections.ts" "$fixture_dir/utf16-project/collections.ts"; do
  npx tsx tools/src/lsc.ts check --backend=dafny --time-limit=10 "$source"
  generated="${source%.ts}.dfy.gen"
  if grep -Fq 'Std.' "$generated"; then
    echo "ERROR: dafny-library=local emitted a standard-library reference"
    exit 1
  fi
  for helper in SeqFilter SeqAll SeqFoldLeft; do grep -Fq "$helper<" "$generated"; done
done
if grep -Fq '// lsc options:' "$fixture_dir/local-collections/collections.dfy.gen"; then
  echo "ERROR: selecting local helpers changed scalar string semantics"
  exit 1
fi
grep -Fq '// lsc options: string-semantics=javascript-utf16' "$fixture_dir/utf16-project/collections.dfy.gen"

expect_failure \
  "Dafny standard library was combined with javascript-utf16 strings" \
  npx tsx -e 'import { dafnyVerify } from "./tools/src/dafny-commands.ts"; process.exit(dafnyVerify("tools/fixtures/string-with-standard-library.dfy", ".") ? 0 : 1)'

expect_failure \
  "javascript-utf16 was accepted by the Lean backend" \
  npx tsx tools/src/lsc.ts gen --backend=lean "$fixture_dir/utf16-project/src/lean-rejected.ts"
expect_absent "$fixture_dir/utf16-project/src/lean-rejected.def.lean"

# The default profile cannot represent a lone surrogate: refused at extraction
# with the source line, not silently replaced by the UTF-8 file writer.
expect_failure \
  "unicode-scalar accepted an unpaired surrogate literal" \
  npx tsx tools/src/lsc.ts gen --backend=dafny "$fixture_dir/unpaired.ts"
expect_absent "$fixture_dir/unpaired.dfy.gen"

# The default profile leaves generated text exactly as before: no header token.
npx tsx tools/src/lsc.ts gen --backend=dafny "$fixture_dir/legacy-safe-slice.ts"
if grep -Fq '// lsc options:' "$fixture_dir/legacy-safe-slice.dfy.gen"; then
  echo "ERROR: unicode-scalar stamped an options header"
  exit 1
fi

# Run log: a real check → broken proof → fixed proof sequence is recorded with
# member outcomes and hashes, inside a self-ignoring .lemmascript/ beside the config.
run_log_dir="$fixture_dir/run-log-project"
mkdir -p "$run_log_dir"
echo '{}' > "$run_log_dir/lemmascript.json"
cp examples/arraySum.ts examples/arraySum.dfy "$run_log_dir/"
LSC_RUN_LOG=true npx tsx tools/src/lsc.ts check --backend=dafny "$run_log_dir/arraySum.ts"
cp "$run_log_dir/arraySum.dfy" "$run_log_dir/arraySum.dfy.good"
# Break the proof with an addition (a false invariant on its own line), so the
# additions-only check passes and Dafny itself rejects it.
awk '{ print } /invariant \(sum == sumTo\(arr, i\)\)/ { print "    invariant sum == 0" }' \
  "$run_log_dir/arraySum.dfy.good" > "$run_log_dir/arraySum.dfy"
expect_failure \
  "run log fixture: a false added invariant verified" \
  env LSC_RUN_LOG=true npx tsx tools/src/lsc.ts check --backend=dafny "$run_log_dir/arraySum.ts"
mv "$run_log_dir/arraySum.dfy.good" "$run_log_dir/arraySum.dfy"
LSC_RUN_LOG=true npx tsx tools/src/lsc.ts check --backend=dafny "$run_log_dir/arraySum.ts"
node -e '
const runs = require("fs").readFileSync(process.argv[1], "utf8").trim().split("\n").map(l => JSON.parse(l));
const fail = msg => { console.error("ERROR: run log fixture: " + msg); process.exit(1); };
const stages = runs.map(r => r.stage).join(",");
if (stages !== "ok,verify,ok") fail("stages were " + stages);
if (!runs[1].failed.includes("arraySum")) fail("arraySum was not recorded as failing");
if (!runs[2].passed.includes("arraySum")) fail("arraySum was not recorded as passing again");
if (new Set(runs.map(r => r.tsHash)).size !== 1) fail("the .ts hash changed although the .ts did not");
if (runs[1].dfyHash === runs[0].dfyHash || runs[2].dfyHash !== runs[0].dfyHash) fail("dfy hashes did not track the proof edit");
' "$run_log_dir/.lemmascript/runs.jsonl"
grep -qx '\*' "$run_log_dir/.lemmascript/.gitignore"
expect_absent .lemmascript

# lsc runs: a code bug in the .ts fails under regen and its removal passes, so
# the log above now holds a proof catch (the proof edit) and a source-fix catch
# whose diff changed only code.
cp "$run_log_dir/arraySum.ts" "$run_log_dir/arraySum.ts.good"
sed 's/sum = sum + arr\[i\];/sum = sum + arr[i] + 1;/' "$run_log_dir/arraySum.ts.good" > "$run_log_dir/arraySum.ts"
expect_failure \
  "run log fixture: arraySum with an off-by-one sum verified" \
  env LSC_RUN_LOG=true npx tsx tools/src/lsc.ts regen --backend=dafny "$run_log_dir/arraySum.ts"
mv "$run_log_dir/arraySum.ts.good" "$run_log_dir/arraySum.ts"
LSC_RUN_LOG=true npx tsx tools/src/lsc.ts regen --backend=dafny "$run_log_dir/arraySum.ts"
npx tsx tools/src/lsc.ts runs --json --config="$run_log_dir/lemmascript.json" | node -e '
const report = JSON.parse(require("fs").readFileSync(0, "utf8"));
const fail = msg => { console.error("ERROR: lsc runs fixture: " + msg); process.exit(1); };
const caught = report.catches.map(c => `${c.function} ${c.kind} ${c.evidence?.hint ?? "-"}`).join(", ");
if (caught !== "arraySum proof -, arraySum source-fix code") fail("catches were " + caught);
if (report.open.length + report.dropped.length !== 0) fail("expected no open or dropped failures");
'

# A contract copied from another file names a helper of that file the importer never calls;
# the helper must be declared too, or Dafny cannot resolve the copied contract.
cp -R tools/fixtures/contract-helper-project "$fixture_dir/contract-helper-project"
npx tsx tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/contract-helper-project/importer.ts"
if ! grep -Fq 'function {:axiom} positive' "$fixture_dir/contract-helper-project/importer.dfy.gen"; then
  echo "ERROR: a helper named by an imported contract was not declared"
  exit 1
fi
# An import named only by a contract, never called in a body, is declared too.
npx tsx tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/contract-helper-project/contract-only.ts"

# "run-log": false in lemmascript.json keeps logging off; LSC_RUN_LOG=true leaves
# the decision to the config rather than overriding it.
run_log_off_dir="$fixture_dir/run-log-off-project"
mkdir -p "$run_log_off_dir"
echo '{ "run-log": false }' > "$run_log_off_dir/lemmascript.json"
cp examples/arraySum.ts examples/arraySum.dfy "$run_log_off_dir/"
LSC_RUN_LOG=true npx tsx tools/src/lsc.ts check --backend=dafny "$run_log_off_dir/arraySum.ts"
expect_absent "$run_log_off_dir/.lemmascript"
