/**
 * Functional flow test: the full new game loop, end to end —
 * objective phases -> weapon pickup -> kill chain (grandma -> grandpa ->
 * devil, via the K damage cheat) -> door unlocks -> walk out -> YOU GOT OUT.
 *
 *   node scripts/flow.mjs        (dev server on PORT, default 3001)
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
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

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

// --- menu branding
const menuText = await page.evaluate(() => document.body.innerText);
check("menu shows GRANNY'S HOUSE", menuText.includes("GRANNY'S HOUSE"));
check("no PAGES anywhere on the menu", !menuText.includes("PAGES"));
await page.screenshot({ path: "scripts/shots/f0-menu.png" });

await page.click("button");
await sleep(1500);

// --- opening objective
let text = await page.evaluate(() => document.body.innerText);
check("objective: FIND A WEAPON", text.includes("FIND A WEAPON — GRANDMA IS HOME"));
await page.screenshot({ path: "scripts/shots/f1-objective.png" });

// --- pick up the axe -> objective flips to SURVIVE
await page.evaluate(() => {
  const e = window.__backrooms;
  const p = e.items.pickups.find((x) => x.spawnId === "spawn-axe");
  const pl = e.player;
  pl.pos.set(p.basePos.x + 1.2, 0, p.basePos.z);
  pl.vel.set(0, 0, 0);
  const dx = p.basePos.x - pl.pos.x, dz = p.basePos.z - pl.pos.z;
  pl.yaw = Math.atan2(-dx, -dz);
  pl.pitch = Math.atan2(p.basePos.y + 0.1 - 1.62, Math.hypot(dx, dz));
});
await sleep(900);
await page.keyboard.press("KeyE");
await sleep(500);
const armed = await page.evaluate(() => ({
  owned: [...window.__backrooms.weapons.owned],
  current: window.__backrooms.weapons.current,
  text: document.body.innerText,
}));
check("axe picked up + equipped", armed.owned.includes("axe") && armed.current === "axe",
  JSON.stringify({ owned: armed.owned, current: armed.current }));
check("objective: SURVIVE", armed.text.includes("SURVIVE"));

// --- cheats on (god, so the K-driven chain can't kill us mid-test)
await page.keyboard.type("redrum");
await page.keyboard.press("KeyG");
await sleep(300);

// --- kill chain helper: spawn the next tier now, then K it to death
const killActive = async (presses) => {
  for (let i = 0; i < presses; i++) {
    await page.evaluate(() => {
      const e = window.__backrooms;
      if (e.activeEnemy && !e.activeEnemy.dying) e.activeEnemy.takeDamage(50);
    });
    await sleep(250);
  }
};
const waitTier = (slug) =>
  page.waitForFunction(
    (s) => window.__backrooms.activeEnemy?.cfg.slug === s,
    { timeout: 90000 },
    slug,
  );

// grandma wakes (skip the 20s grace), 100hp -> 2 hits
await page.evaluate(() => { window.__backrooms.startedAt = -100; });
await waitTier("grandma");
check("grandma spawned", true);
await killActive(2);
await page.waitForFunction(() => window.__backrooms.activeEnemy === null, { timeout: 30000 });
text = await page.evaluate(() => document.body.innerText);
check("objective after grandma: SOMETHING ELSE…", text.includes("SOMETHING ELSE IS IN THE HOUSE…"));

// grandpa, 150hp -> 3 hits
await page.evaluate(() => { window.__backrooms.calmT = 0; });
await waitTier("grandpa");
check("grandpa spawned", true);
await killActive(3);
await page.waitForFunction(() => window.__backrooms.activeEnemy === null, { timeout: 30000 });
text = await page.evaluate(() => document.body.innerText);
check("objective after grandpa: IT KNOWS YOUR NAME.", text.includes("IT KNOWS YOUR NAME."));

// devil, 250hp -> 5 hits; its death opens the front door
await page.evaluate(() => { window.__backrooms.calmT = 0; });
await waitTier("devil");
check("devil spawned", true);
await page.screenshot({ path: "scripts/shots/f2-devil.png" });
await killActive(5);
await page.waitForFunction(() => window.__backrooms.exitUnlocked, { timeout: 30000 });
text = await page.evaluate(() => document.body.innerText);
check("objective after devil: THE DOOR IS OPEN. RUN.", text.includes("THE DOOR IS OPEN. RUN."));
check("exit door opened by the kill chain", await page.evaluate(() => window.__backrooms.items.exitOpen));
check("HUD kill counter reads KILLS 3/3", text.includes("KILLS 3/3"));
await page.screenshot({ path: "scripts/shots/f3-door-open.png" });

// --- walk out
await page.evaluate(() => {
  const e = window.__backrooms;
  const exit = e.level.exit;
  e.player.pos.set(exit.doorPos.x, 0, exit.doorPos.z);
  e.player.vel.set(0, 0, 0);
});
await page.waitForFunction(() => window.__backrooms.state === "won", { timeout: 15000 });
text = await page.evaluate(() => document.body.innerText);
check("win screen: YOU GOT OUT", text.includes("YOU GOT OUT"));
check("win screen stats: kills + time, no pages",
  text.includes("KILLS 3/3") && !text.includes("PAGES"));
await page.screenshot({ path: "scripts/shots/f4-won.png" });

// --- retry starts a fresh run back at the menu objective
await page.waitForFunction(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("GO BACK IN"));
  return b && !b.disabled;
}, { timeout: 5000 });
await page.evaluate(() => {
  [...document.querySelectorAll("button")].find((x) => x.textContent.includes("GO BACK IN")).click();
});
await page.waitForFunction(() => {
  const e = window.__backrooms;
  return e.state === "playing" && document.body.innerText.includes("FIND A WEAPON");
}, { timeout: 30000 });
check("retry restarts a fresh run", true);

console.log("=== ISSUES (" + errors.length + ") ===");
for (const e of errors.slice(0, 20)) console.log(e);
check("0 console errors", errors.length === 0);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
await browser.close();
process.exit(failed.length ? 1 : 0);
