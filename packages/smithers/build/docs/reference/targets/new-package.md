---
title: "NewPackage"
description: "Scaffolds the smallest package tree the workspace default target can discover."
---

Scaffolds the smallest package tree the workspace default target can discover.

```ts
import { Smithers } from "@smthrs/targets"

const newPackage = Smithers.NewPackage({ license: "MIT" })

export const Package = Smithers.Package({
  targets: { newPackage }
})
```

The package name is invocation state, not a declaration attribute:

```sh
smithers-build run //:newPackage --name @scope/widget
```

`@scope/widget` creates `packages/widget`.

## Attributes

| Name              | Type                      | Default                      | Description                         |
| ----------------- | ------------------------- | ---------------------------- | ----------------------------------- |
| `directory`       | `string`                  | `"packages"`                 | Workspace-relative parent directory |
| `version`         | `string`                  | `"0.1.0"`                    | Initial package version             |
| `license`         | supported license literal | required                     | Initial manifest license            |
| `fields`          | JSON record               | `{}`                         | Shared manifest template fields     |
| `tsconfigExtends` | `string`                  | `"../../tsconfig.base.json"` | Generated tsconfig base             |

The name passes the same lowercase, scoped npm-name validation used by package
manifest declarations. An existing destination is refused; scaffolding never
merges into or overwrites an existing package.

The complete tree is written beneath a unique sibling temporary directory and
published with one rename only after every file is durable. A failed write,
rename, or cancellation leaves no partially visible package and attempts to
remove the temporary; a cleanup failure is reported together with the primary
failure instead of being hidden. Concurrent attempts to create the same name
admit one complete tree and reject the other.

## Files

The result contains the created directory and these paths:

- `package.json`;
- `tsconfig.json`;
- `src/index.ts`;
- `test/index.test.ts`;
- `README.md`.

No `PACKAGE.ts` is written. Add a `PACKAGE.ts` or `PACKAGE.vibe` exporting
an explicit `Package` map before the new directory participates in queries or
CI. The CLI does not synthesize targets from `PackageDefaults` exports.

## Channels and status

| Property  | Value                                  |
| --------- | -------------------------------------- |
| Kinds     | `run`                                  |
| Cacheable | Never                                  |
| Success   | `ScaffoldReport`, `{directory, files}` |
| Error     | `WriteFileError`, `{path, message}`    |
| Executes  | Yes, through `ScaffoldPackageLive`     |

Omitting `--name` is a typed target failure. The static boilerplate works
offline and does not invoke a model.

## See also

- [Running targets](../../workspace/running-targets.md)
- [Default targets](../../extending/default-rules.md)
- [PackageJson](package-json-gen.md)
