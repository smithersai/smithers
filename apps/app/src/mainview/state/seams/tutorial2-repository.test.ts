import { expect, test } from "bun:test"
import { rankTutorialRepositories } from "./RepositoriesSeam"
const now = Date.parse("2026-09-09T00:00:00Z")
const commit = (sha: string, login = "will", date = "2026-09-01T00:00:00Z") => ({ sha, author: { login }, commit: { author: { date } } })
test("authored distinct SHAs rank above recent pushes, paginate and ignore other authors and old dates", async () => {
  const urls: string[] = []
  const result = await rankTutorialRepositories(async url => {
    urls.push(url)
    const u = new URL(url)
    if (!u.pathname.endsWith("commits")) return Response.json([{ full_name: "org/recent", pushed_at: "2026-09-09" }, { full_name: "org/contributed", pushed_at: "2020-01-01" }])
    if (u.pathname.includes("recent")) return Response.json([commit("x")])
    return u.searchParams.get("page") === "1"
      ? Response.json([commit("a"), commit("a"), commit("other", "other"), commit("old", "will", "2020-01-01")], { headers: { link: '<https://api.github.com/ignored>; rel="next"' } })
      : Response.json([commit("b"), commit("a")])
  }, "https://local.test", "will", now)
  expect(result.repositories.map(r => [r.fullName, r.count])).toEqual([["org/contributed", 2], ["org/recent", 1]])
  expect(result.partial).toBe(true)
  expect(urls.every(url => url.startsWith("https://local.test/"))).toBe(true)
  expect(new Set(urls.filter(u => u.includes("commits")).map(u => new URL(u).searchParams.get("since"))).size).toBe(1)
})
test("permission failures are unknown, not zero", async () => {
  const result = await rankTutorialRepositories(async url => url.includes("commits") ? new Response("", { status: 403 }) : Response.json([{ full_name: "org/private" }]), "", "will", now)
  expect(result.repositories[0]?.count).toBeNull()
  expect(result.repositories[0]?.coverage).toBe("unknown")
})
test("equal counts use latest authored date then lexical full name", async () => {
  const result = await rankTutorialRepositories(async url => {
    if (!url.includes("commits")) return Response.json([{ full_name: "org/z" }, { full_name: "org/old" }, { full_name: "org/a" }])
    return Response.json([commit("one", "will", url.includes("/old/") ? "2026-08-01T00:00:00Z" : "2026-09-01T00:00:00Z")])
  }, "", "will", now)
  expect(result.repositories.map(row => row.fullName)).toEqual(["org/a", "org/z", "org/old"])
})
