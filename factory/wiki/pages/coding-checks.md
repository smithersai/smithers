# Checks against immutable source

`checks.ts` is a private repository recipe. It registers the `coding/CommandCheck` delegate with the existing executable catalog and supplies `checkLayers(options)` to the existing native action table. There is no additional executor or database.

## Pin a registered command

A project check is an ordinary discovered Markdown flow whose verified body starts with a JSON command declaration: `argv`, a relative `cwd` and a bounded `timeoutMs`. The recipe reads only that first nonempty line, so arguments the registry appends cannot replace it.

The plan names the check flow and its execution digest, so changing the command changes that digest. The invocation carries the verified body into the action payload, and `checkInputDigest` binds the result to the exact implemented revision and check.

## Run from an exported revision

The action exports the implementation's commit with `smithers-jj-export` into a temporary directory and verifies the returned commit, tree and JJ change IDs before running the command. The working directory must stay inside that export. Links into the live checkout or anywhere else outside the export are refused before a checker starts.

A relative executable requires a host-supplied `PATH`; otherwise the command must name an absolute executable. The command does not inherit the gateway's environment by default. The export is a source snapshot, not a security sandbox: the host supplies process confinement.

## Retain measured receipts

Exit code zero produces a passing receipt. A nonzero exit produces a failed receipt with a finding owned by the implementation's Change. Invalid exports, missing executables, timeouts and failed cleanup fail execution instead of inventing validation evidence. Output is bounded, and truncation is recorded in the receipt.

## Limit resource use

`checkLayers` accepts an optional `concurrency` limit. The deployed coding host selects `concurrency: 1`, so one command check at a time covers export, installation, execution and cleanup. Standalone compositions without the limit run checks concurrently.
