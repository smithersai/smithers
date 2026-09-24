#!/usr/bin/env node
/**
 * Batch-seeds the closed-alpha allowlist (readiness audit §7.9): the invite
 * mechanics work end to end (auth.request-access -> admin.allowlist.add) but
 * only one login at a time through the UI's `admin.allowlist.add <login>`
 * flow. This script issues the same identity-worker admin call the product
 * Worker's POST /api/admin/allowlist route forwards (index.ts's
 * forwardAdminCall to /api/identity/admin/allowlist), batched over a file or
 * comma list of GitHub logins — it talks to the identity worker directly, so
 * it needs the identity admin credential, not a browser admin session.
 *
 * Usage:
 *   node scripts/seed-allowlist.mjs --logins alice,bob,carol
 *   node scripts/seed-allowlist.mjs --file invitees.txt
 *   node scripts/seed-allowlist.mjs --file invitees.txt --dry-run
 *   node scripts/seed-allowlist.mjs --logins alice --action remove
 *
 * Credentials (skipped entirely in --dry-run):
 *   IDENTITY_UPSTREAM_URL   the identity worker (matches the var name in wrangler.jsonc)
 *   IDENTITY_ADMIN_TOKEN    identity's ADMIN_SERVICE_TOKEN (a wrangler secret, never a var)
 */

import { readFileSync } from "node:fs";

const USAGE = `Usage: node scripts/seed-allowlist.mjs (--logins a,b,c | --file path) [--action add|remove] [--dry-run] [--requester login] [--timeout-ms 15000]

Batch-adds (or removes) GitHub logins on the closed-alpha allowlist, one identity-worker
admin call per login. Credentials come from IDENTITY_UPSTREAM_URL / IDENTITY_ADMIN_TOKEN
(the same names wrangler.jsonc and src/index.ts use); --upstream overrides only the URL. --dry-run
needs neither and never makes a network call.`;

const parseArgs = (argv) => {
	const args = { action: "add", dryRun: false };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		// `pnpm run <script> -- --foo` forwards the literal `--` (npm strips it, pnpm does not).
		if (arg === "--") continue;
		if (arg === "--dry-run") args.dryRun = true;
		else if (arg === "--logins") args.logins = argv[(i += 1)];
		else if (arg === "--file") args.file = argv[(i += 1)];
		else if (arg === "--action") args.action = argv[(i += 1)];
		else if (arg === "--requester") args.requester = argv[(i += 1)];
		else if (arg === "--upstream") args.upstream = argv[(i += 1)];
		else if (arg === "--timeout-ms") args.timeoutMs = Number(argv[(i += 1)]);
		else if (arg === "--help" || arg === "-h") args.help = true;
		else throw new Error(`Unknown argument: ${arg}\n\n${USAGE}`);
	}
	return args;
};

const readLogins = (args) => {
	const raw = args.file !== undefined ? readFileSync(args.file, "utf8") : args.logins;
	if (raw === undefined) throw new Error(`Provide --logins <comma list> or --file <path>.\n\n${USAGE}`);
	return raw
		.split(/[,\n]/)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0 && !entry.startsWith("#"));
};

const seedOne = async (upstream, token, requester, action, login, timeoutMs) => {
	const timestamp = new Date().toISOString();
	try {
		const response = await fetch(new URL("/api/identity/admin/allowlist", upstream).toString(), {
			method: "POST",
			signal: AbortSignal.timeout(timeoutMs),
			headers: { "content-type": "application/json", "x-smithers-admin-token": token },
			body: JSON.stringify({ login, action, requester, timestamp }),
		});
		const body = await response.text();
		return { login, ok: response.ok, detail: `${response.status} ${body}` };
	} catch (error) {
		return { login, ok: false, detail: error instanceof Error && error.name === "TimeoutError" ? `no response within ${timeoutMs} ms` : error instanceof Error ? error.message : String(error) };
	}
};

const main = async () => {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		console.log(USAGE);
		return;
	}
	if (args.action !== "add" && args.action !== "remove") {
		throw new Error(`--action must be "add" or "remove", got ${JSON.stringify(args.action)}`);
	}
	const timeoutMs = args.timeoutMs ?? 15000;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) throw new Error("--timeout-ms must be a positive integer no greater than 2147483647");
	const logins = readLogins(args);
	if (logins.length === 0) throw new Error("No logins to seed.");

	if (args.dryRun) {
		console.log(`[dry-run] would ${args.action} ${logins.length} login(s), no network call made:`);
		for (const login of logins) console.log(`  ${args.action} ${login}`);
		return;
	}

	const upstream = args.upstream ?? process.env.IDENTITY_UPSTREAM_URL;
	const token = process.env.IDENTITY_ADMIN_TOKEN;
	if (upstream === undefined || upstream === "") {
		throw new Error(
			"IDENTITY_UPSTREAM_URL is unset (env var or --upstream). Use --dry-run to preview without credentials.",
		);
	}
	if (token === undefined || token === "") {
		throw new Error("IDENTITY_ADMIN_TOKEN is unset (environment variable). Use --dry-run to preview without credentials.");
	}
	const requester = args.requester ?? process.env.SEED_REQUESTER ?? "seed-allowlist-script";

	const results = [];
	for (const login of logins) {
		results.push(await seedOne(upstream, token, requester, args.action, login, timeoutMs));
	}

	for (const result of results) {
		console.log(`${result.ok ? "ok  " : "FAIL"} ${args.action} ${result.login} — ${result.detail}`);
	}
	const failed = results.filter((result) => !result.ok);
	if (failed.length > 0) {
		console.error(`\n${failed.length}/${results.length} failed.`);
		process.exitCode = 1;
	} else {
		console.log(`\n${results.length}/${results.length} succeeded.`);
	}
};

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
