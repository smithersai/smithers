#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."

# The package's own tsx: npx would load the workspace root manifest, and npm rejects pnpm-only override keys
# such as "vitest@5.0.0>happy-dom" (EINVALIDTAGNAME) before running anything.
tsx="$PWD/node_modules/.bin/tsx"

# Fixture runs use temp dirs outside any git repo, so the run log would land in
# the current directory. Keep it off; the run-log section turns it on locally.
export LSC_RUN_LOG=false

# Run executable tests before the Dafny fixture checks.
"$tsx" --test tools/tests/*.test.ts

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
  "$tsx" tools/src/lsc.ts gen --backend=dafny tools/fixtures/unsupported-dafny-emission.ts

expect_failure \
  "Lean accepted an unsupported declaration" \
  "$tsx" tools/src/lsc.ts gen --backend=lean tools/fixtures/unsupported-extraction.ts

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
cp tools/fixtures/map-set.ts "$fixture_dir/map-set.ts"
cp tools/fixtures/regex.ts "$fixture_dir/regex.ts"
cp tools/fixtures/regex-wrong.ts "$fixture_dir/regex-wrong.ts"
cp examples/safeSlice.ts "$fixture_dir/legacy-safe-slice.ts"
cp -R tools/fixtures/utf16-project "$fixture_dir/utf16-project"
cp tools/fixtures/optional-binder-collisions.ts "$fixture_dir/optional-binder-collisions.ts"
cp tools/fixtures/unpaired-surrogate.ts "$fixture_dir/unpaired.ts"
cp tools/fixtures/optional-guard-order.ts "$fixture_dir/optional-guard-order.ts"
cp tools/fixtures/optional-comparison-order.ts "$fixture_dir/optional-comparison-order.ts"
cp tools/fixtures/spread-required-into-optional.ts tools/fixtures/spread-required-into-optional-wrong.ts "$fixture_dir/"

"$tsx" tools/src/lsc.ts gen --backend=dafny "$fixture_dir/impure.ts"
if ! grep -Fq 'method {:axiom} rollDie' "$fixture_dir/impure.dfy.gen"; then
  echo "ERROR: impure extern did not emit as a body-less method"
  exit 1
fi

"$tsx" tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/deterministic.ts"
"$tsx" tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/negated-array-ternary.ts"
"$tsx" tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/string-search-positions.ts"
"$tsx" tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/map-set.ts"
"$tsx" tools/src/lsc.ts check --backend=dafny --time-limit=60 "$fixture_dir/regex.ts"
expect_failure \
  "Dafny accepted a contract that misstates a regular-expression test" \
  "$tsx" tools/src/lsc.ts check --backend=dafny --time-limit=60 "$fixture_dir/regex-wrong.ts"
expect_failure \
  "Dafny equated two calls to an impure extern" \
  "$tsx" tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/impure.ts"
"$tsx" tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/optional-guard-order.ts"
"$tsx" tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/optional-comparison-order.ts"

"$tsx" tools/src/lsc.ts gen --backend=dafny "$fixture_dir/legacy-safe-slice.ts"
if ! grep -Fq 'function SafeSlice' "$fixture_dir/legacy-safe-slice.dfy.gen"; then
  echo "ERROR: legacy //@ safe-slice no longer enables safe slice emission"
  exit 1
fi
"$tsx" tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/optional-binder-collisions.ts"

# Object spreads of conditionals and field subsets, and exhaustive tagged-message tables.
for name in object-spread-conditional object-spread-partial tagged-match spec-record-spread empty-string-union safe-slice-suffix map-index real-field generic-record quantifier-names real-minmax string-last-index; do
  cp "tools/fixtures/$name.ts" "$fixture_dir/$name.ts"
  "$tsx" tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/$name.ts"
done
cp tools/fixtures/tagged-match-wrong-arm.ts "$fixture_dir/tagged-match-wrong-arm.ts"
expect_failure \
  "a tagged-match arm contradicted its contract and verified" \
  "$tsx" tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/tagged-match-wrong-arm.ts"
cp tools/fixtures/spec-record-spread-wrong.ts "$fixture_dir/spec-record-spread-wrong.ts"
expect_failure \
  "a spread frame in a contract accepted a changed field" \
  "$tsx" tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/spec-record-spread-wrong.ts"
cp tools/fixtures/empty-string-union-wrong.ts "$fixture_dir/empty-string-union-wrong.ts"
expect_failure \
  "an empty union member verified as a different member" \
  "$tsx" tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/empty-string-union-wrong.ts"

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

# A spread's required field over an optional one writes the present value (`spread-required-into-optional.ts`).
"$tsx" tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/spread-required-into-optional.ts"
expect_proof_failure \
  "a wrong twin verified (spread-required-into-optional)" \
  "$tsx" tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/spread-required-into-optional-wrong.ts"
for name in union-to-string string-union-subset generic-bound-array message-union sort-membership filter-index string-case flat-map spec-array-spread generic-optional-spread generic-return-interface generic-union-match declared-return-record index-signature-field local-record nonnullable-record computed-record-alias tagged-match-expression tagged-match-method literal-union-identity record-widening; do
  cp "tools/fixtures/$name.ts" "tools/fixtures/$name-wrong.ts" "$fixture_dir/"
  "$tsx" tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/$name.ts"
  expect_proof_failure \
    "a wrong twin verified ($name)" \
    "$tsx" tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/$name-wrong.ts"
done
# Unicode case mapping changes non-ASCII text and its length; the model must not prove otherwise.
cp tools/fixtures/string-case-length-wrong.ts "$fixture_dir/"
expect_proof_failure \
  "a case mapping proved a non-ASCII string keeps its length" \
  "$tsx" tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/string-case-length-wrong.ts"
# A tagged union declared in a project's own `.d.ts` (a module's emitted declaration) and imported with `import type`.
cp -R tools/fixtures/declared-union "$fixture_dir/"
"$tsx" tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/declared-union/use.ts"
expect_proof_failure \
  "a wrong twin verified (declared-union)" \
  "$tsx" tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/declared-union/use-wrong.ts"
cp -R tools/fixtures/imported-const tools/fixtures/imported-const-wrong tools/fixtures/imported-const-collision tools/fixtures/imported-nullish tools/fixtures/imported-nullish-wrong "$fixture_dir/"
# A contract may read an optional with ??, locally and through an import; a wrong default is a proof failure.
cp tools/fixtures/spec-nullish.ts tools/fixtures/spec-nullish-wrong.ts "$fixture_dir/"
"$tsx" tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/spec-nullish.ts"
expect_proof_failure \
  "Dafny accepted a contract whose ?? names the wrong default" \
  "$tsx" tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/spec-nullish-wrong.ts"
cp tools/fixtures/spec-nullish-narrowed.ts tools/fixtures/spec-nullish-narrowed-wrong.ts tools/fixtures/spec-nullish-falsy-wrong.ts "$fixture_dir/"
"$tsx" tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/spec-nullish-narrowed.ts"
expect_proof_failure \
  "Dafny accepted a wrong guarded-nullish result" \
  "$tsx" tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/spec-nullish-narrowed-wrong.ts"
expect_proof_failure \
  "Dafny treated a present zero as a nullish fallback" \
  "$tsx" tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/spec-nullish-falsy-wrong.ts"
# A destructured anonymous record, its nested record and an inline record parameter are declared records.
cp tools/fixtures/destructured-nested-record.ts tools/fixtures/destructured-nested-record-wrong.ts "$fixture_dir/"
"$tsx" tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/destructured-nested-record.ts"
expect_proof_failure \
  "Dafny accepted a destructured sum over the wrong nested field" \
  "$tsx" tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/destructured-nested-record-wrong.ts"
# `x ?? null` and `x ?? undefined` keep the optional type; claiming another field is a proof failure.
cp tools/fixtures/nullish-null-default.ts tools/fixtures/nullish-null-default-wrong.ts "$fixture_dir/"
"$tsx" tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/nullish-null-default.ts"
expect_proof_failure \
  "Dafny accepted a ?? null result equal to a field it does not read" \
  "$tsx" tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/nullish-null-default-wrong.ts"
"$tsx" tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/imported-nullish/use.ts"
expect_proof_failure \
  "Dafny accepted more than an imported ?? contract says" \
  "$tsx" tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/imported-nullish-wrong/use.ts"
"$tsx" tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/imported-const/use.ts"
expect_proof_failure \
  "an imported constant verified against a value it does not have" \
  "$tsx" tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/imported-const-wrong/use.ts"
expect_failure \
  "an imported constant was merged with a local constant of the same name" \
  "$tsx" tools/src/lsc.ts gen --backend=dafny "$fixture_dir/imported-const-collision/use.ts"

# `//@ opaque` hides a measure's body from every proof but its contract lemma and `//@ reveal`.
cp tools/fixtures/opaque-measure.ts tools/fixtures/opaque-measure-wrong.ts tools/fixtures/opaque-reveal-unknown.ts "$fixture_dir/"
"$tsx" tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/opaque-measure.ts"
if ! grep -Fq 'opaque function sumTo' "$fixture_dir/opaque-measure.dfy.gen" || [ "$(grep -c 'reveal sumTo();' "$fixture_dir/opaque-measure.dfy.gen")" != 2 ]; then
  echo "ERROR: //@ opaque did not emit an opaque function revealed in its lemma and the revealing method"
  exit 1
fi
expect_proof_failure \
  "a loop followed an opaque measure it never revealed" \
  "$tsx" tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/opaque-measure-wrong.ts"
expect_failure \
  "//@ reveal accepted a function that is not opaque" \
  "$tsx" tools/src/lsc.ts gen --backend=dafny "$fixture_dir/opaque-reveal-unknown.ts"

# A contract copied from another module keeps each constant it names there; a same-named local one is refused.
cp -R tools/fixtures/imported-contract-const tools/fixtures/imported-contract-const-wrong tools/fixtures/imported-contract-const-collision "$fixture_dir/"
"$tsx" tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/imported-contract-const/use.ts"
expect_proof_failure \
  "a copied contract's constant verified against a value it does not have" \
  "$tsx" tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/imported-contract-const-wrong/use.ts"
expect_failure \
  "a copied contract's constant was merged with a local constant of the same name" \
  "$tsx" tools/src/lsc.ts gen --backend=dafny "$fixture_dir/imported-contract-const-collision/use.ts"

cp -R tools/fixtures/imported-contract-const-cross-collision "$fixture_dir/"
expect_failure \
  "two copied contracts conflated constants that have different values" \
  "$tsx" tools/src/lsc.ts gen --backend=dafny "$fixture_dir/imported-contract-const-cross-collision/use.ts"

# A checked callee consuming a safe-slice suffix keeps its character relation; the wrong twin must reach a postcondition.
cp tools/fixtures/safe-slice-suffix.ts "$fixture_dir/safe-slice-session.ts"
cp tools/fixtures/safe-slice-session-wrong.ts "$fixture_dir/safe-slice-session-wrong.ts"
"$tsx" tools/src/lsc.ts check --backend=dafny --time-limit=30 "$fixture_dir/safe-slice-session.ts"
expect_proof_failure \
  "a wrong compositional helper twin verified (safe-slice-session)" \
  "$tsx" tools/src/lsc.ts check --backend=dafny --time-limit=30 "$fixture_dir/safe-slice-session-wrong.ts"
if grep -qE 'timed out|time out|out of range' "$fixture_dir/proof-failure.log"; then
  cat "$fixture_dir/proof-failure.log"
  exit 1
fi

# `//@ assert forall(i, A ==> exists(k, B)) by exists(k, C)` proves a forall-exists postcondition from a loop
# invariant and from a precondition, and a caller still reasons from it. The same program without `by` fails at its
# postconditions (apps/vibelang/verify/bugs/forall-exists-witness.dfy); a false parity fails the witness's own check.
cp tools/fixtures/forall-exists-witness.ts tools/fixtures/forall-exists-witness-red.ts \
  tools/fixtures/forall-exists-witness-wrong.ts "$fixture_dir/"
"$tsx" tools/src/lsc.ts check --backend=dafny --time-limit=30 "$fixture_dir/forall-exists-witness.ts"
expect_proof_failure \
  "a forall-exists postcondition verified without its witness" \
  "$tsx" tools/src/lsc.ts check --backend=dafny --time-limit=30 "$fixture_dir/forall-exists-witness-red.ts"
witness_log="$fixture_dir/forall-exists-witness-wrong.log"
if "$tsx" tools/src/lsc.ts check --backend=dafny --time-limit=30 "$fixture_dir/forall-exists-witness-wrong.ts" >"$witness_log" 2>&1; then
  echo "ERROR: a witness proved a false parity"
  exit 1
fi
if grep -qE 'resolution/type errors|timed out|time out' "$witness_log" || ! grep -q "assertion might not hold" "$witness_log"; then
  cat "$witness_log"
  echo "ERROR: the false-parity witness failed before reaching its check"
  exit 1
fi

cp tools/fixtures/safe-slice-suffix-wrong.ts "$fixture_dir/safe-slice-suffix-wrong.ts"
expect_failure \
  "a clamped suffix past the end verified as nonempty" \
  "$tsx" tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/safe-slice-suffix-wrong.ts"
cp tools/fixtures/map-index-wrong.ts "$fixture_dir/map-index-wrong.ts"
expect_failure \
  "a map callback's index verified as the element" \
  "$tsx" tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/map-index-wrong.ts"
cp tools/fixtures/real-field-wrong.ts "$fixture_dir/real-field-wrong.ts"
expect_failure \
  "a real record field verified an integer-only claim" \
  "$tsx" tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/real-field-wrong.ts"
cp tools/fixtures/generic-record-wrong.ts "$fixture_dir/generic-record-wrong.ts"
expect_failure \
  "a generic record verified a replaced element as kept" \
  "$tsx" tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/generic-record-wrong.ts"
cp tools/fixtures/real-minmax-wrong.ts "$fixture_dir/real-minmax-wrong.ts"
expect_proof_failure \
  "a real clamp verified above its floor" \
  "$tsx" tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/real-minmax-wrong.ts"
cp tools/fixtures/string-last-index-wrong.ts "$fixture_dir/string-last-index-wrong.ts"
expect_proof_failure \
  "the last match verified as the first" \
  "$tsx" tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/string-last-index-wrong.ts"
cp tools/fixtures/tagged-match-missing-arm.ts "$fixture_dir/tagged-match-missing-arm.ts"
expect_failure \
  "a non-exhaustive handler table was read as a tagged match" \
  "$tsx" tools/src/lsc.ts gen --backend=dafny "$fixture_dir/tagged-match-missing-arm.ts"

# Project configuration: nearest-ancestor discovery, generic file overrides,
# extern defaults, safe-slice, and mirrored Dafny artifact routing. Work from a
# copy because proof-dir generation intentionally creates companion files.
config_fixture="$fixture_dir/config-project"
cp -R tools/fixtures/config-project "$config_fixture"
configured="$config_fixture/src/configured.ts"

config_report=$("$tsx" tools/src/lsc.ts config "$configured")
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

"$tsx" tools/src/lsc.ts gen --backend=dafny "$configured"
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
"$tsx" tools/src/lsc.ts regen --backend=dafny --no-verify "$configured"
if ! grep -Fq '// retained proof addition' "$config_fixture/proofs/src/configured.dfy"; then
  echo "ERROR: regen did not preserve a proof addition under proof-dir"
  exit 1
fi

"$tsx" tools/src/lsc.ts gen --backend=dafny "$config_fixture/src/safe.ts"
if ! grep -Fq 'function SafeSlice' "$config_fixture/proofs/src/safe.dfy.gen"; then
  echo "ERROR: safe-slice=true from lemmascript.json was not consumed"
  exit 1
fi

"$tsx" tools/src/lsc.ts gen --backend=dafny "$config_fixture/src/pure-override.ts"
if ! grep -Fq 'function {:axiom} rollDie' "$config_fixture/proofs/src/pure-override.dfy.gen"; then
  echo "ERROR: file-level extern-default=pure did not override project config"
  exit 1
fi

"$tsx" tools/src/lsc.ts gen --backend=dafny "$config_fixture/src/cross-file.ts"
cross_file_gen="$config_fixture/proofs/src/cross-file.dfy.gen"
if ! grep -Fq 'method {:axiom} defaultRoll' "$cross_file_gen"; then
  echo "ERROR: extern-default=impure did not apply to a cross-file auto-extern"
  exit 1
fi
if ! grep -Fq 'function {:axiom} stableRoll' "$cross_file_gen"; then
  echo "ERROR: //@ pure on a cross-file const arrow did not override extern-default"
  exit 1
fi

typed_report=$("$tsx" tools/src/lsc.ts info --typed "$configured")
if ! grep -Fq '"options"' <<<"$typed_report" || ! grep -Fq '"extern-default": "impure"' <<<"$typed_report"; then
  echo "ERROR: lsc info --typed did not report effective options"
  exit 1
fi

defaults_report=$("$tsx" tools/src/lsc.ts config --config="$config_fixture/lemmascript.json")
if ! grep -Fq '"proof-dir": "proofs"' <<<"$defaults_report" || grep -Fq '"artifactDir"' <<<"$defaults_report"; then
  echo "ERROR: file-less lsc config did not report project defaults correctly"
  exit 1
fi

expect_failure \
  "Lean accepted an extern made impure by project config" \
  "$tsx" tools/src/lsc.ts gen --backend=lean "$configured"
expect_failure \
  "an extern was accepted with both //@ pure and //@ impure" \
  "$tsx" tools/src/lsc.ts gen --backend=dafny "$config_fixture/src/conflicting-extern.ts"

expect_failure \
  "unknown file option was accepted" \
  "$tsx" tools/src/lsc.ts config "$config_fixture/src/bad-option.ts"
expect_failure \
  "duplicate file option was accepted" \
  "$tsx" tools/src/lsc.ts config "$config_fixture/src/duplicate-option.ts"
expect_failure \
  "config-only proof-dir was accepted in a source directive" \
  "$tsx" tools/src/lsc.ts config "$config_fixture/src/proof-dir-option.ts"
expect_failure \
  "late file option was accepted" \
  "$tsx" tools/src/lsc.ts config "$config_fixture/src/late-option.ts"

expect_failure \
  "unknown lemmascript.json key was accepted" \
  "$tsx" tools/src/lsc.ts config tools/fixtures/config-invalid-unknown/source.ts
expect_failure \
  "bad lemmascript.json value was accepted" \
  "$tsx" tools/src/lsc.ts config tools/fixtures/config-invalid-value/source.ts
expect_failure \
  "proof-dir accepted a source outside the pinned config directory" \
  "$tsx" tools/src/lsc.ts config --config="$config_fixture/lemmascript.json" "$fixture_dir/deterministic.ts"

expect_failure \
  "proof-dir silently bypassed a sibling hand-written proof" \
  "$tsx" tools/src/lsc.ts gen --backend=dafny "$config_fixture/src/legacy.ts"
expect_absent "$config_fixture/proofs/src/legacy.dfy"

# ── String profile and collection library ─────────────────────────────────
# The ordinary example selects both options in source, without a JSON config.
cp examples/utf16.ts "$fixture_dir/utf16-example.ts"
"$tsx" tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/utf16-example.ts"
grep -Fq '// lsc options: string-semantics=javascript-utf16' "$fixture_dir/utf16-example.dfy.gen"

# Under "string-semantics": "javascript-utf16" a JavaScript string is a UTF-16
# code-unit sequence: astral characters occupy two Dafny chars and lone
# surrogates stay representable. The header token is what dafnyVerify maps to
# --unicode-char:false --allow-deprecation.
utf16="$fixture_dir/utf16-project/src/utf16.ts"
utf16_gen="$fixture_dir/utf16-project/src/utf16.dfy.gen"
if ! "$tsx" tools/src/lsc.ts config "$utf16" | grep -Fq '"string-semantics": "javascript-utf16"'; then
  echo "ERROR: lsc config did not report string-semantics=javascript-utf16"
  exit 1
fi
if ! "$tsx" tools/src/lsc.ts config "$utf16" | grep -Fq '"dafny-library": "local"'; then
  echo "ERROR: lsc config did not report the explicit local library choice"
  exit 1
fi
"$tsx" tools/src/lsc.ts check --backend=dafny --time-limit=10 "$utf16"
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
  "$tsx" tools/src/lsc.ts gen --backend=dafny "$incompatible"
expect_failure "UTF-16 accepted an explicit stdlib choice" \
  "$tsx" tools/src/lsc.ts gen --backend=dafny \
    --config="$fixture_dir/incompatible-strings/stdlib.json" "$incompatible"
expect_absent "$fixture_dir/incompatible-strings/source.dfy.gen"
expect_absent "$fixture_dir/incompatible-strings/source.dfy"

# Prove the same collection contracts with default stdlib, scalar/local, and
# UTF-16/local. All generated artifacts stay in the temporary fixture directory.
cp -R tools/fixtures/collection-library-project "$fixture_dir/local-collections"
cp tools/fixtures/collection-library-project/collections.ts "$fixture_dir/standard-collections.ts"
cp tools/fixtures/collection-library-project/collections.ts "$fixture_dir/utf16-project/collections.ts"
"$tsx" tools/src/lsc.ts gen --backend=dafny "$fixture_dir/standard-collections.ts"
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
"$tsx" tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/standard-collections.ts"
for helper in Filter All FoldLeft; do
  grep -Fq "Std.Collections.Seq.$helper(" "$fixture_dir/standard-collections.dfy.gen"
done
for source in "$fixture_dir/local-collections/collections.ts" "$fixture_dir/utf16-project/collections.ts"; do
  "$tsx" tools/src/lsc.ts check --backend=dafny --time-limit=10 "$source"
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
  "$tsx" -e 'import { dafnyVerify } from "./tools/src/dafny-commands.ts"; process.exit(dafnyVerify("tools/fixtures/string-with-standard-library.dfy", ".") ? 0 : 1)'

expect_failure \
  "javascript-utf16 was accepted by the Lean backend" \
  "$tsx" tools/src/lsc.ts gen --backend=lean "$fixture_dir/utf16-project/src/lean-rejected.ts"
expect_absent "$fixture_dir/utf16-project/src/lean-rejected.def.lean"

# The default profile cannot represent a lone surrogate: refused at extraction
# with the source line, not silently replaced by the UTF-8 file writer.
expect_failure \
  "unicode-scalar accepted an unpaired surrogate literal" \
  "$tsx" tools/src/lsc.ts gen --backend=dafny "$fixture_dir/unpaired.ts"
expect_absent "$fixture_dir/unpaired.dfy.gen"

# The default profile leaves generated text exactly as before: no header token.
"$tsx" tools/src/lsc.ts gen --backend=dafny "$fixture_dir/legacy-safe-slice.ts"
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
LSC_RUN_LOG=true "$tsx" tools/src/lsc.ts check --backend=dafny "$run_log_dir/arraySum.ts"
cp "$run_log_dir/arraySum.dfy" "$run_log_dir/arraySum.dfy.good"
# Break the proof with an addition (a false invariant on its own line), so the
# additions-only check passes and Dafny itself rejects it.
awk '{ print } /invariant \(sum == sumTo\(arr, i\)\)/ { print "    invariant sum == 0" }' \
  "$run_log_dir/arraySum.dfy.good" > "$run_log_dir/arraySum.dfy"
expect_failure \
  "run log fixture: a false added invariant verified" \
  env LSC_RUN_LOG=true "$tsx" tools/src/lsc.ts check --backend=dafny "$run_log_dir/arraySum.ts"
mv "$run_log_dir/arraySum.dfy.good" "$run_log_dir/arraySum.dfy"
LSC_RUN_LOG=true "$tsx" tools/src/lsc.ts check --backend=dafny "$run_log_dir/arraySum.ts"
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
  env LSC_RUN_LOG=true "$tsx" tools/src/lsc.ts regen --backend=dafny "$run_log_dir/arraySum.ts"
mv "$run_log_dir/arraySum.ts.good" "$run_log_dir/arraySum.ts"
LSC_RUN_LOG=true "$tsx" tools/src/lsc.ts regen --backend=dafny "$run_log_dir/arraySum.ts"
"$tsx" tools/src/lsc.ts runs --json --config="$run_log_dir/lemmascript.json" | node -e '
const report = JSON.parse(require("fs").readFileSync(0, "utf8"));
const fail = msg => { console.error("ERROR: lsc runs fixture: " + msg); process.exit(1); };
const caught = report.catches.map(c => `${c.function} ${c.kind} ${c.evidence?.hint ?? "-"}`).join(", ");
if (caught !== "arraySum proof -, arraySum source-fix code") fail("catches were " + caught);
if (report.open.length + report.dropped.length !== 0) fail("expected no open or dropped failures");
'

# A contract copied from another file names a helper of that file the importer never calls;
# the helper must be declared too, or Dafny cannot resolve the copied contract.
cp -R tools/fixtures/contract-helper-project "$fixture_dir/contract-helper-project"
"$tsx" tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/contract-helper-project/importer.ts"
if ! grep -Fq 'function {:axiom} positive' "$fixture_dir/contract-helper-project/importer.dfy.gen"; then
  echo "ERROR: a helper named by an imported contract was not declared"
  exit 1
fi
# An import named only by a contract, never called in a body, is declared too.
"$tsx" tools/src/lsc.ts check --backend=dafny --time-limit=10 "$fixture_dir/contract-helper-project/contract-only.ts"

# "run-log": false in lemmascript.json keeps logging off; LSC_RUN_LOG=true leaves
# the decision to the config rather than overriding it.
run_log_off_dir="$fixture_dir/run-log-off-project"
mkdir -p "$run_log_off_dir"
echo '{ "run-log": false }' > "$run_log_off_dir/lemmascript.json"
cp examples/arraySum.ts examples/arraySum.dfy "$run_log_off_dir/"
LSC_RUN_LOG=true "$tsx" tools/src/lsc.ts check --backend=dafny "$run_log_off_dir/arraySum.ts"
expect_absent "$run_log_off_dir/.lemmascript"

# An Effect Schema model translates through the value type the checker resolves (`fixtures/schema-model`): imported
# from its source, imported from the declaration TypeScript emits for it, and declared beside the proof. The folder
# sits inside the package so `effect` resolves; a wrong twin must fail on a proof obligation.
schema_dir=$(mktemp -d "$PWD/.schema-model.XXXXXX")
trap 'rm -rf "$fixture_dir" "$schema_dir"' EXIT
cp tools/fixtures/schema-model/*.ts tools/fixtures/schema-model/tsconfig.json "$schema_dir/"
"$tsx" tools/src/lsc.ts check --backend=dafny --time-limit=10 "$schema_dir/use.ts"
"$tsx" tools/src/lsc.ts check --backend=dafny --time-limit=10 "$schema_dir/local.ts"
"$tsx" tools/src/lsc.ts check --backend=dafny --time-limit=10 "$schema_dir/client-first.ts"
# A proved function of another module called with the schema's value type names its datatype in the signature.
"$tsx" tools/src/lsc.ts check --backend=dafny --time-limit=10 "$schema_dir/cross.ts"
expect_proof_failure \
  "a wrong twin verified (schema-model, cross-module)" \
  "$tsx" tools/src/lsc.ts check --backend=dafny --time-limit=10 "$schema_dir/cross-wrong.ts"
# A rest binding of the model keeps the type `Model`, which an imported contract's narrowed optional field names.
"$tsx" tools/src/lsc.ts check --backend=dafny --time-limit=10 "$schema_dir/rest.ts"
expect_proof_failure \
  "a wrong twin verified (schema-model, rest binding)" \
  "$tsx" tools/src/lsc.ts check --backend=dafny --time-limit=10 "$schema_dir/rest-wrong.ts"
expect_proof_failure \
  "a wrong twin verified (schema-model)" \
  "$tsx" tools/src/lsc.ts check --backend=dafny --time-limit=10 "$schema_dir/use-wrong.ts"
"$PWD/node_modules/.bin/tsc" --declaration --emitDeclarationOnly --strict --exactOptionalPropertyTypes --target es2022 --module esnext \
  --moduleResolution bundler --skipLibCheck --outDir "$schema_dir/declared" "$schema_dir/model.ts"
grep -q "Schema.optionalKey<" "$schema_dir/declared/model.d.ts"
cp "$schema_dir/use.ts" "$schema_dir/use-wrong.ts" "$schema_dir/client-first.ts" "$schema_dir/tsconfig.json" "$schema_dir/declared/"
"$tsx" tools/src/lsc.ts check --backend=dafny --time-limit=10 "$schema_dir/declared/use.ts"
"$tsx" tools/src/lsc.ts check --backend=dafny --time-limit=10 "$schema_dir/declared/client-first.ts"
expect_proof_failure \
  "a wrong twin verified (schema-model, declared)" \
  "$tsx" tools/src/lsc.ts check --backend=dafny --time-limit=10 "$schema_dir/declared/use-wrong.ts"
