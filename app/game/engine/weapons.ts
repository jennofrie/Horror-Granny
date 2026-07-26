import * as THREE from "three";
import { Level, WALL_H } from "./level";
import { Enemy } from "./enemy";
import { Player } from "./player";
import { loadGLTF } from "./gltf";

/* -------------------------------------------------------------------------
 * Weapons + inventory (P4).
 *
 * Balance (enemy hp: grandma 100 / grandpa 150 / devil 250):
 *   handgun 40 dmg, 0.5s between shots, hitscan
 *     grandma 3 shots · grandpa 4 · devil 7 — a full chain needs 14 hits,
 *     and the house holds 12-18 rounds, so the devil is meant to feel
 *     ammo-hungry: misses hurt, melee finishers matter.
 *   axe    55 dmg, 1.0s swing, 2.2m reach — grandma 2 · grandpa 3 · devil 5
 *   shovel 30 dmg, 0.6s swing, 2.0m reach — grandma 4 · grandpa 5 · devil 9
 *
 * Ammo is one simple pool (handgun only) fed by ammo crates (+6 each) —
 * no magazine/reload mechanic: Granny-style scarcity over gunplay depth.
 * ------------------------------------------------------------------------- */

export type WeaponId = "handgun" | "axe" | "shovel";

export interface WeaponConfig {
  id: WeaponId;
  /** HUD display name */
  name: string;
  /** interaction prompt label */
  pickupName: string;
  /** GLTF asset slug (public/assets/models/<slug>/scene.glb) */
  slug: string;
  kind: "gun" | "melee";
  damage: number;
  /** seconds between attacks */
  cooldown: number;
  /** gun: hitscan max range · melee: reach */
  range: number;
  /** viewmodel animation duration (recoil / full swing arc) */
  animTime: number;
  /** viewmodel size: longest model axis in meters */
  viewSize: number;
  viewPos: [number, number, number];
  viewRot: [number, number, number];
  /** floor-pickup size (longest axis, meters) */
  pickupSize: number;
}

export const WEAPONS: Record<WeaponId, WeaponConfig> = {
  handgun: {
    id: "handgun",
    name: "HANDGUN",
    pickupName: "TAKE HANDGUN",
    slug: "handgun",
    kind: "gun",
    damage: 40,
    cooldown: 0.5,
    range: 40,
    animTime: 0.28,
    viewSize: 0.3,
    viewPos: [0.21, -0.2, -0.42],
    viewRot: [0, Math.PI, 0],
    pickupSize: 0.32,
  },
  axe: {
    id: "axe",
    name: "FIRE AXE",
    pickupName: "TAKE FIRE AXE",
    slug: "axe",
    kind: "melee",
    damage: 55,
    cooldown: 1.0,
    range: 2.2,
    animTime: 0.85,
    viewSize: 0.85,
    viewPos: [0.3, -0.34, -0.55],
    viewRot: [0.3, 0, 1.05],
    pickupSize: 0.9,
  },
  shovel: {
    id: "shovel",
    name: "SHOVEL",
    pickupName: "TAKE SHOVEL",
    slug: "shovel",
    kind: "melee",
    damage: 30,
    cooldown: 0.6,
    range: 2.0,
    animTime: 0.55,
    viewSize: 1.1,
    viewPos: [0.4, -0.38, -0.55],
    viewRot: [0.3, 0, -2.2],
    pickupSize: 1.15,
  },
};

/** keyboard slots: 1 / 2 / 3 (only owned weapons are selectable) */
export const WEAPON_SLOTS: WeaponId[] = ["handgun", "axe", "shovel"];
export const AMMO_PER_BOX = 6;

/** how far a gunshot / melee swing is heard (meters) */
const GUNSHOT_NOISE_RADIUS = 45;
const SWING_NOISE_RADIUS = 12;
/** enemy capsule approximation for hitscan */
const ENEMY_HIT_RADIUS = 0.45;

// Melee swing keyframes (raise → sweep across → recover), eased per segment.
const SWING_T = [0, 0.3, 0.6, 1];
const SWING_ROTX = [0, -0.6, -0.05, 0];
const SWING_ROTY = [0, 0.55, -0.85, 0];
const SWING_POSZ = [0, 0.05, -0.14, 0];
// Handgun recoil: quick kick back+up, then recover.
const RECOIL_T = [0, 0.2, 1];
const RECOIL_ROTX = [0, -0.14, 0];
const RECOIL_POSZ = [0, 0.07, 0];

/** Piecewise-smoothstep track sampled at `p` (0..1). Allocation-free. */
function track(p: number, times: number[], values: number[]): number {
  if (p <= times[0]) return values[0];
  for (let i = 1; i < times.length; i++) {
    if (p <= times[i]) {
      const k = (p - times[i - 1]) / (times[i] - times[i - 1]);
      const e = k * k * (3 - 2 * k);
      return values[i - 1] + (values[i] - values[i - 1]) * e;
    }
  }
  return values[values.length - 1];
}

export class Weapons {
  /** owned weapon set — start with nothing */
  readonly owned = new Set<WeaponId>();
  /** handgun rounds (single pool, no magazines) */
  ammo = 0;
  current: WeaponId | null = null;

  /** world group — lags the camera like the flashlight rig */
  readonly rig = new THREE.Group();

  /* Event hooks. P6 hangs VFX off onFire/onImpact; P7 hangs audio off
   * onFire (gunshot), onSwing (whoosh), onDryFire (empty click),
   * onHitEnemy (flesh thud). Pickup sounds route through Engine.tryInteract. */
  onFire: ((muzzleWorldPos: THREE.Vector3) => void) | null = null;
  onImpact: ((point: THREE.Vector3, hitEnemy: boolean) => void) | null = null;
  onSwing: ((id: WeaponId) => void) | null = null;
  onDryFire: (() => void) | null = null;
  onHitEnemy: (() => void) | null = null;
  /** loud actions alert the hunter — engine wires this to Enemy.hearNoise */
  onNoise: ((radius: number) => void) | null = null;

  private mount = new THREE.Group(); // idle sway / walk bob
  private anim = new THREE.Group(); // attack animation offsets
  private models = new Map<WeaponId, THREE.Group>();
  private loading = new Set<WeaponId>();

  private cooldownT = 0;
  private animT = 0;
  private meleeLatched = false;

  // scratch — no per-frame allocation
  private vDir = new THREE.Vector3();
  private vPoint = new THREE.Vector3();
  private vMuzzle = new THREE.Vector3();

  constructor(
    private level: Level,
    private player: Player,
  ) {
    this.rig.add(this.mount);
    this.mount.add(this.anim);
    this.rig.visible = false;
  }

  addTo(scene: THREE.Scene) {
    scene.add(this.rig);
  }

  setVisible(v: boolean) {
    this.rig.visible = v && this.current !== null;
  }

  /* ----------------------------- inventory ----------------------------- */

  give(id: WeaponId) {
    this.owned.add(id);
    this.loadModel(id);
    // A fresh find goes straight into the hands.
    this.current = id;
    this.cooldownT = 0;
    this.animT = 0;
    this.syncView();
  }

  addAmmo(n: number) {
    this.ammo += n;
  }

  /** keyboard slot select — returns true when the weapon changed hands */
  selectSlot(index: number): boolean {
    const id = WEAPON_SLOTS[index];
    if (!id || !this.owned.has(id) || id === this.current) return false;
    this.current = id;
    this.animT = 0;
    this.cooldownT = Math.min(this.cooldownT, 0.25); // quick draw, not instant
    this.syncView();
    return true;
  }

  /** touch control: rotate through owned weapons */
  cycle(): boolean {
    if (this.owned.size === 0) return false;
    const list = WEAPON_SLOTS.filter((id) => this.owned.has(id));
    const i = this.current ? list.indexOf(this.current) : -1;
    this.current = list[(i + 1) % list.length];
    this.animT = 0;
    this.cooldownT = Math.min(this.cooldownT, 0.25);
    this.syncView();
    return true;
  }

  private syncView() {
    for (const [id, g] of this.models) g.visible = id === this.current;
    this.rig.visible = this.current !== null;
    this.player.setHandTorchVisible(this.current === null);
  }

  /* ------------------------------ attack ------------------------------ */

  /**
   * One attack attempt (mouse click / touch FIRE). Hit resolution is
   * immediate for the gun; melee lands during the swing's active window
   * (see update) so the arc and the hit line up.
   */
  tryAttack(enemies: Enemy[]) {
    const id = this.current;
    if (!id || this.cooldownT > 0) return;
    const cfg = WEAPONS[id];

    if (cfg.kind === "gun") {
      if (this.ammo <= 0) {
        // Dry click — no cooldown-free spam, no shot.
        this.cooldownT = 0.3;
        this.onDryFire?.();
        return;
      }
      this.ammo--;
      this.cooldownT = cfg.cooldown;
      this.animT = cfg.animTime;

      const cam = this.player.camera;
      const origin = cam.position;
      const dir = cam.getWorldDirection(this.vDir);

      // Muzzle event for P6 (flash/smoke anchor).
      this.vMuzzle.copy(origin).addScaledVector(dir, 0.55);
      this.vMuzzle.y -= 0.12;
      this.onFire?.(this.vMuzzle);

      const wallT = this.rayWallT(origin, dir, cfg.range);
      const hit = this.rayEnemies(origin, dir, wallT, enemies);
      if (hit) {
        this.vPoint.copy(origin).addScaledVector(dir, hit.t);
        hit.enemy.takeDamage(cfg.damage, this.vPoint);
        this.onImpact?.(this.vPoint, true);
        this.onHitEnemy?.();
      } else {
        this.vPoint.copy(origin).addScaledVector(dir, wallT);
        this.onImpact?.(this.vPoint, false);
      }
      this.onNoise?.(GUNSHOT_NOISE_RADIUS);
    } else {
      this.cooldownT = cfg.cooldown;
      this.animT = cfg.animTime;
      this.meleeLatched = false;
      this.onSwing?.(id);
      this.onNoise?.(SWING_NOISE_RADIUS);
    }
  }

  /** Nearest wall/floor/ceiling distance along the ray (grid march, cheap). */
  private rayWallT(origin: THREE.Vector3, dir: THREE.Vector3, maxT: number): number {
    let t = maxT;
    for (let d = 0.3; d < t; d += 0.12) {
      if (this.level.solidAtWorld(origin.x + dir.x * d, origin.z + dir.z * d)) {
        t = d;
        break;
      }
    }
    if (dir.y < -1e-6) t = Math.min(t, -origin.y / dir.y); // floor
    else if (dir.y > 1e-6) t = Math.min(t, (WALL_H - origin.y) / dir.y); // ceiling
    return t;
  }

  /** First living enemy whose vertical capsule the ray crosses before tMax. */
  private rayEnemies(
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    tMax: number,
    enemies: Enemy[],
  ): { enemy: Enemy; t: number } | null {
    let best: { enemy: Enemy; t: number } | null = null;
    for (const e of enemies) {
      if (e.dying || e.dead || e.state === "dormant") continue;
      // 2D ray-circle in XZ, then height check at the hit distance.
      const ox = origin.x - e.pos.x;
      const oz = origin.z - e.pos.z;
      const a = dir.x * dir.x + dir.z * dir.z;
      let t = -1;
      if (a > 1e-8) {
        const b = 2 * (ox * dir.x + oz * dir.z);
        const c = ox * ox + oz * oz - ENEMY_HIT_RADIUS * ENEMY_HIT_RADIUS;
        const disc = b * b - 4 * a * c;
        if (disc < 0) continue;
        const sq = Math.sqrt(disc);
        t = (-b - sq) / (2 * a);
        if (t < 0) t = (-b + sq) / (2 * a); // origin inside the circle
      } else if (ox * ox + oz * oz < ENEMY_HIT_RADIUS * ENEMY_HIT_RADIUS) {
        t = 0; // shooting straight up/down while inside the column
      }
      if (t < 0 || t >= tMax || (best && t >= best.t)) continue;
      const y = origin.y + dir.y * t;
      if (y < 0 || y > e.cfg.height) continue;
      best = { enemy: e, t };
    }
    return best;
  }

  /* ------------------------------ update ------------------------------ */

  update(dt: number, time: number, enemies: Enemy[]) {
    if (this.cooldownT > 0) this.cooldownT -= dt;
    if (this.current === null) return;

    // Ride the camera with the flashlight's lagged hand feel.
    const cam = this.player.camera;
    this.rig.position.copy(cam.position);
    this.rig.quaternion.slerp(cam.quaternion, Math.min(1, dt * 11));

    // Idle sway + walk bob, driven by the player's own bob cycle.
    const bobPhase = this.player.bobPhase;
    const bobAmp = this.player.bobAmp;
    this.mount.position.set(
      Math.cos(bobPhase) * 0.014 * bobAmp,
      Math.sin(bobPhase * 2) * 0.018 * bobAmp + Math.sin(time * 1.4) * 0.004,
      0,
    );
    this.mount.rotation.z = Math.cos(bobPhase) * 0.012 * bobAmp;

    // Attack animation.
    const cfg = WEAPONS[this.current];
    if (this.animT > 0) {
      this.animT -= dt;
      const p = Math.min(1, 1 - Math.max(0, this.animT) / cfg.animTime);
      if (cfg.kind === "gun") {
        this.anim.rotation.x = track(p, RECOIL_T, RECOIL_ROTX);
        this.anim.rotation.y = 0;
        this.anim.position.z = track(p, RECOIL_T, RECOIL_POSZ);
      } else {
        this.anim.rotation.x = track(p, SWING_T, SWING_ROTX);
        this.anim.rotation.y = track(p, SWING_T, SWING_ROTY);
        this.anim.position.z = track(p, SWING_T, SWING_POSZ);

        // Active window: the middle third of the swing, one hit per swing.
        if (!this.meleeLatched && p > 1 / 3 && p < 2 / 3) {
          const camDir = cam.getWorldDirection(this.vDir);
          for (const e of enemies) {
            if (e.dying || e.dead || e.state === "dormant") continue;
            const dx = e.pos.x - this.player.pos.x;
            const dz = e.pos.z - this.player.pos.z;
            if (Math.hypot(dx, dz) > cfg.range + ENEMY_HIT_RADIUS) continue;
            this.vPoint.set(e.pos.x, e.cfg.height * 0.5, e.pos.z);
            const to = this.vMuzzle.subVectors(this.vPoint, cam.position);
            const d = to.length();
            if (d < 1e-6 || to.divideScalar(d).dot(camDir) < 0.5) continue; // ~60° cone
            const a = this.level.cellOf(this.player.pos.x, this.player.pos.z);
            const b = this.level.cellOf(e.pos.x, e.pos.z);
            if (!this.level.lineOfSight(a.x, a.z, b.x, b.z)) continue;
            this.meleeLatched = true;
            e.takeDamage(cfg.damage, this.vPoint);
            this.onImpact?.(this.vPoint, true);
            this.onHitEnemy?.();
            break;
          }
        }
      }
      if (this.animT <= 0) {
        this.anim.rotation.set(0, 0, 0);
        this.anim.position.set(0, 0, 0);
      }
    }
  }

  /* ------------------------------ models ------------------------------ */

  /** Lazily instantiate the viewmodel (cache is prewarmed by the engine). */
  private loadModel(id: WeaponId) {
    if (this.models.has(id) || this.loading.has(id)) return;
    this.loading.add(id);
    const cfg = WEAPONS[id];
    void loadGLTF(`./assets/models/${cfg.slug}/scene.glb`)
      .then((gltf) => {
        const root = gltf.scene.clone(true);
        // Normalize: longest axis = viewSize, bbox centered on the origin,
        // so `viewRot`/`viewPos` behave the same for any source model.
        const box = new THREE.Box3().setFromObject(root);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const s = cfg.viewSize / Math.max(size.x, size.y, size.z, 1e-6);
        root.scale.setScalar(s);
        root.position.set(-center.x * s, -center.y * s, -center.z * s);
        const g = new THREE.Group();
        g.add(root);
        g.rotation.set(...cfg.viewRot);
        g.position.set(...cfg.viewPos);
        g.visible = id === this.current;
        g.traverse((o) => {
          if ((o as THREE.Mesh).isMesh) {
            o.castShadow = false;
            o.receiveShadow = false;
          }
        });
        this.anim.add(g);
        this.models.set(id, g);
        this.loading.delete(id);
        this.syncView();
      })
      .catch((err) => {
        this.loading.delete(id);
        console.error(`failed to load weapon viewmodel ${cfg.slug}:`, err);
      });
  }
}
