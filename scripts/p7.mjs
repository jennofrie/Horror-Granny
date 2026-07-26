/** P7 verification: sample library wired into the WebAudio engine.
 *  Headless Chromium has no audio output — everything is asserted via
 *  graph state: context state, decoded buffers (loadedSamples), one-shot
 *  counters (playedCounts), music/heartbeat loop sources, and gain levels. */
import puppeteer from "puppeteer-core";
import { existsSync } from "node:fs";

const BROWSER = [
  process.env.BROWSER,
  `${process.env.HOME}/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`,
].filter(Boolean).find((p) => existsSync(p));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

const EXPECTED = [
  "gunshot", "growl", "heartbeat", "stinger", "music",
  "step1", "step2", "step3", "swing1", "swing2", "impact1", "impact2",
  "doorCreak", "wardrobeCreak", "doorOpen", "pickup",
];

const audio = (fn, ...args) =>
  page.evaluate((f, a) => {
    const au = window.__backrooms.audio;
    return typeof au[f] === "function" ? au[f](...a) : au[f];
  }, fn, args);

const browser = await puppeteer.launch({
  executablePath: BROWSER,
  headless: true,
  args: [
    "--no-sandbox", "--mute-audio", "--enable-unsafe-swiftshader",
    "--autoplay-policy=no-user-gesture-required", "--window-size=1280,720",
  ],
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

/* ---- 1) start click: context created + running, samples decode ---- */

await page.click("button");
await sleep(1200);
const ctxState = await audio("contextState");
check("audio context running after start-click", ctxState === "running", ctxState);

await page.waitForFunction(
  (n) => window.__backrooms.audio.loadedSamples.length >= n,
  { timeout: 30000 },
  EXPECTED.length,
).catch(() => {});
const loaded = await audio("loadedSamples");
const missing = EXPECTED.filter((k) => !loaded.includes(k));
check("all 16 sample buffers decoded", missing.length === 0,
  missing.length ? `missing: ${missing.join(",")}` : `${loaded.length}/16`);

/* ---- 2) continuous layers: music bed + heartbeat loop ---- */

await page.waitForFunction(() => window.__backrooms.audio.musicPlaying, { timeout: 15000 })
  .catch(() => {});
check("music loop source started", await audio("musicPlaying"));
check("heartbeat loop source started", await audio("heartbeatLooping"));

// fade-in (tc=1.8s) needs a few seconds to approach MUSIC_BASE=0.2
await sleep(4000);
const musicRest = await audio("musicLevel");
check("music faded in under the mix", musicRest > 0.1, `gain=${musicRest.toFixed(3)}`);

/* ---- 3) player footsteps: wood samples round-robin ---- */

// Drive movement through the touch-stick hook (headless game-time runs
// ~0.25x real, so a key hold is too short for the bob cycle to tick).
await page.evaluate(() => {
  const e = window.__backrooms;
  e.player.pos.copy(e.level.spawn);
  e.player.vel.set(0, 0, 0);
  e.player.yaw = Math.PI * 0.25;
  e.setTouchMove(0, -1);
});
await sleep(8000); // ~15 headless frames/s, dt clamped 0.05 → ~0.4 game-s per real-s
await page.evaluate(() => window.__backrooms.setTouchMove(0, 0));
let counts = await audio("playedCounts");
const steps = (counts.step1 ?? 0) + (counts.step2 ?? 0) + (counts.step3 ?? 0);
check("player footsteps fired wood samples", steps >= 2, `steps=${steps} ${JSON.stringify(counts)}`);

/* ---- 4) weapons: gunshot, dry fire, swing, impact ---- */

await page.evaluate(() => {
  const e = window.__backrooms;
  e.weapons.give("handgun");
  e.weapons.addAmmo(30);
});
await sleep(500);
await page.evaluate(() => window.__backrooms.weapons.tryAttack(window.__backrooms.enemies));
await sleep(300);
counts = await audio("playedCounts");
check("gunshot sample on fire", (counts.gunshot ?? 0) >= 1, `gunshot=${counts.gunshot ?? 0}`);

// dry fire: empty the pool, shoot again -> synth click, no new gunshot
await page.evaluate(() => {
  const e = window.__backrooms;
  e.weapons.ammo = 0;
  e.weapons.cooldownT = 0;
  e.weapons.tryAttack(e.enemies);
});
await sleep(300);
counts = await audio("playedCounts");
check("dry fire plays no gunshot sample", (counts.gunshot ?? 0) === 1, `gunshot=${counts.gunshot ?? 0}`);

// melee whoosh
await page.evaluate(() => {
  const e = window.__backrooms;
  e.weapons.give("axe");
  e.weapons.cooldownT = 0;
  e.weapons.tryAttack(e.enemies);
});
await sleep(300);
counts = await audio("playedCounts");
const swings = (counts.swing1 ?? 0) + (counts.swing2 ?? 0);
check("melee swing whoosh sample", swings >= 1, `swings=${swings}`);

/* ---- 5) enemy: spawn stinger, kill -> growl, gun hit -> impact ---- */

await page.keyboard.type("redrum");
await page.keyboard.press("KeyG"); // god
await page.evaluate(() => { window.__backrooms.startedAt = -100; });
await page.waitForFunction(() => !!window.__backrooms.activeEnemy, { timeout: 60000 });
counts = await audio("playedCounts");
check("tier spawn fired jumpscare stinger", (counts.stinger ?? 0) >= 1, `stinger=${counts.stinger ?? 0}`);

await page.evaluate(() => { window.__backrooms.cheats.freeze = true; }); // freeze AI
await sleep(200);
// gun hit on grandma -> onHitEnemy -> melee-impact sample
await page.evaluate(() => {
  const e = window.__backrooms;
  const p = e.player;
  const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
  e.activeEnemy.pos.set(p.pos.x + fx * 3, 0, p.pos.z + fz * 3);
  e.weapons.give("handgun");
  e.weapons.addAmmo(10);
  e.weapons.cooldownT = 0;
  e.weapons.tryAttack(e.enemies);
});
await sleep(300);
counts = await audio("playedCounts");
const impacts = (counts.impact1 ?? 0) + (counts.impact2 ?? 0);
check("hit on enemy fired impact sample", impacts >= 1, `impacts=${impacts}`);

// kill grandma -> onEnemyDeath -> onScreech -> growl (tier-pitched)
await page.evaluate(() => { window.__backrooms.activeEnemy.hp = 1; });
await page.keyboard.press("KeyK");
await page.waitForFunction(() => {
  const e = window.__backrooms;
  return !e.activeEnemy || e.activeEnemy.cfg.slug !== "grandma";
}, { timeout: 30000 }).catch(() => {});
counts = await audio("playedCounts");
check("enemy death screech played growl sample", (counts.growl ?? 0) >= 1, `growl=${counts.growl ?? 0}`);

/* ---- 6) music ducks ~50% in chase, restores after ---- */

await page.evaluate(() => { window.__backrooms.calmT = 0; });
await page.waitForFunction(() => window.__backrooms.activeEnemy?.cfg.slug === "grandpa", { timeout: 60000 });
// still frozen from before — a second KeyX would TOGGLE it off and let the
// AI overwrite the forced "chase" state below
const restBefore = await audio("musicLevel");
await page.evaluate(() => { window.__backrooms.activeEnemy.state = "chase"; });
await sleep(2000);
const ducked = await audio("musicLevel");
check("chase ducks music ~50%", ducked < restBefore * 0.72,
  `rest=${restBefore.toFixed(3)} ducked=${ducked.toFixed(3)}`);
await page.evaluate(() => { window.__backrooms.activeEnemy.state = "roam"; });
await sleep(5000);
const restored = await audio("musicLevel");
check("music restores after chase", restored > ducked * 1.4,
  `ducked=${ducked.toFixed(3)} restored=${restored.toFixed(3)}`);

/* ---- 7) sanity: hiding creak + pickup + door samples fire ---- */

await page.evaluate(() => {
  const e = window.__backrooms;
  e.audio.creak("wardrobe");
  e.audio.creak("under-bed");
  e.audio.pickup();
  e.audio.doorOpen();
});
await sleep(300);
counts = await audio("playedCounts");
check("wardrobe/door creak + pickup + door-open samples",
  (counts.wardrobeCreak ?? 0) >= 1 && (counts.doorCreak ?? 0) >= 1 &&
  (counts.pickup ?? 0) >= 1 && (counts.doorOpen ?? 0) >= 1,
  JSON.stringify({ w: counts.wardrobeCreak, d: counts.doorCreak, p: counts.pickup, o: counts.doorOpen }));

/* ---------------- wrap up ---------------- */

console.log("pageerrors:", errors.length, errors.slice(0, 8));
check("0 console errors", errors.length === 0);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
await browser.close();
process.exit(failed.length ? 1 : 0);
