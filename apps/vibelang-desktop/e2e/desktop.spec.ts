// Stays .ts: Playwright discovers and loads test files by JS/TS extension only.
import { test, expect, chromium, type Browser, type Page } from "@playwright/test"
import { spawn, execFile, execFileSync } from "node:child_process"
import { promisify } from "node:util"
import { mkdir, writeFile, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { homedir, tmpdir } from "node:os"

import { closeSync, mkdirSync, openSync } from "node:fs"

let nativeLock: number | undefined
const execute = promisify(execFile)
const root = join(tmpdir(), `vldesktop-${process.pid}`)
const folder = join(root, "folder")
const secondFolder = join(root, "second")
const processes: ReturnType<typeof spawn>[] = []
let browser: Browser
let page: Page
let native: ReturnType<typeof spawn>
let nativeErrors = ""
const start = (command: string, args: string[], env = {}) => {
  const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], detached: true })
  child.stdout?.on("data", data => process.stdout.write(data))
  child.stderr?.on("data", data => { nativeErrors += data; process.stderr.write(data) })
  processes.push(child)
  return child
}
const connect = async () => {
  await expect.poll(async () => fetch("http://127.0.0.1:14509/json/version").then(r => r.status).catch(() => 0), { timeout: 120000 }).toBe(200)
  browser = await chromium.connectOverCDP("http://127.0.0.1:14509")
  await expect.poll(() => browser.contexts().flatMap(context => context.pages()).filter(p => p.url().startsWith("http://127.0.0.1:44509")).length).toBe(1)
  page = browser.contexts().flatMap(context => context.pages()).find(p => p.url().startsWith("http://127.0.0.1:44509"))!
}
const launch = () => {
  native = start("pnpm", ["start"], { DISPLAY: ":109", LIBGL_ALWAYS_SOFTWARE: "1", VIBELANG_DESKTOP_DATA: join(root, "data"), VIBELANG_DESKTOP_PORT: "44509", VIBELANG_DESKTOP_TEST: "1" })
}
const crashAndRestart = async () => {
  process.kill(-native.pid!, "SIGKILL")
  await expect.poll(async () => fetch("http://127.0.0.1:14509/json/version").then(() => false).catch(() => true)).toBe(true)
  launch()
  await connect()
}
const x11 = `
import ctypes,sys,json,time
x=ctypes.CDLL('libX11.so.6'); t=ctypes.CDLL('libXtst.so.6')
x.XOpenDisplay.restype=ctypes.c_void_p
d=x.XOpenDisplay(b':109')
if not d: raise SystemExit(1)
x.XDefaultRootWindow.argtypes=[ctypes.c_void_p];x.XDefaultRootWindow.restype=ctypes.c_ulong
x.XQueryTree.argtypes=[ctypes.c_void_p,ctypes.c_ulong,ctypes.POINTER(ctypes.c_ulong),ctypes.POINTER(ctypes.c_ulong),ctypes.POINTER(ctypes.POINTER(ctypes.c_ulong)),ctypes.POINTER(ctypes.c_uint)]
x.XFetchName.argtypes=[ctypes.c_void_p,ctypes.c_ulong,ctypes.POINTER(ctypes.c_char_p)]
x.XFree.argtypes=[ctypes.c_void_p]
x.XFlush.argtypes=[ctypes.c_void_p]
handler_type=ctypes.CFUNCTYPE(ctypes.c_int,ctypes.c_void_p,ctypes.c_void_p)
handler=handler_type(lambda display,event:0)
x.XSetErrorHandler.argtypes=[handler_type];x.XSetErrorHandler(handler)
class Attr(ctypes.Structure):
 _fields_=[('x',ctypes.c_int),('y',ctypes.c_int),('width',ctypes.c_int),('height',ctypes.c_int),('border_width',ctypes.c_int),('depth',ctypes.c_int),('visual',ctypes.c_void_p),('root',ctypes.c_ulong),('class_',ctypes.c_int),('bit_gravity',ctypes.c_int),('win_gravity',ctypes.c_int),('backing_store',ctypes.c_int),('backing_planes',ctypes.c_ulong),('backing_pixel',ctypes.c_ulong),('save_under',ctypes.c_int),('colormap',ctypes.c_ulong),('map_installed',ctypes.c_int),('map_state',ctypes.c_int),('all_event_masks',ctypes.c_long),('your_event_mask',ctypes.c_long),('do_not_propagate_mask',ctypes.c_long),('override_redirect',ctypes.c_int),('screen',ctypes.c_void_p)]
x.XGetWindowAttributes.argtypes=[ctypes.c_void_p,ctypes.c_ulong,ctypes.POINTER(Attr)]
def visible(w):
 a=Attr();return x.XGetWindowAttributes(d,w,ctypes.byref(a)) and a.map_state==2
if sys.argv[1]=='names':
 r=ctypes.c_ulong();p=ctypes.c_ulong();c=ctypes.POINTER(ctypes.c_ulong)();n=ctypes.c_uint()
 x.XQueryTree(d,x.XDefaultRootWindow(d),ctypes.byref(r),ctypes.byref(p),ctypes.byref(c),ctypes.byref(n))
 names=[]
 for i in range(n.value):
  name=ctypes.c_char_p()
  if visible(c[i]) and x.XFetchName(d,c[i],ctypes.byref(name)) and name.value: names.append(name.value.decode(errors='replace'))
 print(json.dumps(names))
else:
 x.XSetInputFocus.argtypes=[ctypes.c_void_p,ctypes.c_ulong,ctypes.c_int,ctypes.c_ulong]
 r=ctypes.c_ulong();p=ctypes.c_ulong();c=ctypes.POINTER(ctypes.c_ulong)();n=ctypes.c_uint()
 x.XQueryTree(d,x.XDefaultRootWindow(d),ctypes.byref(r),ctypes.byref(p),ctypes.byref(c),ctypes.byref(n))
 for attempt in range(200):
  x.XQueryTree(d,x.XDefaultRootWindow(d),ctypes.byref(r),ctypes.byref(p),ctypes.byref(c),ctypes.byref(n))
  found=False
  for i in range(n.value):
   name=ctypes.c_char_p()
   if visible(c[i]) and x.XFetchName(d,c[i],ctypes.byref(name)) and name.value==b'Open File':x.XSetInputFocus(d,c[i],1,0);found=True;break
  if found:break
  time.sleep(.05)
 else:raise SystemExit('Native chooser not found')
 x.XKeysymToKeycode.argtypes=[ctypes.c_void_p,ctypes.c_ulong];x.XKeysymToKeycode.restype=ctypes.c_uint
 t.XTestFakeKeyEvent.argtypes=[ctypes.c_void_p,ctypes.c_uint,ctypes.c_int,ctypes.c_ulong]
 def key(k,v):t.XTestFakeKeyEvent(d,x.XKeysymToKeycode(d,k),v,0)
 def tap(k):key(k,1);key(k,0)
 key(0xffe3,1);tap(ord('l'));key(0xffe3,0)
 for c in sys.argv[2]:tap(ord(c))
 tap(0xff0d);key(0xffe9,1);tap(ord('s'));key(0xffe9,0)
 x.XFlush(d)
`

test.beforeAll(async () => {
  test.setTimeout(300000)
  const locks = join(homedir(), ".cache", "smithers")
  mkdirSync(locks, { recursive: true, mode: 0o700 })
  nativeLock = openSync(join(locks, "electrobun-test.lock"), "a", 0o600)
  execFileSync("flock", ["--exclusive", "--wait", "180", "3"], { stdio: ["ignore", "ignore", "pipe", nativeLock], timeout: 185000 })
  await mkdir(folder, { recursive: true })
  await mkdir(secondFolder, { recursive: true })
  await writeFile(join(secondFolder, "hello.vibe"), 'const value = "before-b"\n')
  await writeFile(join(folder, "hello.vibe"), 'const value = "before"\n')
  start("Xvfb", [":109", "-screen", "0", "1280x900x24", "-nolisten", "tcp"])
  start("bun", ["e2e/model-server.vibe"])
  await expect.poll(async () => fetch("http://127.0.0.1:24509/v1/models").then(r => r.status).catch(() => 0)).toBe(200)
  launch()
  await connect()
})

test.afterAll(async () => {
  await browser?.close()
  for (const child of processes.reverse()) {
    const signal = (name: NodeJS.Signals) => { try { process.kill(-child.pid!, name) } catch {} }
    const alive = () => { try { process.kill(-child.pid!, 0); return true } catch { return false } }
    signal("SIGTERM")
    const deadline = Date.now() + 3000
    while (alive() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25))
    if (alive()) signal("SIGKILL")
    if (child.exitCode === null && child.signalCode === null) await Promise.race([new Promise(resolve => child.once("close", resolve)), new Promise(resolve => setTimeout(resolve, 2000))])
  }
  await rm(root, { recursive: true, force: true })
  if (nativeLock !== undefined) { closeSync(nativeLock); nativeLock = undefined }
})

test("native mock, folder picker and local model run the shared Foldkit conversation", async () => {
  await expect(page.getByText("No folder open", { exact: true })).toBeVisible()
  expect(nativeErrors).not.toContain("Error converting strings")
  let message = page.getByRole("textbox", { name: "Message", exact: true })
  await message.fill("What is VibeLang?")
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(page.locator('[data-role="assistant"][data-done="true"]')).toHaveCount(1)
  await expect(page.getByText("Mock", { exact: true }).first()).toBeVisible()
  await expect.poll(() => fetch("http://127.0.0.1:24509/stats").then(r => r.json()).then(b => b.calls)).toBe(0)
  await page.getByRole("button", { name: "Open folder", exact: true }).click()
  await expect.poll(async () => (await execute("python3", ["-c", x11, "names"])).stdout).toMatch(/Select|Open|Choose/)
  await execute("python3", ["-c", x11, "type", folder])
  await expect(page.getByRole("button", { name: "Close folder" })).toBeVisible()
  await page.getByRole("button", { name: "Models", exact: true }).click()
  await page.getByRole("textbox", { name: "Endpoint", exact: true }).fill("http://127.0.0.1:24509")
  await page.getByRole("button", { name: "Connect", exact: true }).click()
  await page.getByRole("button", { name: "Use model", exact: true }).click()
  await page.getByRole("button", { name: "Minimize Models" }).click()
  await message.fill("Edit hello.vibe: replace before with after")
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(page.getByText("Edited hello.vibe.", { exact: true })).toBeVisible()
  expect(await readFile(join(folder, "hello.vibe"), "utf8")).toBe('const value = "after"\n')
  await expect(page.getByText("fs.edit · hello.vibe", { exact: true })).toHaveCount(1)
  const searchCard = page.locator("details.sui-toolcall").filter({ hasText: 'fs.search · "before"' }).first()
  await expect(searchCard.locator("summary")).toContainText("1 match · 1 file")
  await expect(page.getByText("VibeLang agent · local-test · local", { exact: true })).toBeVisible()
  expect((await searchCard.boundingBox())!.width).toBeGreaterThan(400)
  await expect(page.locator(".dt-controls > *").first()).toContainText(folder)
  await expect(page.locator(".sui-chat-composer-toolbar .dt-controls")).toHaveCount(1)
  expect((await page.locator(".sui-chat-composer[data-docked]").boundingBox())!.height).toBeLessThanOrEqual(120)
  await page.getByText('fs.search · "before"', { exact: true }).first().click()
  await expect(searchCard.locator("pre")).toContainText("hello.vibe:1:")
  await searchCard.locator("summary").click()
  await expect(page.getByText("1 match · 1 file", { exact: true })).toBeVisible()
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.screenshot({ path: process.env.VIBELANG_DESKTOP_SCREENSHOT ?? "/home/lane/vl/vl-desktop-1280.png", fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await page.screenshot({ path: process.env.VIBELANG_DESKTOP_PHONE_SCREENSHOT ?? "/home/lane/vl/vl-desktop-phone.png", fullPage: true })
  await crashAndRestart()
  message = page.getByRole("textbox", { name: "Message", exact: true })
  await expect(page.getByText("fs.edit · hello.vibe", { exact: true })).toHaveCount(1)
  await expect(page.getByText("Edited hello.vibe.", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Close folder" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Model", exact: true })).toContainText("local-test")
  // A persisted Mock choice starts without consulting an unavailable saved provider.
  await page.getByRole("button", { name: "Models", exact: true }).click()
  await page.getByRole("button", { name: "Mock", exact: true }).click()
  await page.getByRole("button", { name: "Minimize Models" }).click()
  const discoveries = await fetch("http://127.0.0.1:24509/stats").then(r => r.json()).then(b => b.discoveries)
  await fetch("http://127.0.0.1:24509/stall-discovery")
  await crashAndRestart()
  message = page.getByRole("textbox", { name: "Message", exact: true })
  await expect(page.getByText("Mock", { exact: true }).first()).toBeVisible()
  expect(await fetch("http://127.0.0.1:24509/stats").then(r => r.json()).then(b => b.discoveries)).toBe(discoveries)
  await fetch("http://127.0.0.1:24509/release-discovery")
  await page.getByRole("button", { name: "Models", exact: true }).click()
  await page.getByRole("textbox", { name: "Endpoint", exact: true }).fill("http://127.0.0.1:24509")
  await page.getByRole("button", { name: "Connect", exact: true }).click()
  await page.getByRole("button", { name: "Use model", exact: true }).click()
  await page.getByRole("button", { name: "Minimize Models" }).click()
  // Hold a real provider response while the person changes folder authority.
  await fetch("http://127.0.0.1:24509/hold")
  const previousCalls = await fetch("http://127.0.0.1:24509/stats").then(r => r.json()).then(b => b.calls)
  await message.fill("Edit the current folder")
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect.poll(() => fetch("http://127.0.0.1:24509/stats").then(r => r.json()).then(b => b.calls)).toBeGreaterThan(previousCalls)
  await page.getByRole("button", { name: "Close folder" }).click()
  await page.getByRole("button", { name: "Open folder", exact: true }).click()
  await expect.poll(async () => (await execute("python3", ["-c", x11, "names"])).stdout).toMatch(/Select|Open|Choose/)
  await execute("python3", ["-c", x11, "type", secondFolder])
  await expect(page.getByRole("button", { name: "Close folder" })).toBeVisible()
  await fetch("http://127.0.0.1:24509/release")
  await expect(page.getByText("Folder changed. Send again.", { exact: true })).toBeVisible()
  await expect(message).toBeEnabled()
  expect(await readFile(join(secondFolder, "hello.vibe"), "utf8")).toBe('const value = "before-b"\n')
  // Failure and folder revocation survive a process crash.
  await page.getByRole("button", { name: "Close folder" }).click()
  await expect(page.getByRole("button", { name: "Close folder" })).toHaveCount(0)
  await crashAndRestart()
  message = page.getByRole("textbox", { name: "Message", exact: true })
  await expect(page.getByRole("button", { name: "Close folder" })).toHaveCount(0)
  await expect(message).toBeEnabled()
  await fetch("http://127.0.0.1:24509/fail")
  await message.fill("Answer once more")
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(page.getByRole("button", { name: "Choose a model", exact: true })).toBeVisible()
  await expect(message).toBeDisabled()
  await page.getByRole("button", { name: "Choose a model", exact: true }).click()
  await page.getByRole("button", { name: "Mock", exact: true }).click()
  await page.getByRole("button", { name: "Minimize Models" }).click()
  await expect(message).toBeEnabled()
  await expect(page.goto("http://127.0.0.1:24509/v1/models", { waitUntil: "domcontentloaded" })).rejects.toThrow(/ERR_ABORTED|blocked/i)
  await expect(page).toHaveURL("http://127.0.0.1:44509/")
  expect(nativeErrors).not.toContain("Error converting strings")
  expect(nativeErrors).not.toContain("Raw values")
})

test("the shared history stays usable without a project backend", async () => {
  await page.getByRole("link", { name: "History", exact: true }).click()
  await expect(page.locator('.vl-app[data-surface="history"]')).toBeVisible()
  await expect(page.getByText("Mock", { exact: true })).toBeVisible()
  const compiler = page.getByRole("button", { name: /The compiler/ })
  await expect(compiler).toBeVisible()
  await compiler.click()
  await expect(compiler).toHaveAttribute("aria-expanded", "true")
  await page.getByRole("list", { name: "The compiler" }).getByRole("link").first().click()
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible()
  await page.getByRole("link", { name: "Minimize", exact: true }).click()
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible()
})

test("Models pane maximizes and restores within the native viewport", async () => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.getByRole("button", { name: "Models", exact: true }).click()
  const pane = page.getByRole("region", { name: "Models", exact: true })
  await page.getByRole("button", { name: "Maximize Models", exact: true }).click()
  await expect(pane).toHaveAttribute("data-maximized", "true")
  const maximized = await pane.boundingBox()
  expect(maximized!.y).toBe(106)
  expect(maximized!.height).toBeGreaterThan(600)
  await page.getByRole("button", { name: "Maximize Models", exact: true }).click()
  const restored = await pane.boundingBox()
  expect(restored!.width).toBeLessThan(maximized!.width)
  await page.getByRole("button", { name: "Minimize Models", exact: true }).click()
  await expect(pane).toHaveCount(0)
})

test("the model picker moves keyboard focus and Escape returns it to the message", async () => {
  await page.getByRole("button", { name: "Model", exact: true }).click()
  const options = page.getByRole("listbox", { name: "Models", exact: true })
  await expect(options).toBeFocused()
  await page.keyboard.press("Escape")
  await expect(options).toHaveCount(0)
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeFocused()
})

test("external links cannot execute shell substitutions", async () => {
  const marker = join(root, "external-shell-marker")
  await fetch("http://127.0.0.1:44509/desktop/external", {
    method: "POST", headers: { origin: "http://127.0.0.1:44509", "content-type": "application/json" },
    body: JSON.stringify({ url: `https://example.invalid/$(touch ${marker})` }),
  })
  expect(await readFile(marker).then(() => true).catch(() => false)).toBe(false)
})

test("a failed old reply cannot disable a reselected model", async () => {
  await page.goto("http://127.0.0.1:44509/")
  await page.getByRole("button", { name: "Models", exact: true }).click()
  await page.getByRole("textbox", { name: "Endpoint", exact: true }).fill("http://127.0.0.1:24509")
  await page.getByRole("button", { name: "Connect", exact: true }).click()
  await page.getByRole("button", { name: "Use model", exact: true }).click()
  await page.getByRole("button", { name: "Minimize Models", exact: true }).click()
  await fetch("http://127.0.0.1:24509/hold")
  const calls = await fetch("http://127.0.0.1:24509/stats").then(r => r.json()).then(b => b.calls)
  const message = page.getByRole("textbox", { name: "Message", exact: true })
  await message.fill("Answer while the current choice is held")
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect.poll(() => fetch("http://127.0.0.1:24509/stats").then(r => r.json()).then(b => b.calls)).toBeGreaterThan(calls)
  await page.getByRole("button", { name: "Models", exact: true }).click()
  await page.getByRole("button", { name: "Selected", exact: true }).click()
  await page.getByRole("button", { name: "Minimize Models", exact: true }).click()
  await fetch("http://127.0.0.1:24509/fail")
  await fetch("http://127.0.0.1:24509/release")
  await expect(page.getByText("Model changed. Send again.", { exact: true })).toBeVisible()
  await expect(message).toBeEnabled()
  await expect(page.getByRole("button", { name: "Choose a model", exact: true })).toHaveCount(0)
})

test("shared project sandboxes keep the signed-out policy in the local host", async () => {
  const response = await page.evaluate(async () => {
    const read = await fetch("/api/sandboxes/home")
    const body = await read.json()
    const forged = await fetch("/api/sandboxes/home/start", { method: "POST", headers: { "content-type": "application/json", "x-role": "maintainer" }, body: JSON.stringify({ operationId: "desktop-forged", role: "maintainer" }) })
    return { status: read.status, body, refused: forged.status }
  })
  expect(response).toMatchObject({ status: 200, body: { role: "viewer", status: "stopped", remaining: 0 }, refused: 403 })
})

test("Command-K keeps the model picker in the active composer and opens Models", async () => {
  await page.keyboard.press("Control+k")
  const palette = page.getByRole("dialog", { name: "Ask the agent", exact: true })
  await expect(palette).toBeVisible()
  await palette.getByRole("button", { name: "Model", exact: true }).click()
  await expect(page.locator("#dt-model-options")).toHaveCount(1)
  await expect(palette.getByRole("listbox", { name: "Models", exact: true })).toBeFocused()
  await page.keyboard.press("Escape")
  await expect(palette.getByRole("textbox", { name: "Message", exact: true })).toBeFocused()
  await palette.getByRole("button", { name: "Model", exact: true }).click()
  await palette.getByRole("button", { name: "Manage models…", exact: true }).click()
  await expect(palette).not.toBeVisible()
  const manager = page.getByRole("region", { name: "Models", exact: true })
  await expect(manager).toBeVisible()
  await manager.getByRole("textbox", { name: "Endpoint", exact: true }).fill("http://127.0.0.1:24509")
  await page.getByRole("button", { name: "Minimize Models" }).click()
})


test("a stale expected original cannot overwrite the person's edit", async () => {
  await fetch("http://127.0.0.1:24509/stale")
  const personal = 'const value = "person edit"\n'
  await writeFile(join(folder, "hello.vibe"), personal)
  await page.getByRole("button", { name: "Open folder", exact: true }).click()
  await execute("python3", ["-c", x11, "type", folder])
  await expect(page.getByRole("button", { name: "Close folder" })).toBeVisible()
  await page.getByRole("button", { name: "Models", exact: true }).click()
  const manager = page.getByRole("region", { name: "Models", exact: true })
  await manager.getByRole("textbox", { name: "Endpoint", exact: true }).fill("http://127.0.0.1:24509")
  await manager.getByRole("button", { name: "Connect", exact: true }).click()
  await manager.getByRole("button", { name: /^(Selected|Use model)$/ }).click()
  await page.getByRole("button", { name: "Minimize Models" }).click()
  const message = page.getByRole("textbox", { name: "Message", exact: true })
  await message.fill("Apply the edit using the previous original")
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(page.locator('[data-role="assistant"]').last()).toContainText(/Edited hello\.vibe\.|Edit refused\./)
  expect(await readFile(join(folder, "hello.vibe"), "utf8")).toBe(personal)
  await expect(page.locator('[data-role="assistant"]').last()).toContainText("Edit refused.")
  await expect(message).toBeEnabled()
})


test("Mock project identities work and a local model restores Viewer without a second sign-in", async () => {
  await page.goto("http://127.0.0.1:44509/")
  await page.getByRole("button", { name: "Models", exact: true }).click()
  const manager = page.getByRole("region", { name: "Models", exact: true })
  await manager.getByRole("button", { name: "Mock", exact: true }).click()
  await page.getByRole("button", { name: "Minimize Models" }).click()
  await page.getByRole("combobox", { name: "Visit as", exact: true }).selectOption("maintainer")
  await expect(page.getByRole("button", { name: "Account", exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Account", exact: true }).click()
  await page.getByRole("menuitem", { name: "People", exact: true }).click()
  await expect(page.getByRole("region", { name: "People", exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Close People", exact: true }).click()
  await page.getByRole("button", { name: "Models", exact: true }).click()
  await manager.getByRole("textbox", { name: "Endpoint", exact: true }).fill("http://127.0.0.1:24509")
  await manager.getByRole("button", { name: "Connect", exact: true }).click()
  await manager.getByRole("button", { name: "Use model", exact: true }).click()
  await page.getByRole("button", { name: "Minimize Models" }).click()
  await expect(page.getByRole("button", { name: "Account", exact: true })).toHaveCount(0)
  await expect(page.getByRole("combobox", { name: "Visit as", exact: true })).toHaveCount(0)
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("Sign-in unavailable.")
  await expect(page).toHaveURL("http://127.0.0.1:44509/")
  await page.getByRole("button", { name: "Home", exact: true }).click()
  await page.getByRole("button", { name: "Learn more", exact: true }).click()
  await expect(page.locator(".dt-side").getByText("Mock", { exact: true })).toBeVisible()
  await expect(page.getByRole("combobox", { name: "Visit as", exact: true })).toHaveCount(0)
  await page.keyboard.press("Escape")
})
