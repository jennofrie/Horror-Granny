/**
 * Deep visual inspection via the dev __backrooms hook.
 * Stages the camera/enemy/weapons to verify key scenes render correctly:
 * house rooms, a hunting enemy, weapon viewmodels, hiding spots, the door.
 *
 *   node scripts/inspect.mjs     (dev server on PORT, default 3001)
 */
import puppeteer from "puppeteer-core";
import { existsSync, mkdirSync } from "node:fs";

const BROWSER = [
  process.env.BROWSER,
  `${process.env.HOME}/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`,
  `${process.env.HOME}/.cache/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell`,
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
].filter(Boolean).find((p) => existsSync(p));
if (!BROWSER) {
  console.error("No browser found — set BROWSER=/path/to/chrome");
  process.exit(1);
}
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
page.on("pageerror", (err) => errors.push(`[pageerror] ${err.message}`));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`[console] ${m.text()}`);
});

await page.goto(`http://localhost:${process.env.PORT ?? 3001}`, {
  waitUntil: "domcontentloaded",
  timeout: 60000,
});
await page.waitForFunction(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("ENTER"));
  return b && !b.disabled;
}, { timeout: 60000 });
await page.click("button");
await sleep(1200);

// cheats: fullbright for readable screenshots, god so nothing kills us
await page.keyboard.type("redrum");
await page.keyboard.press("KeyB");
await page.keyboard.press("KeyG");
await sleep(300);

// stand at (px,pz) [world], aim at (tx,tz)
const look = async (px, pz, tx, tz, pitch, file) => {
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
  await sleep(2200); // let furniture GLBs land + a few frames render
  await page.screenshot({ path: `scripts/shots/${file}` });
};

/* --- 1. house rooms (world = house - (30,22)) --- */
await look(0, 18, 0, 10, 0, "i1-hallway.png");      // hallway, facing north
await look(-15, -4, -10, -8.6, 0.02, "i2-dining.png"); // dining table + chairs
await look(-17, 3, -24.75, 6.8, 0.02, "i3-living.png"); // living room sofa
await look(-13, -14, -3.65, -14.05, 0.02, "i4-kitchen.png"); // kitchen run

/* --- 2. grandma in the flashlight beam, mid-hunt --- */
await page.evaluate(() => { window.__backrooms.startedAt = -100; });
await page.waitForFunction(() => !!window.__backrooms.activeEnemy, { timeout: 90000 });
await page.keyboard.press("KeyX"); // freeze AI for a stable portrait
await page.evaluate(() => {
  const e = window.__backrooms;
  const p = e.player;
  p.pos.copy(e.level.spawn);
  p.vel.set(0, 0, 0);
  p.yaw = Math.PI * 0.25;
  p.pitch = 0;
  const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
  const en = e.activeEnemy;
  en.pos.set(p.pos.x + fx * 4, 0, p.pos.z + fz * 4);
  en.heading = Math.atan2(-fx, -fz); // face the player
});
await sleep(800);
await page.screenshot({ path: "scripts/shots/i5-grandma.png" });

/* --- 3. weapon viewmodels --- */
await page.evaluate(() => {
  const e = window.__backrooms;
  // park grandma far away so the aura doesn't kill the lights
  const far = e.level.entitySpawnCell;
  e.activeEnemy.pos.set(e.level.worldX(far.x), 0, e.level.worldZ(far.z));
  e.weapons.give("axe");
});
await sleep(1500);
await page.screenshot({ path: "scripts/shots/i6-axe.png" });
await page.evaluate(() => window.__backrooms.weapons.give("handgun"));
await sleep(1500);
await page.screenshot({ path: "scripts/shots/i7-handgun.png" });

/* --- 4. inside a wardrobe (occlusion overlay + gap) --- */
await page.evaluate(() => {
  const e = window.__backrooms;
  const s = e.hiding.spots.find((x) => x.def.id === "hide-bed1-wardrobe");
  const fx = Math.sin(s.def.yaw), fz = Math.cos(s.def.yaw);
  const p = e.player;
  p.pos.set(s.def.pos.x + fx * 1.4, 0, s.def.pos.z + fz * 1.4);
  p.vel.set(0, 0, 0);
  const dx = s.anchor.x - p.pos.x, dz = s.anchor.z - p.pos.z;
  p.yaw = Math.atan2(-dx, -dz);
  p.pitch = Math.atan2(s.anchor.y - 1.62, Math.hypot(dx, dz));
});
await sleep(700);
await page.screenshot({ path: "scripts/shots/i8-wardrobe-outside.png" });
await page.keyboard.press("KeyE");
await sleep(900);
await page.screenshot({ path: "scripts/shots/i9-wardrobe-inside.png" });
await page.keyboard.press("KeyE"); // climb back out
await page.waitForFunction(() => !window.__backrooms.player.hidden, { timeout: 30000 });

/* --- 5. the front door (locked — the chain isn't done) --- */
await page.evaluate(() => {
  const e = window.__backrooms;
  const p = e.player;
  const exit = e.level.exit;
  p.pos.set(
    exit.doorPos.x + exit.facing.x * 2.6,
    0,
    exit.doorPos.z + exit.facing.z * 2.6,
  );
  p.yaw = Math.atan2(exit.facing.x, exit.facing.z);
  p.pitch = -0.05;
});
await sleep(700);
await page.screenshot({ path: "scripts/shots/i10-door.png" });
const prompt = await page.evaluate(() => window.__backrooms.lastPrompt);
console.log("door prompt (locked):", JSON.stringify(prompt));

console.log("=== ISSUES (" + errors.length + ") ===");
for (const e of errors.slice(0, 20)) console.log(e);
await browser.close();
process.exit(errors.length ? 1 : 0);
