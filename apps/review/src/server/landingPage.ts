import { standaloneThemeCss } from "@smthrs/ui-styleguide";

export const landingPage = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>smithers review</title>
<style>
${standaloneThemeCss()}
main { max-width: 720px; margin: 0 auto; padding: 64px 24px; }
h1 { font-size: 28px; margin: 0 0 8px; }
p { max-width: 65ch; }
</style>
</head>
<body>
<main>
<h1>smithers review</h1>
<p>Code review plus story-form walkthroughs for repos that want an unlisted, shareable review artifact.</p>
<h2>Publish a walkthrough</h2>
<p>Run from a registered repo:</p>
<pre><code>smithers-review --from main --to HEAD --publish</code></pre>
<p>The publish response returns an unlisted walkthrough URL such as <code>https://review.example/w/&lt;id&gt;</code>.</p>
<h2>Get access</h2>
<p>Install the GitHub Action so GitHub OIDC can mint a short-lived session with <code>POST /api/sessions</code>. An operator registers the repo before the action can publish walkthroughs.</p>
<h2>Check plan &amp; quota</h2>
<p>Use <code>GET /api/plan</code> from an authorized session to see the repo plan and current usage.</p>
<p>Part of <a href="https://github.com/smithersai/smithers">smithers</a>.</p>
</main>
</body>
</html>`;
