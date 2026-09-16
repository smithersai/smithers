import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

// Exercise layout and wheel hit testing with the shipped styles and card hierarchy.
const css = ['styles/base.css', 'styles/chat.css', 'styles/cards.css', 'onboarding/guide.css']
  .map(path => readFileSync(new URL(`../../src/mainview/${path}`, import.meta.url), 'utf8')).join('\n')
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage()
  for (const [width, height] of [[1440, 900], [900, 1000], [390, 844]]) {
    await page.setViewportSize({ width, height })
    await page.setContent(`<style>${css}</style><div class="guide-shell" data-step="14">
      <div class="guide-content"><div class="guide-app"><div class="app-shell" style="--chrome-bar-width:0px">
      <div class="smithers-transcript"><div class="card-maximize-backdrop"></div>
      <section class="smithers-card" data-maximized="true"><header class="smithers-card-header"><button>Restore</button></header>
      <div class="smithers-card-body"><div class="world-card-list"><p class="world-card-row">Workspace</p><div class="world-card-row">Desktop · Files</div>
      <div class="workspace-desktop"><iframe class="workspace-desktop-frame" srcdoc="<body style='height:4000px;background:teal'>Desktop</body>"></iframe><p class="world-card-row">Rotate session</p></div>
      <div class="world-card-row">Suspend · Fork · Snapshot</div></div></div></section></div></div></div>
      <main class="guide-main"><div class="guide-dialogue">You're set</div></main></div>
      <footer class="guide-footer"><button>Chat</button></footer></div>`)
    const frame = page.locator('iframe')
    const bounds = await frame.boundingBox()
    assert(bounds.height > height * .65, `Desktop should fill the content: ${JSON.stringify(bounds)}`)
    assert(bounds.width > width * .9)
    assert.equal(await page.locator('.guide-main').isVisible(), false)
    const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName,
      { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 })
    assert.equal(hit, 'IFRAME')
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
    await page.mouse.wheel(0, 400)
    await page.waitForFunction(() => document.querySelector('iframe').contentWindow.scrollY > 0)
    assert.equal(await page.locator('.smithers-transcript').evaluate(el => el.scrollTop), 0)
    assert(await page.getByRole('button', { name: 'Chat', exact: true }).isVisible())
    await page.locator('.smithers-card').evaluate(el => el.dataset.maximized = 'false')
    assert(await page.locator('.guide-main').isVisible())
    console.log(`PASS ${width}×${height}: desktop fills content, receives wheel input, restores guide`)
  }
} finally {
  await browser.close()
}
