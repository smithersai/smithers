---
title: Repair CI build, documentation examples, and capability inventory
status: done
area: build
owner: Codex ci-build
updated: 2026-10-29
links: [../../../../packages/smithers/build/build-cli/PACKAGE.ts, ../../../../packages/smithers/build/targets/PACKAGE.ts, ../../../../packages/smithers/flows/flow/PACKAGE.ts, ../../../../packages/smithers/flows/capability/PACKAGE.ts]
---

Repair the six assigned build, reference-example, and capability targets using the CI target runner on Latitude. Library catalog entries: `@smthrs/build-cli`, `@smthrs/targets`, `@smthrs/flow`, `@smthrs/plan`, and `@smthrs/capability`.

Scratch copies omitted the result-cache directory that Linux confinement must seal beneath the writable cache. Create an empty directory through the existing cache containment check. Regressions cover default and nested cache paths, escaping parent symlinks, a real confined dry run, refusal to write the scratch result cache, and preservation of real cached results. The four original drift failures and four new cache regressions fail against the old implementation.

Confined checks, overlays, and affected dependency suites require explicit authority for linked dependency installations. Capture canonical installation paths during planning only when the workspace declares `nodeModules`; execution cannot follow a replacement into a different host directory. Scratch links point directly to the recorded installation. Real confinement regressions admit declared dependencies while refusing unrelated source links, private siblings, undeclared installations, and installations replaced after planning a Run or Diff. The linked-installation and canonical-link regressions fail against the old code; the replacement cases fail against execution-time discovery of installation authority.

The artifact-known-red refusal introduced in `844e31b6bb34` exceeded the reviewed plain-error count. Use the existing tagged `KnownRedError`, retaining its message and lifecycle refusal. The existing raw-error regression fails against the old code; its reviewed count stays unchanged.

The pipeline test still expected the browser and Go jobs removed by `82b5490dbe95` under SCOPE-3. Update its exact job list while retaining its required-gate assertions. Reference examples now import their dependencies and define the flow and callback they use. Every reference fence remains selected: five targets examples and three flow examples compile independently.

The capability inventory now honors its documented exclusion of test sources and reads VibeLang authoring files. A real-filesystem regression preserves rejection of malformed authoring grants and traversal of directories whose names resemble test files; it fails against the old scanner. Explain a whitespace-prefixed resource without presenting an invalid grant as copyable policy. The inventory also caught the release publisher's unsupported `net:put` selector: use `net:post`, the kernel's selector for HTTP write methods, and regenerate the factory projection. This release declaration is the minimal change outside the assigned packages.

Latitude preflight passes with the CI tool versions: all 20 real OCI, Foundry, and Anvil chain tests; 922 capability tests under each of Node and Bun, with 100% Node coverage; build CLI, targets, and capability typechecks; and site, LLM-bundle, and factory-projection drift checks. All six assigned targets pass in the full cache-disabled CI invocation: ten graph nodes ran, with zero cache hits, failures, skipped targets, or known-red exemptions. The same run passes site, LLM-bundle, and factory-projection drift checks. The required read-only Codex Sol review found no issues. No test was deleted or newly skipped, and no threshold, timeout, reference-block selection, or known-red entry changed.
