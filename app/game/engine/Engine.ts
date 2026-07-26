import * as THREE from "three";
import { Level, WALL_H } from "./level";
import { Player, EYE_HEIGHT } from "./player";
import { Enemy, ENEMIES, CAUGHT_WINDOW } from "./enemy";
import { instantiate, preloadModel } from "./gltf";
import { GameAudio } from "./audio";
import { GameFX } from "./fx";
import { VFX } from "./vfx";
import { Items } from "./items";
import { Weapons, WEAPONS, WEAPON_SLOTS, AMMO_PER_BOX, WeaponId } from "./weapons";
import { Hiding, HIDE_EXIT_TIME } from "./hiding";
import { FURNITURE_SLUGS, loadFurnitureModels } from "./furniture";
import { randRange } from "./rng";

export type GameState = "idle" | "playing" | "paused" | "dying" | "dead" | "won";

export interface HudState {
  /** enemies put down this run (0-3 — the full kill chain) */
  kills: number;
  stamina: number;
  prompt: string | null;
  objective: string;
  flashlight: boolean;
  sneaking: boolean;
  /** compact list of active cheats, e.g. "GOD · NOCLIP" — null when none */
  cheats: string | null;
  /** name of the thing currently hunting you — null in the quiet gaps */
  enemy: string | null;
  /** equipped weapon + ammo (null ammo = melee) — null when empty-handed */
  weapon: { name: string; ammo: number | null } | null;
  /** owned slot hints, e.g. "[1] HANDGUN  [2] FIRE AXE" — null when none */
  slots: string | null;
  /** brief true pulse when an attack connects — crosshair hit marker */
  hitFlash: boolean;
  /** P5: the kind of spot the player is hidden in — null when out in the open */
  hidden: "wardrobe" | "under-bed" | null;
}

export interface EngineCallbacks {
  onState: (state: GameState) => void;
  onHud: (hud: HudState) => void;
  /** run-over stats — kills = enemies put down, enemy = slug of the killer (death) or null (escaped) */
  onStats: (stats: { seconds: number; kills: number; enemy: string | null }) => void;
  onToast: (msg: string) => void;
}

const POOL_SIZE = 12;
const UP = new THREE.Vector3(0, 1, 0);
/** keys the browser must not act on while playing (Ctrl+S, space scroll…) */
const GAME_KEYS = new Set([
  "KeyW", "KeyA", "KeyS", "KeyD",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight",
  "KeyE", "KeyF", "KeyC", "Space",
]);
/** movement keys — pressing one while hidden starts the climb out */
const MOVE_KEYS = new Set([
  "KeyW", "KeyA", "KeyS", "KeyD",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
]);

export class Engine {
  state: GameState = "idle";

  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private level: Level;
  private player: Player;
  /** every enemy spawned this run — corpses included (mixers keep ticking) */
  private enemies: Enemy[] = [];
  /** the enemy currently hunting, null during calm gaps / before first spawn */
  private activeEnemy: Enemy | null = null;
  /** the one that landed the killing blow — the death cam stares at it */
  private killer: Enemy | null = null;
  /** kill-chain progress: -1 = nobody yet, else index of NEXT tier in ENEMIES */
  private tier = -1;
  /** enemies put down this run — the devil's death unlocks the exit */
  private get kills(): number {
    return Math.min(Math.max(this.tier, 0), ENEMIES.length);
  }
  /** calm seconds left before the next tier walks in */
  private calmT = 0;
  private spawning = false;
  /** set when the devil dies — the flow phase consumes this; unlocks the exit */
  exitUnlocked = false;
  private items: Items;
  /** P5: wardrobe / under-bed hiding spots + the climb-out lerp */
  private hiding: Hiding;
  /** inventory + first-person viewmodels + hit resolution (P4) */
  readonly weapons: Weapons;
  private audio = new GameAudio();
  private fx: GameFX;
  /** P6: pooled world-space particles — muzzle flash, impacts, blood, smoke */
  readonly vfx: VFX;

  private clock = new THREE.Clock();
  private elapsed = 0;
  private raf = 0;

  private fear = 0;
  private fearSpike = 0;
  private glitch = 0;
  private beatPhase = 0;
  private deathT = 0;
  private startedAt = 0;

  private lightPool: THREE.PointLight[] = [];
  private fixtureMult: Float32Array;
  private fixtureBurst = new Map<number, number>();
  /** dead fixtures temporarily sputtering alive — index -> seconds left */
  private fixtureFlare = new Map<number, number>();
  private nextAmbientEvent = 18;
  private hudTimer = 0;
  private lastPrompt: string | null = null;
  /** crosshair hit-marker seconds left (P4) */
  private hitFlashT = 0;

  /** dev cheats — unlocked by typing "redrum" while playing */
  readonly cheats = { unlocked: false, god: false, noclip: false, fullbright: false, freeze: false };
  private cheatBuffer = "";
  /** one-time "sneak is C, not Ctrl" toast for muscle-memory players */
  private ctrlHintShown = false;
  private brightLight: THREE.AmbientLight | null = null;

  // pointer-lock bookkeeping (Chromium enforces a ~1.25s relock cooldown)
  private unlockAt = -10000;
  private pendingLock: ReturnType<typeof setTimeout> | null = null;
  /** true once a pointer lock has ever engaged — arms the in-game watchdog */
  private hasLockedOnce = false;
  private lockLossT = 0;
  /** ignore mousemove until this time — lock engagement fires garbage deltas */
  private lockGraceUntil = 0;
  /** primary input is touch (phone/tablet) — no pointer lock on these */
  readonly touchPrimary =
    typeof window !== "undefined" &&
    window.matchMedia?.("(pointer: coarse)").matches === true;

  // scratch vectors — the hot loop must not allocate (GC pauses = stutter)
  private vCamDir = new THREE.Vector3();
  private vA = new THREE.Vector3();
  private vB = new THREE.Vector3();
  private nearestLitSq = Infinity;

  private disposed = false;
  private detachInput: (() => void) | null = null;

  constructor(
    private container: HTMLElement,
    private canvas: HTMLCanvasElement,
    private callbacks: EngineCallbacks,
    private seed = (Date.now() ^ (Math.random() * 0xffffff)) >>> 0,
  ) {
    const width = container.clientWidth;
    const height = container.clientHeight;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      powerPreference: "high-performance",
    });
    this.renderer.setSize(width, height, false);
    // Render at the device's native pixel ratio (capped — phones report 3+).
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.2;

    const fogColor = new THREE.Color(0x0e0b06);
    this.scene.background = fogColor;
    this.scene.fog = new THREE.FogExp2(fogColor, 0.036);

    // A dim, warm house at night: faint bounce light only — the tungsten
    // ceiling lamps (fixtures) and the flashlight do the real work.
    this.scene.add(new THREE.AmbientLight(0x352c1c, 0.55));
    this.scene.add(new THREE.HemisphereLight(0xffe2b0, 0x2e2820, 0.35));

    this.level = new Level(seed);
    this.level.build(this.scene);
    this.fixtureMult = new Float32Array(this.level.fixtures.length).fill(-1);

    this.player = new Player(this.level, width / height);
    this.player.addTo(this.scene);
    this.player.onStep = (sprinting) => this.audio.playerStep(sprinting);

    // Warm the GLTF cache now — the ~20s grace before grandma wakes is
    // plenty of cover for the downloads, so no spawn ever hitches.
    for (const cfg of ENEMIES) preloadModel(cfg.slug);
    for (const slug of ["handgun", "axe", "shovel", "ammo-box"]) preloadModel(slug);
    for (const slug of FURNITURE_SLUGS) preloadModel(slug);

    this.hiding = new Hiding(this.level);
    this.items = new Items(this.level, seed, this.scene, this.hiding.spots);
    loadFurnitureModels(this.level);

    this.weapons = new Weapons(this.level, this.player);
    this.weapons.addTo(this.scene);
    // Loud actions wake the hunter; hits flash the crosshair; dry fire clicks.
    this.weapons.onNoise = (radius) =>
      this.activeEnemy?.hearNoise(this.player.pos, radius);
    this.weapons.onHitEnemy = () => {
      this.hitFlashT = 0.18;
      this.audio.meleeImpact();
    };
    this.weapons.onDryFire = () => this.audio.click();
    this.weapons.onSwing = () => this.audio.meleeSwing();

    // P6: hang world-space effects off the weapon events.
    this.vfx = new VFX(this.scene);
    this.weapons.onFire = (pos) => {
      this.player.camera.getWorldDirection(this.vCamDir);
      this.vfx.gunshot(pos, this.vCamDir);
      this.audio.gunshot();
    };
    this.weapons.onImpact = (point, hitEnemy) => {
      if (hitEnemy) {
        const melee =
          this.weapons.current !== null &&
          WEAPONS[this.weapons.current].kind === "melee";
        this.vfx.blood(point, melee ? 0.65 : 1);
        // not every hit paints the room — decals are the occasional souvenir
        if (Math.random() < (melee ? 0.3 : 0.55)) this.bloodDecalNear(point);
      } else {
        this.vfx.impact(point, this.surfaceNormalAt(point, this.vA));
      }
    };

    for (let i = 0; i < POOL_SIZE; i++) {
      const l = new THREE.PointLight(0xffd9a0, 0, 13, 1.8);
      this.lightPool.push(l);
      this.scene.add(l);
    }

    this.fx = new GameFX(this.renderer, this.scene, this.player.camera, width, height);

    this.attachInput();
    this.loop();
  }

  /* ----------------------------- lifecycle ----------------------------- */

  start() {
    if (this.state !== "idle") return;
    this.audio.init();
    void this.audio.resume();
    this.setState("playing");
    this.startedAt = this.elapsed;
    if (this.touchPrimary) this.enterTouchFullscreen();
    else this.lockPointer();
    this.pushHud(true);
  }

  resume() {
    if (this.state !== "paused") return;
    if (this.touchPrimary) {
      // No pointer lock on touch devices — resume directly (and re-grab
      // fullscreen, the back gesture / Esc may have dropped it).
      this.enterTouchFullscreen();
      void this.audio.resume();
      this.setState("playing");
      return;
    }
    // The state flips to "playing" once the pointer lock actually engages
    // (see onLockChange) — flipping early would fight the relock cooldown.
    this.lockPointer();
  }

  /**
   * Phones only: browser chrome eats ~25% of a small landscape screen, so
   * go fullscreen on the start/resume tap (a user gesture, as required).
   * Desktop deliberately stays in-tab. iPhone Safari has no Fullscreen API
   * at all — there the manifest's display:fullscreen (add to home screen)
   * is the only route, so a rejection here is silently ignored.
   */
  private enterTouchFullscreen() {
    if (document.fullscreenElement) return;
    try {
      const p = document.documentElement.requestFullscreen?.({ navigationUI: "hide" });
      void p
        ?.then(() => {
          // Pin landscape while fullscreen (Android; needs fullscreen first).
          const o = screen.orientation as ScreenOrientation & {
            lock?: (o: string) => Promise<void>;
          };
          return o.lock?.("landscape");
        })
        .catch(() => {});
    } catch {
      // older WebKit throws synchronously — nothing to do
    }
  }

  /** External pause (pause button on touch UI / rotate-to-portrait). */
  pause() {
    if (this.state !== "playing") return;
    this.player.clearKeys();
    this.player.touchMove.x = 0;
    this.player.touchMove.z = 0;
    void this.audio.suspend();
    this.setState("paused");
  }

  private setState(s: GameState) {
    if (this.state === s) return;
    this.state = s;
    this.callbacks.onState(s);
  }

  /**
   * Cooldown-aware pointer lock. Chromium rejects requestPointerLock for
   * ~1.25s after an unlock; firing into that window silently fails and the
   * game feels like "the mouse stopped working". Queue the request instead.
   */
  private lockPointer() {
    if (this.pendingLock !== null) {
      clearTimeout(this.pendingLock);
      this.pendingLock = null;
    }
    const wait = 1350 - (performance.now() - this.unlockAt);
    if (wait > 0) {
      this.pendingLock = setTimeout(() => {
        this.pendingLock = null;
        if (!this.disposed && document.pointerLockElement !== this.canvas) {
          this.doLock();
        }
      }, wait);
    } else {
      this.doLock();
    }
  }

  private doLock() {
    const el = this.canvas as HTMLCanvasElement & {
      requestPointerLock(options?: { unadjustedMovement?: boolean }): Promise<void> | void;
    };
    try {
      const res = el.requestPointerLock({ unadjustedMovement: true });
      if (res && typeof (res as Promise<void>).catch === "function") {
        (res as Promise<void>).catch(() => el.requestPointerLock());
      }
    } catch {
      el.requestPointerLock();
    }
  }

  private attachInput() {
    const onMouseMove = (e: MouseEvent) => {
      if (this.state === "playing" && document.pointerLockElement === this.canvas) {
        // Chromium fires bogus movement deltas right as the lock engages
        // (cursor recenter leaks in) — would snap the view across the room.
        if (performance.now() < this.lockGraceUntil) return;
        this.player.onMouseDelta(e.movementX, e.movementY);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (this.state !== "playing") return;
      // Keep game keys away from the browser (Ctrl+S dialog, space scroll…).
      if (GAME_KEYS.has(e.code)) e.preventDefault();
      // OS key repeat fires keydown over and over while a key is held —
      // without this, every toggle (sneak, torch) strobes on/off. Movement
      // is held-key-set based, so repeats carry no information at all.
      if (e.repeat) return;
      // Old habit guard: Ctrl is NOT sneak. A held Ctrl makes W close the
      // tab (Ctrl+W is browser-reserved, unblockable outside fullscreen).
      if (e.code === "ControlLeft" || e.code === "ControlRight") {
        if (!this.ctrlHintShown) {
          this.ctrlHintShown = true;
          this.toast("SNEAK IS ON [C] — DON'T HOLD CTRL, CTRL+W CLOSES THE TAB");
        }
        return;
      }
      // Hidden: E or any movement key starts the climb out; everything else
      // (torch, sneak, weapon slots, fire) is dead until you're out.
      if (this.hiding.active) {
        if (e.code === "KeyE") this.tryInteract();
        else if (MOVE_KEYS.has(e.code)) this.beginExitHiding();
        this.handleCheatKeys(e);
        return;
      }
      this.player.keyDown(e.code);
      if (e.code === "KeyE") this.tryInteract();
      if (e.code === "KeyF") this.audio.click();
      if (e.code === "Digit1" || e.code === "Digit2" || e.code === "Digit3") {
        if (this.weapons.selectSlot(Number(e.code.slice(-1)) - 1)) this.pushHud(true);
      }
      this.handleCheatKeys(e);
    };
    const onMouseDown = (e: MouseEvent) => {
      // Attack only while the pointer is captured — an unlocked click is the
      // player's "give me back the mouse" gesture (see onCanvasClick), not a
      // shot, so the two never fight. No firing from inside a wardrobe.
      if (e.button === 0 && this.state === "playing" && !this.hiding.active &&
          document.pointerLockElement === this.canvas) {
        this.weapons.tryAttack(this.enemies);
      }
    };
    const onCanvasClick = () => {
      // Safety net: relock if the browser dropped the lock without pausing us.
      if (this.state === "playing" && !this.touchPrimary &&
          document.pointerLockElement !== this.canvas) {
        this.lockPointer();
      }
    };
    const onBlur = () => {
      // Focus stolen (alt-tab, OS popup, click outside a windowed game) —
      // pause so keys don't stick and the run isn't lost blind.
      if (this.state === "playing" && !this.touchPrimary) this.pause();
    };
    const onKeyUp = (e: KeyboardEvent) => this.player.keyUp(e.code);
    const onLockChange = () => {
      if (document.pointerLockElement === this.canvas) {
        this.hasLockedOnce = true;
        this.lockGraceUntil = performance.now() + 200;
        // Lock (re)acquired — if we were waiting in the pause menu, resume.
        if (this.state === "paused") {
          void this.audio.resume();
          this.setState("playing");
        }
      } else {
        this.unlockAt = performance.now();
        if (this.state === "playing") {
          this.player.clearKeys();
          void this.audio.suspend();
          this.setState("paused");
        }
      }
    };
    const onResize = () => {
      const w = this.container.clientWidth;
      const h = this.container.clientHeight;
      this.player.camera.aspect = w / h;
      this.player.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h, false);
      this.fx.setSize(w, h, this.renderer.getPixelRatio());
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("pointerlockchange", onLockChange);
    window.addEventListener("resize", onResize);
    window.addEventListener("blur", onBlur);
    this.canvas.addEventListener("click", onCanvasClick);

    this.detachInput = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keyup", onKeyUp);
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("pointerlockchange", onLockChange);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("blur", onBlur);
      this.canvas.removeEventListener("click", onCanvasClick);
    };
  }

  /* --------------------------- touch controls --------------------------- */
  // Driven by the React touch overlay (joystick / look pad / buttons).

  setTouchMove(x: number, z: number) {
    // pushing the stick while hidden = climb out
    if (this.hiding.active && Math.hypot(x, z) > 0.5) {
      this.beginExitHiding();
      return;
    }
    this.player.touchMove.x = x;
    this.player.touchMove.z = z;
  }

  touchLook(dx: number, dy: number) {
    if (this.state === "playing") this.player.onMouseDelta(dx, dy);
  }

  touchInteract() {
    if (this.state === "playing") this.tryInteract();
  }

  touchTorch() {
    if (this.state !== "playing" || this.hiding.active) return;
    this.player.toggleFlashlight();
    this.audio.click();
  }

  setSneak(on: boolean) {
    this.player.sneaking = on;
  }

  touchAttack() {
    if (this.state === "playing" && !this.hiding.active) this.weapons.tryAttack(this.enemies);
  }

  touchCycleWeapon() {
    if (this.state === "playing" && this.weapons.cycle()) this.pushHud(true);
  }

  /* ---------------------------- progression ---------------------------- */
  // One hunter at a time: grandma -> grandpa -> devil. A kill buys a few
  // seconds of quiet, then something worse walks in. Killing the devil
  // breaks the house's hold on the front door.

  /** How long after the run starts grandma wakes up. */
  private static readonly FIRST_SPAWN_DELAY = 20;

  private spawnTier(tier: number) {
    if (this.spawning || tier >= ENEMIES.length) return;
    this.spawning = true;
    const cfg = ENEMIES[tier];
    void instantiate(cfg.slug)
      .then((inst) => {
        if (this.disposed) return;
        const e = new Enemy(this.level, this.seed + tier * 7919, cfg, inst);
        e.addTo(this.scene);
        e.hidingSpots = this.hiding.spots;
        e.onScreech = () => this.onScreech();
        e.onStep = () => this.onEnemyStep(e);
        e.onKill = () => this.beginDeath(e);
        e.onDeath = () => this.onEnemyDeath(e);
        e.onCheckSpot = () => this.onEnemyCheckSpot(e);
        // Horror-director teleports leave/ arrive in a puff of dark smoke.
        e.onTeleport = (from, to) => {
          const devil = cfg.slug === "devil";
          this.vfx.teleportPuff(from, devil);
          this.vfx.teleportPuff(to, devil);
        };
        // First tier uses the plan's garage spawn; later tiers walk in from
        // as far from the player as the house allows.
        const cell = tier === 0
          ? this.level.entitySpawnCell
          : this.level.distantCellFrom(
              this.level.cellOf(this.player.pos.x, this.player.pos.z),
              18,
              Math.random,
            );
        e.activate(cell);
        // Materialize smoke — the devil's Come-out intro especially.
        this.vfx.teleportPuff(e.pos, cfg.slug === "devil");
        this.enemies.push(e);
        this.activeEnemy = e;
        this.spawning = false;
        this.audio.stinger(0.55); // "something stirs" — the house notices
        this.toast(
          tier === 0
            ? "SOMETHING STIRS IN THE HOUSE…"
            : `SOMETHING WORSE STIRS — ${cfg.displayName.toUpperCase()} IS HERE`,
        );
        this.pushHud(true);
      })
      .catch((err) => {
        this.spawning = false;
        console.error(`failed to spawn ${cfg.slug}:`, err);
      });
  }

  private onEnemyDeath(e: Enemy) {
    const cfg = e.cfg;
    this.onScreech(); // death sting
    // The collapse gets a lingering burst — the devil goes out big and red.
    this.vfx.deathBurst(e.pos, cfg.slug === "devil");
    this.activeEnemy = null; // corpse stays in the world, the hunt pauses
    this.tier++;
    if (this.tier >= ENEMIES.length) {
      // The devil is down — the house lets go of the door.
      this.exitUnlocked = true;
      this.items.exitUnlocked = true;
      this.items.openExit();
      this.audio.doorOpen();
      this.toast(`${cfg.displayName.toUpperCase()} IS DEAD — THE FRONT DOOR GIVES WAY`);
    } else {
      this.calmT = 9; // a few breaths of quiet, then the next one
      this.toast(`${cfg.displayName.toUpperCase()} IS DOWN — BUT THE HOUSE IS NOT DONE`);
    }
    this.pushHud(true);
  }

  /* ------------------------------ cheats ------------------------------ */

  /**
   * Developer cheats. Type "redrum" during a run to unlock, then:
   * G god · N noclip · B fullbright · X freeze enemy · K damage enemy · T to exit
   */
  private handleCheatKeys(e: KeyboardEvent) {
    if (/^[a-z]$/i.test(e.key)) {
      this.cheatBuffer = (this.cheatBuffer + e.key.toLowerCase()).slice(-10);
      if (!this.cheats.unlocked && this.cheatBuffer.endsWith("redrum")) {
        this.cheats.unlocked = true;
        this.toast("CHEATS UNLOCKED — [G]OD [N]OCLIP [B]RIGHT [X]FREEZE [K]DAMAGE [T]ELEPORT");
        return;
      }
    }
    if (!this.cheats.unlocked) return;

    switch (e.code) {
      case "KeyG":
        this.cheats.god = !this.cheats.god;
        this.toast(`GOD MODE ${this.cheats.god ? "ON" : "OFF"}`);
        break;
      case "KeyN":
        this.cheats.noclip = !this.cheats.noclip;
        this.player.noclip = this.cheats.noclip;
        this.toast(`NOCLIP ${this.cheats.noclip ? "ON — through the walls" : "OFF"}`);
        break;
      case "KeyB":
        this.cheats.fullbright = !this.cheats.fullbright;
        if (this.cheats.fullbright && !this.brightLight) {
          this.brightLight = new THREE.AmbientLight(0xfff4d8, 2.4);
          this.scene.add(this.brightLight);
        } else if (!this.cheats.fullbright && this.brightLight) {
          this.scene.remove(this.brightLight);
          this.brightLight = null;
        }
        this.toast(`FULLBRIGHT ${this.cheats.fullbright ? "ON" : "OFF"}`);
        break;
      case "KeyX":
        this.cheats.freeze = !this.cheats.freeze;
        this.toast(`ENEMY ${this.cheats.freeze ? "FROZEN" : "RELEASED"}`);
        break;
      case "KeyK": {
        // Hand-drive the kill chain: 50 damage to whatever is hunting.
        const target = this.activeEnemy;
        if (target && !target.dying) {
          target.takeDamage(50);
          this.toast(`DEALT 50 — ${target.cfg.displayName.toUpperCase()} HP ${Math.max(0, target.hp)}`);
        } else {
          this.toast("NOTHING TO HIT");
        }
        break;
      }
      case "KeyT": {
        const exit = this.level.exit;
        this.player.pos.set(
          exit.doorPos.x + exit.facing.x * 1.6,
          0,
          exit.doorPos.z + exit.facing.z * 1.6,
        );
        this.player.vel.set(0, 0, 0);
        this.player.yaw = Math.atan2(-exit.facing.x, -exit.facing.z) + Math.PI;
        this.toast("TELEPORTED TO THE EXIT DOOR");
        break;
      }
    }
  }

  private toast(msg: string) {
    this.callbacks.onToast(msg);
  }

  /* ------------------------------ VFX (P6) ------------------------------ */

  /**
   * Best-guess surface normal at a bullet hit: probe the grid 18cm out on
   * each axis (walls), then floor/ceiling by height, else face the shooter.
   */
  private surfaceNormalAt(point: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    const P = 0.18;
    if (this.level.solidAtWorld(point.x + P, point.z)) return out.set(-1, 0, 0);
    if (this.level.solidAtWorld(point.x - P, point.z)) return out.set(1, 0, 0);
    if (this.level.solidAtWorld(point.x, point.z + P)) return out.set(0, 0, -1);
    if (this.level.solidAtWorld(point.x, point.z - P)) return out.set(0, 0, 1);
    if (point.y < 0.35) return out.set(0, 1, 0);
    if (point.y > WALL_H - 0.35) return out.set(0, -1, 0);
    return out.subVectors(this.player.camera.position, point).normalize();
  }

  /** Splatter near an enemy hit: wall behind it if one's close, else the floor. */
  private bloodDecalNear(point: THREE.Vector3) {
    const n = this.surfaceNormalAt(point, this.vB);
    const p = this.vA.copy(point).addScaledVector(n, 0.03);
    if (n.y > 0.5) p.y = 0.02 + Math.random() * 0.012; // sit just above the boards
    this.vfx.bloodDecal(p, n, randRange(Math.random, 0.9, 1.5));
  }

  /* ----------------------------- gameplay ----------------------------- */

  private tryInteract() {
    // Hidden: E is always "get out".
    if (this.hiding.active) {
      this.beginExitHiding();
      return;
    }
    const camDir = this.player.camera.getWorldDirection(this.vCamDir);
    const hit = this.items.findInteractable(this.player.camera.position, camDir);
    if (!hit) return;

    if (hit.type === "hiding") {
      this.enterHiding(hit.index);
    } else if (hit.type === "pickup") {
      const p = this.items.takePickup(hit.index);
      this.audio.pickup();
      if (p.kind === "weapon") {
        const id = p.item as WeaponId;
        this.weapons.give(id);
        const slot = WEAPON_SLOTS.indexOf(id) + 1;
        this.toast(`${WEAPONS[id].name} — [${slot}] TO EQUIP, CLICK TO USE`);
      } else {
        this.weapons.addAmmo(AMMO_PER_BOX);
        this.toast(`+${AMMO_PER_BOX} 9MM ROUNDS`);
      }
      this.pushHud(true);
    } else if (hit.type === "door" && this.exitUnlocked && !this.items.exitOpen) {
      this.items.openExit();
      this.audio.doorOpen();
      this.fearSpike = Math.min(1, this.fearSpike + 0.15);
      this.pushHud(true);
    }
  }

  /* ------------------------------ hiding (P5) ------------------------------ */

  private enterHiding(index: number) {
    const spot = this.hiding.spots[index];
    if (!spot || spot.occupied || this.hiding.active) return;

    // Caught entering: anything with fresh eyes on the player KNOWS where
    // they went — it walks over, looks inside, and drags them out.
    for (const e of this.enemies) {
      if (e.dying || e.dead || e.state === "dormant") continue;
      if (e.seenAgo < CAUGHT_WINDOW) e.inspectHidingSpot(spot);
    }

    spot.occupied = true;
    this.hiding.active = spot;
    this.hiding.torchWasOn = this.player.flashlightOn;
    this.player.flashlightOn = false; // hiding in the dark is the point
    this.player.pos.set(spot.def.pos.x, 0, spot.def.pos.z);
    this.player.vel.set(0, 0, 0);
    this.player.sneaking = false;
    this.player.hidden = true;
    this.player.eyeOverride = spot.eyeY;
    this.weapons.setVisible(false);
    this.audio.creak(spot.def.kind);
    this.pushHud(true);
  }

  private beginExitHiding() {
    if (!this.hiding.active || this.hiding.exiting) return;
    this.hiding.beginExit(this.player.pos);
    if (this.hiding.exiting) this.audio.creak(this.hiding.active.def.kind);
  }

  /** drive the climb-out lerp; called every frame while playing */
  private updateHidingExit(dt: number) {
    const spot = this.hiding.active;
    if (!spot || !this.hiding.exiting) return;
    this.hiding.exitT -= dt;
    const k = 1 - Math.max(0, this.hiding.exitT) / HIDE_EXIT_TIME;
    const e = k * k * (3 - 2 * k);
    this.player.pos.lerpVectors(this.hiding.exitFrom, this.hiding.exitTo, e);
    this.player.eyeOverride = spot.eyeY + (EYE_HEIGHT - spot.eyeY) * e;
    if (this.hiding.exitT > 0) return;

    // Out: release the spot, pop clear of its collider, face the room.
    spot.occupied = false;
    this.hiding.active = null;
    const f = spot.facing(this.vA);
    this.level.collide(this.player.pos, 0.32);
    this.player.yaw = Math.atan2(-f.x, -f.z);
    this.player.hidden = false;
    this.player.eyeOverride = null;
    if (this.hiding.torchWasOn) this.player.flashlightOn = true;
    this.weapons.setVisible(true);
    this.pushHud(true);
  }

  /** hidden state teardown without moving the player (death) */
  private clearHiding() {
    this.hiding.clear();
    this.player.hidden = false;
    this.player.eyeOverride = null;
  }

  private onEnemyCheckSpot(e: Enemy) {
    const toEntity = this.vA.subVectors(e.pos, this.player.pos);
    const dist = toEntity.length();
    toEntity.normalize();
    const camDir = this.player.camera.getWorldDirection(this.vCamDir);
    const right = this.vB.crossVectors(camDir, UP).normalize();
    this.audio.spotCheck(dist, toEntity.dot(right), this.hiding.active?.def.kind);
    this.fearSpike = Math.min(1, this.fearSpike + 0.35);
    if (this.hiding.active) this.toast("IT'S LOOKING — DON'T BREATHE");
  }

  private onScreech() {
    this.audio.screech(this.activeEnemy?.cfg.slug ?? "devil");
    this.fearSpike = 1;
    this.glitch = Math.min(1, this.glitch + 0.8);
    this.player.shake = 1;
  }

  private onEnemyStep(e: Enemy) {
    const toEntity = this.vA.subVectors(e.pos, this.player.pos);
    const dist = toEntity.length();
    toEntity.normalize();
    const camDir = this.player.camera.getWorldDirection(this.vCamDir);
    const right = this.vB.crossVectors(camDir, UP).normalize();
    this.audio.entityStep(dist, toEntity.dot(right), e.cfg.slug);
  }

  private beginDeath(killer: Enemy) {
    if (this.state !== "playing") return;
    if (this.cheats.god) return; // it reaches for you and passes through
    this.killer = killer;
    this.setState("dying");
    this.deathT = 0;
    this.audio.death(killer.cfg.slug);
    this.glitch = 1;
    this.clearHiding(); // dragged out of wherever you were stuffed
    this.player.clearKeys();
    this.weapons.setVisible(false); // death cam shouldn't wear the viewmodel
  }

  /* ------------------------------- loop ------------------------------- */

  private loop = () => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);

    const dt = Math.min(0.05, this.clock.getDelta());
    this.elapsed += dt;
    const t = this.elapsed;

    if (this.state === "playing") {
      // Watchdog: the pointer lock died without an event (browser quirk) —
      // the cursor would drift free over the close button while the game
      // runs. Pause within half a second so it's obvious and recoverable.
      if (!this.touchPrimary && this.hasLockedOnce &&
          document.pointerLockElement !== this.canvas) {
        this.lockLossT += dt;
        if (this.lockLossT > 0.5) {
          this.lockLossT = 0;
          this.pause();
        }
      } else {
        this.lockLossT = 0;
      }

      this.player.update(dt, t);
      this.updateHidingExit(dt);

      // The kill chain: grandma wakes ~20s in; each death buys a short calm,
      // then the next tier walks in. The devil's death opens the door.
      if (!this.activeEnemy && !this.exitUnlocked && !this.spawning) {
        if (this.tier < 0) {
          if (t - this.startedAt > Engine.FIRST_SPAWN_DELAY) {
            this.tier = 0;
            this.spawnTier(0);
          }
        } else {
          this.calmT -= dt;
          if (this.calmT <= 0) this.spawnTier(this.tier);
        }
      }

      const camDir = this.player.camera.getWorldDirection(this.vCamDir);
      for (const e of this.enemies) {
        if (this.cheats.freeze && !e.dying) continue;
        e.update(dt, {
          playerPos: this.player.pos,
          playerHead: this.player.camera.position,
          camDir,
          playerSpeed: this.player.speed,
          playerSprinting: this.player.sprinting,
          playerSneaking: this.player.sneaking,
          playerHidden: this.hiding.active !== null,
          flashlightOn: this.player.flashlightOn,
          time: t,
        });
      }

      this.items.update(dt, t);
      this.weapons.update(dt, t, this.enemies);
      this.updateInteractionPrompt(camDir);

      // Walking into the light beyond the open door = escape.
      const doorDx = this.player.pos.x - this.level.exit.doorPos.x;
      const doorDz = this.player.pos.z - this.level.exit.doorPos.z;
      if (this.items.exitOpen && Math.hypot(doorDx, doorDz) < 1.05) {
        this.setState("won");
        this.audio.win();
        this.callbacks.onStats({
          seconds: Math.floor(t - this.startedAt),
          kills: this.kills,
          enemy: null, // escaped — nothing took you
        });
        document.exitPointerLock();
      }
    } else if (this.state === "dying") {
      this.updateDeath(dt);
    }

    this.updateFixtures(t, dt);
    this.updateFearAndAudio(dt);
    this.hitFlashT = Math.max(0, this.hitFlashT - dt);
    this.vfx.update(dt); // ticks in every state — effects finish during death cam

    this.fx.update(t, this.fear, this.glitch, this.beat, this.deathT);
    this.fx.render();

    this.hudTimer -= dt;
    if (this.hudTimer <= 0 && (this.state === "playing" || this.state === "dying")) {
      this.hudTimer = 0.12;
      this.pushHud();
    }
  };

  private updateDeath(dt: number) {
    this.deathT = Math.min(1, this.deathT + dt * 0.55);
    // Camera wrenched around to face it.
    const head = this.killer ? this.killer.headWorldPos : this.vB.set(0, 1.5, 0);
    const cam = this.player.camera;
    const target = this.vA.subVectors(head, cam.position);
    const yaw = Math.atan2(-target.x, -target.z);
    const pitch = Math.atan2(target.y, Math.hypot(target.x, target.z));
    const k = Math.min(1, dt * 7);
    cam.rotation.y += (yaw - cam.rotation.y) * k;
    cam.rotation.x += (pitch - cam.rotation.x) * k;
    cam.position.y += (1.1 - cam.position.y) * dt * 0.7; // dragged down
    this.player.shake = 0.7;

    if (this.deathT >= 1) {
      this.setState("dead");
      this.callbacks.onStats({
        seconds: Math.floor(this.elapsed - this.startedAt),
        kills: this.kills,
        enemy: this.killer?.cfg.slug ?? "grandma",
      });
      document.exitPointerLock();
    }
  }

  private updateInteractionPrompt(camDir: THREE.Vector3) {
    let prompt: string | null;
    if (this.hiding.active) {
      prompt = this.hiding.exiting ? null : "[E] GET OUT";
    } else {
      const hit = this.items.findInteractable(this.player.camera.position, camDir);
      prompt = hit
        ? hit.type !== "door" || this.exitUnlocked
          ? `[E] ${hit.label}`
          : hit.label
        : null;
    }
    if (prompt !== this.lastPrompt) {
      this.lastPrompt = prompt;
      this.pushHud(true);
    }
  }

  /* --------------------------- light orchestra --------------------------- */

  private updateFixtures(t: number, dt: number) {
    const fixtures = this.level.fixtures;
    const playerPos = this.player.pos;
    const hunter = this.activeEnemy && !this.activeEnemy.dying ? this.activeEnemy : null;

    // Random ambient events. Two flavors:
    //  - choke: a nearby light strangles for a few seconds (scare)
    //  - flare: a DEAD light down some corridor sputters alive, then dies
    //    again (lure — something to walk toward)
    this.nextAmbientEvent -= dt;
    if (this.nextAmbientEvent <= 0 && this.state === "playing") {
      this.nextAmbientEvent = randRange(Math.random, 16, 38);
      if (this.activeEnemy?.state !== "chase") {
        const wantFlare = Math.random() < 0.45;
        const dead = wantFlare
          ? fixtures.filter((f) => {
              if (f.state !== "off") return false;
              const d = f.pos.distanceToSquared(playerPos);
              return d > 100 && d < 484; // 10-22m: visible, not adjacent
            })
          : [];
        if (dead.length > 0) {
          const f = dead[Math.floor(Math.random() * dead.length)];
          this.fixtureFlare.set(f.index, 4.5 + Math.random() * 3);
          this.audio.buzz();
        } else {
          const near = fixtures.filter(
            (f) => f.state === "on" && f.pos.distanceToSquared(playerPos) < 169,
          );
          if (near.length > 0) {
            const f = near[Math.floor(Math.random() * near.length)];
            this.fixtureBurst.set(f.index, 2.5 + Math.random() * 2);
            this.audio.zap();
            this.fearSpike = Math.min(1, this.fearSpike + 0.12);
          }
        }
      }
    }

    const candidates: { f: (typeof fixtures)[number]; d: number; mult: number }[] = [];
    this.nearestLitSq = Infinity;

    for (const f of fixtures) {
      const dSq = f.pos.distanceToSquared(playerPos);
      if (f.state !== "off" && dSq < this.nearestLitSq) this.nearestLitSq = dSq;
      if (dSq > 676) continue; // beyond fog (26m) — irrelevant this frame

      let mult: number;
      switch (f.state) {
        case "off":
          mult = 0.006;
          break;
        case "flicker": {
          const n = Math.sin(t * 13 + f.phase * 7) + Math.sin(t * 31 + f.phase);
          mult = n > 0.4 ? 1 : n > -0.6 ? 0.45 : 0.05;
          break;
        }
        default:
          mult = 0.97 + Math.sin(t * 40 + f.phase) * 0.03;
      }

      // Flare events: a dead panel arcs back to life, stuttering.
      const flare = this.fixtureFlare.get(f.index);
      if (flare !== undefined) {
        if (flare <= 0) this.fixtureFlare.delete(f.index);
        else {
          this.fixtureFlare.set(f.index, flare - dt);
          // bangs on like a real tube, stutters, then sputters out
          const n = Math.sin(t * 19 + f.phase) + Math.sin(t * 47 + f.phase * 3);
          const dieOff = Math.min(1, flare * 1.2);
          mult = Math.max(mult, (n > -0.3 ? 0.9 : 0.12) * dieOff);
        }
      }

      // Burst events override.
      const burst = this.fixtureBurst.get(f.index);
      if (burst !== undefined) {
        if (burst <= 0) this.fixtureBurst.delete(f.index);
        else {
          this.fixtureBurst.set(f.index, burst - dt);
          mult *= Math.random() < 0.45 ? 0.08 : 0.7;
        }
      }

      // The hunter smothers light around it.
      if (hunter) {
        const dEntSq = f.pos.distanceToSquared(hunter.pos);
        if (dEntSq < 64) {
          const aura = 1 - Math.sqrt(dEntSq) / 8;
          f.aura += (aura - f.aura) * Math.min(1, dt * 6);
        } else {
          f.aura += (0 - f.aura) * Math.min(1, dt * 3);
        }
        if (f.aura > 0.01) {
          const strangle = Math.random() < f.aura * 0.7 ? 0.06 : 1 - f.aura * 0.75;
          mult *= strangle;
        }
      }

      // Update instanced panel color only when it changed noticeably.
      if (Math.abs(mult - this.fixtureMult[f.index]) > 0.025) {
        this.fixtureMult[f.index] = mult;
        this.level.setFixtureColor(
          f.index,
          f.base[0] * mult,
          f.base[1] * mult,
          f.base[2] * mult,
        );
      }

      if (mult > 0.04 && (f.state !== "off" || this.fixtureFlare.has(f.index)))
        candidates.push({ f, d: dSq, mult });
    }

    // Assign the real point lights to the nearest glowing fixtures.
    candidates.sort((a, b) => a.d - b.d);
    for (let i = 0; i < POOL_SIZE; i++) {
      const light = this.lightPool[i];
      const c = candidates[i];
      if (c) {
        light.position.set(c.f.pos.x, c.f.pos.y - 0.18, c.f.pos.z);
        light.intensity = 7 * c.mult; // tungsten lamps — dimmer than fluorescents
        // light color tracks the panel so anomaly zones wash the room
        light.color.setRGB(c.f.base[0] * 0.53, c.f.base[1] * 0.53, c.f.base[2] * 0.54);
      } else {
        light.intensity = 0;
      }
    }

    // Enemy interference with the flashlight.
    if (hunter) {
      const d = hunter.pos.distanceTo(playerPos);
      this.player.flashlightInterference = d < 9 ? (1 - d / 9) * 0.85 : 0;
    } else {
      this.player.flashlightInterference = 0;
    }
  }

  /* ----------------------------- fear/audio ----------------------------- */

  private get beat(): number {
    return Math.pow(Math.max(0, Math.sin(this.beatPhase)), 6);
  }

  private updateFearAndAudio(dt: number) {
    const playerPos = this.player.pos;

    // Darkness factor — nearest live light, computed in the fixture pass.
    const nearestLit = Math.sqrt(this.nearestLitSq);
    let dark = Math.min(1, Math.max(0, (nearestLit - 5) / 13));
    if (this.player.flashlightOn) dark = Math.min(dark, 0.55);

    // Enemy factor.
    const hunter = this.activeEnemy && !this.activeEnemy.dying ? this.activeEnemy : null;
    const eDist = hunter ? hunter.pos.distanceTo(playerPos) : Infinity;
    let entityFear = 0;
    if (hunter) {
      switch (hunter.state) {
        case "roam": entityFear = Math.max(0, 1 - eDist / 40) * 0.3; break;
        case "stalk": entityFear = 0.4 + Math.max(0, 1 - eDist / 30) * 0.3; break;
        case "search": entityFear = 0.45; break;
        case "chase": entityFear = 0.95; break;
      }
    }
    if (eDist < 8) entityFear = Math.max(entityFear, 0.8);

    this.fearSpike = Math.max(0, this.fearSpike - dt * 0.25);
    // Hidden: the heart never quite settles while you're stuffed in a box.
    const target = Math.min(1, dark * 0.35 + entityFear + this.fearSpike * 0.5 +
      (this.hiding.active ? 0.25 : 0));
    const rate = target > this.fear ? 1.6 : 0.13;
    this.fear += (target - this.fear) * Math.min(1, dt * rate);

    this.glitch = Math.max(0, this.glitch - dt * 2.2);
    if (eDist < 10) this.glitch = Math.max(this.glitch, (1 - eDist / 10) * 0.25);

    this.beatPhase += dt * Math.PI * 2 * (0.95 + this.fear * 1.25);

    if (this.audio.ready) {
      const camDir = this.player.camera.getWorldDirection(this.vCamDir);
      const toEntity = hunter
        ? this.vA.subVectors(hunter.pos, playerPos).normalize()
        : this.vA.set(0, 0, 0);
      const right = this.vB.crossVectors(camDir, UP).normalize();
      this.audio.setParams({
        fear: this.fear,
        entityDist: eDist,
        entityPan: isFinite(eDist) ? toEntity.dot(right) : 0,
        chasing: hunter?.state === "chase",
      });
      this.audio.update(dt);
    }
  }

  /* ------------------------------- HUD ------------------------------- */

  private pushHud(force = false) {
    void force;
    const active: string[] = [];
    if (this.cheats.god) active.push("GOD");
    if (this.cheats.noclip) active.push("NOCLIP");
    if (this.cheats.fullbright) active.push("BRIGHT");
    if (this.cheats.freeze) active.push("FROZEN");
    const hunter = this.activeEnemy;
    const w = this.weapons.current ? WEAPONS[this.weapons.current] : null;
    // The objective line walks the player through the run: arm yourself,
    // survive the chain, then run for the door. GameShell re-banners it
    // whenever the phase (text before the dash) changes.
    const objective = this.exitUnlocked
      ? "THE DOOR IS OPEN. RUN."
      : this.tier >= 2
        ? "IT KNOWS YOUR NAME."
        : this.tier >= 1
          ? "SOMETHING ELSE IS IN THE HOUSE…"
          : this.weapons.owned.size > 0
            ? "SURVIVE"
            : "FIND A WEAPON — GRANDMA IS HOME";
    this.callbacks.onHud({
      kills: this.kills,
      stamina: this.player.stamina,
      prompt: this.lastPrompt,
      objective,
      enemy: hunter ? hunter.cfg.displayName : null,
      flashlight: this.player.flashlightOn,
      sneaking: this.player.sneaking,
      cheats: active.length > 0 ? active.join(" · ") : null,
      weapon: w ? { name: w.name, ammo: w.kind === "gun" ? this.weapons.ammo : null } : null,
      slots: this.weapons.owned.size > 0
        ? WEAPON_SLOTS.filter((id) => this.weapons.owned.has(id))
            .map((id) => `[${WEAPON_SLOTS.indexOf(id) + 1}] ${WEAPONS[id].name}`)
            .join("  ")
        : null,
      hitFlash: this.hitFlashT > 0,
      hidden: this.hiding.active ? this.hiding.active.def.kind : null,
    });
  }

  /* ----------------------------- teardown ----------------------------- */

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    if (this.pendingLock !== null) clearTimeout(this.pendingLock);
    this.detachInput?.();
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
    this.audio.dispose();
    this.fx.dispose();
    this.vfx.dispose(this.scene);
    this.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.geometry?.dispose();
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const m of mats) {
          for (const key of Object.keys(m)) {
            const v = (m as unknown as Record<string, unknown>)[key];
            if (v instanceof THREE.Texture) v.dispose();
          }
          m.dispose();
        }
      }
    });
    this.renderer.dispose();
  }
}
