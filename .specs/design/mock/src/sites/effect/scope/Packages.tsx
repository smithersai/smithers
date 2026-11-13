import { pluralize } from "../../repo/ui/pluralize"
import { useEffect, useState } from "react"
import { Markdown as SourceMarkdown } from "../../app/lib"
import { stripFrontmatter } from "../../repo/ui/markdown-source"
import { useMock, useRead } from "../../core/mock"
import { Link, useLocation } from "../../core/router"
import { children, commit, file, fmtAgo, pulls, repo, to, tree } from "../../repo/fixtures"
import { useIssues } from "../../repo/views/issues/model"
import { issuesFor } from "../work/filters"
import { extras } from "../../repo/fixtures/data/Effect-TS__effect"
import type { PackageInfo } from "../../repo/fixtures/types"
import { Empty, Failed, Loading, registerSlash, RepoFrame, usePackageScope, useRepoFrame } from "../../repo/frame"
import { packageFamilies, packageSlug, scopedRoute } from "../../repo/frame/packageScope"
import { AgentMark, Box, Icon, PersonChip } from "../../repo/ui"

const packageHref = (pkg: PackageInfo) => scopedRoute(to(`packages/${packageSlug(pkg)}`), pkg)
const releaseFor = (pkg: PackageInfo) => extras.packageReleases.filter(value => value.package === pkg.name).sort((a, b) => b.date.localeCompare(a.date))[0]
const openPulls = (pkg: PackageInfo) => {
  const refs = new Set(extras.relations.filter(value => value.kind === "pull" && (value.packages.includes(pkg.name) || (value.basis === "shared-input" && value.packages.length === 0))).map(value => value.ref))
  return pulls.filter(value => refs.has(String(value.n)) && (value.state === "open" || value.state === "draft"))
}
const Owners = ({ pkg, compact = false }: { pkg: PackageInfo; compact?: boolean }) => <span className="effect-package-owners">{pkg.owners.map(login => <PersonChip login={login} compact={compact} key={login} />)}</span>

export const PackagesLoading = () => <Loading rows={8} />
export const PackagesFailed = ({ retry }: { retry: () => void }) => <Failed what="packages" reason="The workspace manifest couldn't be read from the repository host." retry={retry} />
export const PackagesEmpty = () => <Empty title="No packages in this repository." />
export const PackagesNoMatches = ({ clear }: { clear: () => void }) => <Empty title="No matching packages." action={<button className="repo-ui-btn" title="/package.filter" onClick={clear}>Clear filter</button>} />
export const PackagesSignedOut = () => <PackagesReady />

export const PackagesReady = () => {
  const location = useLocation()
  const issues = useIssues()
  const initialQuery = new URLSearchParams(location.split("?")[1]).get("q") ?? ""
  const [filter, setFilter] = useState(initialQuery)
  const { openAsk, actionOpen } = useRepoFrame()
  const { withScope } = usePackageScope()
  useEffect(() => { setFilter(initialQuery) }, [initialQuery])
  const packages = repo.config.packages ?? []
  const matching = packages.filter(pkg => `${pkg.name} ${pkg.path} ${pkg.description}`.toLowerCase().includes(filter.toLowerCase()))
  useEffect(() => registerSlash("package.filter", {
    purpose: "Filter packages", access: "public", confirm: false,
    fields: [{ name: "query", label: "Filter", required: false }],
    run: values => setFilter(values.query ?? "")
  }), [])
  return <>
    <div className="effect-packages-heading"><h2>Packages <span>{packages.length}</span></h2><button className={`repo-ui-btn${actionOpen ? "" : " repo-ui-btn-primary"}`} title="/package.open" onClick={() => openAsk("/package.open", { send: true })}>Open package</button></div>
    <nav className="effect-packages-tools" aria-label="Package tools">
      <Link to={withScope(to("runs"))}>Runs</Link>
      <Link to={withScope(to("releases/plan"))}>Version packages</Link>
    </nav>
    <div className="effect-packages-filter"><Icon name="search" /><label className="repo-ui-sr" htmlFor="effect-packages-query">Filter packages</label><input id="effect-packages-query" placeholder="Filter by name, path, or description…" value={filter} onChange={event => setFilter(event.target.value)} /></div>
    {matching.length ? packageFamilies.map(([family, label]) => {
      const members = matching.filter(pkg => (pkg.family ?? "") === family)
      return members.length ? <section className="effect-packages-group" key={family} aria-label={`${label} packages`}><div className="effect-packages-group-heading"><h3>{label}</h3><span>{members.length}</span></div><div className="effect-packages-list">{members.map(pkg => {
        const latest = releaseFor(pkg)
        const issueCount = issuesFor(pkg, issues).filter(value => value.state === "open").length
        const pullCount = openPulls(pkg).length
        return <article className="effect-package-row" key={pkg.path}>
          <div className="effect-package-identity"><Link className="effect-package-name" to={packageHref(pkg)} title={`/package.open ${pkg.name}`}>{pkg.name}</Link><p>{pkg.description}</p><Link className="effect-package-path" to={scopedRoute(to(`tree/${repo.defaultBranch}/${pkg.path}`), pkg)}>{pkg.path}</Link></div>
          <div className="effect-package-row-meta"><span className="effect-package-version">{pkg.private ? "private" : pkg.version}</span><span className="effect-package-owner-meta">Owners <Owners pkg={pkg} /></span><div className="effect-package-counts"><Link to={scopedRoute(to("issues"), pkg)} aria-label={`${issueCount} open ${pluralize(issueCount, "issue")} for ${pkg.name}`}><Icon name="issue" size={16} />{issueCount} {pluralize(issueCount, "issue")}</Link><Link to={scopedRoute(to("pulls"), pkg)} aria-label={`${pullCount} open ${pluralize(pullCount, "pull request")} for ${pkg.name}`}><Icon name="change" size={16} />{pullCount} {pluralize(pullCount, "pull request")}</Link></div>{latest && !pkg.private && <Link className="effect-package-latest" to={scopedRoute(to(`releases/tag/${encodeURIComponent(latest.tag)}`), pkg)}>Released {fmtAgo(latest.date)}</Link>}</div>
        </article>
      })}</div></section> : null
    }) : <PackagesNoMatches clear={() => setFilter("")} />}
  </>
}

export const Packages = () => {
  const { flags } = useMock()
  const read = useRead(`packages:${repo.slug}:${repo.defaultBranch}`)
  return <RepoFrame tab="packages" title={`Packages · ${repo.slug}`} askContext={`${repo.slug} packages`}>
    {read.state === "loading" ? <PackagesLoading /> : read.state === "error" ? <PackagesFailed retry={read.retry} /> : flags.data === "empty" || !repo.config.packages?.length ? <PackagesEmpty /> : flags.as === "out" ? <PackagesSignedOut /> : <PackagesReady />}
  </RepoFrame>
}

export const PackageHomeLoading = () => <Loading variant="file" rows={8} />
export const PackageHomeFailed = ({ retry }: { retry: () => void }) => <Failed what="this package" reason="The repository host didn't return the package tree and README." retry={retry} />
export const PackageHomeEmpty = () => <Empty title="This package has no files." />
export const PackageHomeMissing = ({ slug }: { slug: string }) => <Empty title={`Package ${slug} wasn't found.`} action={<Link className="repo-ui-btn" to={to("packages")}>Browse packages</Link>} />
const PackageReadme = ({ pkg, source, revision }: { pkg: PackageInfo; source: string; revision: string }) => <SourceMarkdown source={stripFrontmatter(source)} resolve={href => {
  if (/^(https?:|mailto:)/.test(href)) return { kind: "external", href }
  if (href.startsWith("#")) return { kind: "text" }
  if (href.startsWith("smithers.sh/")) return { kind: "route", to: href }
  const segments = href.startsWith("/") ? [] : pkg.path.split("/")
  for (const segment of href.split("/")) {
    if (segment === "..") segments.pop()
    else if (segment && segment !== ".") segments.push(segment)
  }
  const path = segments.join("/")
  const kind = tree.some(entry => entry.kind === "dir" && entry.path === path) ? "tree" : "blob"
  return { kind: "route", to: scopedRoute(to(`${kind}/${encodeURIComponent(revision)}/${path}`), pkg) }
}} />

const PackageFiles = ({ pkg, revision }: { pkg: PackageInfo; revision: string }) => {
  const entries = children(pkg.path)
  return <Box header={<Link className="effect-package-tree-title" to={scopedRoute(to(`tree/${encodeURIComponent(revision)}/${pkg.path}`), pkg)}><Icon name="folder" />{pkg.path}</Link>}><div className="effect-package-files" role="table" aria-label={`Files in ${pkg.name}`}><div className="repo-ui-sr" role="row"><span role="columnheader">Name</span><span role="columnheader">Last commit</span><span role="columnheader">Updated</span></div>{entries.map(entry => {
    const last = commit(entry.sha)
    return <div className="effect-package-file-row" role="row" key={entry.path}><span role="cell"><Link to={scopedRoute(to(`${entry.kind === "dir" ? "tree" : "blob"}/${encodeURIComponent(revision)}/${entry.path}`), pkg)}><Icon name={entry.kind === "dir" ? "folder" : "file"} />{entry.path.split("/").at(-1)}</Link></span><span role="cell" className="effect-package-file-commit">{last && <><Link to={scopedRoute(to(`commit/${last.sha}`), pkg)}>{last.title}</Link>{last.agent && <AgentMark agent={last.agent} />}</>}</span><span role="cell" className="effect-package-file-date">{last && fmtAgo(last.date)}</span></div>
  })}</div></Box>
}

const PackageSidebar = ({ pkg }: { pkg: PackageInfo }) => {
  const issues = useIssues()
  const issueCount = issuesFor(pkg, issues).filter(value => value.state === "open").length
  const pullCount = openPulls(pkg).length
  const { withScope } = usePackageScope()
  const packages = repo.config.packages ?? []
  const dependencies = packages.filter(value => pkg.dependencies?.some(dep => dep.name === value.name))
  const dependents = packages.filter(value => value.dependencies?.some(dep => dep.name === pkg.name))
  const releases = extras.packageReleases.filter(value => value.package === pkg.name)
  return <aside className="effect-package-sidebar" aria-label="Package details">
    <section><h3>{pkg.private ? "Private package" : "Version"}</h3>{!pkg.private && <><span className="effect-package-version">{pkg.version}</span><a className="effect-package-npm" href={`https://www.npmjs.com/package/${pkg.name}`} target="_blank" rel="noopener noreferrer">npm <Icon name="external" size={12} /></a></>}</section>
    <section><h3>Owners</h3><Owners pkg={pkg} /></section>
    <section><h3>Documentation</h3><Link className="effect-package-open-docs" to={withScope(to(pkg.docs ?? `docs/${packageSlug(pkg)}`))}>Open docs <Icon name="chevron" size={16} /></Link></section>
    <section><h3>Open work</h3><Link to={withScope(to("issues"))}>{issueCount} {pluralize(issueCount, "issue")}</Link><Link to={withScope(to("pulls"))}>{pullCount} {pluralize(pullCount, "pull request")}</Link></section>
    {dependencies.length > 0 && <section><h3>Workspace dependencies <span>{dependencies.length}</span></h3><ul>{dependencies.map(dep => <li key={dep.path}><Link to={packageHref(dep)}>{dep.name}</Link><span>{[...new Set(pkg.dependencies?.filter(value => value.name === dep.name).map(value => value.kind))].join(", ")}</span></li>)}</ul></section>}
    {dependents.length > 0 && <section><h3>Dependents <span>{dependents.length}</span></h3><details><summary title="/package.dependents">{dependents.length} {pluralize(dependents.length, "package")}</summary><ul>{dependents.map(dep => <li key={dep.path}><Link to={packageHref(dep)}>{dep.name}</Link></li>)}</ul></details></section>}
    {!pkg.private && releases.length > 0 && <section><h3>Releases</h3>{releases.map(release => <Link key={release.tag} to={withScope(to(`releases/tag/${encodeURIComponent(release.tag)}`))}>{release.version}<small>{fmtAgo(release.date)}</small></Link>)}</section>}
  </aside>
}

export const PackageHomeReady = ({ pkg, revision }: { pkg: PackageInfo; revision: string }) => {
  const { withScope } = usePackageScope()
  const readme = pkg.readme ? file(pkg.readme) : file(`${pkg.path}/README.md`)
  useEffect(() => registerSlash("package.dependents", { purpose: "Open package dependents", access: "public", confirm: false, fields: [], run: (_, context) => { context.closeAsk(); document.querySelector<HTMLDetailsElement>(".effect-package-sidebar details")?.setAttribute("open", "") } }), [])
  return <>
    <div className="effect-package-heading"><div><nav aria-label="Package breadcrumb"><Link to={withScope(to("packages"))}>Packages</Link><span>/</span><span>{pkg.name}</span></nav><h2>{pkg.name}</h2><p>{pkg.description}</p></div><Link className="repo-ui-btn repo-ui-btn-primary" to={withScope(to(`tree/${encodeURIComponent(revision)}/${pkg.path}`))}>Browse files</Link></div>
    <div className="effect-package-layout"><div className="effect-package-main"><PackageFiles pkg={pkg} revision={revision} />{readme && <Box className="effect-package-readme" header={<Link to={withScope(to(`blob/${encodeURIComponent(revision)}/${readme.path}`))}><Icon name="file" size={14} />README.md</Link>}><article><PackageReadme pkg={pkg} source={readme.content} revision={revision} /></article></Box>}</div><PackageSidebar pkg={pkg} /></div>
  </>
}
export const PackageHomeSignedOut = ({ pkg, revision }: { pkg: PackageInfo; revision: string }) => <PackageHomeReady pkg={pkg} revision={revision} />

export const PackageHome = ({ slug }: { slug: string }) => {
  const location = useLocation()
  const query = new URLSearchParams(location.split("?")[1])
  const { flags } = useMock()
  const revision = query.get("ref") ?? repo.defaultBranch
  const read = useRead(`package:${repo.slug}:${revision}:${slug}`)
  const pkg = repo.config.packages?.find(value => packageSlug(value) === slug)
  return <RepoFrame tab="packages" title={`${pkg?.name ?? slug} · ${repo.slug}`} askContext={`${pkg?.name ?? slug} at ${revision}`}>
    {read.state === "loading" ? <PackageHomeLoading /> : read.state === "error" ? <PackageHomeFailed retry={read.retry} /> : !pkg ? <PackageHomeMissing slug={slug} /> : flags.data === "empty" ? <PackageHomeEmpty /> : flags.as === "out" ? <PackageHomeSignedOut pkg={pkg} revision={revision} /> : <PackageHomeReady pkg={pkg} revision={revision} />}
  </RepoFrame>
}

