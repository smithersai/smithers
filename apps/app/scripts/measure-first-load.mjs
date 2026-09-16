// Start `SMITHERS_LOCAL_PORT=47311 bun e2e/playwright/webserver.ts` first.
// FIRST_LOAD_URL=http://127.0.0.1:47311/ bun scripts/measure-first-load.mjs /tmp/cold.json [original-built-worker.js]
// Optional worker snapshot alternates before/after against the SAME built app.
import { chromium } from 'playwright'
import { readFileSync, writeFileSync } from 'node:fs'

const [output = '/tmp/smithers-cold.json', baselineWorker] = process.argv.slice(2)
const baseURL = process.env.FIRST_LOAD_URL ?? 'http://127.0.0.1:47311/'
const browser = await chromium.launch({ headless: true })
const results = []
try {
  for (let run = 0; run < (baselineWorker ? 6 : 3); run++) {
    const context = await browser.newContext()
    const variant = baselineWorker && run % 2 === 0 ? 'before' : 'after'
    if (variant === 'before') {
      await context.route('**/opfs-worker-*.js', route => route.fulfill({
        contentType: 'text/javascript', body: readFileSync(baselineWorker, 'utf8'),
      }))
    }
    const page = await context.newPage()
    const cdp = await context.newCDPSession(page)
    await cdp.send('Network.enable')
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true })
    const requests = [], errors = []
    cdp.on('Network.requestWillBeSent', e => requests.push({
      url: e.request.url, time: e.timestamp, initiator: e.initiator.type, resourceType: e.type,
    }))
    page.on('pageerror', error => errors.push(error.message))
    await page.addInitScript(() => {
      const stats = window.__firstLoad = { marks: {}, longTasks: [], workerMessages: [] }
      new PerformanceObserver(list => stats.longTasks.push(...list.getEntries().map(e => e.toJSON())))
        .observe({ type: 'longtask', buffered: true })
      const NativeWorker = window.Worker
      window.Worker = class extends NativeWorker {
        constructor(...args) {
          super(...args)
          const pending = new Map(), post = this.postMessage.bind(this)
          this.postMessage = (message, ...rest) => {
            const row = { type: message.type, sql: message.sql, start: performance.now() }
            stats.workerMessages.push(row)
            pending.set(message.requestId, row)
            post(message, ...rest)
          }
          this.addEventListener('message', event => {
            const row = pending.get(event.data.requestId)
            if (row) row.end = performance.now()
          })
        }
      }
      document.addEventListener('focusin', event => {
        if (event.target.matches('[data-testid="composer-input"]')) stats.marks.composerFocused = performance.now()
      })
      document.addEventListener('input', () => { stats.marks.input = performance.now() }, { once: true })
      const visible = (node) => {
        if (!node || !node.getClientRects().length) return false
        for (let el = node; el; el = el.parentElement) {
          const style = getComputedStyle(el)
          if (Number(style.opacity) < .99 || style.visibility === 'hidden') return false
        }
        return true
      }
      const probe = () => {
        const card = document.querySelector('.first-run-actions')
        const actions = document.querySelector('.first-run-actions')
        if (!stats.marks.cardVisible && visible(card)) stats.marks.cardVisible = performance.now()
        if (!stats.marks.navigationVisible && visible(actions)) stats.marks.navigationVisible = performance.now()
        if (stats.marks.cardVisible && stats.marks.navigationVisible) {
          const button = actions.querySelector('button:not(:disabled)')
          button?.focus()
          if (document.activeElement === button) stats.marks.keyboardReady = performance.now()
        } else requestAnimationFrame(probe)
      }
      requestAnimationFrame(probe)
      new MutationObserver(() => {
        if (!stats.marks.app && document.querySelector('.app-shell')) {
          stats.marks.app = performance.now()

        }
      }).observe(document, { childList: true, subtree: true })
    })
    try {
    await page.goto(baseURL, { waitUntil: 'domcontentloaded' })
    await page.locator('.app-shell').waitFor({ timeout: 60_000 })
    await page.waitForFunction(() => window.__firstLoad.marks.keyboardReady, undefined, { timeout: 60_000 })
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => document.querySelector('.first-run-actions') === null)
    await page.evaluate(() => { window.__firstLoad.marks.keyboardActivationVerified = performance.now() })
    } catch (error) { errors.push(error.message) }
    await page.waitForTimeout(150)
    const data = await page.evaluate(() => ({
      ...window.__firstLoad,
      navigation: performance.getEntriesByType('navigation')[0].toJSON(),
      resources: performance.getEntriesByType('resource').map(e => e.toJSON()),
      paint: performance.getEntriesByType('paint').map(e => e.toJSON()),
      html: document.body.innerText.slice(0, 1000),
      backend: localStorage.getItem('smithers-mvp.persistenceBackend'),
    }))
    results.push({ run, variant, ...data, requests, errors })
    writeFileSync(output, JSON.stringify(results, null, 2) + '\n')
    console.log(JSON.stringify({ run, variant, marks: data.marks, backend: data.backend, errors }))
    await context.close()
  }
} finally {
  await browser.close()
}
