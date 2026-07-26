import * as THREE from "three";
import { Level } from "./level";
import { GltfInstance } from "./gltf";
import { mulberry32, Rand, randRange } from "./rng";
import { ROOMS } from "./house";
import { CHECK_STANDOFF, HideSpotState } from "./hiding";

export type EnemyState = "dormant" | "roam" | "stalk" | "chase" | "search";

export interface EnemyContext {
  playerPos: THREE.Vector3;
  playerHead: THREE.Vector3;
  camDir: THREE.Vector3;
  playerSpeed: number;
  playerSprinting: boolean;
  playerSneaking: boolean;
  /** P5: player is inside a wardrobe / under a bed — invisible, silent */
  playerHidden: boolean;
  flashlightOn: boolean;
  time: number;
}

export interface EnemyConfig {
  slug: string;
  displayName: string;
  /** normalized world height in meters (bbox-scaled on load) */
  height: number;
  /** extra yaw (rad) so the model's face points along movement */
  yawOffset: number;
  speedMultipliers: { roam: number; stalk: number; chase: number; search: number };
  killRange: number;
  /** seconds from attack start to the killing blow */
  attackWindup: number;
  hp: number;
  clips: {
    idle: string;
    walk: string;
    run?: string; // falls back to time-scaled walk
    attack: string;
    hit?: string;
    death?: string; // no clip -> procedural collapse
    search?: string;
    /** P5: bending over a hiding spot to look inside (else attack clip) */
    check?: string;
    spawnIntro?: string;
  };
  /** timescale for the run clip (walk reused as run wants ~1.6) */
  runTimeScale: number;
  /** meters walked per footstep event */
  stepLength: number;
  /** seconds between screeches while chasing */
  screechInterval: number;
  /** scene-graph nodes to hide (variant props shipped inside the GLB) */
  hideNodes?: string[];
}

/** The kill chain: grandma -> grandpa -> devil. */
export const ENEMIES: EnemyConfig[] = [
  {
    slug: "grandma",
    displayName: "Grandma",
    height: 1.7,
    yawOffset: -Math.PI / 2, // model front is +X — turn it to +Z
    speedMultipliers: { roam: 0.85, stalk: 0.9, chase: 0.95, search: 0.85 },
    killRange: 1.3,
    attackWindup: 0.45,
    hp: 100,
    clips: {
      idle: "Armature|GrannyIdle",
      walk: "Armature|GrannyWalk",
      run: "Armature|GrannyWalk", // no run clip — time-scaled walk
      attack: "Armature|grannycloset", // lunge out of the closet = the grab
      search: "Armature|GrannySeeking",
      check: "Armature|grannybed", // bends down to peer under the bed
    },
    runTimeScale: 1.6,
    stepLength: 0.55,
    screechInterval: 7,
  },
  {
    slug: "grandpa",
    displayName: "Grandpa",
    height: 1.75,
    yawOffset: 0,
    speedMultipliers: { roam: 0.9, stalk: 0.95, chase: 0.98, search: 0.9 },
    killRange: 1.4,
    attackWindup: 0.5,
    hp: 150,
    clips: {
      idle: "idle",
      walk: "walk",
      run: "walk",
      attack: "attack",
      hit: "Stunned",
      search: "search",
      check: "underbed",
    },
    runTimeScale: 1.6,
    stepLength: 0.6,
    screechInterval: 9,
  },
  {
    slug: "devil",
    displayName: "The Devil",
    height: 2.2,
    yawOffset: 0,
    speedMultipliers: { roam: 0.95, stalk: 1, chase: 1.01, search: 1 },
    killRange: 1.7,
    attackWindup: 0.4,
    hp: 250,
    clips: {
      idle: "Idle1",
      walk: "Walk1",
      run: "Run1",
      attack: "Punch1",
      hit: "Get-damage",
      death: "Death",
      spawnIntro: "Come-out1",
    },
    runTimeScale: 1,
    stepLength: 0.85,
    screechInterval: 6,
  },
];

// Base speeds (m/s) — per-enemy multipliers applied on top. A chase you
// react to is survivable; every tier stays a hair under the player's 4.7
// sprint (grandma 4.32 · grandpa 4.46 · devil 4.60), close enough that
// stumbling or a closed door is what kills you.
const ROAM_SPEED = 1.3;
const STALK_SPEED = 2.15;
const CHASE_SPEED = 4.55;
const SEARCH_SPEED = 2.4;

const FADE = 0.25;

// --- P5 hiding: caught-entering + search paranoia ---
/** seen entering within this window = the enemy knows where you went */
export const CAUGHT_WINDOW = 1.5;
/** chance per search-waypoint pick to go look inside a nearby hiding spot */
const PARANOIA_CHANCE = 0.2;
/** min seconds between two paranoia checks */
const PARANOIA_COOLDOWN = 8;
/** only spots within this of the last-seen position are worth a look */
const PARANOIA_RADIUS = 14;

/**
 * A hunter: the Wanderer's proven grid AI (A*, state machine, perception,
 * observed-freeze, horror director) driving a real animated GLTF character
 * instead of the old procedural body.
 */
export class Enemy {
  state: EnemyState = "dormant";
  pos = new THREE.Vector3();
  root = new THREE.Group();
  frozen = false;
  hp: number;
  /** dying or dead — AI halted, corpse stays in the world */
  dying = false;
  dead = false;

  onScreech: (() => void) | null = null;
  onKill: (() => void) | null = null;
  onStep: (() => void) | null = null;
  onDeath: (() => void) | null = null;
  /** P5: starts walking over to look inside a hiding spot (audio hook) */
  onCheckSpot: (() => void) | null = null;
  /** P6: horror-director teleport — old spot vanishes, new spot appears (VFX) */
  onTeleport: ((from: THREE.Vector3, to: THREE.Vector3) => void) | null = null;
  /** P5: wired by the engine — live occupancy of every hiding spot */
  hidingSpots: HideSpotState[] = [];

  private rng: Rand;
  private heading = 0;
  private modelGroup = new THREE.Group();
  private mixer: THREE.AnimationMixer;
  private actions: Map<string, THREE.AnimationAction>;
  private durations: Map<string, number>;
  private current: THREE.AnimationAction | null = null;

  // scratch vectors — keep the per-frame path allocation-free
  private vToPlayer = new THREE.Vector3();
  private vHead = new THREE.Vector3();
  private path: { x: number; z: number }[] = [];
  private repathTimer = 0;
  private waypoint: { x: number; z: number } | null = null;
  private lastKnownPlayer = new THREE.Vector3();
  /** seconds since the player was last visible — starts "never" */
  private losLostTime = 999;
  private observedTime = 0;
  private searchTimer = 0;
  private farFromPlayerTime = 0;
  private screechTimer = 0;
  private stepAcc = 0;
  private vTeleportFrom = new THREE.Vector3(); // scratch for the P6 teleport event

  // P5: walking over to look inside a hiding spot
  private checkSpot: { spot: HideSpotState; stand: THREE.Vector3 } | null = null;
  private checkT = 0; // >0: look-in anim playing, resolves at 0
  private paranoiaCd = 0;

  // one-shot modes
  private spawnT = 0; // >0: playing the materialize intro
  private attackT = 0; // >0: attack anim running, blow lands at 0
  private hitT = 0; // >0: flinching from damage
  private deathT = 0;
  private deathDur = 1.4;
  private collapse = false; // no death clip -> procedural fall

  constructor(
    private level: Level,
    seed: number,
    readonly cfg: EnemyConfig,
    inst: GltfInstance,
  ) {
    this.rng = mulberry32(seed ^ 0xbeef);
    this.hp = cfg.hp;
    this.mixer = inst.mixer;
    this.actions = inst.actions;
    this.durations = inst.durations;

    // Hide variant props BEFORE measuring — they skew the bounds.
    for (const name of cfg.hideNodes ?? []) {
      const node = inst.root.getObjectByName(name);
      if (node) node.visible = false;
    }
    // Normalize: exact height, feet on the floor, face along +Z.
    // Bind-pose Box3.setFromObject lies for skinned meshes (raw geometry
    // bounds ignore the skeleton, and this rig's rest pose is collapsed),
    // so strike the idle pose first, then union pose-aware bounds per mesh.
    const idleAction = this.actions.get(cfg.clips.idle);
    if (idleAction) {
      idleAction.play();
      this.current = idleAction;
      this.mixer.update(0.05);
    }
    inst.root.updateMatrixWorld(true);
    const bbox = new THREE.Box3();
    const tmpBox = new THREE.Box3();
    inst.root.traverse((o) => {
      const sm = o as THREE.SkinnedMesh;
      if (sm.isSkinnedMesh) {
        sm.skeleton.update();
        sm.computeBoundingBox();
        if (sm.boundingBox) bbox.union(tmpBox.copy(sm.boundingBox).applyMatrix4(sm.matrixWorld));
      } else if ((o as THREE.Mesh).isMesh) {
        const mesh = o as THREE.Mesh;
        mesh.geometry.computeBoundingBox();
        if (mesh.geometry.boundingBox) {
          bbox.union(tmpBox.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld));
        }
      }
    });
    const h = Math.max(0.01, bbox.max.y - bbox.min.y);
    const s = cfg.height / h;
    this.modelGroup.scale.setScalar(s);
    // Feet on the floor AND centered — some rigs stand meters off-origin,
    // and the offset scales up with the model.
    this.modelGroup.position.set(
      -((bbox.min.x + bbox.max.x) / 2) * s,
      -bbox.min.y * s,
      -((bbox.min.z + bbox.max.z) / 2) * s,
    );
    this.modelGroup.rotation.y = cfg.yawOffset;
    this.modelGroup.add(inst.root);
    this.modelGroup.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = true;
        o.receiveShadow = false;
      }
    });
    this.root.add(this.modelGroup);
    this.root.visible = false;
  }

  addTo(scene: THREE.Scene) {
    scene.add(this.root);
  }

  /** Approximate head — the death cinematic wrenches the camera here. */
  get headWorldPos(): THREE.Vector3 {
    return this.vHead.set(this.pos.x, this.cfg.height * 0.88, this.pos.z);
  }

  /* ----------------------------- lifecycle ----------------------------- */

  activate(cell?: { x: number; z: number }) {
    if (this.state !== "dormant") return;
    const c = cell ?? this.level.entitySpawnCell;
    this.teleportToCell(c.x, c.z);
    const intro = this.cfg.clips.spawnIntro;
    if (intro && this.actions.has(intro)) {
      // Materializes in front of you: play the intro, AI suspended.
      this.spawnT = this.durations.get(intro) ?? 1.5;
      this.playClip(intro, { once: true });
      this.state = "roam"; // state is roam; spawnT gates the AI below
    } else {
      this.setState("roam");
      this.playLocomotion(0);
    }
  }

  takeDamage(amount: number, hitPoint?: THREE.Vector3) {
    void hitPoint; // a later phase will aim flinches at the hit location
    if (this.dying || this.state === "dormant") return;
    this.hp -= amount;
    if (this.hp <= 0) {
      this.die();
      return;
    }
    // Flinch: brief hit reaction, locomotion resumes right after.
    this.hitT = 0.55;
    this.attackT = 0;
    const hit = this.cfg.clips.hit;
    if (hit && this.actions.has(hit)) this.playClip(hit, { once: true });
  }

  /**
   * Loud noises (gunfire, melee swings) pull the hunt toward the sound.
   * A stalker/chaser already knows where you are — this wakes roamers and
   * re-aims a searcher at the shot.
   */
  hearNoise(pos: THREE.Vector3, radius: number) {
    if (this.dying || this.dead || this.state === "dormant") return;
    if (this.pos.distanceTo(pos) > radius) return;
    this.lastKnownPlayer.copy(pos);
    if (this.state === "roam" || this.state === "search") {
      this.waypoint = null; // repath straight at the noise
      this.setState("search");
    }
  }

  /** seconds since the player was last visible (999 = never seen) */
  get seenAgo(): number {
    return this.losLostTime;
  }

  /**
   * P5: walk to a hiding spot and look inside. If the player is still in
   * there when the look finishes, it's a drag-out kill; an empty spot just
   * sends the enemy back to searching. Fires when the player was SEEN
   * climbing in (caught-entering) and from search paranoia.
   */
  inspectHidingSpot(spot: HideSpotState) {
    if (this.dying || this.dead || this.state === "dormant") return;
    const standoff = CHECK_STANDOFF[spot.def.kind];
    const stand = new THREE.Vector3(
      spot.def.pos.x + Math.sin(spot.def.yaw) * standoff,
      0,
      spot.def.pos.z + Math.cos(spot.def.yaw) * standoff,
    );
    this.checkSpot = { spot, stand };
    this.checkT = 0;
    this.attackT = 0;
    this.path = [];
    this.repathTimer = 0;
    this.waypoint = null;
    this.setState("search"); // the hunt narrows to this one piece of furniture
    this.onCheckSpot?.();
  }

  private die() {
    this.dying = true;
    this.deathT = 0;
    this.attackT = 0;
    this.hitT = 0;
    this.spawnT = 0;
    this.checkSpot = null;
    this.checkT = 0;
    const death = this.cfg.clips.death;
    if (death && this.actions.has(death)) {
      this.deathDur = this.durations.get(death) ?? 1.4;
      this.playClip(death, { once: true });
    } else {
      // No death clip — keel over procedurally.
      this.collapse = true;
      this.deathDur = 1.4;
    }
    this.onDeath?.();
  }

  /* ----------------------------- AI ----------------------------- */

  private teleportToCell(cx: number, cz: number) {
    this.pos.set(this.level.worldX(cx), 0, this.level.worldZ(cz));
    this.path = [];
    this.waypoint = null;
    this.root.visible = true;
  }

  private setState(s: EnemyState) {
    if (s === this.state) return;
    const prev = this.state;
    this.state = s;
    this.path = [];
    this.repathTimer = 0;
    if (s === "chase" && prev !== "chase") {
      this.onScreech?.();
      this.screechTimer = this.cfg.screechInterval;
    }
    if (s === "search") this.searchTimer = 7;
  }

  /** Straight-line visibility between enemy and player (grid based). */
  private hasLOS(target: THREE.Vector3): boolean {
    const a = this.level.cellOf(this.pos.x, this.pos.z);
    const b = this.level.cellOf(target.x, target.z);
    return this.level.lineOfSight(a.x, a.z, b.x, b.z);
  }

  update(dt: number, ctx: EnemyContext): void {
    // Death plays out regardless of game state (mixer only).
    if (this.dying) {
      this.deathT += dt;
      if (this.collapse) {
        // Keel over backward and sink a touch — sells the fall without a rig.
        const k = Math.min(1, this.deathT / 1.2);
        const ease = 1 - Math.pow(1 - k, 3);
        // Pivot is at the feet — the body tips backward and lies flat.
        this.modelGroup.rotation.x = -ease * Math.PI / 2;
        if (this.deathT >= this.deathDur) this.dead = true;
      } else if (this.deathT >= this.deathDur + 0.1) {
        this.dead = true; // clip clamped on its last frame
      }
      this.root.position.copy(this.pos);
      this.root.rotation.y = this.heading;
      this.mixer.update(dt);
      return;
    }
    if (this.state === "dormant") return;
    if (this.dead) return;

    const toPlayer = this.vToPlayer.subVectors(ctx.playerPos, this.pos);
    const dist = toPlayer.length();
    // A hidden player is simply not there: no LOS, no noise, no tracking.
    const los = this.hasLOS(ctx.playerPos) && !ctx.playerHidden;
    this.paranoiaCd -= dt;

    // Spawn intro: visible, menacing, but not yet hunting.
    if (this.spawnT > 0) {
      this.spawnT -= dt;
      this.root.position.copy(this.pos);
      this.root.rotation.y = this.heading;
      this.mixer.update(dt);
      return;
    }

    // Is the player looking at me? (LOS + within view cone + lit)
    const facingDot = dist > 1e-6
      ? -(ctx.camDir.x * toPlayer.x + ctx.camDir.y * toPlayer.y + ctx.camDir.z * toPlayer.z) / dist
      : 1;
    const observed =
      los && dist < 24 && facingDot > 0.82 && (ctx.flashlightOn || dist < 7);

    if (los) {
      this.lastKnownPlayer.copy(ctx.playerPos);
      this.losLostTime = 0;
    } else {
      this.losLostTime += dt;
    }

    // ---------- hiding-spot check owns the AI while it runs ----------
    if (this.checkSpot) {
      this.updateSpotCheck(dt);
      return;
    }

    // ---------- state transitions ----------
    switch (this.state) {
      case "roam": {
        this.frozen = false;
        // Sneaking players are much harder to notice.
        const noticeRange = ctx.playerSneaking ? 11 : 22;
        if (dist < noticeRange && (los || ctx.playerSprinting)) this.setState("stalk");
        // Horror director: if the player has been "safe" too long, close in.
        this.farFromPlayerTime = dist > 38 ? this.farFromPlayerTime + dt : 0;
        if (this.farFromPlayerTime > 30 && !los) {
          this.farFromPlayerTime = 0;
          this.relocateNear(ctx.playerPos, 8, 14);
        }
        break;
      }
      case "stalk": {
        if (ctx.playerHidden) {
          // vanished into furniture — go poke around the last-seen spot
          this.setState("search");
          break;
        }
        this.frozen = observed && dist > 4.5;
        if (this.frozen) {
          this.observedTime += dt;
          if (this.observedTime > 3) {
            this.frozen = false;
            this.observedTime = 0;
            this.setState("chase"); // it knows that you know
          }
        } else {
          this.observedTime = Math.max(0, this.observedTime - dt * 0.5);
        }
        if (dist < (ctx.playerSneaking ? 5.5 : 8) && los && !this.frozen) this.setState("chase");
        if (dist > 36) this.setState("roam");
        break;
      }
      case "chase": {
        this.frozen = false;
        // Climbing into furniture mid-chase snaps the thread instantly —
        // unless it saw you climb in (the engine fires a spot check then).
        if (ctx.playerHidden) {
          this.setState("search");
          break;
        }
        // Breaking line of sight is rewarded sooner — duck around a corner
        // and hold your nerve and it loses the thread.
        if (this.losLostTime > 3.5 && dist > 11) this.setState("search");
        // An active chase keeps screaming — you should never feel safe.
        this.screechTimer -= dt;
        if (this.screechTimer <= 0) {
          this.screechTimer = this.cfg.screechInterval;
          this.onScreech?.();
        }
        break;
      }
      case "search": {
        this.frozen = false;
        this.searchTimer -= dt;
        if (los && dist < 20) this.setState("chase");
        else if (this.searchTimer <= 0) this.setState("roam");
        break;
      }
    }

    // ---------- attack ----------
    // In range: commit to a swing; the blow lands when the windup ends.
    if (this.hitT > 0) {
      this.hitT -= dt; // flinching — no attack, no movement
    } else if (this.attackT > 0) {
      // Face the player through the swing.
      this.heading = Math.atan2(toPlayer.x, toPlayer.z);
      this.attackT -= dt;
      if (this.attackT <= 0 && dist < this.cfg.killRange + 0.8) {
        this.onKill?.();
      }
    } else if (dist < this.cfg.killRange && los) {
      this.attackT = this.cfg.attackWindup;
      this.playClip(this.cfg.clips.attack, { once: true });
    }

    // ---------- pathing ----------
    const m = this.cfg.speedMultipliers;
    const speed = this.frozen || this.attackT > 0 || this.hitT > 0
      ? 0
      : this.state === "chase"
        ? CHASE_SPEED * m.chase
        : this.state === "stalk"
          ? STALK_SPEED * m.stalk
          : this.state === "search"
            ? SEARCH_SPEED * m.search
            : ROAM_SPEED * m.roam;

    this.repathTimer -= dt;
    if (this.repathTimer <= 0 && !this.frozen && this.attackT <= 0 && this.hitT <= 0) {
      this.repathTimer = this.state === "chase" ? 0.35 : 0.8;
      this.computePath(ctx);
    }

    // Close-range chase with clear LOS: steer straight at them, no grid wobble.
    const directSteer = !this.frozen && this.attackT <= 0 && this.hitT <= 0 &&
      this.state === "chase" && los && dist < 7;

    if (directSteer) {
      const dir = toPlayer.normalize();
      this.heading = Math.atan2(dir.x, dir.z);
      this.pos.x += dir.x * speed * dt;
      this.pos.z += dir.z * speed * dt;
      this.level.collide(this.pos, 0.38);
    } else if (!this.frozen && this.attackT <= 0 && this.hitT <= 0 && this.path.length > 0) {
      this.stepAlongPath(dt, speed, this.state === "chase" ? 9 : 5);
    }

    this.animate(dt, speed);
  }

  /** Walk the A* path, turning smoothly toward each waypoint. */
  private stepAlongPath(dt: number, speed: number, turnRate: number) {
    const wp = this.path[0];
    if (!wp) return;
    const wx = this.level.worldX(wp.x);
    const wz = this.level.worldZ(wp.z);
    const dx = wx - this.pos.x;
    const dz = wz - this.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.6) {
      this.path.shift();
    } else {
      const targetHeading = Math.atan2(dx, dz);
      let diff = targetHeading - this.heading;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      this.heading += diff * Math.min(1, dt * turnRate);

      this.pos.x += Math.sin(this.heading) * speed * dt;
      this.pos.z += Math.cos(this.heading) * speed * dt;
      this.level.collide(this.pos, 0.38);
    }
  }

  /**
   * P5: the hiding-spot check. Walk to the stand point in front of the
   * opening, play the look-in anim, then resolve: occupied = drag-out kill,
   * empty = back to searching. Normal perception/attack is suspended — the
   * enemy is committed to this one piece of furniture.
   */
  private updateSpotCheck(dt: number) {
    const chk = this.checkSpot;
    if (!chk) return;

    if (this.hitT > 0) {
      this.hitT -= dt; // flinching — the appointment waits
      this.animate(dt, 0);
      return;
    }

    // The look-in is playing out; the grab lands as it ends.
    if (this.checkT > 0) {
      this.checkT -= dt;
      if (this.checkT <= 0) {
        const occupied = chk.spot.occupied;
        this.checkSpot = null;
        this.waypoint = null;
        if (occupied) {
          this.onKill?.();
        } else {
          this.playLocomotion(0);
        }
      }
      this.animate(dt, 0);
      return;
    }

    const dStand = Math.hypot(chk.stand.x - this.pos.x, chk.stand.z - this.pos.z);
    if (dStand < 0.7) {
      // In place — bend down / yank the door and LOOK.
      this.heading = Math.atan2(
        chk.spot.def.pos.x - this.pos.x,
        chk.spot.def.pos.z - this.pos.z,
      );
      const want = this.cfg.clips.check ?? this.cfg.clips.attack;
      const clip = this.actions.has(want) ? want : this.cfg.clips.idle;
      this.checkT = Math.min(3.2, Math.max(1.2, this.durations.get(clip) ?? 1.4));
      this.playClip(clip, { once: true });
      this.animate(dt, 0);
      return;
    }

    const speed = SEARCH_SPEED * this.cfg.speedMultipliers.search;
    this.repathTimer -= dt;
    if (this.repathTimer <= 0) {
      this.repathTimer = 0.6;
      const from = this.level.cellOf(this.pos.x, this.pos.z);
      const to = this.level.cellOf(chk.stand.x, chk.stand.z);
      const path = this.aStar(from, to);
      if (!path) {
        // Stand point unreachable — give up on the spot rather than freeze.
        this.checkSpot = null;
        this.animate(dt, 0);
        return;
      }
      this.path = path;
    }
    this.stepAlongPath(dt, speed, 5);
    this.animate(dt, speed);
  }

  private relocateNear(playerPos: THREE.Vector3, minCells: number, maxCells: number) {
    const pc = this.level.cellOf(playerPos.x, playerPos.z);
    for (let i = 0; i < 60; i++) {
      const ang = this.rng() * Math.PI * 2;
      const r = randRange(this.rng, minCells, maxCells);
      const cx = Math.round(pc.x + Math.cos(ang) * r);
      const cz = Math.round(pc.z + Math.sin(ang) * r);
      if (!this.level.isBlocked(cx, cz) && !this.level.lineOfSight(cx, cz, pc.x, pc.z)) {
        this.vTeleportFrom.copy(this.pos);
        this.teleportToCell(cx, cz);
        this.onTeleport?.(this.vTeleportFrom, this.pos);
        return;
      }
    }
  }

  private computePath(ctx: EnemyContext) {
    const from = this.level.cellOf(this.pos.x, this.pos.z);
    let target: { x: number; z: number };

    if (this.state === "chase" || this.state === "stalk") {
      target = this.level.cellOf(ctx.playerPos.x, ctx.playerPos.z);
    } else if (this.state === "search") {
      const lk = this.level.cellOf(this.lastKnownPlayer.x, this.lastKnownPlayer.z);
      if (!this.waypoint || (from.x === this.waypoint.x && from.z === this.waypoint.z)) {
        // Search paranoia: sometimes it goes and LOOKS inside a nearby
        // hiding spot instead of just wandering past. Granny rules.
        if (this.paranoiaCd <= 0 && this.rng() < PARANOIA_CHANCE) {
          const spot = this.pickParanoiaSpot();
          if (spot) {
            this.paranoiaCd = PARANOIA_COOLDOWN;
            this.inspectHidingSpot(spot);
            return;
          }
        }
        this.waypoint = {
          x: lk.x + Math.round(randRange(this.rng, -3, 3)),
          z: lk.z + Math.round(randRange(this.rng, -3, 3)),
        };
        if (this.level.isBlocked(this.waypoint.x, this.waypoint.z)) this.waypoint = lk;
      }
      target = this.waypoint;
    } else {
      if (!this.waypoint || (from.x === this.waypoint.x && from.z === this.waypoint.z)) {
        this.waypoint = this.level.randomOpenCell(this.rng, 16);
      }
      target = this.waypoint;
    }

    const path = this.aStar(from, target);
    if (path) this.path = path;
  }

  private aStar(
    from: { x: number; z: number },
    to: { x: number; z: number },
  ): { x: number; z: number }[] | null {
    if (this.level.isBlocked(to.x, to.z)) return null;
    const S = this.level.size;
    const key = (x: number, z: number) => z * S + x;
    const open = new Map<number, number>(); // key -> f
    const g = new Map<number, number>();
    const came = new Map<number, number>();
    const startK = key(from.x, from.z);
    const goalK = key(to.x, to.z);
    g.set(startK, 0);
    open.set(startK, Math.abs(to.x - from.x) + Math.abs(to.z - from.z));

    let iterations = 0;
    while (open.size > 0 && iterations++ < 2500) {
      // lowest f
      let curK = -1, curF = Infinity;
      for (const [k, f] of open) {
        if (f < curF) { curF = f; curK = k; }
      }
      if (curK === goalK) {
        const cells: { x: number; z: number }[] = [];
        let k = curK;
        while (k !== startK) {
          cells.push({ x: k % S, z: Math.floor(k / S) });
          k = came.get(k)!;
        }
        cells.reverse();
        return this.smoothPath(cells);
      }
      open.delete(curK);
      const cx = curK % S, cz = Math.floor(curK / S);
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (!this.level.canMove(cx, cz, dx, dz)) continue;
        const nx = cx + dx, nz = cz + dz;
        const nk = key(nx, nz);
        const ng = g.get(curK)! + 1;
        if (ng < (g.get(nk) ?? Infinity)) {
          g.set(nk, ng);
          came.set(nk, curK);
          open.set(nk, ng + Math.abs(to.x - nx) + Math.abs(to.z - nz));
        }
      }
    }
    return null;
  }

  /** A hiding spot in the room where the player was last seen, or null. */
  private pickParanoiaSpot(): HideSpotState | null {
    if (this.hidingSpots.length === 0) return null;
    const c = this.level.cellOf(this.lastKnownPlayer.x, this.lastKnownPlayer.z);
    const ri = this.level.roomOf[c.z * this.level.size + c.x];
    if (ri < 0) return null;
    const roomId = ROOMS[ri].id;
    const cands = this.hidingSpots.filter(
      (s) =>
        s.def.room === roomId &&
        Math.hypot(
          s.def.pos.x - this.lastKnownPlayer.x,
          s.def.pos.z - this.lastKnownPlayer.z,
        ) < PARANOIA_RADIUS,
    );
    return cands.length > 0 ? cands[Math.floor(this.rng() * cands.length)] : null;
  }

  /** Skip intermediate waypoints that have direct grid LOS — fewer zigzags. */
  private smoothPath(cells: { x: number; z: number }[]): { x: number; z: number }[] {
    if (cells.length <= 2) return cells;
    const out: { x: number; z: number }[] = [];
    let anchor = this.level.cellOf(this.pos.x, this.pos.z);
    let i = 0;
    while (i < cells.length) {
      let j = Math.min(i + 6, cells.length - 1);
      while (j > i && !this.level.lineOfSight(anchor.x, anchor.z, cells[j].x, cells[j].z)) {
        j--;
      }
      out.push(cells[j]);
      anchor = cells[j];
      i = j + 1;
    }
    return out;
  }

  /* ----------------------------- animation ----------------------------- */

  private playClip(
    name: string,
    opts: { once?: boolean; fade?: number; timeScale?: number } = {},
  ): THREE.AnimationAction | null {
    const action = this.actions.get(name);
    if (!action) return null;
    if (this.current === action && !opts.once) {
      action.timeScale = opts.timeScale ?? 1;
      return action;
    }
    action.reset();
    action.timeScale = opts.timeScale ?? 1;
    if (opts.once) {
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
    } else {
      action.setLoop(THREE.LoopRepeat, Infinity);
    }
    const fade = opts.fade ?? FADE;
    if (this.current && this.current !== action) {
      action.crossFadeFrom(this.current, fade, false);
    }
    action.play();
    this.current = action;
    return action;
  }

  /** Pick the locomotion clip from AI state + actual speed. */
  private playLocomotion(speed: number) {
    const c = this.cfg.clips;
    if (this.state === "search" && c.search && this.actions.has(c.search)) {
      this.playClip(c.search, { timeScale: Math.max(0.7, speed / SEARCH_SPEED) });
      return;
    }
    if (speed > 3) {
      const run = c.run && this.actions.has(c.run) ? c.run : c.walk;
      this.playClip(run, { timeScale: c.run === c.walk ? this.cfg.runTimeScale : 1 });
    } else if (speed > 0.05) {
      // Match stride to speed a little so feet don't skate.
      this.playClip(c.walk, { timeScale: Math.min(1.5, Math.max(0.7, speed / 1.5)) });
    } else {
      this.playClip(c.idle);
    }
  }

  private animate(dt: number, speed: number) {
    this.root.position.copy(this.pos);
    this.root.rotation.y = this.heading;

    // Footstep events — the audio phase hangs sounds off these.
    if (speed > 0.05) {
      this.stepAcc += speed * dt;
      if (this.stepAcc >= this.cfg.stepLength) {
        this.stepAcc = 0;
        this.onStep?.();
      }
    } else {
      this.stepAcc = 0;
    }

    // One-shots (attack/hit/spot-check) own the rig while they run.
    if (this.attackT <= 0 && this.hitT <= 0 && this.checkT <= 0) this.playLocomotion(speed);
    this.mixer.update(dt);
  }
}
