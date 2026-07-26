/** 30s soak: god mode, grandma active, player wandering. Expect 0 errors. */
import puppeteer from "puppeteer-core";
import { existsSync, mkdirSync } from "node:fs";

const BROWSER = [
  process.env.BROWSER,
  `${process.env.HOME}/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`,
].filter(Boolean).find((p) => existsSync(p));
mkdirSync("scripts/shots", { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: BROWSER,
  headless: true,
  args: ["--no-sandbox", "--mute-audio", "--enable-unsafe-swiftshader", "--window-size=1280,720"],
  defaultViewport: { width: 1280, height: 720 },
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
await page.goto(`http://localhost:${process.env.PORT ?? 3001}`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("ENTER"));
  return b && !b.disabled;
}, { timeout: 60000 });
await page.click("button");
await sleep(1500);
await page.keyboard.type("redrum");
await page.keyboard.press("KeyG");
await page.evaluate(() => { window.__backrooms.startedAt = -100; });
await page.waitForFunction(() => !!window.__backrooms.activeEnemy, { timeout: 60000 });
console.log("grandma active — soaking 30s");

// wander: alternate forward bursts and turns so AI paths/chases happen
const end = Date.now() + 30000;
let i = 0;
while (Date.now() < end) {
  const key = ["KeyW", "KeyW", "KeyA", "KeyW", "KeyD"][i++ % 5];
  await page.keyboard.down(key);
  await sleep(900);
  await page.keyboard.up(key);
  await page.evaluate(() => { window.__backrooms.player.yaw += 0.9; });
  if (i % 6 === 0) await page.keyboard.press("ShiftLeft");
}
const state = await page.evaluate(() => ({
  enemy: window.__backrooms.activeEnemy?.cfg.slug,
  enemyState: window.__backrooms.activeEnemy?.state,
  hp: window.__backrooms.activeEnemy?.hp,
  playerState: window.__backrooms.state,
  pos: window.__backrooms.activeEnemy?.pos.toArray().map((v) => +v.toFixed(1)),
}));
console.log("after soak:", JSON.stringify(state));
console.log("pageerrors:", errors.length, errors.slice(0, 8));
await page.screenshot({ path: "scripts/shots/p3-soak.png" });
await browser.close();
process.exit(errors.length ? 1 : 0);
