/** P3 verification: enemy visuals + full kill chain via the dev hook. */
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

// helper injected each step
const lookAtEnemy = async () => {
  await page.evaluate(() => {
    const e = window.__backrooms;
    const en = e.activeEnemy;
    if (!en) return;
    const p = e.player;
    // stand 4m away from the enemy, facing it
    const dx = en.pos.x - p.pos.x, dz = en.pos.z - p.pos.z;
    const d = Math.hypot(dx, dz) || 1;
    p.pos.set(en.pos.x - (dx / d) * 4, 0, en.pos.z - (dz / d) * 4);
    p.vel.set(0, 0, 0);
    p.yaw = Math.atan2(-dx, -dz);
    p.pitch = 0;
  });
};

// unlock cheats (typed keys go through the real cheat path)
await page.keyboard.type("redrum");
await page.keyboard.press("KeyG"); // god — survive the staged encounters
await sleep(300);

// force grandma's spawn NOW (skip the 20s grace) by aging the run clock
await page.evaluate(() => { window.__backrooms.startedAt = -100; });
await page.waitForFunction(() => !!window.__backrooms.activeEnemy, { timeout: 60000 });
const t0 = await page.evaluate(() => ({
  enemy: window.__backrooms.activeEnemy.cfg.slug,
  state: window.__backrooms.activeEnemy.state,
  hp: window.__backrooms.activeEnemy.hp,
}));
console.log("spawned:", JSON.stringify(t0));
await lookAtEnemy();
await sleep(1200);
await page.screenshot({ path: "scripts/shots/p3-grandma.png" });

// force a chase for the run-anim shot
await page.evaluate(() => {
  const en = window.__backrooms.activeEnemy;
  en.state = "chase";
});
await sleep(1500);
await lookAtEnemy();
await sleep(600);
await page.screenshot({ path: "scripts/shots/p3-grandma-chase.png" });

// cheat-kill grandma (2 x K = 100hp)
await page.keyboard.press("KeyK");
await sleep(400);
await page.keyboard.press("KeyK");
await sleep(2500); // death anim (procedural collapse)
await page.screenshot({ path: "scripts/shots/p3-grandma-dead.png" });
const dead1 = await page.evaluate(() => ({
  dying: window.__backrooms.enemies[0].dying,
  active: window.__backrooms.activeEnemy?.cfg.slug ?? null,
  tier: window.__backrooms.tier,
}));
console.log("grandma dead:", JSON.stringify(dead1));

// skip the calm, let grandpa spawn
await page.evaluate(() => { window.__backrooms.calmT = 0; });
await page.waitForFunction(() => window.__backrooms.activeEnemy?.cfg.slug === "grandpa", { timeout: 60000 });
await sleep(800);
await lookAtEnemy();
await sleep(800);
await page.screenshot({ path: "scripts/shots/p3-grandpa.png" });

// kill grandpa (150hp = 3 x K)
for (let i = 0; i < 3; i++) { await page.keyboard.press("KeyK"); await sleep(350); }
await sleep(2000);
await page.evaluate(() => { window.__backrooms.calmT = 0; });
await page.waitForFunction(() => window.__backrooms.activeEnemy?.cfg.slug === "devil", { timeout: 60000 });
await sleep(2500); // Come-out1 intro
await lookAtEnemy();
await sleep(800);
await page.screenshot({ path: "scripts/shots/p3-devil.png" });

// kill the devil (250hp = 5 x K)
for (let i = 0; i < 5; i++) { await page.keyboard.press("KeyK"); await sleep(350); }
await sleep(2500); // Death clip
await page.screenshot({ path: "scripts/shots/p3-devil-dead.png" });
const end = await page.evaluate(() => ({
  exitUnlocked: window.__backrooms.exitUnlocked,
  exitOpen: window.__backrooms.items.exitOpen,
  tier: window.__backrooms.tier,
  active: window.__backrooms.activeEnemy?.cfg.slug ?? null,
  enemies: window.__backrooms.enemies.map((e) => ({ slug: e.cfg.slug, dead: e.dead })),
}));
console.log("after devil:", JSON.stringify(end));

// walk through the open door -> won
await page.evaluate(() => {
  const e = window.__backrooms;
  e.player.pos.set(e.level.exit.doorPos.x, 0, e.level.exit.doorPos.z);
});
await sleep(1500);
const final = await page.evaluate(() => window.__backrooms.state);
console.log("final state:", final);

console.log("pageerrors:", errors.length, errors.slice(0, 8));
await browser.close();
