import { expect, test } from '@playwright/test'

test.use({ contextOptions: { reducedMotion: 'reduce' } })

test('Mode selects on release, dismisses accessibly, persists, and Vim navigates without activating', async ({ page }) => {
  await page.goto('/')
  const mode = page.getByRole('button', { name: 'Mode: Normal', exact: true })
  await expect(mode).toBeVisible()
  await page.keyboard.down('m')
  await expect(mode).toHaveAttribute('data-pressed', '')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await page.keyboard.up('m')
  await expect(page.getByRole('menuitemradio', { name: 'Normal' })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.down('Enter')
  await expect(page.getByRole('menuitemradio', { name: 'Vim' })).toHaveAttribute('aria-checked', 'false')
  await page.keyboard.up('Enter')
  await expect(page.getByRole('button', { name: 'Mode: Vim', exact: true })).toBeFocused()
  await expect(page.getByTestId('composer-input')).toBeHidden()
  const issues = page.getByRole('button', { name: 'Show issues', exact: true })
  const changes = page.getByRole('button', { name: 'Review changes', exact: true })
  await issues.focus()
  await page.keyboard.down('l')
  await expect(issues).toBeFocused()
  await expect(changes).toHaveAttribute('data-pressed', '')
  await page.keyboard.up('l')
  await expect(changes).toBeFocused()
  await expect(page.locator('.guide-shell')).toHaveAttribute('data-stage', '1')
  await page.keyboard.press('h')
  await expect(issues).toBeFocused()
  await page.keyboard.press('m')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Mode: Vim', exact: true })).toBeFocused()
  await page.keyboard.press('m')
  await page.locator('.guide-goal').click()
  await expect(page.getByRole('menu')).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole('button', { name: 'Mode: Vim', exact: true })).toBeVisible()
  await page.keyboard.press('c')
  const input = page.getByTestId('composer-input')
  await expect(input).toBeFocused()
  await input.pressSequentially('chjklm')
  await expect(input).toHaveValue('chjklm')
  await expect(page.getByRole('menu')).toHaveCount(0)
})

test('switching away from Dictation stops capture without reopening Chat', async ({ page }) => {
  await page.addInitScript(() => {
    const host = window as any
    host.SpeechRecognition = class {
      onend: any
      start() { host.starts = (host.starts ?? 0) + 1 }
      stop() { this.onend?.() }
      abort() { host.aborts = (host.aborts ?? 0) + 1 }
    }
  })
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Mode: Normal', exact: true })).toBeVisible()
  await page.keyboard.press('m')
  await page.getByRole('menuitemradio', { name: 'Dictation' }).click()
  expect(await page.evaluate(() => (window as any).starts ?? 0)).toBe(0)
  await page.keyboard.press('c')
  await expect(page.getByTestId('composer-input')).toBeVisible()
  await expect.poll(() => page.evaluate(() => (window as any).starts)).toBe(1)
  await page.getByRole('button', { name: 'Mode: Dictation', exact: true }).click()
  await page.getByRole('menuitemradio', { name: 'Normal' }).click()
  await expect.poll(() => page.evaluate(() => (window as any).aborts)).toBe(1)
  await expect(page.getByRole('button', { name: 'Stop dictation' })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.keyboard.press('c')
  await expect.poll(() => page.evaluate(() => (window as any).starts)).toBe(1)
})

test('repository pages share Chat and Mode without duplicating tutorial controls', async ({ page }) => {
  await page.goto('/smithersai/smithers/')
  await expect(page.locator('.guide-shell')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Mode: Normal', exact: true })).toHaveCount(1)
  await page.keyboard.press('m')
  await page.getByRole('menuitemradio', { name: 'Vim' }).click()
  await expect(page.getByRole('button', { name: 'Mode: Vim', exact: true })).toBeVisible()
  await page.keyboard.press('c')
  await expect(page.getByTestId('composer-input')).toBeFocused()
})
