import { GitHub } from "@smthrs/integrations"
import { Effect, Redacted } from "effect"
import { FetchHttpClient } from "effect/http"
import { expect, test } from "./devices"
import { step } from "./fixtures"
import { github, pollGitHub } from "./github"
import { me, requires, scratchRepository } from "./target"

// Publish, Update branch and Resync end to end (docs/features/branch-publish.md, rulings GH-6 and GH-11): the real app,
// ChatApi, the branch's machine, the `branch/Publish` and `branch/Update` flows and their resync on Cloudflare, Code
// Storage and GitHub itself. `/new` makes a Smithers-only branch of the scratch repository; a file edited and saved in its
// live editor reaches GitHub only when the person presses Publish, as one commit and a pull request opened as them; after
// main moves on GitHub, Update branch takes it in and the working copy follows, so the file main added opens, takes an
// edit, saves, and Publish again pushes it. It writes to GitHub as the test account, so it runs against a deployment signed in
// as that account, on the scratch repository E2E_ISSUES_REPOSITORY (roninjin10/smithers-github-tests on smithers.sh),
// which the account can write. Main moves, and the run cleans up after itself, as the App installation
// (GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY from the vault's environment wrapper), outside Playwright, so no key or token
// enters a trace.

/** A container's first start may take a while on a cold machine. */
const MACHINE = 240_000

/** The App installation's GitHub REST on the scratch repository, with the SDK's credential scrubbing. */
const asApp = (repository: string) => {
  const [owner, name] = repository.split("/") as [string, string]
  const token = Effect.runPromise(Effect.gen(function* () {
    const app = yield* GitHub.AppAuth.make({ appId: process.env.GITHUB_APP_ID!, privateKey: Redacted.make(process.env.GITHUB_APP_PRIVATE_KEY!) })
    const installation = yield* app.installation(owner, name)
    return (yield* app.installationToken({
      installationId: installation.id,
      repositories: [name],
      permissions: { contents: "write", pull_requests: "write" },
    })).token
  }).pipe(Effect.provide(FetchHttpClient.layer)))
  return (method: GitHub.GitHubClient.RequestMethod, path: string, body?: unknown) =>
    token.then((value) => Effect.runPromise(Effect.gen(function* () {
      const client = yield* GitHub.GitHubClient.make({ token: Redacted.value(value) }, {})
      return yield* client.request(method, `/repos/${repository}${path}`, body)
    }).pipe(Effect.provide(FetchHttpClient.layer))))
}

/** One commit on the default branch adding `path`, as someone pushing on GitHub: its SHA. */
const pushToMain = async (app: ReturnType<typeof asApp>, defaultBranch: string, path: string, text: string) => {
  const head = await app("GET", `/git/ref/heads/${defaultBranch}`) as { object: { sha: string } }
  const base = await app("GET", `/git/commits/${head.object.sha}`) as { tree: { sha: string } }
  const tree = await app("POST", "/git/trees", { base_tree: base.tree.sha, tree: [{ path, mode: "100644", type: "blob", content: text }] }) as { sha: string }
  const commit = await app("POST", "/git/commits", { message: `Branch publish e2e: ${path}`, tree: tree.sha, parents: [head.object.sha] }) as { sha: string }
  await app("PATCH", `/git/refs/heads/${defaultBranch}`, { sha: commit.sha })
  return commit.sha
}

test("publish: a Smithers-only branch reaches GitHub only through Publish, as a pull request by the person; Update branch takes main in", {
  annotation: {
    type: "summary",
    description: "/new, edit and save a file, Publish: the pull request is on GitHub as you; main moves; Update branch takes it in; " +
      "edit the file main added, save, Publish again.",
  },
}, async ({ devices }) => {
  requires("githubScratch", "member", "githubAppKey")
  test.setTimeout(15 * 60_000)
  const repo = scratchRepository()
  const app = asApp(repo)
  const [maya] = await devices.open("Maya")
  const page = maya!.page
  const facts = await github<{ default_branch: string }>(page, `/repos/${repo}`)
  const file = `e2e/publish-${devices.word}.md`
  let number: number | undefined
  let ref: string | undefined
  try {
    const branch = await step("Maya starts a new conversation on the scratch repository with /new", async () => {
      await page.goto(`/${repo}/tree/${facts.default_branch}`)
      await expect(page.getByRole("navigation", { name: "Branch" })).toContainText(facts.default_branch, { timeout: 60_000 })
      await page.getByRole("button", { name: /^Chat\b/ }).click()
      const composer = page.getByRole("textbox", { name: "Message Smithers" })
      await expect(composer).toBeVisible()
      await composer.fill(`/new ${repo}`)
      await composer.press("Enter")
      // The page starts on the default branch's tree, which a plain `/tree/<name>` pattern already matches.
      await expect(page).toHaveURL(new RegExp(`/${repo}/tree/(?!${facts.default_branch}$)[^/]+$`), { timeout: 120_000 })
      const name = decodeURIComponent(new URL(page.url()).pathname.split("/").at(-1)!)
      expect(name).not.toBe(facts.default_branch)
      await expect(page.getByRole("navigation", { name: "Branch" })).toContainText(name, { timeout: 60_000 })
      return name
    })

    await step("Nothing is on GitHub yet", async () => {
      const branches = await github<Array<{ name: string }>>(page, `/repos/${repo}/branches?per_page=100`)
      expect(branches.map((each) => each.name).filter((name) => name.startsWith(branch))).toEqual([])
    })

    await step("Maya writes a file in the live editor and saves it", async () => {
      await page.goto(`/${repo}/tree/${branch}?edit=${file}`)
      // A Markdown file opens in the Markdown editor, whose text is the region's textbox.
      const editor = page.getByRole("region", { name: file }).getByRole("textbox", { name: file })
      await editor.click({ timeout: MACHINE })
      await page.keyboard.type(`Published from Smithers ${devices.word}`)
      await page.getByRole("region", { name: file }).getByRole("button", { name: "Save", exact: true }).click()
      await expect(page.getByRole("region", { name: file }).getByRole("button", { name: "Saved", exact: true })).toBeVisible({ timeout: MACHINE })
    })

    number = await step("Maya presses Publish with a title, and the branch links its pull request", async () => {
      await page.goto(`/${repo}/tree/${branch}`)
      const header = page.getByRole("navigation", { name: "Branch" })
      await header.getByRole("button", { name: "Publish", exact: true }).click()
      await page.getByRole("textbox", { name: "Title" }).fill(`Branch publish e2e ${devices.word}`)
      await page.getByRole("form", { name: "Publish" }).getByRole("button", { name: "Publish", exact: true }).click()
      const link = header.getByRole("link", { name: /^#\d+$/ })
      await expect(link).toBeVisible({ timeout: MACHINE })
      return Number((await link.textContent())!.slice(1))
    })

    const pull = await step("GitHub has the pull request, opened by Maya, holding her file", async () => {
      const found = await pollGitHub(
        () => github<{ user: { login: string }; head: { ref: string; sha: string }; base: { ref: string }; title: string }>(page, `/repos/${repo}/pulls/${number}`),
        (value) => value.head.sha.length === 40,
      )
      expect(found.user.login.toLowerCase()).toBe(me().login.toLowerCase())
      const commit = await github<{ author: { login: string } | null }>(page, `/repos/${repo}/commits/${found.head.sha}`)
      expect(commit.author?.login.toLowerCase()).toBe(me().login.toLowerCase())
      expect([found.base.ref, found.title]).toEqual([facts.default_branch, `Branch publish e2e ${devices.word}`])
      expect(found.head.ref.startsWith(`${branch}-`)).toBe(true)
      const files = await github<Array<{ filename: string }>>(page, `/repos/${repo}/pulls/${number}/files`)
      expect(files.map((each) => each.filename)).toEqual([file])
      ref = found.head.ref
      return found
    })

    const mains = `e2e/base-${devices.word}.md`
    const moved = await step("Main moves on GitHub", () => pushToMain(app, facts.default_branch, mains, "moved\n"))

    await step("Maya presses Update branch, and the branch takes main in", async () => {
      const header = page.getByRole("navigation", { name: "Branch" })
      await header.getByRole("button", { name: "Update branch" }).click()
      await expect(header).toContainText("Updated", { timeout: MACHINE })
      const compared = await pollGitHub(
        () => github<{ behind_by: number; ahead_by: number }>(page, `/repos/${repo}/compare/${moved}...${pull.head.ref}`),
        (value) => value.behind_by === 0,
      )
      expect(compared.ahead_by).toBeGreaterThan(0)
    })

    await step("The working copy follows GitHub's branch: no longer Behind, and no conflict", async () => {
      const header = page.getByRole("navigation", { name: "Branch" })
      await expect(header).not.toContainText("Behind", { timeout: MACHINE })
      await expect(header).not.toContainText("Resyncing")
      await expect(header).not.toContainText("Conflict")
    })

    await step("Maya edits the file main added, and it saves", async () => {
      await page.goto(`/${repo}/tree/${branch}?edit=${mains}`)
      const region = page.getByRole("region", { name: mains })
      const editor = region.getByRole("textbox", { name: mains })
      await expect(editor).toContainText("moved", { timeout: MACHINE })
      await editor.click()
      // Markdown renders the final source newline as a paragraph boundary, not an empty line.
      // End stays in that paragraph; Enter starts the paragraph Maya wants to add.
      await page.keyboard.press("ControlOrMeta+End")
      await page.keyboard.press("Enter")
      await page.keyboard.type(`Edited after Update ${devices.word}`)
      await region.getByRole("button", { name: "Save", exact: true }).click()
      await expect(region.getByRole("button", { name: "Saved", exact: true })).toBeVisible({ timeout: MACHINE })
    })

    await step("Publish again pushes it: GitHub's branch holds main's line and Maya's", async () => {
      await page.goto(`/${repo}/tree/${branch}`)
      const header = page.getByRole("navigation", { name: "Branch" })
      await expect(header.getByRole("link", { name: `#${number}` })).toBeVisible({ timeout: 60_000 })
      await header.getByRole("button", { name: "Publish", exact: true }).click()
      await page.getByRole("form", { name: "Publish" }).getByRole("button", { name: "Publish", exact: true }).click()
      const pushed = await pollGitHub(
        () => github<{ content: string }>(page, `/repos/${repo}/contents/${mains}?ref=${encodeURIComponent(ref!)}`),
        (value) => Buffer.from(value.content, "base64").toString("utf8").includes(`Edited after Update ${devices.word}`),
      )
      expect(Buffer.from(pushed.content, "base64").toString("utf8").trimEnd()).toBe(`moved\n\nEdited after Update ${devices.word}`)
      await expect(header).not.toContainText("Conflict")
      await expect(header).not.toContainText("Couldn't publish")
    })

    await step("Compare lists the branch's commits and its file", async () => {
      await page.getByRole("navigation", { name: "Branch" }).getByRole("link", { name: "Compare" }).click()
      await expect(page.getByRole("region", { name: "Compare" })).toContainText(`Branch publish e2e ${devices.word}`, { timeout: 60_000 })
      await expect(page.getByRole("region", { name: "Compare" })).toContainText(file)
    })
  } finally {
    // The scratch repository keeps nothing of the run but main's commit.
    if (number !== undefined) await app("PATCH", `/pulls/${number}`, { state: "closed" }).catch(() => undefined)
    if (ref !== undefined) await app("DELETE", `/git/refs/heads/${ref}`).catch(() => undefined)
  }
})
