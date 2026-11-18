---
title: "NewPackage"
description: "Scaffolds a workspace package with a PACKAGE.ts, so its targets are listed as soon as it exists."
---

Scaffolds a workspace package with a `PACKAGE.ts`, so its targets are listed as
soon as it exists.

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
| `template`        | `string`                  | unset                        | Workspace-relative template folder  |

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
- `README.md`;
- `PACKAGE.ts`.

The generated `PACKAGE.ts` declares one `test` target, a `Vitest` run of
`test/**/*.test.ts` in the new directory. The CLI does not synthesize targets
from `PackageDefaults` exports, so the scaffold writes the declaration itself.

## Templates

Set `template` to a workspace-relative folder to give new packages your
workspace's files. Every file under it is written into the new package:

- A trailing `.template` is dropped from the path, so `PACKAGE.ts.template`
  becomes `PACKAGE.ts`. The suffix keeps the folder from being read as a
  package or checked by your tools.
- `{{name}}`, `{{identifier}}`, `{{directory}}`, and `{{root}}` are replaced
  with the package name, the binding `src/index.ts` exports, the package's
  workspace-relative path, and the relative path from the package to the
  workspace root.
- `package.json` must hold a JSON object. It is merged over the generated
  manifest; `name`, `version`, and `license` still come from the scaffold.
- Any other file replaces the generated file at its path or adds a new one.

A missing folder, a symbolic link, or a non-JSON `package.json` fails the
scaffold and publishes nothing. If the template adds dependencies, run your
package manager's install before the new targets run.

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
