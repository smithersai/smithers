/** Real git repositories that already build with Smithers build, for the tests. */
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

/** Runs git in `root` as a fixed author, apart from the machine's configuration. */
export const git = (root: string, ...args: ReadonlyArray<string>): string =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Smithers CI test",
      GIT_AUTHOR_EMAIL: "ci@example.invalid",
      GIT_COMMITTER_NAME: "Smithers CI test",
      GIT_COMMITTER_EMAIL: "ci@example.invalid",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null"
    }
  })

/** A fresh directory under the system temp directory. */
export const temporary = (prefix: string): string => mkdtempSync(join(tmpdir(), `smithers-ci-native-${prefix}-`))

/** Writes `files` under `root` and commits them; returns the commit. */
export const commit = (root: string, subject: string, files: Readonly<Record<string, string>>): string => {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true })
    writeFileSync(join(root, name), content)
  }
  git(root, "add", "--all")
  git(root, "commit", "--quiet", "--message", subject)
  return git(root, "rev-parse", "HEAD").trim()
}

/** A new repository holding `files` in one commit. */
export const repository = (files: Readonly<Record<string, string>>): string => {
  const root = temporary("repo")
  git(root, "init", "--quiet", "--initial-branch=main")
  commit(root, "first", files)
  return root
}

/** A workflow with one job a push triggers, which any machine can run. */
export const workflow = `on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: sh test.sh
`

/** A workspace file as an owner writes it. */
export const ownWorkspace = `import { Smithers as S } from "@smthrs/targets"
export const Workspace = S.Workspace("own", { repository: "git+https://example.invalid/own.git" })
`

/** A package file as an owner writes it. */
export const ownPackage = `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: {} })
`

/** What a repository with a GitHub workflow holds besides its build files. */
export const ciFiles = { ".github/workflows/ci.yml": workflow, "test.sh": "exit 0\n", ".gitignore": ".flows\n" }
