/** P5 staged screenshots: enemy at the wardrobe mid-check + close-ups. */
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
page.on("console", (m) => {
  if (m.type() === "error") errors.push("console: " + m.text());
});
await page.goto(`http://localhost:${process.env.PORT ?? 3001}`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("ENTER"));
  return b && !b.disabled;
}, { timeout: 60000 });
await page.click("button");
await sleep(1500);

await page.keyboard.type("redrum");
await page.keyboard.press("KeyG"); // god
await page.keyboard.press("KeyB"); // fullbright
await sleep(200);
await page.evaluate(() => { window.__backrooms.startedAt = -100; });
await page.waitForFunction(() => !!window.__backrooms.activeEnemy, { timeout: 60000 });
await sleep(300);

const look = async (px, pz, tx, tz, pitch, file, settle = 2200) => {
  await page.evaluate(
    ({ px, pz, tx, tz, pitch }) => {
      const p = window.__backrooms.player;
      p.pos.set(px, 0, pz);
      p.vel.set(0, 0, 0);
      const dx = tx - px, dz = tz - pz;
      p.yaw = Math.atan2(-dx, -dz);
      p.pitch = pitch;
    },
    { px, pz, tx, tz, pitch },
  );
  await sleep(settle);
  await page.screenshot({ path: `scripts/shots/${file}` });
};

// close-up: fridge (world -3.65,-14.05) from 3m west
await look(-6.8, -14, -3.65, -14.05, 0, "p5-fridge-closeup.png");
// close-up: master-bedroom wardrobe + bed from 4m
await look(24.5, -18.5, 28.3, -20.5, 0, "p5-wardrobe-closeup.png");

// freeze AI, pose grandma at the wardrobe stand point mid-check
await page.evaluate(() => {
  const e = window.__backrooms;
  const spot = e.hiding.spots.find((x) => x.def.id === "hide-bed1-wardrobe");
  const en = e.activeEnemy;
  const fx = Math.sin(spot.def.yaw), fz = Math.cos(spot.def.yaw);
  en.pos.set(spot.def.pos.x + fx * 1.3, 0, spot.def.pos.z + fz * 1.3);
  en.heading = Math.atan2(-fx, -fz); // face the wardrobe
  en.paranoiaCd = 0;
  en.inspectHidingSpot(spot); // starts the approach -> check anim at arrival
});
await page.waitForFunction(() => (window.__backrooms.activeEnemy?.checkT ?? 0) > 0, { timeout: 60000 });
// camera: inside bedroom1, 4m SW of the wardrobe, looking at grandma + doors
await page.evaluate(() => {
  const e = window.__backrooms;
  const en = e.activeEnemy;
  const p = e.player;
  p.pos.set(en.pos.x - 3.2, 0, en.pos.z + 2.6);
  p.vel.set(0, 0, 0);
  const dx = en.pos.x - p.pos.x, dz = en.pos.z - p.pos.z;
  p.yaw = Math.atan2(-dx, -dz);
  p.pitch = 0.02;
});
await sleep(800);
await page.screenshot({ path: "scripts/shots/p5-enemy-check.png" });

console.log("errors:", errors.length, errors.slice(0, 5));
await browser.close();
