import puppeteer from "puppeteer-core";
import { existsSync } from "node:fs";
const BROWSER = [process.env.BROWSER, `${process.env.HOME}/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`].filter(Boolean).find((p) => existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: BROWSER, headless: true,
  args: ["--no-sandbox", "--mute-audio", "--enable-unsafe-swiftshader"], defaultViewport: { width: 1280, height: 720 } });
const page = await browser.newPage();
await page.goto(`http://localhost:${process.env.PORT ?? 3001}`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => [...document.querySelectorAll("button")].find((x) => x.textContent.includes("ENTER") && !x.disabled), { timeout: 60000 });
await page.click("button");
await sleep(1200);
await page.evaluate(() => {
  const e = window.__backrooms;
  // stand in front of the exit door, look at it
  const exit = e.level.exit;
  e.player.pos.set(exit.doorPos.x + exit.facing.x * 1.6, 0, exit.doorPos.z + exit.facing.z * 1.6);
  e.player.yaw = Math.atan2(exit.facing.x, exit.facing.z);
});
await sleep(800);
const out = await page.evaluate(() => {
  const e = window.__backrooms;
  const camDir = e.player.camera.getWorldDirection(new (e.player.pos.constructor)());
  const hit = e.items.findInteractable(e.player.camera.position, camDir);
  return { hit, exitOpen: e.items.exitOpen, exitUnlocked: e.exitUnlocked };
});
console.log(JSON.stringify(out));
await browser.close();
