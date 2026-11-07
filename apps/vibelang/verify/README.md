# Conversation verification

From the app:

- `pnpm verify`: install the pinned tools if missing, strictly typecheck and freshly verify the production module.
- `pnpm verify verify/broken/<name>.ts`: demonstrate one executable mutation failing with its function and line.
- `pnpm verify:broken`: assert every committed mutation fails its intended proof obligation.
- `pnpm verify verify/bugs/<name>.ts`: reproduce a toolchain lowering defect.

See [decision 0005](../wiki/decisions/0005-formal-verification.md) for the numeric bounds and the exact coverage;

`verify:broken` checks fixture freshness and byte-identical annotations, then asks Dafny to check the intended
function in each full source copy (`--filter-symbol` also selects its generated `_ensures` lemma). Other functions
and contracts remain present and are unchanged from the production module. Their full proofs run in `pnpm verify`;
a direct check of a broken copy checks all functions. This avoids repeating unrelated proofs for every mutation.
The selftest requires exit 4, an actual failed postcondition/invariant/assertion, and a diagnostic in the intended
function; a backend error or timeout fails the selftest. It uses two workers by default; set `CHECK_JOBS=1` to limit
it further. Every solver uses one core and the whole pipeline runs under `nice`.

Artifacts, source hashes, command/exit transcripts, CSV proof timings and summaries stay in `.checks/run-*`. The
runner uses no saved proof artifacts. `python3 verify/mutations.py` regenerates copies after an intentional
production change; `--check` is read-only and is part of the selftest. Keep executable mutations meaningful and
never change annotations to make a copy fail. macOS installers support Apple Silicon and Intel but were not run on
the Linux lane. Versions are LemmaScript 0.6.6 and Dafny 4.11.0; release archives are pinned by SHA-256.

