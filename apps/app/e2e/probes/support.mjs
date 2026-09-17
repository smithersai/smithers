// Shared by the probes in this directory: the one sanctioned browser profile is
// leased before it is opened, and a sign-in door counts only when it is visible.
import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { link, realpath, unlink, writeFile } from "node:fs/promises";

// The chrome door and the historical sign-in buttons an answered transcript
// step keeps in the DOM. Both are counted through `visibleDoors`.
export const SIGN_IN_DOOR = "[data-testid=chrome-sign-in], button:has-text('Sign in with GitHub')";
export const ANY_SIGN_IN_DOOR = 'button[data-flow="auth.sign-in"], button[data-flow="cloud.sign-in"], [data-testid=chrome-sign-in]';

/**
 * A door nobody can see is not a door. A hidden `auth.sign-in` button inside a
 * dismissed composer overlay matches every selector above, so a probe that
 * counts matches reads a signed-in page as signed out.
 */
export const visibleDoors = (page, selector) => page.locator(selector).filter({ visible: true });

/**
 * The atomic lease `e2e/real/auth-permissions/profile.ts` takes, so a probe and
 * a real-E2E run can never drive the same profile at once. `link(2)` publishes
 * an already-written record and refuses to replace an existing owner's inode,
 * so a held lock fails closed rather than being reaped. Releasing verifies
 * ownership first and also runs on exit, including the probe's own `fail`.
 */
export const acquireProfileLease = async (profile) => {
  const lockPath = `${await realpath(profile).catch(() => profile)}.smithers-real-e2e.lock`;
  const nonce = randomUUID();
  const record = JSON.stringify({ pid: process.pid, nonce, acquiredAt: new Date().toISOString() });
  const candidate = `${lockPath}.${process.pid}.${nonce}.candidate`;
  await writeFile(candidate, record, { flag: "wx", mode: 0o600 });
  try { await link(candidate, lockPath); }
  finally { await unlink(candidate); }
  let held = true;
  const release = () => {
    if (!held) return;
    const owner = JSON.parse(readFileSync(lockPath, "utf8"));
    if (owner.pid !== process.pid || owner.nonce !== nonce) throw new Error("Profile lease ownership changed before release");
    unlinkSync(lockPath);
    held = false;
  };
  process.once("exit", release);
  return { lockPath, release };
};
