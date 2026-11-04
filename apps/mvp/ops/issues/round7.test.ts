import { describe, expect, test } from "vitest"
import { clean, repositoryCandidates, suspectRegions } from "./scrub.mjs"
import { confirmRepositories } from "./repositories.mjs"
import { yamlQuotedReading } from "./reading.mjs"

const sources = {
  commands: [
    "gh issue list -R nobody/open", "gh pr view --repo nobody/open", "gh release list --repo=nobody/open",
    "gh repo view nobody/open", "gh arbitrary future-command nobody/open", "gh api repos/nobody/open/issues",
    "gh api /repos/nobody/open", 'gh pr list --repo="nobody/open"', "gh pr list -R'nobody/open'", "gh -R nobody/open pr list", "gh api 'repos/nobody/open/issues'",
    "gh:nobody/open", "git@gh:nobody/open", "${{ github.repository }} is nobody/open",
    "x_uses: nobody/open@v1", "reuses: nobody/open@v1", "action: nobody/open@v1", "package: nobody/open#ref",
    "npm i nobody/open", "npm install --save nobody/open#dev", "pnpm add nobody/open", "yarn add nobody/open",
    "npx degit nobody/open", "brew tap nobody/open", '"dep": "nobody/open#ref"',
    "GH_REPO=nobody/open", "GITHUB_REPOSITORY='nobody/open'", 'GH_REPO="nobody/open" gh issue list',
  ],
  routes: [
    ...["organizations", "orgs", "users", "user", "sponsors", "stars", "enterprises", "u", "settings", "marketplace", "search", "topics", "notifications", "login"].map((route) => `https://github.com/${route}/nobody`),
    "https://github.com/@nobody", "https://www.nobody.github.io/open", "https://github.com/codespaces/new/nobody/open",
  ],
  qualifiers: ["github.com", "api.github.com", "gist.github.com", "npm.pkg.github.com"].flatMap((host) =>
    ["user", "org", "owner", "repo", "author"].flatMap((qualifier) => [
      `https://${host}/search?q=${qualifier}:nobody`, `https://${host}/search?q=${qualifier}%3Anobody`,
    ])),
  extensions: ["png", "keys", "gpg", "atom"].map((extension) => `https://github.com/nobody.${extension}`),
  aliases: ["git@github.com-work:nobody/open", "ssh://git@github.com-work/nobody/open", "ssh://git@github.com-work:443/nobody/open",
    ...["work_personal", "personal.local", "seat+one", "équipe"].flatMap((alias) => [`git@github.com-${alias}:nobody/open`, `ssh://git@github.com-${alias}/nobody/open`])],
  malformed: [
    "ssh://git@github.com:22:nobody/hidden", "ssh://git@github.com:nobody:hidden",
    "git@ssh.github.com:443:nobody/hidden", "https://github.com:443:nobody/hidden",
    "https://github.com:4a3/nobody/hidden", "git@[github.com]:443/nobody/hidden",
    "git@ssh.github.com:443/nobody", "https://ghcr.io/v2/nobody/hidden/manifests/latest",
    "https://npm.pkg.github.com/@nobody/hidden", "https://github.com:22:other:nobody:hidden",
  ],
}

describe("round 7 general owner ties", () => {
  for (const [kind, references] of Object.entries(sources)) {
    test.each(references)(`${kind}: %s`, async (source) => {
      for (const reference of [source, encodeURI(source).replace(/:/g, "%3A").replace(/\//g, "%2F")]) {
        const asked: string[] = []
        const repositoryVerdicts = await confirmRepositories([{ body: reference }, { body: "nobody/another" }], {
          cacheFile: null, fetch: async (url: string) => { asked.push(url.split("/repos/")[1]!); return new Response(null, { status: 404 }) },
        })
        expect(repositoryVerdicts.watched).toContain("nobody")
        expect(asked).toContain("nobody/another")
        expect(clean("nobody/another", { repositoryVerdicts })).toMatchObject({ ok: true, text: "[repo]" })
      }
    })
  }

  test.each(["organizations", "sponsors", "user", "search", "settings"])("reserved route never becomes owner: %s", (route) => {
    const { watched } = repositoryCandidates(`https://github.com/${route}/nobody`)
    expect(watched).toContain("nobody")
    expect(watched).not.toContain(route)
  })
  test.each(["user", "org", "owner", "repo"])("search qualifier is not an account: %s", (qualifier) => {
    const { watched } = repositoryCandidates(`https://api.github.com/search?q=${qualifier}:nobody`)
    expect(watched).toContain("nobody")
    expect(watched).not.toContain(qualifier)
  })

  test.each(["the", "fix", "lands", "and", "work", "then", "issue", "test", "Ship", "VibeLang"])("a parsed owner cannot absorb prose word %s", async (word) => {
    const source = `ssh://git@ssh.github.com:443/ ${word} @nobody/hidden`
    const { watched, candidates } = repositoryCandidates(source)
    expect(watched).not.toContain(word.toLowerCase())
    expect(candidates).toEqual([])
    const repositoryVerdicts = await confirmRepositories([source], { cacheFile: null, fetch: async () => { throw new Error("unexpected request") } })
    expect(clean(source, { repositoryVerdicts }).text).toBe(`[repo] ${word} @nobody/hidden`)
  })

  test("untied prose preserves its original text with zero requests", async () => {
    const text = "node/bun ts/tsx and/or TCP/IP src/path/file.ts @scope/pkg origin/main feature/x"
    const repositoryVerdicts = await confirmRepositories([text], { cacheFile: null, fetch: async () => { throw new Error("unexpected request") } })
    expect(repositoryVerdicts.requests).toBe(0)
    expect(clean(text, { repositoryVerdicts })).toMatchObject({ ok: true, text })
  })
  test("non-GitHub SSH hosts retain main's redaction behavior", async () => {
    const text = "ssh://host/path and git://host/path"
    const repositoryVerdicts = await confirmRepositories([text], { cacheFile: null, fetch: async () => { throw new Error("unexpected request") } })
    expect(clean(text, { repositoryVerdicts })).toMatchObject({ ok: true, text: "ssh:[repo] and git:[repo]" })
  })
  test("prose boundaries never hide a spaced repository name", () => {
    expect(repositoryCandidates("https://github.com/nobody/ work").candidates.map((ref: { name: string }) => ref.name)).toContain("nobody/work")
  })
})


describe("round 7 configuration credential boundaries", () => {
  test.each([
    '\"password\": \"nobody/open#ref\"', '\"token\": \"nobody/open#ref\"',
    'password: nobody/open#ref', 'export password=nobody/open#ref',
    '\"api_key\": \"gh pr list -R nobody/open\"',
    'credentials: npm install nobody/open',
  ])("serialized credential configuration is opaque: %s", async (source) => {
    const repositoryVerdicts = await confirmRepositories([{ body: source }, { body: "@nobody/another" }], {
      cacheFile: null, fetch: async () => { throw new Error("credential-derived request") },
    })
    expect(repositoryVerdicts.requests).toBe(0)
    expect(repositoryVerdicts.watched).not.toContain("nobody")
    expect(clean("@nobody/another", { repositoryVerdicts })).toMatchObject({ ok: true, text: "@nobody/another" })
  })
})


describe("round 7 structural configuration", () => {
  test.each(["GH_REPO", "GITHUB_REPOSITORY"])("a parsed %s environment value ties its owner", (key) => {
    expect(repositoryCandidates({ env: { [key]: "nobody/open" } }).watched).toContain("nobody")
  })
  test.each(["dependencies", "devDependencies", "optionalDependencies"])("a parsed %s value retains its tool-spec meaning", async (key) => {
    const { watched, candidates } = repositoryCandidates({ [key]: { dep: "nobody/open#ref" } })
    expect(watched).toContain("nobody")
    expect(candidates.map((ref: { name: string }) => ref.name)).toContain("nobody/open")
  })
  test.each(["account/organizations", "user/repos", "settings/sponsors"])("a reserved segment is never an account: %s", (path) => {
    const { watched } = repositoryCandidates(`https://github.com/${path}`)
    for (const route of path.split("/")) expect(watched).not.toContain(route)
  })
})


describe("round 7 Astra class regressions", () => {
  test("dotted path segments are not URL authorities", () => {
    expect(repositoryCandidates("https://github.com/stranger/open/lib.js / nobody/hidden").candidates.map((ref: { name: string }) => ref.name)).toContain("nobody/hidden")
  })
  test.each([
    'npm --registry "https://registry.example/?a=1&b=2" install nobody/open',
    "gh --template 'some; value' pr list -R nobody/open",
    'pnpm --filter "web|tools" add nobody/open',
    'gh --search and pr list -R nobody/open',
    "npm --silent install nobody/open", "pnpm --filter web add nobody/open", "yarn --cwd web add nobody/open",
    "npm --registry https://registry.example install nobody/open", "npx --yes degit nobody/open", "brew --debug tap nobody/open",
    "https://github.com/search?q=-author:nobody", "https://api.github.com/search?q=-user%3Anobody",
  ])("ties through grammatical modifiers: %s", async (source) => {
    const repositoryVerdicts = await confirmRepositories([{ body: source }, { body: "nobody/hidden" }], { cacheFile: null, fetch: async () => new Response(null, { status: 404 }) })
    expect(repositoryVerdicts.watched).toContain("nobody")
    expect(clean("nobody/hidden", { repositoryVerdicts })).toMatchObject({ ok: true, text: "[repo]" })
  })
  test("shell comments do not turn ordinary prose into arguments", async () => {
    const text = "gh pr list # node/bun and ts/tsx"
    const repositoryVerdicts = await confirmRepositories([text], { cacheFile: null, fetch: async () => { throw new Error("unexpected request") } })
    expect(clean(text, { repositoryVerdicts })).toMatchObject({ ok: true, text })
  })
  test.each(["with", "beside", "near", "plus", "through", "without", "concerning"])("authority boundaries preserve any following prose word: %s", async (word) => {
    for (const gap of [" ", "  ", "\u00a0"]) {
      const text = `ssh://git@ssh.github.com:443/${gap}${word} @nobody/hidden and @${word}/value`
      const repositoryVerdicts = await confirmRepositories([text], { cacheFile: null, fetch: async () => { throw new Error("unexpected request") } })
      expect(repositoryVerdicts.requests).toBe(0)
      expect(repositoryVerdicts.watched).not.toContain(word)
      expect(clean(text, { repositoryVerdicts })).toMatchObject({ ok: true, text: `[repo]${gap}${word} @nobody/hidden and @${word}/value` })
    }
  })
})


describe("round 7 second Astra regressions", () => {
  test.each(["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"])("%s retain ref-less repository values", async (key) => {
    const repositoryVerdicts = await confirmRepositories([{ [key]: { dep: "nobody/open" } }, { body: "nobody/hidden" }], { cacheFile: null, fetch: async () => new Response(null, { status: 404 }) })
    expect(repositoryVerdicts.watched).toContain("nobody")
    expect(clean("nobody/hidden", { repositoryVerdicts })).toMatchObject({ ok: true, text: "[repo]" })
  })
  test.each(["compare/ token:open", "head= token:open", "compare/\ttoken:open"])("cross-reference whitespace is not configuration: %s", async (cross) => {
    const text = `see smithersai/vibelang and ${cross}`
    const repositoryVerdicts = await confirmRepositories([text], { cacheFile: null, publicRepos: ["smithersai/vibelang", "token/open"], fetch: async () => { throw new Error("unexpected request") } })
    expect(clean(text, { repositoryVerdicts })).toMatchObject({ ok: true, text })
  })
  test.each(["bad", "4a3", "443:bad"])("malformed port %s cannot absorb following prose", async (port) => {
    const text = `ssh://git@github.com:${port}/ near @nobody/hidden and @near/value`
    const repositoryVerdicts = await confirmRepositories([text], { cacheFile: null, fetch: async () => { throw new Error("unexpected request") } })
    expect(repositoryVerdicts.requests).toBe(0)
    expect(repositoryVerdicts.watched).not.toContain("near")
    expect(clean(text, { repositoryVerdicts })).toMatchObject({ ok: true, text: "[repo] near @nobody/hidden and @near/value" })
  })
})

describe("round 7 shell and configuration contexts", () => {
  test.each([">", ">>", "<", "<>", ">|", "2>", "3>>", "2>&", "4<&", "&>", "&>>", "<<", "<<-", "<<<"])("shell redirection %s does not supply a repository argument", async (operator) => {
    for (const gap of ["", " "]) for (const filename of ["node/bun", '"node/bun"', "'node/bun'"]) {
      const source = `gh issue list ${operator}${gap}${filename}`
      const repositoryVerdicts = await confirmRepositories([source], { cacheFile: null, fetch: async () => { throw new Error("filename became repository") } })
      expect(repositoryVerdicts.requests).toBe(0)
      expect(repositoryVerdicts.watched).not.toContain("node")
      expect(clean(source, { repositoryVerdicts })).toMatchObject({ ok: true, text: source })
    }
  })
  test.each(["> node/bun gh repo view nobody/open", "gh issue list > node/bun nobody/open", "gh issue list nobody/open > node/bun"])("redirections preserve real arguments: %s", (source) => {
    expect(repositoryCandidates(source).watched).toContain("nobody")
    expect(repositoryCandidates(source).watched).not.toContain("node")
  })
  test.each(["-----BEGIN PRIVATE KEY-----\ndependencies:\n  pkg: nobody/open\n-----END PRIVATE KEY-----", "-----BEGIN PRIVATE KEY-----\ndependencies:\n  pkg: nobody/open"])("protected credential regions cannot open a dependency scope", async (source) => {
    const repositoryVerdicts = await confirmRepositories([source, "@nobody/hidden"], { cacheFile: null, fetch: async () => { throw new Error("credential region became configuration") } })
    expect(repositoryVerdicts.requests).toBe(0)
    expect(repositoryVerdicts.watched).not.toContain("nobody")
    expect(clean("@nobody/hidden", { repositoryVerdicts })).toMatchObject({ ok: true, text: "@nobody/hidden" })
  })
  test.each(["? token\n: nobody/open", "? url\n: https://github.com/nobody)"])("explicit keys preserve credential and literal URL boundaries: %s", async (source) => {
    const repositoryVerdicts = await confirmRepositories([source, "@nobody/hidden"], { cacheFile: null, fetch: async () => { throw new Error("explicit key lost field context") } })
    expect(repositoryVerdicts.requests).toBe(0)
    expect(repositoryVerdicts.watched).not.toContain("nobody")
  })
  test.each(['dependencies:\n  ? p\n  : "nobody/open"', "dependencies:\n  ? p : nobody/open", "dependencies:\n  ? p\n  :\n    nobody/open", "? dependencies\n:\n  pkg: nobody/open"])("explicit mapping keys preserve dependency ancestry: %s", async (source) => {
    const repositoryVerdicts = await confirmRepositories([source, "nobody/hidden"], { cacheFile: null, fetch: async () => new Response(null, { status: 404 }) })
    expect(repositoryVerdicts.watched).toContain("nobody")
    expect(clean("nobody/hidden", { repositoryVerdicts })).toMatchObject({ ok: true, text: "[repo]" })
    const publicVerdicts = await confirmRepositories([source], { cacheFile: null, publicRepos: ["nobody/open"], fetch: async () => { throw new Error("explicit public dependency was reinterpreted") } })
    expect(publicVerdicts.requests).toBe(0)
    expect(clean(source, { repositoryVerdicts: publicVerdicts })).toMatchObject({ ok: true, text: source })
  })
  test.each(["dependencies:\n  pkg: |\n    nobody/open # literal text", "dependencies:\n  pkg: >-\n    nobody/open # literal text", "dependencies:\n  pkg: |\n    nobody/open\n    # literal text", "dependencies:\n  pkg: |\n    nobody/open\n    extra"])("block scalar content cannot become a truncated dependency: %s", async (source) => {
    const repositoryVerdicts = await confirmRepositories([source, "@nobody/hidden"], { cacheFile: null, fetch: async () => { throw new Error("literal block content removed") } })
    expect(repositoryVerdicts.requests).toBe(1)
    expect(repositoryVerdicts.watched).not.toContain("nobody")
  })
  test("enclosing literal YAML owns nested JSON escapes", async () => {
    const source = String.raw`dependencies:
  pkg: '{"repo":"stranger/\u006fpen"}'`
    const repositoryVerdicts = await confirmRepositories([source, "gh repo view stranger/u006fpen"], { cacheFile: null, publicRepos: ["stranger/open"], fetch: async () => new Response(null, { status: 404 }) })
    const result = clean(source, { repositoryVerdicts })
    expect(result.ok && result.text === source).toBe(false)
  })
  test.each(["\"url\": \"ssh://git@github.com:nobody/hidden.git\"\n\"other\": \"nobody/hidden\"", "\"dep\": \"nobody/hidden\" and nobody/hidden", "GITHUB_REPOSITORY: nobody/hidden and nobody/hidden", "x_uses: nobody/hidden@v1 and nobody/hidden", "reuses: nobody/hidden@v1 and nobody/hidden", "action: nobody/hidden@v1 and nobody/hidden"])("configuration snippets retain their original owner ties: %s", async (source) => {
    const repositoryVerdicts = await confirmRepositories([source], { cacheFile: null, fetch: async () => new Response(null, { status: 404 }) })
    expect(repositoryVerdicts.watched).toContain("nobody")
    expect(clean("nobody/hidden", { repositoryVerdicts })).toMatchObject({ ok: true, text: "[repo]" })
  })
  test.each(["dependencies:\n  x: nobody/open extra", "dependencies:\n  x: nobody/open\n    extra", "dependencies:\n  x: nobody/open,extra", "{dependencies: {x: nobody/open extra}}", "dependencies:\n  x: gh repo view nobody/open", "dependencies:\n  x: nobody/open gh repo view nobody/other", "dependencies:\n  x: nobody/open\n    gh repo view nobody/other"])("plain configuration scalars require their complete value: %s", async (source) => {
    const repositoryVerdicts = await confirmRepositories([source, "@nobody/hidden"], { cacheFile: null, fetch: async () => { throw new Error("plain scalar truncated") } })
    expect(repositoryVerdicts.requests).toBe(source.includes("open,extra") ? 0 : new Set(source.match(/nobody\/(?:open|other)/g)).size)
    expect(repositoryVerdicts.watched).not.toContain("nobody")
    expect(clean("@nobody/hidden", { repositoryVerdicts })).toMatchObject({ ok: true, text: "@nobody/hidden" })
  })
  test("normalized field keys and opaque URL fields retain literal boundaries", async () => {
    const wide = (text: string) => text.replace(/[!-~]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0))
    for (const source of [wide(JSON.stringify({ url: "https://github.com/nobody)" })), { [wide("url")]: wide("https://github.com/nobody)") }, { token: { url: "https://github.com/?q=org:nobody)" } }]) {
      const repositoryVerdicts = await confirmRepositories([source, "@nobody/hidden"], { cacheFile: null, fetch: async () => { throw new Error("field context lost its literal boundary") } })
      expect(repositoryVerdicts.requests).toBe(0)
      expect(repositoryVerdicts.watched).not.toContain("nobody")
      expect(clean("@nobody/hidden", { repositoryVerdicts })).toMatchObject({ ok: true, text: "@nobody/hidden" })
    }
  })
  test.each(["github.com:bad", "[github.com]", "github.com:22:bad", "ssh.github.com:4a3"])("malformed literal authorities retain complete owner segments: %s", async (host) => {
    const source = `gh api 'https://${host}/nobody)tail'`
    const repositoryVerdicts = await confirmRepositories([source, "@nobody/hidden"], { cacheFile: null, fetch: async () => { throw new Error("malformed literal shortened its owner") } })
    expect(repositoryVerdicts.requests).toBe(0)
    expect(repositoryVerdicts.watched).not.toContain("nobody")
    expect(clean("@nobody/hidden", { repositoryVerdicts })).toMatchObject({ ok: true, text: "@nobody/hidden" })
  })
  test.each(["nobody/open)", "nobody/open*", "nobody/open`tail"])("configuration requires a complete repository specification: %s", async (value) => {
    for (const source of [{ dependencies: { x: value } }, JSON.stringify({ dependencies: { x: value } }), `dependencies:\n  x: '${value}'`]) {
      const repositoryVerdicts = await confirmRepositories([source, "@nobody/hidden"], { cacheFile: null, fetch: async () => { throw new Error("configuration shortened its specification") } })
      expect(repositoryVerdicts.requests).toBe(0)
      expect(repositoryVerdicts.watched).not.toContain("nobody")
      expect(clean("@nobody/hidden", { repositoryVerdicts })).toMatchObject({ ok: true, text: "@nobody/hidden" })
    }
  })
  test.each(["nobody*", "nobody`tail", "nobody)tail", '"nobody"tail'])("literal URL delimiters cannot authorize an account prefix: %s", async (account) => {
    for (const path of [`search?q=user:${account}`, account]) {
      const source = `gh api 'https://github.com/${path}'`
      const repositoryVerdicts = await confirmRepositories([source, "@nobody/hidden"], { cacheFile: null, fetch: async () => { throw new Error("literal URL shortened to account prefix") } })
      expect(repositoryVerdicts.requests).toBe(0)
      expect(repositoryVerdicts.watched).not.toContain("nobody")
      expect(clean("@nobody/hidden", { repositoryVerdicts })).toMatchObject({ ok: true, text: "@nobody/hidden" })
    }
  })
  test("declared URL fields retain literal names during discovery and cleaning", async () => {
    const url = "https://github.com/nobody/_name"
    for (const source of [{ url }, JSON.stringify({ url }), `url: ${url}`]) {
      const repositoryVerdicts = await confirmRepositories([source], { cacheFile: null, publicRepos: ["nobody/_name"], fetch: async () => { throw new Error("declared URL interpreted as markup") } })
      expect(repositoryVerdicts.requests).toBe(0)
      expect(clean(url, { repositoryVerdicts, urlField: true })).toMatchObject({ ok: true, text: url })
      const text = typeof source === "string" ? source : JSON.stringify(source)
      expect(clean(text, { repositoryVerdicts })).toMatchObject({ ok: true, text })
    }
  })
  test.each(["#ref", "@ref"])("parsed and serialized dependency specifications preserve literal names: %s", async (ref) => {
    const object = { dep: `nobody/_name${ref}` }, text = JSON.stringify(object)
    for (const source of [object, text]) {
      const repositoryVerdicts = await confirmRepositories([source], { cacheFile: null, publicRepos: ["nobody/_name"], fetch: async () => { throw new Error("dependency specification became markup") } })
      expect(repositoryVerdicts.requests).toBe(0)
      expect(clean(text, { repositoryVerdicts })).toMatchObject({ ok: true, text })
    }
  })
  test.each(["GH_REPO=nobody/_name", "GITHUB_REPOSITORY=nobody/_name", "dependencies:\n  dep: nobody/_name", "dependencies:\n  dep: |\n    nobody/_name", "gh api https://github.com/nobody/_name#ref"])("unquoted repository values retain literal spans: %s", async (source) => {
    const repositoryVerdicts = await confirmRepositories([source], { cacheFile: null, publicRepos: ["nobody/_name"], fetch: async () => { throw new Error("unquoted value became markup") } })
    expect(repositoryVerdicts.requests).toBe(0)
    expect(clean(source, { repositoryVerdicts })).toMatchObject({ ok: true, text: source })
  })
  test("parsed dependency values retain literal context", async () => {
    const source = { dependencies: { dep: "nobody/_name" } }
    const repositoryVerdicts = await confirmRepositories([source], { cacheFile: null, publicRepos: ["nobody/_name"], fetch: async () => { throw new Error("parsed dependency became markup") } })
    expect(repositoryVerdicts.requests).toBe(0)
    expect(clean(JSON.stringify(source), { repositoryVerdicts })).toMatchObject({ ok: true, text: JSON.stringify(source) })
  })
  test("learned private names cannot reinterpret a public literal", async () => {
    const source = 'gh api "https://github.com/nobody/_name"'
    const repositoryVerdicts = await confirmRepositories([source, "gh api https://github.com/nobody/name"], { cacheFile: null, publicRepos: ["nobody/_name"], fetch: async () => new Response(null, { status: 404 }) })
    expect(clean(source, { repositoryVerdicts })).toMatchObject({ ok: true, text: source })
  })
  test.each(["user", "org", "owner", "repo"])("literal %s qualifiers never acquire markup account names", async (qualifier) => {
    const source = `gh api 'https://github.com/search?q=${qualifier}:_nobody_'`
    const repositoryVerdicts = await confirmRepositories([source, "@nobody/hidden"], { cacheFile: null, fetch: async () => { throw new Error("literal qualifier invented an account") } })
    expect(repositoryVerdicts.requests).toBe(0)
    expect(repositoryVerdicts.watched).not.toContain("nobody")
    expect(clean("@nobody/hidden", { repositoryVerdicts })).toMatchObject({ ok: true, text: "@nobody/hidden" })
  })
  test.each(['--body no"body"/probe', '--body=no"body"/probe', '-b no"body"/probe', '-bno"body"/probe', '-b=no"body"/probe'])("secret command operands stay opaque: %s", async (operand) => {
    const source = `gh secret set DEMO ${operand}`
    const repositoryVerdicts = await confirmRepositories([source, "@nobody/hidden"], { cacheFile: null, publicRepos: ["nobody/probe"], fetch: async () => { throw new Error("secret operand requested") } })
    expect(repositoryVerdicts.requests).toBe(0)
    expect(repositoryVerdicts.watched).not.toContain("nobody")
    expect(clean(source, { repositoryVerdicts }).text).not.toBe(source)
    expect(clean("@nobody/hidden", { repositoryVerdicts })).toMatchObject({ ok: true, text: "@nobody/hidden" })
    const ordinary = `gh variable set DEMO ${operand}`
    expect(repositoryCandidates(ordinary).watched).toContain("nobody")
  })
  test.each([String.raw`gh api "https://github.com/nobody\_name"`, String.raw`gh api 'https://github.com/nobody/_name'`, String.raw`GH_REPO="nobody/_name"`])("shell literal names never acquire markup identities: %s", async (source) => {
    const repositoryVerdicts = await confirmRepositories([source], { cacheFile: null, publicRepos: ["nobody/_name"], fetch: async () => { throw new Error("shell literal interpreted as markup") } })
    expect(repositoryVerdicts.requests).toBe(0)
    expect(clean(source, { repositoryVerdicts })).toMatchObject({ ok: true, text: source })
  })
  test.each([
    [String.raw`gh api https://github.com/nobody\open/readme`, "nobodyopen/readme"],
    [String.raw`gh api 'https://github.com/nobody\open/readme'`, "nobody/open"],
    [String.raw`gh api "https://github.com/nobody\\open/readme"`, "nobody/open"],
    [String.raw`GH_REPO="nobody\name"`, "nobody/name"],
    [String.raw`GH_REPO="nobody\\name"`, "nobody/name"],
  ])("shell quote context retains the exact public identity: %s", async (source, repository) => {
    const publicRepos = repository === "nobody/open" ? [repository, "open/readme"] : [repository]
    const repositoryVerdicts = await confirmRepositories([source], { cacheFile: null, publicRepos, fetch: async () => { throw new Error("shell quote context fabricated a repository") } })
    expect(repositoryVerdicts.requests).toBe(0)
    expect(clean(source, { repositoryVerdicts })).toMatchObject({ ok: true, text: source })
  })
  test.each(["open", "name", "xray", "unit", "123", "_name"])("double-quoted shell backslash before %s keeps repository identity", async (name) => {
    const source = `gh api "https://github.com/nobody\\${name}/readme"`
    const asked: string[] = []
    const repositoryVerdicts = await confirmRepositories([source, "nobody/hidden"], { cacheFile: null, publicRepos: [`nobody${name}/readme`], fetch: async (url: string) => { asked.push(new URL(url).pathname); return new Response(null, { status: 404 }) } })
    expect(repositoryVerdicts.watched).toContain("nobody")
    expect(asked).toContain(`/repos/nobody/${name}`)
    expect(asked).not.toContain(`/repos/nobody${name}/readme`)
    expect(clean(source, { repositoryVerdicts }).text).not.toBe(source)
    expect(clean("nobody/hidden", { repositoryVerdicts })).toMatchObject({ ok: true, text: "[repo]" })
    // A leading underscore also has the importer's established Markdown reading. Keep that
    // privacy control above; exact-public controls use names without that separate ambiguity.
    if (name !== "_name") {
      const publicVerdicts = await confirmRepositories([source], { cacheFile: null, publicRepos: [`nobody/${name}`, `${name}/readme`], fetch: async () => { throw new Error("double quote changed identity") } })
      expect(clean(source, { repositoryVerdicts: publicVerdicts })).toMatchObject({ ok: true, text: source })
    }
  })
  test.each(["{ [ :"])("block content %s cannot consume the following mapping", async (content) => {
    for (const indicator of ["|", ">"]) {
      const source = `notes: ${indicator}\n  ${content}\ndependencies:\n  dep: "zed/hide"`
      const repositoryVerdicts = await confirmRepositories([source, "zed/another"], { cacheFile: null, fetch: async () => new Response(null, { status: 404 }) })
      expect(repositoryVerdicts.watched).toContain("zed")
      expect(clean("zed/another", { repositoryVerdicts })).toMatchObject({ ok: true, text: "[repo]" })
    }
  })
  test.each(["|", "|-", "|+", "|2", ">", ">-", ">+", ">2"])("block scalar %s keeps inner label-looking text literal", async (indicator) => {
    for (const boundary of ["\n", "\r", "\r\n"]) {
      const source = `notes: ${indicator}${boundary}  message: "stranger/\\x6fpen"${boundary}body: retained`
      const asked: string[] = []
      const repositoryVerdicts = await confirmRepositories([source, "https://github.com/stranger"], { cacheFile: null, publicRepos: ["stranger/open"], fetch: async (url: string) => { asked.push(new URL(url).pathname); return new Response(null, { status: 404 }) } })
      expect(asked).toEqual(["/repos/stranger/x6fpen"])
      const result = clean(source, { repositoryVerdicts })
      expect(result.ok).toBe(true)
      expect(result.text).not.toContain("x6fpen")
      expect(result.text).toContain("body: retained")
      const publicVerdicts = await confirmRepositories([source, "https://github.com/stranger"], { cacheFile: null, publicRepos: ["stranger/x6fpen"], fetch: async () => { throw new Error("block text decoded as quoted YAML") } })
      expect(clean(source, { repositoryVerdicts: publicVerdicts })).toMatchObject({ ok: true, text: source })
    }
  })
  test.each(["\n", "\r", "\r\n"])("configuration scopes preserve physical line boundary %j", async (boundary) => {
    for (const first of ["\n", "\r", "\r\n"]) for (const depth of [0, 1]) {
      const source = `${"- ".repeat(depth)}dependencies:${first}${" ".repeat(depth * 2 + 2)}package: safe/open${boundary}${" ".repeat(depth * 2)}password: zed/hide`
      const repositoryVerdicts = await confirmRepositories([source, "@zed/another"], { cacheFile: null, publicRepos: ["safe/open"], fetch: async () => { throw new Error("credential sibling requested") } })
      expect(repositoryVerdicts.requests).toBe(0)
      expect(repositoryVerdicts.watched).not.toContain("zed")
      expect(clean("@zed/another", { repositoryVerdicts })).toMatchObject({ ok: true, text: "@zed/another" })
    }
    for (const indicator of ["|", ">-"]) {
      const source = `dependencies:${boundary}  dep: ${indicator}${boundary}    zed/hide${boundary}body: retained`
      const repositoryVerdicts = await confirmRepositories([source], { cacheFile: null, fetch: async () => new Response(null, { status: 404 }) })
      expect(repositoryVerdicts.watched).toContain("zed")
      expect(clean(source, { repositoryVerdicts }).text).toContain("body: retained")
    }
  })
  test.each(["\n\n", "\r\n\r\n", "\n# comment\n", "\n \t\n", " \\\n\n"])("command continuation stops at physical gaps: %s", async (gap) => {
    for (const prose of ["node/bun", "ts/tsx", "and/or", "TCP/IP", "src/file.ts", "@scope/pkg", "origin/main", "feature/x"]) {
      const source = `gh issue list${gap}${prose}`
      const repositoryVerdicts = await confirmRepositories([source], { cacheFile: null, fetch: async () => { throw new Error("separate prose requested") } })
      expect(repositoryVerdicts.requests).toBe(0)
      expect(clean(source, { repositoryVerdicts })).toMatchObject({ ok: true, text: source })
    }
    expect(repositoryCandidates("gh issue list\n  nobody/open").watched).toContain("nobody")
  })
  test("a sequence mapping ends dependency scope before ordinary prose siblings", async () => {
    const source = "- dependencies:\n    package: stranger/open\n  body: node/bun"
    const repositoryVerdicts = await confirmRepositories([source], { cacheFile: null, publicRepos: ["stranger/open"], fetch: async () => { throw new Error("prose sibling requested") } })
    expect(repositoryVerdicts.requests).toBe(0)
    expect(clean(source, { repositoryVerdicts })).toMatchObject({ ok: true, text: source })
  })
  test.each(["\\/", "\\x2f", "\\u002F", "\\U0000002F"])("YAML escape %s has one confirmed identity and source span", async (escape) => {
    const source = `dependencies:\n  dep: "nobody${escape}hidden"\nbody: retained`
    const asked: string[] = []
    const repositoryVerdicts = await confirmRepositories([source], { cacheFile: null, publicRepos: ["nobody/x2fhidden", "nobody/u002Fhidden", "nobody/U0000002Fhidden"], fetch: async (url: string) => { asked.push(new URL(url).pathname); return new Response(null, { status: 404 }) } })
    expect(asked).toEqual(["/repos/nobody/hidden"])
    const result = clean(source, { repositoryVerdicts })
    expect(result.ok).toBe(true)
    expect(result.text).toContain("[repo]")
    expect(result.text).toContain("\nbody: retained")
    const publicVerdicts = await confirmRepositories([source], { cacheFile: null, publicRepos: ["nobody/hidden"], fetch: async () => { throw new Error("YAML syntax fabricated another identity") } })
    expect(publicVerdicts.requests).toBe(0)
    expect(clean(source, { repositoryVerdicts: publicVerdicts })).toMatchObject({ ok: true, text: source })
  })
  test.each(['"dependen\\x63ies":\n  dep: nobody/hidden', '"dependen\\U00000063ies":\n  dep: nobody/hidden', "- dependencies:\n    dep: nobody/hidden", "- - dependencies:\n      dep: nobody/hidden", '- !!map dependencies:\n    dep: nobody/hidden'])("YAML key and sequence syntax retains dependency context: %s", async (source) => {
    for (const encode of [(s: string) => s, encodeURIComponent, (s: string) => s.replace(/[!-~]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 0xfee0))]) {
      const text = encode(source), repositoryVerdicts = await confirmRepositories([text], { cacheFile: null, fetch: async () => new Response(null, { status: 404 }) })
      expect(repositoryVerdicts.watched).toContain("nobody")
      expect(clean(text, { repositoryVerdicts }).text).toContain("[repo]")
    }
  })
  test.each(["\\x74oken", "\\u0074oken", "\\U00000074oken"])("escaped YAML credential key %s stays opaque", async (key) => {
    const source = `"${key}": "nobody/open"`
    const repositoryVerdicts = await confirmRepositories([source, "@nobody/hidden"], { cacheFile: null, fetch: async () => { throw new Error("credential payload requested") } })
    expect(repositoryVerdicts.requests).toBe(0)
    expect(repositoryVerdicts.watched).not.toContain("nobody")
    expect(clean("@nobody/hidden", { repositoryVerdicts })).toMatchObject({ ok: true, text: "@nobody/hidden" })
  })
  test("YAML quoted scalar decoding retains complete escape and folding source ranges", () => {
    const source = String.raw`"nobody\x2Fhidden"`, decoded = yamlQuotedReading(source)!
    expect(decoded.text).toBe("nobody/hidden")
    expect(source.slice(decoded.from[6], decoded.to[6])).toBe(String.raw`\x2F`)
    expect(yamlQuotedReading(String.raw`"\0\a\b\t\n\v\f\r\e\ \"\/\\\N\_\L\P"`)?.text).toBe('\0\x07\b\t\n\v\f\r\x1b "/\\\u0085\u00a0\u2028\u2029')
    expect(yamlQuotedReading('"nobo\\\n  dy/hidden"')?.text).toBe("nobody/hidden")
    expect(yamlQuotedReading('"one\n  two\n\n  three"')?.text).toBe("one two\nthree")
    expect(yamlQuotedReading("'one''s' ".trim())?.text).toBe("one's")
    expect(yamlQuotedReading(String.raw`"\xzz"`)).toBeUndefined()
    expect(yamlQuotedReading(String.raw`"\U00110000"`)).toBeUndefined()
  })
  test.each([
    ...["&repository", "!!str", "!", "!local", "!e!string", "!<tag:yaml.org,2002:str>", "&repository !!str", "!!str &repository"].map((properties) => `dependencies:\n  dep: ${properties} nobody/open`),
    "dependencies: &deps\n  dep: nobody/open", "dependencies: !!map\n  dep: nobody/open",
    "dependencies:\n  &repository dep: nobody/open",
    '!!map &deps dependencies:\n  !!str "dep": nobody/open',
    "dependencies:\n  dep: &repository !!str >-\n    nobody/open",
  ])("node properties retain dependency scalar identity: %s", async (source) => {
    for (const encode of [(s: string) => s, encodeURIComponent, (s: string) => s.replace(/[!-~]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 0xfee0))]) {
      const text = encode(source), repositoryVerdicts = await confirmRepositories([text, "nobody/hidden"], { cacheFile: null, fetch: async () => new Response(null, { status: 404 }) })
      expect(repositoryVerdicts.watched).toContain("nobody")
      expect(clean(text, { repositoryVerdicts }).text).not.toContain("nobody/open")
      expect(clean("nobody/hidden", { repositoryVerdicts })).toMatchObject({ ok: true, text: "[repo]" })
      const publicText = encode(source.replace("nobody/open", "stranger/open"))
      const publicVerdicts = await confirmRepositories([publicText], { cacheFile: null, publicRepos: ["stranger/open"], fetch: async () => { throw new Error("node properties fabricated an identity") } })
      expect(publicVerdicts.requests).toBe(0)
      expect(clean(publicText, { repositoryVerdicts: publicVerdicts })).toMatchObject({ ok: true, text: publicText })
    }
  })
  test.each(["nobody_suffix", "nobody.suffix", "nobody&#95;suffix", "nobody%5Fsuffix", "nobody&lowbar;suffix", "nobody&notfoo"])("qualifier values cannot tie an invalid account prefix: %s", async (value) => {
    // Retained property counterexample: seed 20261104, path 3:0:0:0, fullwidth user:nobody_suffix.
    for (const kind of ["user", "org", "owner", "repo"]) for (const encode of [(s: string) => s, encodeURIComponent, (s: string) => s.replace(/[!-~]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 0xfee0))]) {
      const source = encode(`https://github.com/search?q=${kind}:${value}`)
      const repositoryVerdicts = await confirmRepositories([source, "@nobody/hidden"], { cacheFile: null, fetch: async () => { throw new Error("invalid qualifier prefix requested") } })
      expect(repositoryVerdicts.requests).toBe(0)
      expect(repositoryVerdicts.watched).not.toContain("nobody")
      expect(repositoryVerdicts.watched).not.toContain(kind)
      expect(clean("@nobody/hidden", { repositoryVerdicts }).text).toBe("@nobody/hidden")
    }
  })
  test.each(['user:"nobody"', 'repo:"nobody/open"', "user:nobody&not=extra", "repo:nobody/open"])("complete qualifier values retain their account: %s", (value) => {
    expect(repositoryCandidates(`https://github.com/search?q=${value}`).watched).toContain("nobody")
  })
  test.each([
    'gh api --header "head=X-Session-Id: syntheticvalue"', 'gh api -H "head=X-Session-Id: syntheticvalue"',
    "gh api --header 'base=X-Session-Id: syntheticvalue'",
  ])("detached option data retains its credential context: %s", async (source) => {
    for (const text of [source, encodeURIComponent(source), source.replace(/[!-~]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 0xfee0))]) {
      const repositoryVerdicts = await confirmRepositories([text], { cacheFile: null, fetch: async () => { throw new Error("detached data disclosed in a repository request") } })
      expect(repositoryVerdicts.requests).toBe(0)
      expect([...repositoryVerdicts.byRepository]).toEqual([])
    }
  })
  test.each([
    "gh issue create -tnobody/open", "gh issue view -wRnobody/open 1", "gh issue create -wtnobody/open",
    "gh release create tag -dtNobody/open", "gh repo edit -dnobody/open", "gh pr checkout -fRnobody/open",
    "gh auth setup-git -fhnobody/open", "gh browse -cRnobody/open", "gh issue view -w=nobody/open",
  ])("attached values and clusters use command option roles: %s", (source) => {
    expect(repositoryCandidates(source).watched).toContain("nobody")
  })
  test.each([
    "gh issue create -tstranger/open", "gh issue view -wRstranger/open 1", "gh issue create -wtstranger/open",
    "gh release create tag -dtstranger/open", "gh repo edit -dstranger/open", "gh pr checkout -fRstranger/open",
    "gh auth setup-git -fhstranger/open", "gh browse -cRstranger/open", "gh issue view -w=stranger/open",
  ])("known option grammar preserves exact public operands: %s", async (source) => {
    const repositoryVerdicts = await confirmRepositories([source], { cacheFile: null, publicRepos: ["stranger/open"], fetch: async () => { throw new Error("option grammar invented an identity") } })
    expect(repositoryVerdicts.requests).toBe(0)
    expect(clean(source, { repositoryVerdicts })).toMatchObject({ ok: true, text: source })
  })
  test.each([
    'gh api --header="X-Session-Id: syntheticvalue"', "gh api --header='X-Session-Id: syntheticvalue'",
    'gh api -H="X-Session-Id: syntheticvalue"', 'gh api --field=header="X-Session-Id: syntheticvalue"',
    'gh api --header="head=X-Session-Id: syntheticvalue"', 'gh api "--header=X-Session-Id: syntheticvalue"',
    "gh api --header=$'X-Session-Id: syntheticvalue'",
  ])("credential labels inside option data never become repository requests: %s", async (source) => {
    for (const text of [source, encodeURIComponent(source), source.replace(/[!-~]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 0xfee0))]) {
      const repositoryVerdicts = await confirmRepositories([text], { cacheFile: null, fetch: async () => { throw new Error("option data disclosed in a repository request") } })
      expect(repositoryVerdicts.requests).toBe(0)
      expect([...repositoryVerdicts.byRepository]).toEqual([])
      expect(clean(text, { repositoryVerdicts }).text).not.toContain("syntheticvalue")
    }
  })
  test("an explicit repository cross field retains its public identity", async () => {
    const source = "gh api -Fhead=password:public"
    const repositoryVerdicts = await confirmRepositories([source], { cacheFile: null, publicRepos: ["password/public"], fetch: async () => { throw new Error("public cross field requested") } })
    expect(clean(source, { repositoryVerdicts })).toMatchObject({ ok: true, text: source })
  })
  test.each(["[github.com]", "github.com:bad", "api.github.com::443"].flatMap((host) =>
    ["user", "org", "owner", "repo"].map((qualifier) => `https://${host}/search?q=${qualifier}:+nobody`)))("malformed authorities retain account qualifiers: %s", async (source) => {
    const repositoryVerdicts = await confirmRepositories([source, "nobody/hidden"], { cacheFile: null, fetch: async () => new Response(null, { status: 404 }) })
    expect(repositoryVerdicts.watched).toContain("nobody")
    expect(clean("nobody/hidden", { repositoryVerdicts }).text).toBe("[repo]")
  })
  test.each(["gh issue view -Rstranger/open", 'gh issue view -R"stranger/open"', 'gh issue view "-Rstranger/open"', "gh issue view -R'stranger/open'", "gh issue view -Rstranger/open#ref"])("short-option operands preserve public identity: %s", async (source) => {
    for (const text of [source, encodeURIComponent(source), source.replace(/[!-~]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 0xfee0))]) {
      const repositoryVerdicts = await confirmRepositories([text], { cacheFile: null, publicRepos: ["stranger/open"], fetch: async () => { throw new Error("option syntax requested as an owner") } })
      expect(repositoryVerdicts.requests).toBe(0)
      expect(clean(text, { repositoryVerdicts })).toMatchObject({ ok: true, text })
    }
  })
  test("operand normalization retains nested private references", async () => {
    const source = "gh issue view -Rstranger/open/compare/outsider:closed"
    const repositoryVerdicts = await confirmRepositories([source], { cacheFile: null, publicRepos: ["stranger/open"], fetch: async () => new Response(null, { status: 404 }) })
    expect(clean(source, { repositoryVerdicts }).text).not.toContain("outsider:closed")
  })
  test("malformed qualifier discovery still excludes credential payloads", async () => {
    const source = "https://[github.com]/search?token=user:+nobody"
    const repositoryVerdicts = await confirmRepositories([source, "@nobody/hidden"], { cacheFile: null, fetch: async () => { throw new Error("credential payload requested") } })
    expect(repositoryVerdicts.requests).toBe(0)
    expect(repositoryVerdicts.watched).not.toContain("nobody")
  })
  test.each(["https://github.com::191/", "https://github.com:::191/", "ssh://git@[github.com]::191/"])("repeated authority delimiters retain numeric port provenance: %s", async (source) => {
    const repositoryVerdicts = await confirmRepositories([source, "@191/another"], { cacheFile: null, fetch: async () => { throw new Error("numeric port requested as an owner") } })
    expect(repositoryVerdicts.watched).not.toContain("191")
    expect(clean("@191/another", { repositoryVerdicts }).text).toBe("@191/another")
    expect(repositoryCandidates(source + "191/hidden").watched).toContain("191")
  })
  test.each(["npm install alias@nobody/open", "npm install @scope/alias@nobody/open", "pnpm add alias@nobody/open", "yarn add @scope/alias@nobody/open", "npm install alias@github:nobody/open"])("named dependency specifications retain their repository identity: %s", (source) => {
    expect(repositoryCandidates(source).watched).toContain("nobody")
  })
  test("scoped registry packages stay untied", async () => {
    const source = "npm install @scope/pkg"
    const repositoryVerdicts = await confirmRepositories([source], { cacheFile: null, fetch: async () => { throw new Error("registry scope request") } })
    expect(repositoryVerdicts.requests).toBe(0)
    expect(clean(source, { repositoryVerdicts })).toMatchObject({ ok: true, text: source })
  })
  test.each(["https://[github.com]/191/open", "https://[github.com]/safedemo/191", "https://github.com:bad/191/open", "ssh://git@github.com:443:191/open"])("numeric path owners are not ports: %s", (source) => {
    expect(repositoryCandidates(source).watched).toContain("191")
  })
  test("malformed numeric authority ports stay excluded", () => {
    expect(repositoryCandidates("https://[github.com]:191/nobody/open").watched).not.toContain("191")
  })
  test("physical lines cannot reopen a continued shell word", async () => {
    const source = "gh repo view nobody/pub\\\nlic"
    const repositoryVerdicts = await confirmRepositories([source], { cacheFile: null, publicRepos: ["nobody/public"], fetch: async () => { throw new Error("partial continued word requested") } })
    expect(repositoryVerdicts.requests).toBe(0)
    expect(clean(source, { repositoryVerdicts })).toMatchObject({ ok: true, text: source })
  })
  test("named GitHub specifications preserve exact terminal dots", async () => {
    const source = "npm install alias@github:stranger/open."
    const denied = await confirmRepositories([source], { cacheFile: null, publicRepos: ["stranger/open"], fetch: async () => new Response(null, { status: 404 }) })
    expect(clean(source, { repositoryVerdicts: denied }).text).not.toContain("stranger/open.")
    const allowed = await confirmRepositories([source], { cacheFile: null, publicRepos: ["stranger/open."], fetch: async () => { throw new Error("short named identity requested") } })
    expect(allowed.requests).toBe(0)
    expect(clean(source, { repositoryVerdicts: allowed })).toMatchObject({ ok: true, text: source })
  })
  test.each(['gh pr list --repo=$"nobody/open"', '$"gh" pr list --repo=nobody/open', 'g$"h" repo view nobody/open', 'GH_REPO=$"nobody/open"'])("locale-quoted words preserve composition: %s", (source) => {
    expect(repositoryCandidates(source).watched).toContain("nobody")
  })
  test("locale-quoted credential assignments remain opaque", () => {
    expect(repositoryCandidates('gh api graphql -f $"password=nobody/open"').candidates).toEqual([])
  })
  test.each(['# {"body":"gh repo view nobody/open"}', '# {"dependencies":{"dep":"nobody/open"}}'])("JSON inside comments cannot create grammatical ties: %s", async (source) => {
    const repositoryVerdicts = await confirmRepositories([source, "nobody/hidden"], { cacheFile: null, fetch: async () => { throw new Error("comment-derived request") } })
    expect(repositoryVerdicts.requests).toBe(2)
    expect(repositoryVerdicts.watched).not.toContain("nobody")
    expect(clean("nobody/hidden", { repositoryVerdicts })).toMatchObject({ ok: true, text: "[repo]" })
  })
  test("JSON inside comments retains explicit URL ties", () => {
    expect(repositoryCandidates('# {"body":"https://github.com/nobody"}').watched).toContain("nobody")
  })
  test.each([`echo '{"dependencies":{"dep":"nobody/open"}}'`, String.raw`echo '{"dependencies":{"dep":"nobody\u002fopen"}}'`])("quoted JSON containers retain dependency context: %s", async (source) => {
    const repositoryVerdicts = await confirmRepositories([source, "nobody/hidden"], { cacheFile: null, fetch: async () => new Response(null, { status: 404 }) })
    expect(repositoryVerdicts.watched).toContain("nobody")
    expect(clean("nobody/hidden", { repositoryVerdicts })).toMatchObject({ ok: true, text: "[repo]" })
  })
  test("assignment keys normalize without changing repository values", () => {
    expect(repositoryCandidates('gh api graphql -F "ｒｅｐｏｓｉｔｏｒｙ[]=nobody/open"').watched).toContain("nobody")
    expect(repositoryCandidates('gh api graphql -F "ｐａｓｓｗｏｒｄ=nobody/open"').candidates).toEqual([])
  })
  test.each(['gh repo view "stranger/open."', 'GH_REPO="stranger/open."', '{"dependencies":{"dep":"stranger/open."}}'])("exact grammatical values keep terminal dots: %s", async (source) => {
    const denied = await confirmRepositories([source], { cacheFile: null, publicRepos: ["stranger/open"], fetch: async () => new Response(null, { status: 404 }) })
    expect(clean(source, { repositoryVerdicts: denied }).text).not.toContain("stranger/open.")
    const allowed = await confirmRepositories([source], { cacheFile: null, publicRepos: ["stranger/open."], fetch: async () => { throw new Error("shorter identity requested") } })
    expect(allowed.requests).toBe(0)
    expect(clean(source, { repositoryVerdicts: allowed })).toMatchObject({ ok: true, text: source })
  })
  test.each(["https://github.com:bad/nobody/open", "ssh://git@github.com:bad/nobody/open", "https://github.com:443:nobody/open"])("malformed ports cannot inherit public authority: %s", async (source) => {
    const repositoryVerdicts = await confirmRepositories([source], { cacheFile: null, publicRepos: ["bad/nobody", "nobody/open"], fetch: async () => new Response(null, { status: 404 }) })
    expect(clean(source, { repositoryVerdicts })).toMatchObject({ ok: true, text: "[repo]" })
  })
  test("backslashes inside a prose URL retain nested repository meaning", async () => {
    // Retained seed 20261104 counterexample from the composed checkpoint.
    const source = String.raw`the see https://github.com/roninjin10/notes?roninjin10\vault=1 now`
    const repositoryVerdicts = await confirmRepositories([source], { cacheFile: null, publicRepos: ["roninjin10/notes"], fetch: async () => new Response(null, { status: 404 }) })
    const result = clean(source, { repositoryVerdicts })
    expect(result.ok).toBe(true)
    expect(result.text).not.toContain("vault")
  })
  test.each([String.raw`https://github.com/nobody and nobody\hidden`, String.raw`https://github.com/sponsors/nobody and nobody\u002fhidden`, "https://github.com/nobody and nobody/hidden\\"])("prose backslashes retain repository meaning without shell evaluation: %s", async (source) => {
    const repositoryVerdicts = await confirmRepositories([source], { cacheFile: null, fetch: async () => new Response(null, { status: 404 }) })
    const result = clean(source, { repositoryVerdicts })
    expect(result.ok).toBe(true)
    expect(result.text).not.toContain("hidden")
  })
  test.each(["gh api 'https://github.com/no'body/open", 'gh api "https://github.com/no"body/open', String.raw`gh api https://github.com/nobo\dy/open`, String.raw`gh repo view nobo\dy/open`])("ordinary shell composition keeps URL and argument identities: %s", (source) => {
    const references = repositoryCandidates(source)
    expect(references.watched).toContain("nobody")
    expect(references.watched).not.toContain("no")
  })
  test.each(["https://[github.com]/safedemo/nobody", "ssh://git@[github.com]:443/safedemo/nobody", "git@[github.com]:safedemo/nobody"])("bracketed DNS stays unconfirmable and ties every segment: %s", async (source) => {
    const repositoryVerdicts = await confirmRepositories([source, "nobody/hidden"], { cacheFile: null, publicRepos: ["safedemo/nobody"], fetch: async () => new Response(null, { status: 404 }) })
    expect(repositoryVerdicts.watched).toContain("nobody")
    expect(clean("nobody/hidden", { repositoryVerdicts })).toMatchObject({ ok: true, text: "[repo]" })
    expect(clean(source, { repositoryVerdicts })).toMatchObject({ ok: true, text: "[repo]" })
  })
  test("ordinary composed public URLs and surrounding command punctuation survive", async () => {
    const source = "gh api 'https://github.com/no'body/open;echo KEEP"
    const repositoryVerdicts = await confirmRepositories([source], { cacheFile: null, publicRepos: ["nobody/open"], fetch: async () => { throw new Error("fabricated quoted repository") } })
    expect(repositoryVerdicts.requests).toBe(0)
    expect(clean(source, { repositoryVerdicts })).toMatchObject({ ok: true, text: source })
  })
  test.each([
    String.raw`curl $'https://github.com/publicdemo/open?token=https://github.com/no\x62ody/hidden'`,
    String.raw`{"body":"https://github.com/publicdemo/open?token={\"url\":\"https://github.com/@nobody/hidden\"}"}`,
  ])("semantic decoding retains exclusions for nested credential URLs: %s", async (source) => {
    const repositoryVerdicts = await confirmRepositories([source, "@nobody/hidden"], { cacheFile: null, fetch: async () => { throw new Error("credential-derived request") } })
    expect(repositoryVerdicts.requests).toBe(0)
    expect(repositoryVerdicts.watched).not.toContain("nobody")
    expect(clean("@nobody/hidden", { repositoryVerdicts })).toMatchObject({ ok: true, text: "@nobody/hidden" })
  })
  test.each(["curl 'https://github.com/no'body/open?token=x", String.raw`curl $'https://github.com/no\x62ody/open?token=x'`])("opaque fields retain decoded safe URL owners: %s", async (source) => {
    const asked: string[] = []
    const repositoryVerdicts = await confirmRepositories([source, "nobody/hidden"], { cacheFile: null, fetch: async (url: string) => { asked.push(url.split("/repos/")[1]!); return new Response(null, { status: 404 }) } })
    expect(repositoryVerdicts.watched).toContain("nobody")
    expect(repositoryVerdicts.watched).not.toContain("no")
    expect(asked).toEqual(["nobody/hidden"])
    expect(clean("nobody/hidden", { repositoryVerdicts })).toMatchObject({ ok: true, text: "[repo]" })
  })
  test("semantic source spans preserve adjacent punctuation and shell separators", async () => {
    const source = String.raw`gh repo view $'nobody/hidden';echo KEEP`
    const repositoryVerdicts = await confirmRepositories([source], { cacheFile: null, fetch: async () => new Response(null, { status: 404 }) })
    expect(clean(source, { repositoryVerdicts })).toMatchObject({ ok: true, text: "gh repo view [repo];echo KEEP" })
    expect(clean('{"body":"nobody/hidden!"}', { repositoryVerdicts })).toMatchObject({ ok: true, text: '{"body":"[repo]!"}' })
  })
  test("serialized JSON keeps each text field's grammar context", () => {
    expect(repositoryCandidates('{"body":"# nobody:hidden"}').candidates).toEqual([])
    expect(repositoryCandidates('{"body":"gh repo view nobody/open"}').watched).toContain("nobody")
    expect(repositoryCandidates('{"gh":"nobody/open"}').watched).not.toContain("nobody")
  })
  test.each(["gh repo view $'nobody/open'", "$'gh' repo view nobody/open", "GH_REPO=$'nobody/open'", ...[String.raw`\x2f`, String.raw`\x2F`, String.raw`\u002F`, String.raw`\U0000002f`, String.raw`\057`].map((slash) => `gh repo view $'nobody${slash}open'`), String.raw`g$'\x68' repo view nobody/open`, String.raw`gh repo view no$'body\u002f'open`])("ANSI-C quoted shell words retain meaning: %s", (source) => {
    expect(repositoryCandidates(source).watched).toContain("nobody")
  })
  test("ANSI-C quoted credentials are screened before discovery", () => {
    expect(repositoryCandidates(String.raw`gh api graphql -f $'pass\x77ord=nobody/open'`).candidates).toEqual([])
  })
  test.each([false, true])("ANSI-C escape notation cannot fabricate a repository (fullwidth=%s)", async (wide) => {
    const raw = String.raw`gh repo view $'nobody\x2fopen'`
    const source = wide ? raw.replace(/[!-~]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)) : raw
    const repositoryVerdicts = await confirmRepositories([source], { cacheFile: null, publicRepos: ["nobody/open"], fetch: async () => { throw new Error("fabricated request") } })
    expect(repositoryVerdicts.requests).toBe(0)
    expect(clean(source, { repositoryVerdicts })).toMatchObject({ ok: true, text: source })
  })
  test.each(["https://github.com/search?q=user:+nobody", "https://github.com/search/user:nobody", "https://api.github.com/search/org%3Anobody"])("qualifiers cover all URL components: %s", (source) => {
    expect(repositoryCandidates(source).watched).toContain("nobody")
  })
  test.each(["github.com", "github.com-work", "github.com-work_personal", "github.com-seat+one"])("valid SCP on %s ties only its owner", async (host) => {
    const source = `git@${host}:publicdemo/open`
    const repositoryVerdicts = await confirmRepositories([source, "@open/guide"], { cacheFile: null, publicRepos: ["publicdemo/open"], fetch: async () => { throw new Error("repository name became owner") } })
    expect(repositoryVerdicts.watched).not.toContain("open")
    expect(clean("@open/guide", { repositoryVerdicts })).toMatchObject({ ok: true, text: "@open/guide" })
  })
  test.each(["password=demo\n```yaml\ndependencies:\n  pkg: nobody/open\n```", "dependencies: # runtime\n  dep: nobody/open", "dependencies:\n  dep: |\n    nobody/open", "overrides:\n  dep: >-\n    nobody/\n    open", "npx degit@2 nobody/open", "npx --yes degit@latest nobody/open"])("configuration layout and package versions retain meaning: %s", (source) => {
    expect(repositoryCandidates(source).watched).toContain("nobody")
  })
  test.each([
    [String.raw`{"dependencies":{"dep":"nobody\u002fopen"}}`, "nobody/open"],
    [String.raw`{"dependencies":{"d\u0065p":"nobody\u002fopen"}}`, "nobody/open"],
    [String.raw`{"dependencies":{"dep":"nobody\\u002fopen"}}`, "nobody/u002fopen"],
  ])("JSON escapes name only the decoded repository: %s", async (source, repository) => {
    const repositoryVerdicts = await confirmRepositories([source], { cacheFile: null, publicRepos: [repository], fetch: async () => { throw new Error("fabricated repository request") } })
    expect(repositoryVerdicts.requests).toBe(0)
    expect(clean(source, { repositoryVerdicts })).toMatchObject({ ok: true, text: source })
  })
  test("decoded JSON spans retain adjacent public prose", async () => {
    const source = String.raw`{"body":"see stranger/open and nobody\u002fhidden"}`
    const repositoryVerdicts = await confirmRepositories([source, "https://github.com/nobody"], { cacheFile: null, publicRepos: ["stranger/open"], fetch: async () => new Response(null, { status: 404 }) })
    const result = clean(source, { repositoryVerdicts })
    expect(result.ok).toBe(true)
    expect(result.text).toContain("stranger/open")
    expect(result.text).not.toContain("hidden")
  })
  test("comment syntax cannot hide an explicit URL's nested repository", async () => {
    // Retained full-run counterexample, seed 20261104.
    const text = "the # https://github.com/stranger/open/compare/outsider:closed.d"
    const repositoryVerdicts = await confirmRepositories([text], { cacheFile: null, publicRepos: ["stranger/open"], fetch: async () => new Response(null, { status: 404 }) })
    expect(repositoryVerdicts.watched).toContain("outsider")
    const result = clean(text, { repositoryVerdicts })
    expect(result.ok).toBe(true)
    expect(result.text).not.toContain("closed.d")
  })
  test.each(['gh repo view "nobody / open"', "export 'GH_REPO=nobody / open'"])("normalization stays inside the argument boundary: %s", (source) => {
    expect(repositoryCandidates(source).watched).toContain("nobody")
  })
  test.each(['export "GH_REPO=nobody/open"', 'env "GITHUB_REPOSITORY=nobody/open" true', "export 'GH_REPO=nobody/open'"])("quoted environment assignments tie independently of executable: %s", (source) => {
    expect(repositoryCandidates(source).watched).toContain("nobody")
  })
  test.each(['# GH_REPO=nobody/open', 'echo ok # GH_REPO=nobody/open', 'echo ok # "GITHUB_REPOSITORY=nobody/open"', '# uses: nobody/open@v1', '# "dep": "nobody/open#ref"'])("comments never create configuration ties: %s", (source) => {
    expect(repositoryCandidates(source).candidates.map((reference: { name: string }) => reference.name)).toEqual(["nobody/open"])
    expect(repositoryCandidates(source).watched).not.toContain("nobody")
  })
  test.each(['(gh issue list -R nobody/open)', '$(gh issue list -R nobody/open)', 'echo "$(gh issue list -R nobody/open)"', '(npm install nobody/open)', 'echo "`gh repo view nobody/open`"', 'gh repo clone\nnobody/open', 'npm install\nnobody/open', '"dep": "nobody/open" and nobody/hidden', String.raw`{"dependencies":{"dep":"nobody\u002fopen"}}`])("grouped, wrapped or serialized references tie: %s", (source) => {
    expect(repositoryCandidates(source).watched).toContain("nobody")
  })
  test.each([String.raw`{"pass\u0077ord":"nobody/open#ref"}`, String.raw`{"\u0074oken":"nobody/open#ref"}`])("JSON key decoding cannot produce credential requests: %s", (source) => {
    for (const representation of [source, JSON.parse(source)]) {
      expect(repositoryCandidates(representation).candidates).toEqual([])
      expect(repositoryCandidates(representation).watched).not.toContain("nobody")
    }
  })
  test.each(['gh api graphql --field=repository=nobody/open', "gh api graphql -F 'repository[]=nobody/open'", 'gh api graphql -Frepository[owner]=nobody/open', '/usr/bin/gh issue list -R nobody/open', '"/usr/local/bin/gh" repo view nobody/open', 'dependencies:\n  dep: nobody/open', 'overrides:\n  dep: nobody/open'])("structured command/configuration values tie: %s", (source) => {
    expect(repositoryCandidates(source).watched).toContain("nobody")
  })
  test.each(['gh api graphql -f "password=nobody/open"', "gh api graphql -F 'data[password]=nobody/open'", 'gh api graphql --field=password=nobody/open', 'gh pr list # text; gh pr list nobody/open', 'gh pr list # text && gh pr list nobody/open', 'gh pr list # text; gh repo clone nobody/open'])("credential or commented arguments cannot create owner ties: %s", (source) => {
    expect(repositoryCandidates(source).candidates.map((reference: { name: string }) => reference.name)).toEqual(source.includes("#") ? ["nobody/open"] : [])
    expect(repositoryCandidates(source).watched).not.toContain("nobody")
  })
  test.each([['**', '**'], ['_', '_'], ['<em>', '</em>'], ['~~', '~~']])("markup %s preserves authority boundaries", async (open, close) => {
    for (const word of ["and", "beside"]) {
      const text = `${open}ssh://git@ssh.github.com:443/ ${word} @nobody/hidden${close}`
      const repositoryVerdicts = await confirmRepositories([text, `@${word}/value`], { cacheFile: null, fetch: async () => { throw new Error("unexpected request") } })
      expect(repositoryVerdicts.requests).toBe(0)
      expect(repositoryVerdicts.watched).not.toContain(word)
      expect(clean(text, { repositoryVerdicts }).text).toContain(` ${word} @nobody/hidden`)
    }
  })
  test("ordinary serialized prose is not a dependency spec", () => {
    expect(repositoryCandidates('{"body":"node/bun"}').candidates).toEqual([])
  })
  test.each(["%64ependencies", "Ｄｅｐｅｎｄｅｎｃｉｅｓ"])("encoded dependency-container key %s retains context", (key) => {
    const value = { [key]: { pkg: "nobody/open" } }
    for (const source of [value, JSON.stringify(value)]) expect(repositoryCandidates(source).watched).toContain("nobody")
  })
  test.each(['"gh" repo view nobody/open', "'gh' repo view nobody/open", 'g"h" repo view nobody/open', String.raw`\g\h repo view nobody/open`, "gh api graphql -f repository=nobody/open", '"npm" install nobody/open'])("shell words establish command context: %s", (source) => {
    expect(repositoryCandidates(source).watched).toContain("nobody")
  })
  test.each(["gh api /repos/nobody/open", "gh api /rate_limit"])("shell argument boundaries survive normalization: %s", async (text) => {
    const repositoryVerdicts = await confirmRepositories([text], { cacheFile: null, publicRepos: ["nobody/open"], fetch: async () => { throw new Error("unexpected request") } })
    expect(repositoryVerdicts.requests).toBe(0)
    expect(repositoryVerdicts.watched).not.toContain("api")
    expect(clean(text, { repositoryVerdicts })).toMatchObject({ ok: true, text })
  })
  test.each(["config:\n  password: nobody/open#ref", "config:\r\n  password: npm install nobody/open"])("actual configuration credentials remain opaque: %s", (source) => {
    expect(repositoryCandidates(source).candidates).toEqual([])
    expect(repositoryCandidates(source).watched).not.toContain("nobody")
  })
})


describe("round 7 fail-closed suspect regions", () => {
  test.each([...["'gh' secret set", '"gh" secret set', 'g"h" secret set', String.raw`\g\h secret set`, "gh 'secret' 'set'", String.raw`gh se\cret s\et`, "gh --repo acme/open secret set"].flatMap((command) => ["-b ", "--body ", "-b", "-b=", "--body="].map((option) => `${command} DEMO ${option}`)), "gh unknown-future -xyzR ", "gh repo view '"])("parsed credential or unresolved command stays suspect: %s", async (command) => {
    const source = command === "gh repo view '" ? `${command} https://github.com/nobody/open` : `${command}'{"body":"https://github.com/nobody/open"}'`, asked: string[] = []
    const repositoryVerdicts = await confirmRepositories([source, "@nobody/hidden"], { cacheFile: null, fetch: async (url: string) => { asked.push(url); return new Response(null, { status: 404 }) } })
    expect(suspectRegions(source).length).toBeGreaterThan(0)
    expect(asked).toEqual([])
    expect(repositoryVerdicts.watched).not.toContain("nobody")
    expect(clean(source, { repositoryVerdicts }).text).not.toContain("nobody/open")
    expect(clean("@nobody/hidden", { repositoryVerdicts })).toMatchObject({ ok: true, text: "@nobody/hidden" })
  })
  test.each(["gh secret set DEMO --body 'demo'", "gh unknown-future -xyzRother/open", "{dependencies: {pkg: other/open}"])("determinate fences preserve independent discovery: %s", async (inside) => {
    const asked: string[] = [], source = "```sh\n" + inside + "\n```\ngh repo view nobody/open"
    await confirmRepositories([source], { cacheFile: null, fetch: async (url: string) => { asked.push(url); return new Response(null, { status: 404 }) } })
    expect(asked).toEqual(["https://api.github.com/repos/nobody/open"])
  })
  test("an indeterminate row cannot expose a watched credential operand on the next row", async () => {
    const source = "gh secret set DEMO --body '\nnobody/open'"
    const repositoryVerdicts = await confirmRepositories([source], { cacheFile: null, watchedOwners: ["nobody"], fetch: async () => { throw new Error("credential operand requested") } })
    expect(repositoryVerdicts.requests).toBe(0)
    expect(clean(source, { repositoryVerdicts }).text).not.toContain("nobody/open")
  })
  test("only an independent public confirmation can preserve a suspect token", async () => {
    const source = "token:\n  pkg: nobody/open"
    const asked: string[] = []
    const repositoryVerdicts = await confirmRepositories([source, "gh repo view nobody/open"], { cacheFile: null, fetch: async (url: string) => { asked.push(url); return new Response(JSON.stringify({ private: false }), { status: 200 }) } })
    expect(asked).toEqual(["https://api.github.com/repos/nobody/open"])
    expect(repositoryVerdicts.byRepository.get("nobody/open")?.verdict).toBe("public")
  })
  test.each([
    "? password\n:\n  ? dependencies\n  :\n    pkg: nobody/open",
    "dependencies:\n  ? token : nobody/open",
    "password:\n- dependencies:\n    pkg: nobody/open",
    `gh secret set DEMO --body '{"dependencies":{"pkg":"nobody/open"}}'`,
    `gh issue list > '{"dependencies":{"pkg":"nobody/open"}}'`,
    `-----BEGIN PRIVATE KEY-----\ndependencies:\n  pkg: nobody/open`,
    `{"password":{"body":"gh repo view nobody/open"}}`,
    `dependencies:\n  tokenizer: nobody/open`,
    `gh repo view "nobody/open`,
    `{"dependencies":{"pkg":"nobody/open"`,
    "{dependencies: {pkg: nobody/open}",
    String.raw`dependencies:
  bad: "nobody/\qopen"
  good: nobody/open`,
    `gh unknown-future -xyzRnobody/open`,
    `{output}> node/bun gh repo view nobody/open`,
    `notes: |\n  unfinished "\ndependencies:\n  pkg: nobody/open`,
    "gh secret set DEMO --body '\n```json\n{\"dependencies\":{\"pkg\":\"nobody/open\"}}\n```\n'",
    "```sh\ngh secret set DEMO --body '\n```\ngh repo view nobody/open",
  ])("never requests or ties credential/filename structure: %s", async (source) => {
    const asked: string[] = []
    const repositoryVerdicts = await confirmRepositories([source, "@nobody/hidden"], {
      cacheFile: null, fetch: async (url: string) => { asked.push(url); return new Response(null, { status: 404 }) },
    })
    expect(suspectRegions(source).length).toBeGreaterThan(0)
    expect(asked).toEqual([])
    expect(repositoryVerdicts.watched).not.toContain("nobody")
    const result = clean(source, { repositoryVerdicts })
    expect(result.text).not.toContain("nobody/open")
    expect(clean("@nobody/hidden", { repositoryVerdicts })).toMatchObject({ ok: true, text: "@nobody/hidden" })
  })
})
