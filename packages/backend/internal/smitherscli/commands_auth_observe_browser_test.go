package smitherscli

import (
	"context"
	"os"
	"os/exec"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// Opt-in integration test against an actual Observe server. It exercises both
// browser scripts, navigation across loopback, PKCE, session cookies and logout.
// Supply a read:admin/read:user PAT only to the test process, never as an argument.
func TestObserveBrowserIntegration(t *testing.T) {
	base, token := os.Getenv("SMITHERS_OBSERVE_BROWSER_TEST_URL"), os.Getenv("SMITHERS_OBSERVE_BROWSER_TEST_TOKEN")
	if base == "" || token == "" {
		t.Skip("requires an Observe test URL and admin PAT")
	}
	authZWithOpenBrowser(t, func(start string) error {
		ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, "bun", "-e", observeBrowserTestScript, start, base)
		output, err := cmd.CombinedOutput()
		if err != nil {
			t.Log(string(output))
		}
		return err
	})
	require.NoError(t, openObserveSession(base, token))
}

const observeBrowserTestScript = `
const {chromium} = require('playwright');
const [start, base] = process.argv.slice(1);
const browser = await chromium.launch({headless: true});
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  let callback = false, redeemed = false, consumedURL;
  page.on('pageerror', () => errors.push('browser script error'));
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.searchParams.has('token') || url.searchParams.has('ticket') || url.searchParams.has('verifier')) errors.push('credential in query');
    if (url.hostname === '127.0.0.1' && url.pathname === '/observe') callback = true;
    if (url.origin === new URL(base).origin && url.pathname === '/login/cli' && request.method() === 'POST') redeemed = true;
  });
  page.on('framenavigated', frame => { if (frame === page.mainFrame() && frame.url().includes('ticket=')) consumedURL = frame.url(); });
  await page.goto(start);
  await page.locator('nav[aria-label="Primary"]').waitFor({timeout: 60000});
  if (!callback || !redeemed || errors.length || new URL(page.url()).hash) throw new Error('browser handoff did not finish cleanly');
  const cookies = await context.cookies();
  const session = cookies.find(c => c.name === 'observe_session');
  if (!session || !session.httpOnly || session.sameSite !== 'Strict') throw new Error('missing protected session cookie');
  if (base.startsWith('https:') && !session.secure) throw new Error('missing Secure cookie');
  if (await page.evaluate(() => Object.keys(sessionStorage).some(key => key.startsWith('observe-cli:')))) throw new Error('verifier retained after login');
  if (consumedURL) {
    const other = await context.newPage();
    await other.goto(consumedURL);
    await other.waitForFunction(() => document.getElementById('login-status')?.textContent.includes('This tab did not start'));
    await other.close();
  }
  await page.locator('button', {hasText: 'Sign out'}).click();
  await page.locator('input[name="token"]').waitFor();
  console.log('Browser handoff, session, tab binding and logout passed');
} finally { await browser.close(); }
`
