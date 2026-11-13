import { chromium } from "@playwright/test";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("./", import.meta.url));
const which = process.argv[2] ? process.argv[2].split(",") : null;

const shots = [
  ["chat", "desktop.png", "phone.png"],
  ["pick", "desktop-pick.png", "phone-pick.png"],
  ["models", "desktop-models.png", "phone-models.png"],
  ["folder", "desktop-folder.png", "phone-folder.png"],
  ["offline", "desktop-offline.png", null],
  ["error", "desktop-error.png", "phone-error.png"],
  ["loading", "desktop-loading.png", null],
];

const browser = await chromium.launch();
for (const [screen, desk, phone] of shots) {
  if (which && !which.includes(screen)) continue;
  const url = new URL(`./index.html#${screen}`, import.meta.url).href;
  if (desk) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, colorScheme: "dark" });
    await page.goto(url);
    await page.waitForTimeout(400);
    await page.screenshot({ path: dir + desk });
    console.log(desk);
    await page.close();
  }
  if (phone) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme: "dark" });
    await page.goto(url);
    await page.waitForTimeout(400);
    await page.screenshot({ path: dir + phone });
    console.log(phone);
    await page.close();
  }
}
await browser.close();
