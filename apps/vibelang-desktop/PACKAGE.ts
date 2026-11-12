// Stays .ts: smthrs discovers build declarations only in files named PACKAGE.ts.
import { Smithers } from "@smthrs/targets"
import { Package as web } from "../vibelang/PACKAGE.ts"
const sources = [Smithers.glob("//apps/vibelang-desktop/src/**"), Smithers.glob("//apps/vibelang-desktop/test/**"), Smithers.glob("//apps/vibelang-desktop/e2e/**"), Smithers.glob("//apps/vibelang-desktop/*.ts"), Smithers.glob("//apps/vibelang-desktop/verify/*.vibe"), Smithers.file("//apps/vibelang-desktop/package.json"), web.typecheck]
const typecheck = Smithers.Shell.Test({ summary: "Typecheck the native host and shared Foldkit wrapper.", shell: "cd apps/vibelang-desktop && pnpm typecheck", data: sources, timeout: "10m" })
const test = Smithers.Shell.Test({ summary: "Exercise desktop admission, controls, real folders and faulty HTTP services.", shell: "cd apps/vibelang-desktop && pnpm test", data: sources, timeout: "10m" })
const verify = Smithers.Shell.Test({ summary: "Prove local endpoint, model availability and file admission contracts.", shell: "cd apps/vibelang-desktop && pnpm verify", data: [...sources, web.verify], timeout: "10m" })
// Linux only: Xvfb, GTK 3, WebKitGTK 4.1 and flock (README). Only the test build opens the CDP port the suite drives.
const e2e = Smithers.Shell.Test({ summary: "Run the native app under Xvfb: crash recovery, folder authority, the real picker and a local model.", shell: "cd apps/vibelang-desktop && VIBELANG_DESKTOP_TEST=1 pnpm build && pnpm e2e", data: sources, timeout: "30m", exclusive: true, sandbox: { network: "loopback" } })
const verifyBroken = Smithers.Shell.Test({ summary: "Check that every mutation of a policy decision fails a proof obligation.", shell: "cd apps/vibelang-desktop && pnpm verify:broken", data: [...sources, web.verify], timeout: "30m" })
export const Package = Smithers.Package({ targets: { typecheck, test, verify, e2e, verifyBroken } })
