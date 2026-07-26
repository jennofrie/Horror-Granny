/** P4 verification: pickups, inventory, hit resolution, alerts, progression. */
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

// cheats: god (survive) — freeze toggled per-test
await page.keyboard.type("redrum");
await page.keyboard.press("KeyG");
await sleep(300);

/* ---------------- helpers injected per-step ---------------- */

// Stand the player 1.7m from a world point, on non-solid ground, aiming at it.
const gotoAndAim = (tx, ty, tz) =>
  page.evaluate(({ tx, ty, tz }) => {
    const e = window.__backrooms;
    const p = e.player;
    let placed = false;
    for (const [ox, oz] of [[1.7, 0], [-1.7, 0], [0, 1.7], [0, -1.7], [1.2, 1.2], [-1.2, -1.2]]) {
      const px = tx + ox, pz = tz + oz;
      if (!e.level.solidAtWorld(px, pz)) {
        p.pos.set(px, 0, pz);
        placed = true;
        break;
      }
    }
    if (!placed) p.pos.set(tx + 1.7, 0, tz);
    p.vel.set(0, 0, 0);
    const dx = tx - p.pos.x, dz = tz - p.pos.z;
    p.yaw = Math.atan2(-dx, -dz);
    p.pitch = Math.atan2(ty - 1.62, Math.hypot(dx, dz));
  }, { tx, ty, tz });

const pickupInfo = (spawnId) =>
  page.evaluate((id) => {
    const e = window.__backrooms;
    const i = e.items.pickups.findIndex((p) => p.spawnId === id);
    if (i < 0) return null;
    const p = e.items.pickups[i];
    return { index: i, taken: p.taken, label: p.label, pos: { x: p.basePos.x, y: p.basePos.y, z: p.basePos.z } };
  }, spawnId);

const takeViaE = async (spawnId, expectLabel) => {
  const info = await pickupInfo(spawnId);
  if (!info) return { found: false, prompt: null };
  await gotoAndAim(info.pos.x, info.pos.y + 0.1, info.pos.z);
  await sleep(700); // let the camera + prompt catch up
  const prompt = await page.evaluate(() => window.__backrooms.lastPrompt);
  await page.keyboard.press("KeyE");
  await sleep(400);
  const after = await pickupInfo(spawnId);
  return {
    found: true,
    prompt,
    promptOk: prompt === `[E] ${expectLabel}`,
    taken: after.taken,
  };
};

/* ---------------- 1) pickups ---------------- */

const axe = await takeViaE("spawn-axe", "TAKE FIRE AXE");
check("axe pickup prompt + take", axe.found && axe.promptOk && axe.taken, JSON.stringify(axe));
let inv = await page.evaluate(() => ({
  owned: [...window.__backrooms.weapons.owned],
  current: window.__backrooms.weapons.current,
  ammo: window.__backrooms.weapons.ammo,
}));
check("axe in inventory + equipped", inv.owned.includes("axe") && inv.current === "axe", JSON.stringify(inv));

// prompt-in-world screenshot for the handgun pickup (before taking it)
const hgInfo = await pickupInfo("spawn-handgun");
await gotoAndAim(hgInfo.pos.x, hgInfo.pos.y + 0.1, hgInfo.pos.z);
await sleep(900);
await page.screenshot({ path: "scripts/shots/p4-pickup-prompt.png" });
const hg = await takeViaE("spawn-handgun", "TAKE HANDGUN");
check("handgun pickup prompt + take", hg.found && hg.promptOk && hg.taken, JSON.stringify(hg));
inv = await page.evaluate(() => ({
  owned: [...window.__backrooms.weapons.owned],
  current: window.__backrooms.weapons.current,
  ammo: window.__backrooms.weapons.ammo,
}));
check("handgun auto-equipped, ammo still 0", inv.current === "handgun" && inv.ammo === 0, JSON.stringify(inv));

// ammo: find whichever candidates the seed placed
const ammoSpawns = await page.evaluate(() =>
  window.__backrooms.items.pickups.filter((p) => p.kind === "ammo").map((p) => p.spawnId),
);
check("2-3 ammo boxes placed (seeded)", ammoSpawns.length >= 2 && ammoSpawns.length <= 3, ammoSpawns.join(","));
const am = await takeViaE(ammoSpawns[0], "TAKE 9MM AMMO (6)");
check("ammo pickup prompt + take", am.found && am.promptOk && am.taken, JSON.stringify(am));
inv = await page.evaluate(() => ({ ammo: window.__backrooms.weapons.ammo }));
check("ammo +6", inv.ammo === 6, JSON.stringify(inv));

/* ---------------- 2) viewmodel screenshots ---------------- */

await page.evaluate(() => { window.__backrooms.weapons.give("shovel"); });
await page.evaluate(() => {
  const e = window.__backrooms;
  // bright spot for the screenshots: stand in the lit foyer, look level
  e.player.pos.copy(e.level.spawn);
  e.player.vel.set(0, 0, 0);
  e.player.yaw = Math.PI * 0.25;
  e.player.pitch = 0;
  e.weapons.selectSlot(0); // handgun
});
await sleep(2500); // viewmodels load (cache prewarmed) + rig settles
await page.screenshot({ path: "scripts/shots/p4-vm-handgun.png" });
await page.evaluate(() => window.__backrooms.weapons.selectSlot(1)); // axe
await sleep(800);
await page.screenshot({ path: "scripts/shots/p4-vm-axe.png" });
await page.evaluate(() => window.__backrooms.weapons.selectSlot(2)); // shovel
await sleep(800);
await page.screenshot({ path: "scripts/shots/p4-vm-shovel.png" });
// mid-swing pose
await page.evaluate(() => window.__backrooms.weapons.tryAttack(window.__backrooms.enemies));
await sleep(500);
await page.screenshot({ path: "scripts/shots/p4-vm-shovel-swing.png" });
await page.evaluate(() => window.__backrooms.weapons.selectSlot(0)); // back to handgun

/* ---------------- 3) spawn grandma, freeze for deterministic hits ---------------- */

await page.evaluate(() => { window.__backrooms.startedAt = -100; });
await page.waitForFunction(() => !!window.__backrooms.activeEnemy, { timeout: 60000 });
await page.keyboard.press("KeyX"); // freeze AI — positions stay put for hit tests
await sleep(300);

// Put the player in the open, grandma 5m dead ahead.
const stage = async (dist) => {
  await page.evaluate((dist) => {
    const e = window.__backrooms;
    const p = e.player;
    p.pos.copy(e.level.spawn);
    p.vel.set(0, 0, 0);
    p.yaw = Math.PI * 0.25;
    p.pitch = 0;
    const en = e.activeEnemy;
    const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
    en.pos.set(p.pos.x + fx * dist, 0, p.pos.z + fz * dist);
  }, dist);
  await sleep(400);
};
const enemyState = () =>
  page.evaluate(() => ({
    hp: window.__backrooms.activeEnemy.hp,
    state: window.__backrooms.activeEnemy.state,
    ammo: window.__backrooms.weapons.ammo,
    current: window.__backrooms.weapons.current,
  }));

// The headless clock runs ~4x slow (dt clamped at 5fps) — never attack into
// an active cooldown or the attempt is (correctly) ignored.
const waitCooldown = () =>
  page.waitForFunction(() => window.__backrooms.weapons.cooldownT <= 0, { timeout: 20000 });

await stage(5);
let s0 = await enemyState();
await page.evaluate(() => window.__backrooms.weapons.tryAttack(window.__backrooms.enemies));
await sleep(400);
let s1 = await enemyState();
check("handgun hit: -40hp, -1 ammo", s1.hp === s0.hp - 40 && s1.ammo === s0.ammo - 1,
  `${s0.hp}->${s1.hp}, ammo ${s0.ammo}->${s1.ammo}`);

// miss: aim 90° away — hp unchanged, ammo still consumed
await page.evaluate(() => { window.__backrooms.player.yaw += Math.PI / 2; });
await waitCooldown();
await page.evaluate(() => window.__backrooms.weapons.tryAttack(window.__backrooms.enemies));
await sleep(400);
let s2 = await enemyState();
check("handgun miss consumes ammo, no damage", s2.hp === s1.hp && s2.ammo === s1.ammo - 1,
  `hp ${s1.hp}->${s2.hp}, ammo ${s1.ammo}->${s2.ammo}`);

// dry fire: empty pool -> click does nothing
await page.evaluate(() => { window.__backrooms.weapons.ammo = 0; });
await waitCooldown();
await page.evaluate(() => window.__backrooms.weapons.tryAttack(window.__backrooms.enemies));
await sleep(400);
let s3 = await enemyState();
check("dry fire: no damage, ammo stays 0", s3.hp === s2.hp && s3.ammo === 0,
  `hp ${s2.hp}->${s3.hp}, ammo ${s3.ammo}`);

/* ---------------- 4) gunshot alerts the hunter ---------------- */

await page.evaluate(() => {
  const e = window.__backrooms;
  const en = e.activeEnemy;
  en.hitT = 0; // clear flinch from the hit test
  en.state = "roam";
  // 30m away, well outside notice range, player aims at a wall
  en.pos.set(e.player.pos.x + 30, 0, e.player.pos.z);
  e.weapons.addAmmo(2);
});
await sleep(300);
const roamCheck = await page.evaluate(() => window.__backrooms.activeEnemy.state);
await waitCooldown();
await page.evaluate(() => window.__backrooms.weapons.tryAttack(window.__backrooms.enemies));
await sleep(400);
const alerted = await page.evaluate(() => window.__backrooms.activeEnemy.state);
check("gunshot flips roam -> search", roamCheck === "roam" && alerted === "search",
  `${roamCheck} -> ${alerted}`);

/* ---------------- 5) axe melee ---------------- */

await page.evaluate(() => {
  const e = window.__backrooms;
  e.weapons.selectSlot(1); // axe
  e.activeEnemy.hp = 100;
  e.activeEnemy.state = "chase";
});
await stage(1.7);
await waitCooldown();
s0 = await enemyState();
await page.evaluate(() => window.__backrooms.weapons.tryAttack(window.__backrooms.enemies));
await page.waitForFunction(
  (hp) => window.__backrooms.activeEnemy.hp !== hp, { timeout: 20000 }, s0.hp,
).catch(() => {});
s1 = await enemyState();
check("axe swing in range: -55hp", s1.hp === s0.hp - 55, `${s0.hp}->${s1.hp}`);

// out of range: no damage
await page.evaluate(() => { window.__backrooms.activeEnemy.hp = 100; });
await stage(5);
await waitCooldown();
s0 = await enemyState();
await page.evaluate(() => window.__backrooms.weapons.tryAttack(window.__backrooms.enemies));
await sleep(2500);
s1 = await enemyState();
check("axe swing out of range: no damage", s1.hp === s0.hp, `${s0.hp}->${s1.hp}`);

/* ---------------- 6) kill grandma with the axe -> grandpa spawns ---------------- */

await page.evaluate(() => { window.__backrooms.activeEnemy.hp = 55; });
await stage(1.7);
await waitCooldown();
await page.evaluate(() => window.__backrooms.weapons.tryAttack(window.__backrooms.enemies));
await page.waitForFunction(
  () => window.__backrooms.activeEnemy === null || window.__backrooms.activeEnemy.dying,
  { timeout: 20000 },
).catch(() => {});
const afterKill = await page.evaluate(() => ({
  tier: window.__backrooms.tier,
  active: window.__backrooms.activeEnemy?.cfg.slug ?? null,
  grandmaDying: window.__backrooms.enemies[0].dying,
}));
check("grandma killed by axe, tier advanced", afterKill.grandmaDying && afterKill.tier === 1,
  JSON.stringify(afterKill));
await page.evaluate(() => { window.__backrooms.calmT = 0; });
await page.waitForFunction(() => window.__backrooms.activeEnemy?.cfg.slug === "grandpa", { timeout: 60000 });
check("grandpa spawns (progression intact)", true);

/* ---------------- 7) fight soak (~20s), console clean ---------------- */

await page.keyboard.press("KeyX"); // unfreeze — grandpa hunts
await sleep(300);
// keep god-mode player near grandpa, swing the axe periodically
for (let i = 0; i < 7; i++) {
  await page.evaluate(() => {
    const e = window.__backrooms;
    const en = e.activeEnemy;
    if (!en || en.dying) return;
    const p = e.player;
    const dx = en.pos.x - p.pos.x, dz = en.pos.z - p.pos.z;
    const d = Math.hypot(dx, dz) || 1;
    p.pos.set(en.pos.x - (dx / d) * 1.8, 0, en.pos.z - (dz / d) * 1.8);
    p.vel.set(0, 0, 0);
    p.yaw = Math.atan2(-dx, -dz);
    p.pitch = 0;
    e.weapons.tryAttack(e.enemies);
  });
  if (i === 2) await page.screenshot({ path: "scripts/shots/p4-fight.png" });
  await sleep(3000);
}
const soak = await page.evaluate(() => ({
  state: window.__backrooms.state,
  grandpaHp: window.__backrooms.activeEnemy?.hp ?? null,
  exitUnlocked: window.__backrooms.exitUnlocked,
}));
console.log("soak end:", JSON.stringify(soak));
check("survived 20s fight soak (god)", soak.state === "playing", JSON.stringify(soak));

console.log("pageerrors:", errors.length, errors.slice(0, 8));
check("0 console errors", errors.length === 0);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
await browser.close();
process.exit(failed.length ? 1 : 0);
