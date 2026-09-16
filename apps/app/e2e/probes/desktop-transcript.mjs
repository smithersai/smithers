import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

const css = ['styles/base.css', 'styles/cards.css']
  .map(path => readFileSync(new URL(`../../src/mainview/${path}`, import.meta.url), 'utf8')).join('\n')
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
  await page.setContent(`<style>${css}</style><main style="height:600px;overflow:auto" class="smithers-transcript">
    <section class="smithers-card" data-maximized="false" data-control-focus="inline">
      <header class="smithers-card-header">Desktop</header><div class="smithers-card-body"><div class="world-card-list">
        <div class="workspace-desktop"><iframe class="workspace-desktop-frame" srcdoc="Desktop"></iframe></div>
      </div></div></section><p>What can I do next?</p><div style="height:1200px">A later answer</div></main>`)
  const card = page.locator('.smithers-card')
  const before = await card.boundingBox()
  await page.mouse.move(1150, 500)
  await page.mouse.wheel(0, 650)
  await page.waitForFunction(() => document.querySelector('main').scrollTop > 500)
  const after = await card.boundingBox()
  assert(after.y < before.y - 500, 'Embedded desktop must move with the transcript')
  assert.equal(await page.locator('.control-focus-dim').count(), 0)
  assert.equal(await card.evaluate(el => getComputedStyle(el).boxShadow.includes('24px')), false)
  console.log('PASS: focused embedded desktop scrolls away with later messages and has no modal elevation')
} finally { await browser.close() }
