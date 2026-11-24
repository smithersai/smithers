import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { setImmediate } from "node:timers/promises"
import { runInNewContext } from "node:vm"

const page = readFileSync(new URL("../src/pages/demo/index.astro", import.meta.url), "utf8")
const script = page.match(/<script define:vars=\{\{ endpoint \}\}>([\s\S]*?)<\/script>/)[1]

let submissions = 0
const RECEIPT = "01kabcdefghjkmnpqrstvwxyz0"
/** The intake's receipt for a stored request. */
const stored = () => ({ ok: true, status: 201, json: async () => ({ id: RECEIPT }) })

function mount(t, fetch, timeoutName = "TimeoutError") {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const values = { firstName: " Jane ", lastName: "Smith", workEmail: "jane@example.com", message: "A demo, please" }
  const classes = new Set()
  const status = { textContent: "", classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name) } }
  const label = { textContent: "Continue" }
  const button = { disabled: false, querySelector: () => label }
  const thanks = { hidden: true }
  let submit
  const form = {
    hidden: false,
    values,
    reportValidity: () => true,
    querySelector: (selector) => selector === "[data-status]" ? status : button,
    addEventListener: (name, handler) => { assert.equal(name, "submit"); submit = handler }
  }
  runInNewContext(script, {
    document: { querySelector: (selector) => selector === "#demo-form" ? form : thanks },
    FormData: class { constructor(form) { return Object.entries(form.values) } },
    endpoint: "https://intake.example.test/api/demo-requests",
    fetch,
    crypto: { randomUUID: () => `submission-${++submissions}-0000-0000-000000000000` },
    AbortSignal: {
      // Native AbortSignal.timeout uses an internal clock; bind it to the test clock.
      timeout(ms) {
        const controller = new AbortController()
        setTimeout(() => controller.abort(new DOMException("Timed out", timeoutName)), ms)
        return controller.signal
      }
    }
  })
  return { form, thanks, button, label, status, classes, submit: () => submit({ preventDefault() {} }) }
}

for (const timeoutName of ["TimeoutError", "AbortError"]) {
  test(`a stalled request restores retry controls and retains values on ${timeoutName}`, async (t) => {
    let requests = 0
    const ui = mount(t, (_url, { signal }) => {
      if (++requests > 1) return Promise.resolve(stored())
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
      })
    }, timeoutName)
    const entered = { ...ui.form.values }
    const pending = ui.submit()
    assert.equal(ui.button.disabled, true)
    assert.equal(ui.label.textContent, "Sending…")
    t.mock.timers.tick(19_999)
    await setImmediate()
    assert.equal(ui.button.disabled, true)
    t.mock.timers.tick(1)
    await setImmediate()
    assert.equal(ui.button.disabled, false)
    assert.equal(ui.label.textContent, "Continue")
    assert.match(ui.status.textContent, /timed out.*try again/i)
    assert.equal(ui.classes.has("error"), true)
    assert.equal(ui.form.hidden, false)
    assert.equal(ui.thanks.hidden, true)
    assert.deepEqual(ui.form.values, entered)
    await pending
    await ui.submit()
    assert.equal(requests, 2)
    assert.equal(ui.form.hidden, true)
    assert.equal(ui.thanks.hidden, false)
    assert.equal(ui.status.textContent, "")
    assert.equal(ui.classes.has("error"), false)
  })
}

test("successful submission sends trimmed values and restores controls", async (t) => {
  let request
  const ui = mount(t, async (url, options) => { request = { url, options }; return stored() })
  await ui.submit()
  assert.equal(request.url, "https://intake.example.test/api/demo-requests")
  assert.equal(request.options.method, "POST")
  assert.deepEqual(Object.keys(request.options.headers), ["content-type"])
  assert.equal(request.options.headers["content-type"], "application/json")
  const { submissionId, ...sent } = JSON.parse(request.options.body)
  assert.deepEqual(sent, { ...ui.form.values, firstName: "Jane" })
  assert.match(submissionId, /^[A-Za-z0-9_-]{16,128}$/)
  assert.equal(ui.form.hidden, true)
  assert.equal(ui.thanks.hidden, false)
  assert.equal(ui.button.disabled, false)
  assert.equal(ui.label.textContent, "Continue")
})

for (const failure of ["network", "http"]) {
  test(`${failure} failure restores controls and retains values`, async (t) => {
    const ui = mount(t, async () => {
      if (failure === "network") throw new TypeError("Failed to fetch")
      return { ok: false, status: 503 }
    })
    const entered = { ...ui.form.values }
    await ui.submit()
    assert.equal(ui.button.disabled, false)
    assert.equal(ui.label.textContent, "Continue")
    assert.match(ui.status.textContent, /Something went wrong/)
    assert.equal(ui.classes.has("error"), true)
    assert.equal(ui.form.hidden, false)
    assert.equal(ui.thanks.hidden, true)
    assert.deepEqual(ui.form.values, entered)
  })
}

for (const [name, answer] of [
  ["a 200 HTML page", { ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token <") } }],
  ["a 201 without a receipt", { ok: true, status: 201, json: async () => ({}) }],
  ["a 201 with a malformed receipt", { ok: true, status: 201, json: async () => ({ id: "<b>x</b>" }) }]
]) {
  test(`${name} is not a stored request: the form stays and says so`, async (t) => {
    const ui = mount(t, async () => answer)
    const entered = { ...ui.form.values }
    await ui.submit()
    assert.match(ui.status.textContent, /Something went wrong/)
    assert.equal(ui.form.hidden, false)
    assert.equal(ui.thanks.hidden, true)
    assert.deepEqual(ui.form.values, entered)
  })
}

test("a retry after a lost response resends the same submission id and accepts the original receipt", async (t) => {
  const bodies = []
  const ui = mount(t, async (_url, options) => {
    bodies.push(JSON.parse(options.body))
    // The first write committed, but its response was lost.
    if (bodies.length === 1) throw new TypeError("Failed to fetch")
    return stored()
  })
  await ui.submit()
  assert.equal(ui.form.hidden, false)
  await ui.submit()
  assert.equal(bodies.length, 2)
  assert.equal(bodies[1].submissionId, bodies[0].submissionId)
  assert.equal(ui.form.hidden, true)
  assert.equal(ui.thanks.hidden, false)
})
