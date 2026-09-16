import { expect, test, type Page } from "@playwright/test"

async function repository(page: Page) {
  await page.setViewportSize({ width: 1280, height: 600 })
  await page.route('**/api/bootstrap', route => route.fulfill({ json: {
    apiVersion: 1, host: 'cloud', version: 'test', buildSha: 'test', capabilities: ['identity', 'cloud'], authFlow: 'redirect', sandbox: null,
  } }))
  await page.route('**/api/auth/session', route => route.fulfill({ json: { status: 'signed-in', login: 'reader', allowlisted: true, admin: false } }))
  await page.route('**/api/public/repos', route => route.fulfill({ json: { repos: [{ name: 'smithersai/smithers' }, { name: 'acme/second' }] } }))
  await page.route(/\/api\/repos\/[^/]+\/[^/?]+$/, route => route.fulfill({ json: { default_bookmark: 'main' } }))
  await page.route('**/contents/.smithers/home.json', route => route.fulfill({ json: {
    type: 'file', encoding: 'utf-8', content: JSON.stringify({ blocks: [{ type: 'text', text: 'Home introduction. ' + 'A long repository description. '.repeat(180) }] }),
  } }))
  await page.route(/\/api\/.*issues(?:\?|$)/, route => route.fulfill({ json: [] }))
}
const home = (page: Page, repo: string) => page.getByTestId(`card-repo-home-${repo}`).locator('.smithers-card-title')

test('arrival shows the current Home heading, and /issues reveals its new card', async ({ page }) => {
  await repository(page)
  await page.goto('/smithersai/smithers/')
  await expect(home(page, 'smithersai/smithers')).toBeInViewport({ ratio: 1 })
  await page.keyboard.press('Meta+k')
  await page.getByTestId('composer-input').fill('/issues')
  await page.keyboard.press('Enter')
  const issues = page.locator('.smithers-transcript .smithers-card[data-kind="issue-list"]')
  await expect(issues).toBeInViewport({ ratio: 1 })
  await page.goto('/acme/second/')
  await expect(home(page, 'acme/second')).toBeInViewport({ ratio: 1 })
  await page.reload()
  await expect(home(page, 'acme/second')).toBeInViewport({ ratio: 1 })
})

test('an oversized card opens at its heading and scrolling up releases follow', async ({ page }) => {
  await repository(page)
  await page.goto('/smithersai/smithers/')
  await expect(home(page, 'smithersai/smithers')).toBeInViewport({ ratio: 1 })
  await page.keyboard.press('Meta+k')
  await page.getByTestId('composer-input').fill('/repo.home acme/second')
  await page.keyboard.press('Enter')
  await expect(home(page, 'acme/second')).toBeInViewport({ ratio: 1 })
  const scroller = page.locator('.smithers-transcript [data-slot="message-scroller-viewport"]')
  await scroller.hover()
  await page.mouse.wheel(0, -350)
  await expect(page.getByRole('button', { name: 'Jump to latest' })).toHaveAttribute('data-active', 'true')
  const position = await scroller.evaluate(node => node.scrollTop)
  // Resizing remeasures the read but must respect the released pin.
  await page.setViewportSize({ width: 1280, height: 650 })
  await expect.poll(() => scroller.evaluate(node => node.scrollTop)).toBe(position)
  await page.getByRole('button', { name: 'Jump to latest' }).click()
  await expect(page.getByRole('button', { name: 'Jump to latest' })).toHaveAttribute('data-active', 'false')
})
