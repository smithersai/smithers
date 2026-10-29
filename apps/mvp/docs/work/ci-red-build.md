---
title: Repair CI build, documentation examples, and capability inventory
status: in-progress
area: build
owner: Codex ci-build
updated: 2026-10-29
links: [../../../../packages/smithers/build/build-cli/PACKAGE.ts, ../../../../packages/smithers/build/targets/PACKAGE.ts, ../../../../packages/smithers/flows/flow/PACKAGE.ts, ../../../../packages/smithers/flows/capability/PACKAGE.ts]
---

Reproduce the assigned CI targets on Latitude with the CI target runner. Fix drift checks, the repository pipeline parser assertion, self-contained reference examples, and capability inventory parsing without excluding examples or weakening gates. Library catalog entries: `@smthrs/build-cli`, `@smthrs/targets`, `@smthrs/flow`, and `@smthrs/capability`.

Scratch copies omitted the result-cache directory that Linux confinement must seal beneath the writable cache. Create an empty directory through the existing cache containment check. Regressions cover the default and nested cache paths, escaping parent symlinks, an actual confined dry run, refusal to write the scratch result cache, and preservation of real cached results. All four original drift failures and all four new cache regressions fail against the old implementation on Latitude.

The pipeline test still expected the browser and Go jobs removed by `82b5490dbe95` under SCOPE-3. Update its exact job list while retaining its required-gate assertions. Reference examples now import their dependencies and define the flow and callback they use. Every reference fence remains selected: five targets examples and three flow examples compile independently.

The capability inventory now honors its documented exclusion of test sources and reads VibeLang authoring files. A real-filesystem regression preserves rejection of malformed grants in authoring files. Explain a whitespace-prefixed resource without presenting an invalid grant as copyable policy. The inventory also caught the release publisher's unsupported `net:put` selector: use `net:post`, the kernel's selector for HTTP write methods, and regenerate the factory projection. This release declaration is the minimal change outside the assigned packages.

Focused Latitude validation passes: 221 build tests; the complete targets suite; all eight reference examples; and 922 capability tests under each of Node and Bun, with 100% Node coverage. The final complete build CLI suite, typechecks, and review are pending. No threshold, timeout, reference-block selection, or known-red entry changed.
