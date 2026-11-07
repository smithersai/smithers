# Conversation verification

From the app:

- `pnpm verify`: install the pinned tools if missing, strictly typecheck and freshly verify the production module,
  `src/core/conversation.vibe`. LemmaScript reads TypeScript, so the run proves an exact `.ts` copy of its text,
  staged in `.checks/run-*/source/`; reports name the `.vibe` file and line.
- `pnpm verify:broken`: assert every mutation in `mutations.py` fails its intended proof obligation.
- `pnpm verify:broken <name> ...`: demonstrate the named mutations failing with their function and line.
- `pnpm verify verify/bugs/<name>.ts`: reproduce a toolchain lowering defect.

See [decision 0005](../wiki/decisions/0005-formal-verification.md) for the numeric bounds and the exact coverage;

`verify:broken` generates every mutant from the production module into `.checks/broken-*` (never committed) with
byte-identical annotations, then asks Dafny to check the intended
function in each full source copy (`--filter-symbol` also selects its generated `_ensures` lemma). Other functions
and contracts remain present and are unchanged from the production module. Their full proofs run in `pnpm verify`;
a direct check of a broken copy checks all functions. This avoids repeating unrelated proofs for every mutation.
The selftest requires exit 4, an actual failed postcondition/invariant/assertion, and a diagnostic in the intended
function; a backend error or timeout fails the selftest. It uses two workers by default; set `CHECK_JOBS=1` to limit
it further. Every solver uses one core and the whole pipeline runs under `nice`.

Artifacts, source hashes, command/exit transcripts, CSV proof timings and summaries stay in `.checks/run-*`. The
runner uses no saved proof artifacts. `python3 verify/mutations.py OUT [NAME ...]` writes the
mutants and their `manifest.json`; its case list is the manifest, and a case whose production text no longer matches
exactly once fails the run until it is updated. Keep executable mutations meaningful and
never change annotations to make a copy fail. macOS installers support Apple Silicon and Intel but were not run on
the Linux lane. Versions are LemmaScript 0.6.6 and Dafny 4.11.0; release archives are pinned by SHA-256.

