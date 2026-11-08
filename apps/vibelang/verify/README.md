# App verification

From the app:

- `pnpm verify`: install the pinned tools if missing, strictly typecheck and freshly verify every marked production module under
  `src/`, `worker/`, and `scripts/`. LemmaScript reads TypeScript, so the run proves an exact `.ts` copy of its text,
  staged in `.checks/run-*/source/`; reports name the `.vibe` file and line.
- `pnpm verify:broken`: assert every mutation in `mutations.py` fails its intended proof obligation.
- `pnpm verify:broken <name> ...`: demonstrate the named mutations failing with their function and line.
- `pnpm verify <file-or-directory> ...`: check every supplied source; a missing extra source is an error.
- `pnpm verify verify/bugs/<name>.ts`: reproduce a documented tool boundary; unsafe-integer intentionally proves the mathematical model while its native counterexample fails.

See [decision 0018](../wiki/decisions/0018-proofs.md) for the current inventory, claims and proof boundaries, and
[0005](../wiki/decisions/0005-formal-verification.md) for the original conversation proof.

`verify:broken` generates every mutant from their production modules into `.checks/broken-*` (never committed) with
byte-identical annotations, then asks Dafny to check the intended
function in each full source copy (`--filter-symbol` also selects its generated `_ensures` lemma). Other functions
and contracts remain present and are unchanged from the production module. Their full proofs run in `pnpm verify`;
a direct check of a broken copy checks all functions. This avoids repeating unrelated proofs for every mutation.
The selftest requires exit 4, an actual failed precondition/postcondition/invariant/assertion, and a diagnostic in the intended
function; a backend error or timeout fails the selftest. It uses two workers by default; set `CHECK_JOBS=1` to limit
it further. Every solver uses one core and the whole pipeline runs under `nice`.

Artifacts, source hashes, command/exit transcripts, CSV proof timings and summaries stay in `.checks/run-*`. The
runner uses no saved proof artifacts. `python3 verify/mutations.py OUT [NAME ...]` writes the
mutants and their `manifest.json`; its case list is the manifest, and a case whose production text no longer matches
exactly once fails the run until it is updated. Keep executable mutations meaningful and
never change annotations to make a copy fail. macOS installers support Apple Silicon and Intel but were not run on
the Linux lane. Versions are LemmaScript 0.6.6 and Dafny 4.11.0; release archives are pinned by SHA-256.


Expensive negatives select exact production postconditions using `mutation_targets.py`; source changes that remove
or duplicate a selected clause fail closed. Select the earliest broken contract: an earlier assumed postcondition or
checked assertion can hide a later failure in an isolated check. Prefix and delta-field mutations that break an
earlier assertion retain whole-function checks. A surviving mutation fails the gate. Positive checks verify every
contract, without isolation. Timeouts and backend errors never count as proofs or rejections.

The runner rechecks source hashes at completion and rejects production source-set changes. Inventory is generated
from original-source ESTree, including methods and Effect blocks: `node verify/inventory.cjs --write` refreshes the
0018 table; `node verify/inventory.cjs` rejects a stale table.

Each generated-only source directory extends the app's compiler options with an empty root-file list. LemmaScript
adds the exact selected module and resolves its dependencies; it does not reload unrelated app/test files for every
mutation. Strict checking still runs separately over every selected source. The history probe emitted byte-identical
Dafny and reduced generation from25.795s to2.506s on the loaded shared host; this is a diagnostic measurement, not
a reproducible application benchmark claim.
