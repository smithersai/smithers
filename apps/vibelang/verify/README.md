# App verification

From the app:

- `pnpm verify`: install the pinned tools if missing, strictly typecheck and freshly verify every marked production module under
  `src/`, `worker/`, and `scripts/`. LemmaScript reads TypeScript, so the run proves an exact `.ts` copy of its text,
  staged in `.checks/run-*/source/`; reports name the `.vibe` file and line.
- `pnpm verify:broken`: assert every mutation in `mutations.py` fails its intended proof obligation.
- `pnpm verify:broken <name> ...`: demonstrate the named mutations failing with their function and line.
- `pnpm verify:broken --module src/web/x.vibe ...`: run only the mutations of the named production modules, for iterating; a landing still runs the whole suite.
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
it further. Negative solvers use one core and the whole pipeline runs under `nice`.

Artifacts, source hashes, command/exit transcripts, CSV proof timings and summaries stay in `.checks/run-*`. The
runner uses no saved proof artifacts. `python3 verify/mutations.py OUT [NAME ...]` writes the
mutants and their `manifest.json`; its case list is the manifest, and a case whose production text no longer matches
exactly once fails the run until it is updated. Keep executable mutations meaningful and
never change annotations to make a copy fail. macOS installers support Apple Silicon and Intel but were not run on
the Linux lane. Versions are LemmaScript 0.6.6-smthrs.1 (the workspace package `packages/lemmascript`, built by `verify/install.sh`) and Dafny 4.11.0; release archives are pinned by SHA-256.

`verify/fetch.sh` gets the Dafny archive: a copy in the host's shared cache (`VIBELANG_VERIFY_CACHE`, default
`~/.cache/vibelang-verify`, keyed by SHA-256) is reused when its checksum matches; otherwise it downloads with 6
attempts and backoff from 2 seconds, doubling, and caches only a verified archive. `verify/fetch_test.py` runs it
against a local server that answers 504.


Expensive negatives select exact production postconditions using `mutation_targets.py`; source changes that remove
or duplicate a selected clause fail closed. Select the earliest broken contract: an earlier assumed postcondition or
checked assertion can hide a later failure in an isolated check. A few prefix and delta-field mutations select that exact earlier assertion within its function or named switch case;
missing or duplicate functions, cases and clauses fail closed. Other cases retain whole-function checks. A surviving mutation fails the gate. Positive checks verify every
contract, without symbol or position filters. The conversation and `decide` modules isolate every assertion with eight solver
workers, a 60-second limit per batch and a 3,600-second process limit; other positives retain one core and a
180-second process limit. [Dafny assertion batching](https://dafny.org/latest/HowToFAQ/FAQSplitHere) changes how
obligations are grouped, never which obligations are checked. Its reported assertion-batch count is not comparable
to earlier unsplit counts. Timeouts and backend errors never count as proofs or rejections.

The runner rechecks source hashes at completion and rejects production source-set changes. Inventory is generated
from original-source ESTree, including methods and Effect blocks: `node verify/inventory.cjs --write` refreshes the
0018 table; `node verify/inventory.cjs` rejects a stale table.

Each generated-only source directory extends the app's compiler options with an empty root-file list. LemmaScript
adds the exact selected module and resolves its dependencies; it does not reload unrelated app/test files for every
mutation. Strict checking still runs separately over every selected source. The history probe emitted byte-identical
Dafny and reduced generation from 25.795 s to 2.506 s on the loaded shared host; this is a diagnostic measurement, not
a reproducible application benchmark claim.

Production verification allows 60 seconds per Dafny assertion batch; conversation uses the assertion splitting
described above, while other modules use one solver core. The expanded role aggregate
proved unchanged at 27M solver resources but its prior 30-second wall limit became contention-sensitive. Mutation
verification keeps 30 seconds; a timeout never counts as a rejected mutation. No proof obligation is omitted.

`proof_additions.py` supplies an explicit recursive induction step in the freshly generated empty
`pendingCount_ensures` lemma. Dafny checks the recursive call, its preconditions, termination and every original
postcondition. This follows LemmaScript's additions-only proof workflow: all generated text remains byte-identical,
with only the lemma body inserted; no assumptions, axioms or saved proof results are used. The exact source identity,
lemma signature and empty body are checked before insertion. Each `.proof.json` records raw and checked SHA-256
hashes, and both fresh files remain in the run artifacts. The same insertion runs for mutation copies.

The mutation CI target allows 120 minutes for the complete growing suite with the conservative two-worker default.
Per-obligation and per-source solver/process limits are unchanged; a timeout still fails the gate.

The full conversation relation has a finite 1,200-second pipeline budget after the walkthrough adds four event variants. Per-assertion positive solver limits remain 60 seconds, with every assertion isolated and checked; negative limits remain 30 seconds. The prior 600-second pipeline bound expired while checking the larger relation, without reporting a counterexample. The unchanged main baseline freshly verified 6,810 batches in 281 seconds on this host; the walkthrough apply relation alone generates 9,746 batches. This changes scheduling time, never obligations or accepted solver outcomes.

Sandbox exact admission and frame clauses use quantified first-match source positions; their runtime loops are
unchanged. `proof_additions.py` also inserts the checked recursive step into the specification-only
`runningCountPrefix_ensures` lemma. Every insertion name is recorded in the fresh `.proof.json`; the harness rejects
a missing, duplicate or already populated lemma.

`decide` lives in `src/core/decide.vibe`, separate from `apply`, so neither relation risks the wall limit. A module may import from a proved `./x.vibe`: the runner stages `x.vibe.ts` so LemmaScript reads the import's contracts as axioms, and the import is proved in its own module. Mutants of an importing module get the same sibling file. A type-only import (`import type { Message } from "./main.vibe"`) of a module that does not parse as TypeScript stages VibeLang's emitted declaration as `x.vibe.d.ts` beside the importer instead (`declarations.py`): its types are exact, and it carries no constant or contract to read.
