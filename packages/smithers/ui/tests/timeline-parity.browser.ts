// Run on the mini: bun tests/timeline-parity.browser.ts [output directory]. No backend or model substitute:
// both pages use the approved mock's conversation; the app page renders the production ChatTimeline and driver.
import { chromium } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const output = resolve(process.argv[2] ?? "test-results/timeline-parity");
const fullApp = process.argv[4];
await mkdir(output, { recursive: true });
const original = await readFile(process.argv[3] ?? resolve(import.meta.dir, "../../../../apps/mvp/docs/design/timeline/timeline.html"), "utf8");
const scriptStart = original.indexOf("<script>");
const geometryStart = original.indexOf("// ---------- rail geometry");
const shell = original.slice(0, scriptStart).replace('<main class="stage">', '<main class="stage sui-chat-transcript">');
const app = shell + original.slice(scriptStart, geometryStart) + `
if (S.theme) document.documentElement.dataset.theme = S.theme;
document.fonts.ready.then(async () => {
  build(); renderChat();
  const {mount} = await import('/client.js');
  mount(document.getElementById('rail'), {entries:E, phases:B1, arcs:B2, at:S.at != null ? +S.at : S.state === 'medium' ? 17 : S.state === 'long' ? 103 : null, open:S.open});
});
})();</script><style>.sui-chat-timeline{width:100%;height:100%;--text-muted:var(--muted);--text-faint:var(--faint)}.rail.sheet .sui-chat-timeline{--q-tx:var(--sui-tl-muted);--q-tx-in:var(--sui-tl-text);--q-off:1;--q-mk:48%;--q-mk-in:100%;--q-st:100%;--q-ui:62%;--q-dot:100%;--q-line:40%}</style></body></html>`;
const bundle = await Bun.build({ entrypoints: [resolve(import.meta.dir, "timeline-parity.client.tsx")], target: "browser", minify: true });
if (!bundle.success) throw new Error(String(bundle.logs));
const client = await bundle.outputs[0]!.text();
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: request => {
  const path = new URL(request.url).pathname;
  return new Response(path === "/client.js" ? client : path === "/app" ? app : original, { headers: { "content-type": path === "/client.js" ? "text/javascript" : "text/html" } });
} });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const errors: string[] = [];
page.on("pageerror", error => errors.push(error.message));
try {
  for (const size of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    for (const state of size.width === 390 ? ["long"] : ["short", "medium", "long"]) for (const theme of ["light", "dark"] as const) {
      await page.setViewportSize(size);
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      const name = `${fullApp ? "full-app-" : ""}${state}-${size.width}-${theme}`;
      const shots: Buffer[] = [];
      for (const mode of ["mock", "app"]) {
        await page.goto(`http://127.0.0.1:${server.port}/${mode}#shot&state=${state}&theme=${theme}${size.width === 390 ? "&open" : ""}`);
        await page.waitForFunction(() => document.documentElement.dataset.ready === "1");
        await page.mouse.move(size.width - 2, 2);
        await page.waitForTimeout(600);
        const shot = mode === "app" && fullApp !== undefined
          ? await readFile(resolve(fullApp, size.width === 390 ? `long-phone-reduced-${theme}.png` : `${state}-${size.width}-${theme}.png`))
          : await page.screenshot();
        await writeFile(resolve(output, `${name}-${mode}.png`), shot);
        shots.push(shot);
      }
      const data = await page.evaluate(async images => {
        const loaded = await Promise.all(images.map(src => new Promise<HTMLImageElement>(resolve => { const image = new Image(); image.onload = () => resolve(image); image.src = src; })));
        const [a, b] = loaded as [HTMLImageElement, HTMLImageElement];
        const canvas = document.createElement("canvas"); canvas.width = a.width + b.width + 16; canvas.height = Math.max(a.height, b.height) + 32;
        const context = canvas.getContext("2d")!; context.fillStyle = "#eee"; context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = "#333"; context.font = "13px sans-serif"; context.fillText("Approved mock", 12, 21); context.fillText("App rail", a.width + 28, 21);
        context.drawImage(a, 0, 32); context.drawImage(b, a.width + 16, 32);
        return canvas.toDataURL("image/png").split(",")[1]!;
      }, shots.map(shot => `data:image/png;base64,${shot.toString("base64")}`));
      await writeFile(resolve(output, `${name}-parity.png`), Buffer.from(data, "base64"));
      console.log(`${name}: mock/app PNG saved`);
    }
  }
  // Real-browser regression for Astra's overflowing 50-arc case, including a second size measurement.
  for (const [index, size] of [{ width: 1440, height: 900 }, { width: 1280, height: 640 }].entries()) {
    await page.setViewportSize(size);
    if (index === 0) {
      await page.goto(`http://127.0.0.1:${server.port}/app?stress#shot&state=long&theme=light&stress`);
      await page.waitForFunction(() => document.documentElement.dataset.ready === "1");
    }
    await page.waitForFunction(height => document.querySelector<HTMLElement>(".sui-chat-timeline")!.clientHeight === height, size.height - 96);
    await page.waitForTimeout(600);
    const geometry = await page.evaluate(() => {
      const nav = document.querySelector<HTMLElement>(".sui-chat-timeline")!, height = nav.clientHeight;
      return { levels: Number(nav.dataset.levels), height, clips: [...nav.querySelectorAll(".sui-tl-clip")].map(clip => clip.getBoundingClientRect().height),
        lenses: [...nav.querySelectorAll(".sui-tl-lens")].map(lens => { const bounds = lens.closest(".sui-tl-clip")!.getBoundingClientRect(), rect = lens.getBoundingClientRect();
          return { top: rect.top - bounds.top, bottom: rect.bottom - bounds.top, height: bounds.height }; }) };
    });
    if (geometry.levels !== 4 || geometry.clips.some(height => height > geometry.height + 1) || geometry.lenses.some(lens => lens.top < -1 || lens.bottom > lens.height + 1)) throw new Error(JSON.stringify(geometry));
    await page.screenshot({ path: resolve(output, `fifty-arcs-${size.width}.png`) });
    console.log(`50 arcs at ${size.width}: four levels, every clip bounded by ${geometry.height}px`);
  }
  if (errors.length) throw new Error(errors.join("\n"));
} finally { await browser.close(); server.stop(); }
