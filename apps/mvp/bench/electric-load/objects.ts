// `node bench/electric-load/objects.ts <from ISO> <to ISO>`, with CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN set:
// what the run cost the deployment's Workers and its one Electric Durable Object, from Cloudflare's GraphQL analytics
// (workersInvocationsAdaptive, durableObjectsInvocationsAdaptiveGroups, durableObjectsPeriodicGroups): ChatApi and
// gateway invocations by status, object requests by status, and the object's CPU per request. Analytics trail by about
// a minute. Prints counts only, never the token or a raw response.
const [from, to] = process.argv.slice(2)
const account = process.env.CLOUDFLARE_ACCOUNT_ID
const token = process.env.CLOUDFLARE_API_TOKEN
if (from === undefined || to === undefined || account === undefined || token === undefined) {
  throw new Error("usage: CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… objects.ts <from ISO> <to ISO>")
}
const CHATAPI = "smithers-mvp-chatapi-prod"
const GATEWAY = "smithers-mvp-electricgateway-prod"

const window = `datetime_geq:"${new Date(from).toISOString()}", datetime_leq:"${new Date(to).toISOString()}"`
const query = `{ viewer { accounts(filter:{accountTag:"${account}"}) {
  workers: workersInvocationsAdaptive(limit:500, filter:{${window}}) { sum { requests } dimensions { scriptName status } }
  objects: durableObjectsInvocationsAdaptiveGroups(limit:500, filter:{${window}}) { sum { requests } dimensions { scriptName namespaceId status } }
  periodic: durableObjectsPeriodicGroups(limit:500, filter:{${window}}) { sum { cpuTime activeTime } dimensions { namespaceId } }
} } }`
const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({ query }),
})
interface Row<D> { readonly sum: Record<string, number>; readonly dimensions: D }
const body = await response.json() as {
  errors?: ReadonlyArray<unknown>
  data?: { viewer: { accounts: ReadonlyArray<{
    workers: ReadonlyArray<Row<{ scriptName: string; status: string }>>
    objects: ReadonlyArray<Row<{ scriptName: string; namespaceId: string; status: string }>>
    periodic: ReadonlyArray<Row<{ namespaceId: string }>>
  }> } }
}
const data = body.data?.viewer.accounts[0]
if (body.errors?.length || data === undefined) throw new Error(`analytics unreadable (HTTP ${response.status})`)

const byStatus = <D extends { scriptName: string; status: string }>(rows: ReadonlyArray<Row<D>>, script: string) => {
  const counts: Record<string, number> = {}
  for (const row of rows.filter((r) => r.dimensions.scriptName.startsWith(script))) {
    counts[row.dimensions.status] = (counts[row.dimensions.status] ?? 0) + row.sum.requests!
  }
  return counts
}
const total = (counts: Record<string, number>) => Object.values(counts).reduce((a, b) => a + b, 0)
const chatapi = byStatus(data.workers, CHATAPI)
const gateway = byStatus(data.workers, GATEWAY)
const objects = byStatus(data.objects, GATEWAY)
const namespaces = new Set(data.objects.filter((r) => r.dimensions.scriptName.startsWith(GATEWAY)).map((r) => r.dimensions.namespaceId))
const cpuMicros = data.periodic.filter((r) => namespaces.has(r.dimensions.namespaceId)).reduce((n, r) => n + r.sum.cpuTime!, 0)
console.log(JSON.stringify({
  chatapi,
  gateway,
  objects,
  objectRequests: total(objects),
  objectCpuMsPerRequest: total(objects) === 0 ? null : Math.round(cpuMicros / 1000 / total(objects) * 10) / 10,
}))
