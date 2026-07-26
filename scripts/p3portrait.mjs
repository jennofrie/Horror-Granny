/** Per-enemy staged portrait: enemy placed 3.5m in front of the camera,
 *  facing it, world boxes dumped. Usage: node scripts/p3portrait.mjs <tier 0|1|2> */
import puppeteer from "puppeteer-core";
import { existsSync, mkdirSync } from "node:fs";

const tierWanted = Number(process.argv[2] ?? 0);
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
await page.keyboard.press("KeyB"); // fullbright for a clear look
await page.evaluate(() => { window.__backrooms.startedAt = -100; });
await page.waitForFunction(() => !!window.__backrooms.activeEnemy, { timeout: 60000 });

// burn through tiers with the damage cheat until the wanted one is active
for (let t = 0; t < tierWanted; t++) {
  const hp = await page.evaluate(() => window.__backrooms.activeEnemy.hp);
  for (let i = 0; i < Math.ceil(hp / 50); i++) { await page.keyboard.press("KeyK"); await sleep(250); }
  await sleep(1200);
  await page.evaluate(() => { window.__backrooms.calmT = 0; });
  await page.waitForFunction(
    (t2) => !!window.__backrooms.activeEnemy && window.__backrooms.tier === t2,
    { timeout: 60000 }, t + 1,
  );
  await sleep(2500); // spawn intro if any
}

const info = await page.evaluate(() => {
  const e = window.__backrooms;
  const en = e.activeEnemy;
  const p = e.player;
  // put the enemy 3.5m in front of the camera, facing the player
  const dir = p.camera.getWorldDirection(new (p.pos.constructor)());
  en.pos.set(p.pos.x + dir.x * 3.5, 0, p.pos.z + dir.z * 3.5);
  en.heading = Math.atan2(p.pos.x - en.pos.x, p.pos.z - en.pos.z);
  en.path = [];
  en.waypoint = null;
  e.cheats.freeze = true; // halt AI; sync the root manually below
  en.root.position.copy(en.pos);
  en.root.rotation.y = en.heading;

  const V = en.root.position.constructor;
  const boxes = [];
  en.root.updateMatrixWorld(true);
  en.root.traverse((o) => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    let box;
    if (o.isSkinnedMesh) {
      o.skeleton.update();
      o.computeBoundingBox();
      box = o.boundingBox;
    } else {
      o.geometry.computeBoundingBox();
      box = o.geometry.boundingBox;
    }
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const x of [box.min.x, box.max.x])
      for (const y of [box.min.y, box.max.y])
        for (const z of [box.min.z, box.max.z]) {
          const c = new V(x, y, z).applyMatrix4(o.matrixWorld);
          min[0] = Math.min(min[0], c.x); min[1] = Math.min(min[1], c.y); min[2] = Math.min(min[2], c.z);
          max[0] = Math.max(max[0], c.x); max[1] = Math.max(max[1], c.y); max[2] = Math.max(max[2], c.z);
        }
    boxes.push({ n: o.name, vis: o.visible, min: min.map((v) => +v.toFixed(2)), max: max.map((v) => +v.toFixed(2)) });
  });
  return {
    slug: en.cfg.slug,
    enemyPos: en.pos.toArray().map((v) => +v.toFixed(2)),
    playerPos: p.pos.toArray().map((v) => +v.toFixed(2)),
    scale: +en.root.children[0].scale.x.toFixed(3),
    boxes,
  };
});
console.log(JSON.stringify(info, null, 1));
await sleep(800);
await page.screenshot({ path: `scripts/shots/p3-portrait-${info.slug}.png` });
console.log("pageerrors:", errors.length, errors.slice(0, 5));
await browser.close();
