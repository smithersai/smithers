# Changelog

## Unreleased

- A remote cache with no available credential (unset, empty or whitespace-only)
  now stays local from the start, sends no requests, and prints one
  `smthrs: remote cache off: no credentials` notice per run, instead of a 401
  and two warnings. A cache server that accepts unauthenticated requests now
  needs a non-blank token.

- `affected` no longer selects audited confined native process targets or their
  Filegroup dependencies for unrelated package siblings. Unconfined and
  incomplete contracts remain conservative, including readable output mounts,
  custom workspace lockfiles and symbolic-link inputs. Confined tools no longer receive
  blanket read access to undeclared files in their declaring package.

- An interrupted bundler resolve or build still reports a scratch tree it
  could not remove (#3839). Effect 4.0.4 removes a typed failure from an
  interrupted fiber's cause once the unwind passes a recovery handler, so the
  removal's `ExecError` was dropped and the caller saw a plain interruption.
  The failure now leaves the stop as a defect, so the exit carries both.

- Check-mode targets leave declared `hostDirectories` out of the gitignored
  census and link them into the scratch copy instead of copying them. A large
  or read-only host cache, such as Go's module cache, no longer refuses a
  check over its entry count or fails it when the scratch is removed.

- `review --credential-receiver <absolute executable>` writes each review's
  credential discoveries (revision, file, line and name, never a value) to the
  receiver's stdin before inference. A nonzero exit fails the review; the
  receiver's output is discarded (plue#730).

- `ci` accepts mixed exact labels for different target kinds and runs their
  union once, retaining compatible roots when another label belongs to a
  different verb. An exact label that no CI verb supports still fails (#2482).

- **Breaking:** `KnownRed.Entry` requires `failureDigest`; `Verdict` includes
  `observed` failures. Use `fingerprint` on the complete diagnostic so a new
  failure cannot reuse an old target exemption (#2466).

- Compare all generated declaration files in `Api.Compat`, including ignored output
  directories and directories containing package markers.

- Include nested Filegroup sources, declared output files, and complete output
  directories in `Files.digest` comparisons, including ignored generated files.

- Resolve private local baseline and surface producers in `Api.Compat` by their planned identities.

## 1.0.0-rc.0

- First public release candidate of the Smithers build CLI.
