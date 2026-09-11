import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { createControllerBoot } from "./ControllerBootMemo"
import type { AppController } from "./state/AppController"

/*
 * `use(boot)` suspends on the promise it is handed, so every render and every
 * remount of AppIsland has to receive the SAME promise: a fresh promise per
 * render re-suspends forever and the app never mounts.
 */

describe("createControllerBoot", () => {
  test("every call gets the one boot, so a remount does not re-run it", async () => {
    let loads = 0
    const boot = createControllerBoot(() => {
      loads += 1
      return Promise.resolve({ tag: loads } as unknown as AppController)
    })
    const first = boot()
    expect(boot()).toBe(first)
    expect(boot()).toBe(first)
    expect(loads).toBe(1)
    expect(((await first) as unknown as { tag: number }).tag).toBe(1)
  })

  test("the boot starts on the first render, not when the module is imported", () => {
    let loads = 0
    const boot = createControllerBoot(() => {
      loads += 1
      return Promise.resolve({} as unknown as AppController)
    })
    expect(loads).toBe(0)
    boot()
    expect(loads).toBe(1)
  })

  test("a failed boot stays cached, so the error boundary sees one failure", async () => {
    let loads = 0
    const boot = createControllerBoot(() => {
      loads += 1
      return Promise.reject(new Error("boot failed"))
    })
    const first = boot()
    expect(boot()).toBe(first)
    expect(loads).toBe(1)
    await expect(first).rejects.toThrow("boot failed")
  })
})

/*
 * The app has two browser-only hosts and no server entry: main.tsx renders
 * AppIsland into `#root` for the Vite build, and apps/site renders it as an
 * Astro `client:only` island. The boot chain used to serve a TanStack Start
 * SSR entry that serialized an identity answer into the document; the entry is
 * gone, so no module may name it or carry the session it hydrated.
 */
describe("the boot chain names only the hosts that exist", () => {
  const bootModules = [
    "AppIsland.tsx",
    "ControllerBoot.client.ts",
    "ControllerBootMemo.ts",
    "ControllerProvider.tsx",
    "SessionShell.tsx",
    "StartupWatchdog.ts"
  ]

  test("no module mentions the removed Start entry or its serialized session", async () => {
    const offenders: Array<string> = []
    for (const name of bootModules) {
      const source = await readFile(`${import.meta.dir}/${name}`, "utf8")
      if (/routes\/__root|Start entry|Start document|ClientOnly|react-start|BootSession/.test(source)) {
        offenders.push(name)
      }
    }
    expect(offenders).toEqual([])
  })
})
