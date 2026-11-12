// Stays .ts: Vite imports this configuration helper before its VibeLang plugin is installed.
import type * as Native from "#electrobun"
import { type ChildProcess, execFileSync, spawn } from "node:child_process"
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { TestProject } from "vitest/node"

export const bunRuntime = process.versions.bun !== undefined
export interface NativeFixture {
  url: string
  resources: string
  compatibility: number
  display: string
  directory: string
}
declare module "vitest" {
  export interface ProvidedContext {
    nativeFixture: NativeFixture
  }
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"

/**
 * This package's Electrobun CLI. The fixture runs it in test/native, which holds no package.json, so `pnpm exec`
 * there searches only that directory's and the workspace root's bins, and never finds it.
 */
export const electrobun = fileURLToPath(new URL("../../node_modules/.bin/electrobun", import.meta.url))

/** Observe spawn failure before polling readiness, including a tool removed after preflight. */
export const waitForNativeSpawn = (child: ChildProcess, stage: string): Promise<void> =>
  new Promise((resolve, reject) => {
    child.once("error", (cause) => reject(new Error(`Native fixture ${stage} failed to start`, { cause })))
    child.once("spawn", () => resolve())
  })

export default async function setup(project: TestProject) {
  const directory = mkdtempSync(join(tmpdir(), "sdk-native-"))
  const cwd = join(process.cwd(), "test/native")
  const children: ChildProcess[] = []
  const display = ":110"
  let output = ""
  let stopped = false
  let nativeLock: number | undefined
  const stop = async () => {
    if (stopped) return
    stopped = true
    for (const child of children.reverse()) {
      if (child.pid === undefined) continue
      const signal = (name: NodeJS.Signals) => {
        try {
          process.kill(-child.pid!, name)
        } catch {}
      }
      const alive = () => {
        try {
          process.kill(-child.pid!, 0)
          return true
        } catch {
          return false
        }
      }
      signal("SIGTERM")
      const deadline = Date.now() + 3000
      while (alive() && Date.now() < deadline) await pause(25)
      if (alive()) signal("SIGKILL")
      if (child.exitCode === null && child.signalCode === null) {
        await Promise.race([new Promise((resolve) => child.once("close", resolve)), pause(2000)])
      }
    }
    writeFileSync(join(process.cwd(), "test/native/artifacts-last.log"), output)
    rmSync(directory, { recursive: true, force: true })
    if (nativeLock !== undefined) {
      closeSync(nativeLock)
      nativeLock = undefined
    }
  }
  try {
    const locks = join(homedir(), ".cache", "smithers")
    mkdirSync(locks, { recursive: true, mode: 0o700 })
    nativeLock = openSync(join(locks, "electrobun-test.lock"), "a", 0o600)
    // flock's inherited fd shares its open-file description with this retained parent fd.
    execFileSync("flock", ["--exclusive", "--wait", "180", "3"], {
      stdio: ["ignore", "ignore", "pipe", nativeLock],
      timeout: 185000
    })
    const { chromium } = await import("playwright")
    const opener = join(directory, "browser")
    writeFileSync(
      opener,
      `#!/bin/sh\nexec ${quote(chromium.executablePath())} --headless --no-sandbox --disable-gpu --dump-dom "$@" >${
        quote(join(directory, "browser.html"))
      } 2>${quote(join(directory, "browser.log"))}\n`,
      { mode: 0o700 }
    )
    const env = {
      ...process.env,
      DISPLAY: display,
      LIBGL_ALWAYS_SOFTWARE: "1",
      BROWSER: opener,
      SMITHERS_NATIVE_PORT: "0"
    }
    execFileSync("bun", ["run", "build.vibe"], { cwd, env, stdio: "pipe", timeout: 120000 })
    execFileSync(electrobun, ["build"], { cwd, env, stdio: "pipe", timeout: 120000 })
    const x = spawn("Xvfb", [display, "-screen", "0", "1280x900x24", "-nolisten", "tcp"], {
      env,
      detached: true,
      stdio: "ignore"
    })
    children.push(x)
    await waitForNativeSpawn(x, "Xvfb")
    const host = spawn(electrobun, ["dev"], {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"]
    })
    children.push(host)
    await waitForNativeSpawn(host, "Electrobun")
    host.stdout?.on("data", (data) => {
      output += data
      if (!stopped) writeFileSync(join(directory, "native.log"), output)
    })
    host.stderr?.on("data", (data) => {
      output += data
      if (!stopped) writeFileSync(join(directory, "native.log"), output)
    })
    const deadline = Date.now() + 90000
    while (!/SDK_NATIVE_READY (http:\/\/127\.0\.0\.1:\d+)/.test(output)) {
      if (Date.now() > deadline || host.exitCode !== null) throw new Error(`Native fixture did not start: ${output}`)
      await pause(50)
    }
    const url = /SDK_NATIVE_READY (http:\/\/127\.0\.0\.1:\d+)/.exec(output)![1]!
    const meta = await fetch(`${url}/meta`).then((r) => r.json())
    mkdirSync(join(directory, "chosen"))
    project.provide("nativeFixture", {
      url,
      resources: meta.resources,
      compatibility: meta.compatibility,
      display,
      directory
    })
    return stop
  } catch (error) {
    await stop()
    throw error
  }
}

/** The constructor is synchronous, so its test-only foreign transport is synchronous too. */
export function bindings(fixture: NativeFixture): typeof Native {
  const call = (path: string, body: unknown) =>
    JSON.parse(
      execFileSync("curl", [
        "--fail",
        "--silent",
        "--show-error",
        "--max-time",
        "20",
        "--header",
        "content-type: application/json",
        "--data-binary",
        JSON.stringify(body),
        fixture.url + path
      ], { encoding: "utf8" })
    )
  class BrowserWindow {
    readonly id: number
    readonly webview: { setNavigationRules(rules: Array<string>): void }
    constructor(options: ConstructorParameters<typeof Native.BrowserWindow>[0]) {
      this.id = call("/create", { options }).id
      this.webview = {
        setNavigationRules: (rules) => {
          call("/rules", { id: this.id, rules })
        }
      }
    }
    close() {
      call("/close", { id: this.id })
    }
  }
  return {
    BrowserWindow,
    PATHS: { RESOURCES_FOLDER: fixture.resources },
    SMITHERS_BUN14_COMPAT: fixture.compatibility,
    Utils: {
      openExternal: (url) => call("/external", { url }),
      openFileDialog: (options) =>
        fetch(fixture.url + "/choose", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ dialogOptions: options })
        }).then(async (r) => {
          const text = await r.text()
          try {
            return JSON.parse(text)
          } catch {
            throw new Error(`Native chooser response ${r.status}: ${text}`)
          }
        }).catch((error) => {
          console.error("Native chooser transport", error)
          throw error
        })
    }
  }
}

/** Drive the actual GTK chooser, not a dialog replacement. */
export async function choose(fixture: NativeFixture, cancel: boolean) {
  const script = `
import ctypes,sys,time
x=ctypes.CDLL('libX11.so.6'); t=ctypes.CDLL('libXtst.so.6')
x.XOpenDisplay.restype=ctypes.c_void_p
d=x.XOpenDisplay(sys.argv[1].encode())
if not d:raise SystemExit('Native X display unavailable')
# CEF can destroy a child between QueryTree and FetchName. Ignore that X11 race and keep looking for the real chooser.
handler_type=ctypes.CFUNCTYPE(ctypes.c_int,ctypes.c_void_p,ctypes.c_void_p)
handler=handler_type(lambda display,event:0)
x.XSetErrorHandler.argtypes=[handler_type];x.XSetErrorHandler(handler)
x.XDefaultRootWindow.argtypes=[ctypes.c_void_p];x.XDefaultRootWindow.restype=ctypes.c_ulong
x.XQueryTree.argtypes=[ctypes.c_void_p,ctypes.c_ulong,ctypes.POINTER(ctypes.c_ulong),ctypes.POINTER(ctypes.c_ulong),ctypes.POINTER(ctypes.POINTER(ctypes.c_ulong)),ctypes.POINTER(ctypes.c_uint)]
x.XFetchName.argtypes=[ctypes.c_void_p,ctypes.c_ulong,ctypes.POINTER(ctypes.c_char_p)]
x.XSetInputFocus.argtypes=[ctypes.c_void_p,ctypes.c_ulong,ctypes.c_int,ctypes.c_ulong]
x.XFlush.argtypes=[ctypes.c_void_p]
class Attr(ctypes.Structure):
 _fields_=[('x',ctypes.c_int),('y',ctypes.c_int),('width',ctypes.c_int),('height',ctypes.c_int),('border_width',ctypes.c_int),('depth',ctypes.c_int),('visual',ctypes.c_void_p),('root',ctypes.c_ulong),('class_',ctypes.c_int),('bit_gravity',ctypes.c_int),('win_gravity',ctypes.c_int),('backing_store',ctypes.c_int),('backing_planes',ctypes.c_ulong),('backing_pixel',ctypes.c_ulong),('save_under',ctypes.c_int),('colormap',ctypes.c_ulong),('map_installed',ctypes.c_int),('map_state',ctypes.c_int),('all_event_masks',ctypes.c_long),('your_event_mask',ctypes.c_long),('do_not_propagate_mask',ctypes.c_long),('override_redirect',ctypes.c_int),('screen',ctypes.c_void_p)]
x.XGetWindowAttributes.argtypes=[ctypes.c_void_p,ctypes.c_ulong,ctypes.POINTER(Attr)]
for attempt in range(200):
 r=ctypes.c_ulong();p=ctypes.c_ulong();c=ctypes.POINTER(ctypes.c_ulong)();n=ctypes.c_uint()
 x.XQueryTree(d,x.XDefaultRootWindow(d),ctypes.byref(r),ctypes.byref(p),ctypes.byref(c),ctypes.byref(n))
 found=False
 for i in range(n.value):
  name=ctypes.c_char_p(); attr=Attr()
  if x.XGetWindowAttributes(d,c[i],ctypes.byref(attr)) and attr.map_state==2 and x.XFetchName(d,c[i],ctypes.byref(name)) and name.value==b'Open File':x.XSetInputFocus(d,c[i],1,0);found=True;break
 if found:break
 time.sleep(.05)
else:raise SystemExit('Native chooser not found')
x.XKeysymToKeycode.argtypes=[ctypes.c_void_p,ctypes.c_ulong];x.XKeysymToKeycode.restype=ctypes.c_uint
t.XTestFakeKeyEvent.argtypes=[ctypes.c_void_p,ctypes.c_uint,ctypes.c_int,ctypes.c_ulong]
def key(k,v):t.XTestFakeKeyEvent(d,x.XKeysymToKeycode(d,k),v,0)
def tap(k):key(k,1);key(k,0)
if sys.argv[2]=='cancel':tap(0xff1b)
else:
 key(0xffe3,1);tap(ord('l'));key(0xffe3,0);x.XFlush(d);time.sleep(.2)
 for c in sys.argv[2]:
  if c.isupper():key(0xffe1,1);tap(ord(c.lower()));key(0xffe1,0)
  else:tap(ord(c))
 x.XFlush(d);time.sleep(.2);tap(0xff0d);x.XFlush(d);time.sleep(.4);key(0xffe9,1);tap(ord('s'));key(0xffe9,0)
x.XFlush(d)
`
  execFileSync("python3", ["-c", script, fixture.display, cancel ? "cancel" : join(fixture.directory, "chosen")], {
    timeout: 15000
  })
}

export const delay = pause
export const nativeMeta = (fixture: NativeFixture) => fetch(fixture.url + "/meta").then((r) => r.json())

/** Deliberately faulty foreign bindings; successful calls always use the native fixture. */
export function faulty(
  native: typeof Native,
  operation: "constructor" | "rules" | "external" | "close"
): typeof Native {
  class BrowserWindow extends native.BrowserWindow {
    constructor(options: ConstructorParameters<typeof Native.BrowserWindow>[0]) {
      if (operation === "constructor") throw new Error("private-native-message")
      super(options)
      if (operation === "rules") {
        this.webview.setNavigationRules = () => {
          throw new Error("private-rules-message")
        }
      }
    }
    override close() {
      super.close()
      if (operation === "close") throw new Error("private-close-message")
    }
  }
  return operation === "external"
    ? {
      ...native,
      Utils: {
        ...native.Utils,
        openExternal: () => {
          throw new Error("private-browser-message")
        }
      }
    }
    : { ...native, BrowserWindow }
}
