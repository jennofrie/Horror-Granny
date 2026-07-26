/** House tour: teleport the player to key spots and screenshot each. */
import puppeteer from "puppeteer-core";
import { existsSync, mkdirSync } from "node:fs";

const BROWSER = [
  process.env.BROWSER,
  `${process.env.HOME}/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`,
].filter(Boolean).find((p) => existsSync(p));
mkdirSync("scripts/shots", { recursive: true });

const browser = await puppeteer.launch({
  executablePath: BROWSER,
  headless: true,
  args: ["--no-sandbox", "--mute-audio", "--enable-unsafe-swiftshader", "--window-size=1280,720"],
  defaultViewport: { width: 1280, height: 720 },
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(`http://localhost:${process.env.PORT ?? 3000}`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("ENTER"));
  return b && !b.disabled;
}, { timeout: 30000 });
await page.click("button");
await new Promise((r) => setTimeout(r, 1500));

// spots: house-local x/z, yaw (0 = facing -z/north), label
const spots = [
  { hx: 29.5, hz: 40, yaw: Math.PI, pitch: 0, label: "frontdoor" }, // facing south at the door
  { hx: 20, hz: 8, yaw: 0.4, pitch: 0.05, label: "kitchen" },
  { hx: 7, hz: 16, yaw: -0.5, pitch: 0.05, label: "garage" },
  { hx: 49, hz: 9, yaw: 2.6, pitch: 0.05, label: "bedroom1" },
  { hx: 30, hz: 20.5, yaw: -Math.PI / 2, pitch: 0, label: "hallway" },
  { hx: 15, hz: 40, yaw: -0.8, pitch: 0.05, label: "living" },
];
for (const s of spots) {
  await page.evaluate((sp) => {
    const e = window.__backrooms;
    const p = e.player;
    p.pos.set(sp.hx - 30, 0, sp.hz - 22);
    p.vel.set(0, 0, 0);
    p.yaw = sp.yaw;
    p.pitch = sp.pitch;
  }, s);
  await new Promise((r) => setTimeout(r, 700));
  await page.screenshot({ path: `scripts/shots/tour-${s.label}.png` });
}

// structural sanity from the level itself
const info = await page.evaluate(() => {
  const lvl = window.__backrooms.level;
  const rooms = new Set();
  for (let i = 0; i < lvl.roomOf.length; i++) if (lvl.roomOf[i] >= 0) rooms.add(lvl.roomOf[i]);
  return {
    size: lvl.size,
    rooms: rooms.size,
    fixtures: lvl.fixtures.length,
    furniture: lvl.furniture.length,
    itemSpawns: lvl.itemSpawns.length,
    hidingSpots: lvl.hidingSpots.length,
    spawn: lvl.spawnCell,
    exitCell: lvl.exit.cell,
    exitFacing: [lvl.exit.facing.x, lvl.exit.facing.z],
    sampleLOS: lvl.lineOfSight(lvl.spawnCell.x, lvl.spawnCell.z, lvl.exit.cell.x, lvl.exit.cell.z),
  };
});
console.log(JSON.stringify(info));
console.log("pageerrors:", errors.length, errors.slice(0, 5));
await browser.close();
