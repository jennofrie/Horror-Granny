/** P6 verification: world-space VFX — muzzle flash, impacts, blood,
 *  death bursts, devil teleport/materialize smoke. */
import puppeteer from "puppeteer-core";
import { existsSync, mkdirSync } from "node:fs";

const BROWSER = [
  process.env.BROWSER,
  `${process.env.HOME}/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`,
].filter(Boolean).find((p) => existsSync(p));
mkdirSync("scripts/shots", { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
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
await page.keyboard.press("KeyG"); // god — the soak must survive
await sleep(300);

// armed: handgun + plenty of rounds
await page.evaluate(() => {
  const e = window.__backrooms;
  e.weapons.give("handgun");
  e.weapons.addAmmo(60);
});
await sleep(800);

// spawn grandma now, freeze her for deterministic staging
await page.evaluate(() => { window.__backrooms.startedAt = -100; });
await page.waitForFunction(() => !!window.__backrooms.activeEnemy, { timeout: 60000 });
await page.keyboard.press("KeyX"); // freeze AI
await sleep(300);

const waitCooldown = () =>
  page.waitForFunction(() => window.__backrooms.weapons.cooldownT <= 0, { timeout: 20000 });
const aliveCount = () => page.evaluate(() => window.__backrooms.vfx.aliveCount);
const slowVfx = (k) => page.evaluate((k) => { window.__backrooms.vfx.timeScale = k; }, k);

// Park the player at the lit foyer spawn, aiming down the room (wall in range).
const stagePlayer = () =>
  page.evaluate(() => {
    const e = window.__backrooms;
    const p = e.player;
    p.pos.copy(e.level.spawn);
    p.vel.set(0, 0, 0);
    p.yaw = Math.PI * 0.25;
    p.pitch = 0;
  });

/* ================================================================
 * 1) gunshot at a wall: muzzle flash + light + smoke, spark + dust
 *    at the impact point. vfx.timeScale slows particle aging so the
 *    5fps headless renderer actually catches the 60ms flash.
 * ================================================================ */

await stagePlayer();
await waitCooldown();
await slowVfx(0.25); // mild slow-mo: the 60ms flash spans ~1 frame otherwise
await page.evaluate(() => window.__backrooms.weapons.tryAttack(window.__backrooms.enemies));
await sleep(400);
const afterShot = await page.evaluate(() => ({
  alive: window.__backrooms.vfx.aliveCount,
  light: window.__backrooms.vfx.flashLight.intensity,
  ammo: window.__backrooms.weapons.ammo,
}));
check("gunshot spawned particles (flash+smoke+spark+dust)", afterShot.alive >= 5, `alive=${afterShot.alive}`);
check("muzzle light spiked", afterShot.light > 0.05, `intensity=${afterShot.light.toFixed(3)}`);
await page.screenshot({ path: "scripts/shots/p6-muzzle.png" });
await slowVfx(1);
// headless game-time runs ~0.25x real: flash (0.09s) is dead within ~0.5s,
// the impact dust (0.8s) drifts for ~3s real — shoot the clean aftermath
await sleep(1500);
await page.screenshot({ path: "scripts/shots/p6-impact.png" });

/* ================================================================
 * 2) enemy hit: blood burst (sheet frames) + red mist; repeated hits
 *    should leave at least one wall/floor splatter decal (55%/hit)
 * ================================================================ */

// grandma 3.5m dead ahead
await page.evaluate(() => {
  const e = window.__backrooms;
  const p = e.player;
  const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
  e.activeEnemy.pos.set(p.pos.x + fx * 3.5, 0, p.pos.z + fz * 3.5);
});
await sleep(400);
const hp0 = await page.evaluate(() => window.__backrooms.activeEnemy.hp);
await waitCooldown();
// real time: blood spray (0.45s) and red mist (0.8s) live ~2-3s at 0.25x
await page.evaluate(() => window.__backrooms.weapons.tryAttack(window.__backrooms.enemies));
await sleep(1100); // flash long dead, blood mid-air, mist blooming
const hp1 = await page.evaluate(() => window.__backrooms.activeEnemy.hp);
check("enemy hit: -40hp", hp1 === hp0 - 40, `${hp0}->${hp1}`);
await page.screenshot({ path: "scripts/shots/p6-blood.png" });

// 4 more hits (kill shot excluded) to make a decal near-certain
for (let i = 0; i < 4; i++) {
  await page.evaluate(() => { window.__backrooms.activeEnemy.hp = 200; });
  await waitCooldown();
  await page.evaluate(() => window.__backrooms.weapons.tryAttack(window.__backrooms.enemies));
  await sleep(300);
}
const decalsAlive = await page.evaluate(() =>
  window.__backrooms.vfx.decals.filter((d) => d.alive).length,
);
check("blood decal(s) left on wall/floor", decalsAlive >= 1, `decals=${decalsAlive}`);
await page.screenshot({ path: "scripts/shots/p6-decal.png" });

/* ================================================================
 * 3) killing blow: lingering smoke/blood burst at the body
 * ================================================================ */

await page.evaluate(() => { window.__backrooms.activeEnemy.hp = 40; });
await waitCooldown();
await page.evaluate(() => window.__backrooms.weapons.tryAttack(window.__backrooms.enemies));
await sleep(500);
const dying = await page.evaluate(() => ({
  dying: window.__backrooms.enemies[0].dying,
  alive: window.__backrooms.vfx.aliveCount,
}));
check("grandma dying, death burst live", dying.dying && dying.alive >= 6, JSON.stringify(dying));
// wait out the toast banner + flash; death smoke (1.7s) lingers ~7s real
await sleep(4500);
await page.screenshot({ path: "scripts/shots/p6-death.png" });

/* ================================================================
 * 4) chain to the devil: grandpa dies to the kill cheat, devil spawns
 *    with materialize smoke (Come-out intro)
 * ================================================================ */

await page.evaluate(() => { window.__backrooms.calmT = 0; });
await page.waitForFunction(() => window.__backrooms.activeEnemy?.cfg.slug === "grandpa", { timeout: 60000 });
await page.keyboard.press("KeyK"); // 50 dmg cheat
await page.evaluate(() => { window.__backrooms.activeEnemy.hp = 1; });
await page.keyboard.press("KeyK");
await page.evaluate(() => { window.__backrooms.calmT = 0; });
await slowVfx(0.05); // slow so the spawn smoke lingers for the checks
await page.waitForFunction(() => window.__backrooms.activeEnemy?.cfg.slug === "devil", { timeout: 60000 });
const spawnSmoke = await aliveCount();
check("devil spawned with materialize smoke", spawnSmoke >= 5, `alive=${spawnSmoke}`);

// the spawn is 18+ cells away — restage for the photo: devil in front of
// the player, fresh devil-tinted puff fired at its feet
await page.evaluate(() => {
  const e = window.__backrooms;
  const p = e.player;
  const en = e.activeEnemy;
  const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
  en.pos.set(p.pos.x + fx * 4.5, 0, p.pos.z + fz * 4.5);
  e.vfx.teleportPuff(en.pos, true);
});
await sleep(400);
await page.screenshot({ path: "scripts/shots/p6-devil-spawn.png" });
await slowVfx(1);

/* ================================================================
 * 5) horror-director teleport: roam + far-from-player timer forces
 *    relocateNear -> smoke at both ends
 * ================================================================ */

await page.keyboard.press("KeyX"); // unfreeze so the AI ticks
// The director only relocates when the player has been >38m away for 30s —
// the house is small, so stage BOTH ends far apart (garage <-> bedroom1)
// or the far-timer just resets every tick and nothing ever teleports.
const tpFrom = await page.evaluate(() => {
  const e = window.__backrooms;
  const en = e.activeEnemy;
  e.player.pos.set(19, 0, -13); // master bedroom corner (world)
  e.player.vel.set(0, 0, 0);
  en.state = "roam";
  en.spawnT = 0; // skip the rest of the intro
  en.farFromPlayerTime = 100;
  en.pos.set(-20, 0, -10); // far garage corner, no LOS to the bedroom
  return { x: en.pos.x, z: en.pos.z };
});
await page.waitForFunction(
  (f) => {
    const en = window.__backrooms.activeEnemy;
    return Math.hypot(en.pos.x - f.x, en.pos.z - f.z) > 3;
  },
  { timeout: 30000 },
  tpFrom,
).catch(() => {});
const tp = await page.evaluate(() => ({
  pos: { x: window.__backrooms.activeEnemy.pos.x, z: window.__backrooms.activeEnemy.pos.z },
  alive: window.__backrooms.vfx.aliveCount,
}));
const tpMoved = Math.hypot(tp.pos.x - tpFrom.x, tp.pos.z - tpFrom.z) > 3;
check("horror-director teleport fired smoke", tpMoved && tp.alive >= 1,
  `moved=${tpMoved} alive=${tp.alive}`);
await page.keyboard.press("KeyX"); // freeze again

/* ================================================================
 * 6) 20s combat soak vs the devil (god), firing through it — then the
 *    devil's own death burst, bigger + red-tinted
 * ================================================================ */

for (let i = 0; i < 7; i++) {
  // Stage first, THEN fire in a later frame — tryAttack reads the camera
  // quaternion, which only catches up to the new yaw on the next tick.
  await page.evaluate(() => {
    const e = window.__backrooms;
    const en = e.activeEnemy;
    if (!en || en.dying) return;
    const p = e.player;
    const dx = en.pos.x - p.pos.x, dz = en.pos.z - p.pos.z;
    const d = Math.hypot(dx, dz) || 1;
    p.pos.set(en.pos.x - (dx / d) * 3, 0, en.pos.z - (dz / d) * 3);
    p.vel.set(0, 0, 0);
    p.yaw = Math.atan2(-dx, -dz);
    p.pitch = 0;
  });
  await sleep(500); // a few frames for the camera to track the new yaw
  await page.evaluate(() => {
    const e = window.__backrooms;
    e.weapons.cooldownT = 0;
    e.weapons.tryAttack(e.enemies);
  });
  await sleep(3000);
}
const soak = await page.evaluate(() => ({
  state: window.__backrooms.state,
  hp: window.__backrooms.activeEnemy?.hp ?? null,
}));
check("survived 20s combat soak (god)", soak.state === "playing", JSON.stringify(soak));

// devil death: big red burst. Kill via takeDamage — the exact code path a
// gun hit takes (die -> onDeath -> deathBurst). The devil relocates into
// cramped bedrooms where furniture eats staged hitscan shots; gun-vs-enemy
// resolution itself is already proven against grandma in sections 2-3.
// (It may already be dying from a lucky soak hit — don't double-kill.)
await page.evaluate(() => {
  const e = window.__backrooms;
  const devil = e.enemies.at(-1);
  // face it for the photo
  const p = e.player;
  const dx = devil.pos.x - p.pos.x, dz = devil.pos.z - p.pos.z;
  p.yaw = Math.atan2(-dx, -dz);
  if (!devil.dying) devil.takeDamage(devil.hp + 1);
});
await sleep(600);
const devilDeath = await page.evaluate(() => ({
  dying: window.__backrooms.enemies.at(-1).dying,
  alive: window.__backrooms.vfx.aliveCount,
  exitUnlocked: window.__backrooms.exitUnlocked,
}));
check("devil death burst + exit unlocked", devilDeath.dying && devilDeath.alive >= 8 && devilDeath.exitUnlocked,
  JSON.stringify(devilDeath));
// banner + flash out of the way; the devil's big smoke (1.7s) is still up
await sleep(4500);
await page.screenshot({ path: "scripts/shots/p6-devil-death.png" });

/* ---------------- wrap up ---------------- */

console.log("pageerrors:", errors.length, errors.slice(0, 8));
check("0 console errors", errors.length === 0);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
await browser.close();
process.exit(failed.length ? 1 : 0);
