import { Button, LinkTabs, NotificationBell, RepoAbout, FileTabs, ItemAsideSection, ItemConversation, IssuesView, RepositoryHome, SmithersUiStyles } from "@smthrs/ui"
import { RepoView, RepoViewStyles } from "@smthrs/repo-view"
import { listPageOf } from "../../src/features/pulls/view"
import { createRoot } from "react-dom/client"

// Real library renderers, with the production file and conversation labels that
// exposed the defects. This host tests rendering without replacing any service.
const path = new URL(location.href).searchParams.get("file") ?? "README.md"
const markdown = `### Well hello there!\n\n${"A repository document remains readable below its toolbar. ".repeat(15)}\n\n[Read the guide](https://example.com/guide)\n`
const list = new URL(location.href).searchParams.get("list")
const pullPage = listPageOf([], { owner: "smithersai", name: "smithers" }, { syncedAt: "2026-10-23" }, { status: "allowed" }, list !== "pending")
const screen = new URL(location.href).searchParams.get("screen")
createRoot(document.getElementById("app")!).render(screen === null ? <>
  {list === null ? null : <section id="pulls"><IssuesView repo="smithersai/smithers" issues={pullPage.pulls} loading={pullPage.loading} unknown={pullPage.unknown} emptyTitle="No pull requests" /></section>}
  <SmithersUiStyles withTheme />
  <RepoViewStyles />
  <section id="tap-controls">
    <a className="back-to-chat" href="/app">Back to chat</a>
    <Button asChild><a href="/api/auth/sign-in">Sign in with GitHub</a></Button>
    <NotificationBell />
    <NotificationBell needsYou={1} unread={3} />
    <RepoAbout release={{ tag: "v1.0", name: "VibeLang v1.0", href: "https://example.com/release" }} />
  </section>
  <main className="repo-screen" id="repository-home">
    <RepositoryHome sections={[{ blocks: [
      { type: "hero", title: "Smithers", install: "pnpm add @smthrs/flow @smthrs/platform-browser" },
      { type: "code", code: "const workflow = Flow.make(\"a-long-named-durable-workflow\", { body: () => Effect.void })".repeat(4) },
    ] }]} />
  </main>
  <section id="files">
    <FileTabs tabs={[{ key: path, label: path, href: `#${path}`, active: true }]} onOpen={() => {}} onClose={() => {}} />
    <RepoView name="Spoon-Knife" location={{ kind: "blob", path }} htmlMode="split" codeMode="plain"
      tree={{ state: "ready", paths: ["README.md", "index.html", "styles.css", "src/main.ts"] }}
      file={{ state: "text", contents: path === "README.md" ? markdown : "<h1>Hello</h1>", size: 780 }}
      href={(next) => `#${next.path}`} onNavigate={() => {}}
      fileActions={<><Button size="sm">Copy path</Button><Button size="sm">Copy</Button></>} />
  </section>
  <ItemConversation title="A synced issue" number={4432} state="open" body="A production issue." comments={[]}
    externalHref="https://github.com/smithersai/smithers/issues/4432"
    aside={<>
      <ItemAsideSection title="TODO" links={[{ label: "T5", href: "/smithersai/smithers/stack/5" }, { label: "T4", href: "/smithersai/smithers/stack/4" }]} />
      <ItemAsideSection title="Run" links={[{ label: "Watch", href: "/app/runs/todo:13" }]} />
      <ItemAsideSection title="Branch" links={[{ label: "smithers/t13-mobile-layout-84a0f279-c5d2-4f47-bf1f-2d-9f58a66879c3", href: "/roninjin10/smithers-github-tests/tree/branch" }]} />
    </>} />
  <main className="conversations-screen" aria-label="Conversations">
    <ul className="conversation-list-rows" aria-label="Conversations">
      {[['smithers-e2e', 'roninjin10/smithers-github-tests'], ['a-very-long-branch-name-that-must-wrap', 'a-long-owner/a-long-repository-name']].map(([branch, repo]) =>
        <li className="conversation-list-row" key={branch}>
          <a href="#conversation"><span className="conversation-list-branch">{branch}</span>{" "}<span className="conversation-list-repo">{repo}</span></a>
          <Button variant="ghost" aria-label={`Archive ${branch}`}>Archive</Button>
        </li>)}
    </ul>
  </main>
</> : <>
  <SmithersUiStyles withTheme />
  {screen === "shell" ? <main className="app-shell"><header className="app-shell-header"><div className="app-shell-agent">Smithers</div><nav className="app-shell-nav" aria-label="Pages">{["Conversations", "Flows", "Runs", "Settings", "Queue", "Report a bug"].map(label => <a href="#" key={label}>{label}</a>)}</nav><NotificationBell unread={337} /><Button aria-label="Theme">Theme</Button><span aria-label="Account"><span>codeplanesmithers</span><Button>Sign out</Button></span></header><div className="app-shell-composer"><Button aria-keyshortcuts="Meta+K Control+K">Chat <kbd>⌘K</kbd></Button></div></main> : screen === "branch" ? <main className="branch-screen" data-workspace="false">
    <header className="repo-header"><h1>octocat / Spoon-Knife</h1><NotificationBell /></header>
    <div className="branch-screen-view"><LinkTabs className="home-tabs"><a href="#home">Home</a><a href="#code">Code</a></LinkTabs><div style={{ minHeight: "1200px" }}>Files</div></div>
  </main> : screen === "issues" ? <main className="issues-screen">
    <header className="repo-header"><h1 className="repo-header-name">smithersai / smithers</h1>
      {["Issues", "Pull requests", "Runs", "Stack", "Secrets"].map(name => <Button key={name} variant="ghost">{name}</Button>)}
      <span className="repo-header-bell"><NotificationBell /></span>
    </header>
    <p><a href="https://github.com/smithersai/smithers/issues/new">Open an issue on GitHub</a></p>
    <RepositoryHome sections={[{ blocks: [{ type: "hero", title: "VibeLang", announcement: { label: "v0: the language will change", url: "https://example.com/announcement" } }] }]} />
  </main> : <><main className={`${screen}-screen`}><Button asChild><a href="/api/auth/sign-in">Sign in with GitHub</a></Button></main><div className="root-bell"><NotificationBell /></div></>}
</>)
