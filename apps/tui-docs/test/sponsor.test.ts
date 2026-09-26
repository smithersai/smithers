import assert from "node:assert/strict"
import { test } from "node:test"
import { cheapest, Sponsor } from "../server/sponsor.mjs"
const model = { id: "cheap", context_length: 32768, pricing: { prompt: "0.000001", completion: "0.000002" } }
const request = (cookie = "smithers_demo=00000000-0000-0000-0000-000000000000", text = "fix") =>
  new Request("https://docs.test/api/playground/model", {
    method: "POST",
    headers: { Origin: "https://docs.test", Cookie: cookie },
    body: JSON.stringify({ messages: [{ role: "user", content: text }], model: "expensive", max_tokens: 100000 })
  })
test("chooses current lowest price and refuses unknown or negative pricing", () => {
  assert.equal(
    cheapest([model, { ...model, id: "free", pricing: { prompt: "0", completion: "0" } }, {
      ...model,
      id: "broken",
      pricing: {}
    }, { ...model, id: "negative", pricing: { prompt: "-1", completion: "0" } }]).id,
    "free"
  )
})
test("durable reservations, fixed output limits, retries, and same-origin gate", async () => {
  let calls = 0
  const sponsor = new Sponsor({
    key: "test-secret",
    database: ":memory:",
    dailyCalls: 1,
    fetchImpl: async (url, init) => {
      if (url.endsWith("/models")) return Response.json({ data: [model] })
      calls++
      assert.equal(init.headers.Authorization, "Bearer test-secret")
      const body = JSON.parse(init.body)
      assert.equal(body.model, "cheap")
      assert.equal(body.max_tokens, 2048)
      return Response.json({ choices: [{ finish_reason: "stop", message: { content: "answer" } }] })
    }
  })
  try {
    assert.equal((await sponsor.handle(request(), "https://wrong.test")).status, 403)
    const response = await sponsor.handle(request(), "https://docs.test")
    assert.equal(response.status, 200)
    assert.equal((await response.text()).includes("test-secret"), false)
    assert.equal((await sponsor.handle(request(), "https://docs.test")).status, 200)
    assert.equal(calls, 1)
    assert.equal((await sponsor.handle(request(undefined, "another"), "https://docs.test")).status, 429)
    assert.equal(sponsor.db.prepare("SELECT count(*) AS n FROM attempts").get().n, 1)
  } finally {
    sponsor.close()
  }
})
test("missing sponsored credentials fail honestly without a model request", async () => {
  const sponsor = new Sponsor({
    database: ":memory:",
    fetchImpl: () => {
      throw new Error("must not call")
    }
  })
  try {
    assert.equal((await sponsor.handle(request(), "https://docs.test")).status, 503)
  } finally {
    sponsor.close()
  }
})
