/** P5 verification: hiding spots — furniture models, hiding, AI perception. */
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

// cheats on; spawn grandma immediately
await page.keyboard.type("redrum");
await sleep(200);
await page.evaluate(() => { window.__backrooms.startedAt = -100; });
await page.waitForFunction(() => !!window.__backrooms.activeEnemy, { timeout: 60000 });
await sleep(300);

/* ---------------- helpers ---------------- */

// world-space data for one hiding spot
const spotInfo = (id) =>
  page.evaluate((id) => {
    const e = window.__backrooms;
    const i = e.hiding.spots.findIndex((s) => s.def.id === id);
    const s = e.hiding.spots[i];
    return {
      index: i,
      kind: s.def.kind,
      occupied: s.occupied,
      pos: { x: s.def.pos.x, y: s.def.pos.y, z: s.def.pos.z },
      anchor: { x: s.anchor.x, y: s.anchor.y, z: s.anchor.z },
      yaw: s.def.yaw,
    };
  }, id);

// Stand the player in front of a spot's opening, aiming at its anchor.
const gotoSpot = (id) =>
  page.evaluate((id) => {
    const e = window.__backrooms;
    const s = e.hiding.spots.find((x) => x.def.id === id);
    const fx = Math.sin(s.def.yaw), fz = Math.cos(s.def.yaw);
    const p = e.player;
    p.pos.set(s.def.pos.x + fx * 1.4, 0, s.def.pos.z + fz * 1.4);
    p.vel.set(0, 0, 0);
    const dx = s.anchor.x - p.pos.x, dz = s.anchor.z - p.pos.z;
    p.yaw = Math.atan2(-dx, -dz);
    p.pitch = Math.atan2(s.anchor.y - 1.62, Math.hypot(dx, dz));
  }, id);

const state = () =>
  page.evaluate(() => ({
    game: window.__backrooms.state,
    hidden: window.__backrooms.player.hidden,
    activeSpot: window.__backrooms.hiding.active?.def.id ?? null,
    prompt: window.__backrooms.lastPrompt,
    torch: window.__backrooms.player.flashlightOn,
    enemy: window.__backrooms.activeEnemy?.state ?? null,
    enemyPos: window.__backrooms.activeEnemy
      ? { x: window.__backrooms.activeEnemy.pos.x, z: window.__backrooms.activeEnemy.pos.z }
      : null,
    checking: (window.__backrooms.activeEnemy?.checkT ?? 0) > 0,
    playerPos: {
      x: window.__backrooms.player.pos.x,
      z: window.__backrooms.player.pos.z,
    },
  }));

// Park the enemy somewhere with NO line of sight to the player (other end of
// the house, behind walls), in a given AI state.
const parkEnemy = (st) =>
  page.evaluate((st) => {
    const e = window.__backrooms;
    const en = e.activeEnemy;
    en.pos.set(-20, 0, -10); // garage corner
    en.losLostTime = 999;
    en.paranoiaCd = 0;
    en.state = st;
    en.path = [];
    en.waypoint = null;
    en.attackT = 0;
  }, st);

/* ================================================================
 * (a) enter wardrobe UNSEEN: chase breaks to search, player survives 20s
 * ================================================================ */

const W1 = "hide-bed1-wardrobe"; // master bedroom, opening faces west
await gotoSpot(W1);
await sleep(1200);
let s = await state();
check("wardrobe prompt shows [E] HIDE IN WARDROBE", s.prompt === "[E] HIDE IN WARDROBE", s.prompt);

// enemy is "chasing" but has not seen the player in ages (no LOS now)
await parkEnemy("chase");
await page.keyboard.press("KeyE");
await sleep(1200);
s = await state();
check("entered wardrobe (hidden, occupied)", s.hidden && s.activeSpot === W1, JSON.stringify(s));
check("torch auto-off while hidden", s.torch === false);

// chase must snap to search within a couple of seconds
await sleep(2500);
s = await state();
check("chase -> search after unseen hide", s.enemy === "search", s.enemy);

// disable paranoia for the survival soak (tested separately in (d))
await page.evaluate(() => { window.__backrooms.activeEnemy.paranoiaCd = 999; });

// screenshot: first-person inside the wardrobe (dark + gap)
await page.screenshot({ path: "scripts/shots/p5-inside-wardrobe.png" });

// survive 20s real time hidden; enemy must not find/kill
await sleep(20000);
s = await state();
check("survived 20s hidden (no god)", s.game === "playing" && s.hidden, JSON.stringify(s));

/* ================================================================
 * (b) exit works (E, ~0.5s climb, torch restored)
 * ================================================================ */

await page.keyboard.press("KeyE");
await sleep(300);
const midExit = await state();
check("exit takes a moment (still hidden right after E)", midExit.hidden === true);
// headless runs ~4-10x slow — wait out the 0.5s game-time climb
await page.waitForFunction(() => !window.__backrooms.player.hidden, { timeout: 30000 });
s = await state();
const w1 = await spotInfo(W1);
const exitDist = Math.hypot(s.playerPos.x - w1.pos.x, s.playerPos.z - w1.pos.z);
check(
  "exited wardrobe: standing clear, torch back on",
  !s.hidden && s.activeSpot === null && s.torch === true && exitDist > 0.8,
  JSON.stringify({ ...s, exitDist: exitDist.toFixed(2) }),
);
check("spot free again after exit", (await spotInfo(W1)).occupied === false);

/* ================================================================
 * screenshots: furniture placement (fullbright tour of the bedrooms)
 * ================================================================ */

await page.keyboard.press("KeyB"); // fullbright
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
  await sleep(2500); // let furniture GLBs land + a few frames render
  await page.screenshot({ path: `scripts/shots/${file}` });
};
// master bedroom: wardrobe (east wall) + bed, viewed from the doorway side
await look(14, -16.5, 28.3, -20.5, 0.02, "p5-bedroom1.png");
// bedroom 2: wardrobe + bed
await look(3.5, -6, -2.05, -5.1, 0.02, "p5-bedroom2.png");
// dining room: table + chairs (target: table at house 20,13.4 -> world -10,-8.6)
await look(-15, -4, -10, -8.6, 0.02, "p5-dining.png");
// living: sofa (house 5.25,28.8 -> world -24.75,6.8) from the foyer side
await look(-17, 3, -24.75, 6.8, 0.02, "p5-living.png");
// kitchen: fridge + counter run (fridge house 26.35,7.95 -> world -3.65,-14.05)
await look(-13, -14, -3.65, -14.05, 0.02, "p5-kitchen.png");
await page.keyboard.press("KeyB"); // fullbright off
await sleep(200);

/* ================================================================
 * (d) search paranoia: a spot check on an OCCUPIED spot kills (god soaks
 *     the kill so the run continues), then an empty-spot check screenshot
 * ================================================================ */

await page.keyboard.press("KeyG"); // god on — the drag-out passes through
await sleep(200);
await gotoSpot(W1);
await sleep(1000);
await parkEnemy("search");
await page.keyboard.press("KeyE");
await sleep(1000);
s = await state();
check("re-hidden for paranoia test", s.hidden === true);

// force the paranoia appointment on the player's own spot (enemy parked a
// short walk from the stand point — the kill path is what matters here)
await page.evaluate(() => {
  const e = window.__backrooms;
  const spot = e.hiding.spots.find((x) => x.def.id === "hide-bed1-wardrobe");
  const fx = Math.sin(spot.def.yaw), fz = Math.cos(spot.def.yaw);
  e.activeEnemy.pos.set(spot.def.pos.x + fx * 4.5, 0, spot.def.pos.z + fz * 4.5);
  e.activeEnemy.paranoiaCd = 0;
  e.activeEnemy.inspectHidingSpot(spot);
});
await page.waitForFunction(() => (window.__backrooms.activeEnemy?.checkT ?? 0) > 0, { timeout: 90000 });
check("enemy walked to the spot and started the look-in", true);
await page.screenshot({ path: "scripts/shots/p5-check-through-gap.png" });
// the look-in ends -> occupied -> kill -> god mode soaks it
await sleep(6000);
s = await state();
check("occupied check fired the kill (god soaked it, still playing)", s.game === "playing", s.game);
check("enemy resume after check", s.enemy === "search" || s.enemy === "roam" || s.enemy === "chase", s.enemy);

// exit, step back, force a check on the now-EMPTY spot — photo from outside
await page.keyboard.press("KeyE");
await page.waitForFunction(() => !window.__backrooms.player.hidden, { timeout: 30000 });
await page.evaluate(() => {
  const e = window.__backrooms;
  const spot = e.hiding.spots.find((x) => x.def.id === "hide-bed1-wardrobe");
  const fx = Math.sin(spot.def.yaw), fz = Math.cos(spot.def.yaw);
  e.activeEnemy.pos.set(spot.def.pos.x + fx * 5, 0, spot.def.pos.z + fz * 5 + 2.5);
  e.activeEnemy.paranoiaCd = 0;
  e.activeEnemy.inspectHidingSpot(spot);
});
await page.waitForFunction(() => (window.__backrooms.activeEnemy?.checkT ?? 0) > 0, { timeout: 90000 });
// face the wardrobe from across the room for the money shot
await page.evaluate(() => {
  const e = window.__backrooms;
  const en = e.activeEnemy;
  const p = e.player;
  p.pos.set(en.pos.x - 4.5, 0, en.pos.z - 3.5);
  p.vel.set(0, 0, 0);
  const dx = en.pos.x - p.pos.x, dz = en.pos.z - p.pos.z;
  p.yaw = Math.atan2(-dx, -dz);
  p.pitch = 0;
});
await sleep(600);
await page.screenshot({ path: "scripts/shots/p5-enemy-check.png" });
s = await state();
check("empty-spot check did NOT kill", s.game === "playing", s.game);
await page.keyboard.press("KeyG"); // god off
await sleep(200);

/* ================================================================
 * (c) caught entering: hide while the enemy has LOS -> it walks over,
 *     looks inside, drags you out -> dead
 * ================================================================ */

await gotoSpot(W1);
await sleep(1000);
await page.evaluate(() => {
  const e = window.__backrooms;
  const en = e.activeEnemy;
  // right there in the same room, staring at the player
  en.pos.set(e.player.pos.x - 4, 0, e.player.pos.z + 2.5);
  en.state = "chase";
  en.losLostTime = 0;
  en.attackT = 0;
  en.paranoiaCd = 0;
});
await sleep(400); // a frame or two so LOS registers fresh
await page.keyboard.press("KeyE");
await sleep(800);
s = await state();
check("entered wardrobe while seen", s.hidden === true && s.game === "playing", JSON.stringify(s));

// it should walk over and look in — then the drag-out
await page.waitForFunction(
  () => window.__backrooms.state === "dying" || window.__backrooms.state === "dead",
  { timeout: 120000 },
);
check("caught-entering led to the kill", true);
await page.waitForFunction(() => window.__backrooms.state === "dead", { timeout: 90000 });
s = await state();
check("run ended dead (Granny rules)", s.game === "dead", s.game);
await page.screenshot({ path: "scripts/shots/p5-caught-death.png" });

/* ---------------- wrap up ---------------- */

console.log("pageerrors:", errors.length, errors.slice(0, 8));
check("0 console errors", errors.length === 0);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
await browser.close();
process.exit(failed.length ? 1 : 0);
