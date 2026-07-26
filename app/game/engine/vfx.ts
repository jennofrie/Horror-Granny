import * as THREE from "three";

/* -------------------------------------------------------------------------
 * World-space VFX (P6): muzzle flash, bullet impacts, blood, death smoke,
 * devil teleport puffs. Pooled billboards — fixed capacity, zero allocation
 * after init, oldest-first recycling.
 *
 *   sprites: 64 THREE.Sprite (per-particle material so opacity/tint/spin are
 *            independent — 64 materials created ONCE at init, not per shot)
 *   decals:  32 blood splatter planes oriented to wall/floor, shared geometry
 *   light:   1 dedicated muzzle-flash point light (NOT from the fixture pool)
 *
 * Blending: muzzle flash / impact sparks are ADDITIVE (they emit light);
 * smoke, dust and blood use normal alpha (they occlude). Everything is
 * depth-tested but not depth-writing so effects layer without punching
 * holes in the house. Effects stay subtle — the horror post shader keeps
 * the dominant look.
 *
 * Decals live 18s + 3s fade (long enough to read as evidence of a fight,
 * short enough that the 32-slot pool never visibly churns mid-combat).
 * ------------------------------------------------------------------------- */

const SPRITE_CAP = 64;
const DECAL_CAP = 32;
const BLOOD_FRAMES = 7; // 224x32 sheet, 32x32 frames
const DECAL_LIFE = 21; // 18s full + 3s fade
const FLASH_LIGHT_LIFE = 0.08; // ~80ms falloff, squared decay
const Z_AXIS = new THREE.Vector3(0, 0, 1);

interface BurstOpts {
  count: number;
  /** m/s initial radial speed */
  speed: number;
  /** optional bias direction (surface normal / shot dir) mixed into velocity */
  dir?: THREE.Vector3;
  /** 0..1 — how strongly `dir` dominates the random spread */
  spread?: number;
  /** seconds, ±30% per-particle jitter */
  life: number;
  /** base sprite size, meters */
  size: number;
  /** m/s size growth (smoke billows) */
  grow?: number;
  /** m/s² downward acceleration */
  gravity?: number;
  /** velocity damping /s */
  drag?: number;
  tint?: number;
  /** peak opacity */
  opacity?: number;
  additive?: boolean;
  /** max rad/s texture rotation */
  spin?: number;
  /** world-space Y offset of the spawn center */
  yOff?: number;
  /** explicit texture list — picks per particle (blood sheet frames) */
  frames?: THREE.Texture[];
}

class Particle {
  readonly sprite: THREE.Sprite;
  readonly mat: THREE.SpriteMaterial;
  readonly vel = new THREE.Vector3();
  alive = false;
  age = 0;
  life = 1;
  size = 0.2;
  grow = 0;
  gravity = 0;
  drag = 0;
  spin = 0;
  peak = 1;
  fadeIn = 0.04; // seconds to reach peak opacity

  constructor() {
    this.mat = new THREE.SpriteMaterial({
      transparent: true,
      depthWrite: false,
      opacity: 0,
    });
    this.sprite = new THREE.Sprite(this.mat);
    this.sprite.visible = false;
    this.sprite.renderOrder = 5;
  }
}

class Decal {
  readonly mesh: THREE.Mesh;
  readonly mat: THREE.MeshBasicMaterial;
  alive = false;
  age = 0;
  life = DECAL_LIFE;
  peak = 0.85;

  constructor(geo: THREE.PlaneGeometry) {
    this.mat = new THREE.MeshBasicMaterial({
      transparent: true,
      depthWrite: false,
      opacity: 0,
      polygonOffset: true, // sit on the wall/floor without z-fighting
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.visible = false;
    this.mesh.renderOrder = 4;
  }
}

export class VFX {
  /** dev/test hook: scale particle aging (headless screenshots) — 1 in game */
  timeScale = 1;

  private readonly group = new THREE.Group();
  private readonly particles: Particle[] = [];
  private readonly decals: Decal[] = [];
  private cursor = 0; // ring cursor — spawning always overwrites the oldest slot
  private decalCursor = 0;
  private readonly decalGeo = new THREE.PlaneGeometry(1, 1);

  private texMuzzle: THREE.Texture | null = null;
  private texSmoke: THREE.Texture | null = null;
  private texSpark: THREE.Texture | null = null;
  private texBloodHi: THREE.Texture | null = null;
  private readonly texBloodFrames: THREE.Texture[] = [];

  /** the one transient muzzle light — intensity spikes on gunshot */
  private readonly flashLight = new THREE.PointLight(0xffb36b, 0, 7, 2);
  private lightT = 0;

  // scratch — effect calls must not allocate either (they ride the frame loop)
  private readonly vA = new THREE.Vector3();
  private readonly qA = new THREE.Quaternion();
  private readonly qB = new THREE.Quaternion();

  constructor(scene: THREE.Scene) {
    for (let i = 0; i < SPRITE_CAP; i++) {
      const p = new Particle();
      this.particles.push(p);
      this.group.add(p.sprite);
    }
    for (let i = 0; i < DECAL_CAP; i++) {
      const d = new Decal(this.decalGeo);
      this.decals.push(d);
      this.group.add(d.mesh);
    }
    this.group.add(this.flashLight);
    scene.add(this.group);

    // Relative URLs — the game is served from a sub-path in production.
    const loader = new THREE.TextureLoader();
    const srgb = (t: THREE.Texture) => {
      t.colorSpace = THREE.SRGBColorSpace;
      return t;
    };
    loader.load("./assets/vfx/muzzle-flash.png", (t) => (this.texMuzzle = srgb(t)));
    loader.load("./assets/vfx/smoke-puff.png", (t) => (this.texSmoke = srgb(t)));
    loader.load("./assets/vfx/impact-spark.png", (t) => (this.texSpark = srgb(t)));
    loader.load("./assets/vfx/blood-splatter-hi.png", (t) => (this.texBloodHi = srgb(t)));
    loader.load("./assets/vfx/blood-splatter.png", (t) => {
      srgb(t);
      // Clone AFTER load (clones made earlier would keep a null image) —
      // 7 tiny frame textures, created once.
      for (let i = 0; i < BLOOD_FRAMES; i++) {
        const f = t.clone();
        f.repeat.set(1 / BLOOD_FRAMES, 1);
        f.offset.set(i / BLOOD_FRAMES, 0);
        f.needsUpdate = true;
        this.texBloodFrames.push(f);
      }
    });
  }

  /* --------------------------- primitives --------------------------- */

  /** Spawn one particle from the ring (recycles the oldest slot). */
  private spawn(tex: THREE.Texture, additive: boolean): Particle {
    const p = this.particles[this.cursor];
    this.cursor = (this.cursor + 1) % SPRITE_CAP;
    p.alive = true;
    p.age = 0;
    p.mat.map = tex;
    p.mat.blending = additive ? THREE.AdditiveBlending : THREE.NormalBlending;
    p.mat.fog = !additive; // additive sprites must not pick up the fog color
    p.mat.needsUpdate = true;
    p.mat.rotation = Math.random() * Math.PI * 2;
    p.sprite.visible = true;
    return p;
  }

  /**
   * Generic particle burst. `frames` overrides `tex` with a per-particle
   * pick (blood sprite sheet: a random frame per particle).
   */
  burst(tex: THREE.Texture, pos: THREE.Vector3, o: BurstOpts) {
    const spread = o.spread ?? 0;
    for (let i = 0; i < o.count; i++) {
      const t = o.frames?.length
        ? o.frames[Math.floor(Math.random() * o.frames.length)]
        : tex;
      const p = this.spawn(t, o.additive ?? false);
      p.life = o.life * (0.7 + Math.random() * 0.6);
      p.size = o.size * (0.75 + Math.random() * 0.5);
      p.grow = o.grow ?? 0;
      p.gravity = o.gravity ?? 0;
      p.drag = o.drag ?? 1.5;
      p.peak = o.opacity ?? 1;
      p.spin = (Math.random() * 2 - 1) * (o.spin ?? 1.5);
      p.mat.color.set(o.tint ?? 0xffffff);
      p.sprite.position.set(
        pos.x,
        pos.y + (o.yOff ?? 0),
        pos.z,
      );
      // random sphere direction, biased toward `dir` by `spread`
      const a = Math.random() * Math.PI * 2;
      const z = Math.random() * 2 - 1;
      const r = Math.sqrt(Math.max(0, 1 - z * z));
      p.vel.set(r * Math.cos(a), z, r * Math.sin(a));
      if (o.dir && spread > 0) {
        p.vel.lerp(o.dir, spread).normalize();
      }
      p.vel.multiplyScalar(o.speed * (0.6 + Math.random() * 0.8));
    }
  }

  /** Single short-lived billboard — the muzzle flash itself. */
  flash(tex: THREE.Texture, pos: THREE.Vector3, size: number, life: number, tint: number) {
    const p = this.spawn(tex, true);
    p.life = life;
    p.size = size;
    p.grow = size * 2; // flashes swell as they die
    p.gravity = 0;
    p.drag = 0;
    p.peak = 1;
    p.fadeIn = 0.01;
    p.spin = 0;
    p.vel.set(0, 0, 0);
    p.sprite.position.copy(pos);
    p.mat.color.set(tint);
  }

  /**
   * Blood splatter on a surface. `normal` orients the plane; the mesh is
   * nudged 2.5cm off the surface (plus polygonOffset) against z-fighting.
   */
  decal(tex: THREE.Texture, pos: THREE.Vector3, normal: THREE.Vector3, size: number) {
    const d = this.decals[this.decalCursor];
    this.decalCursor = (this.decalCursor + 1) % DECAL_CAP;
    d.alive = true;
    d.age = 0;
    d.life = DECAL_LIFE;
    d.mat.map = tex;
    d.mat.color.set(0xbbbbbb); // slightly subdued — fresh blood is dark
    d.mat.needsUpdate = true;
    d.mesh.position.copy(pos).addScaledVector(normal, 0.025);
    // face along the normal, then a random roll around it
    this.qA.setFromUnitVectors(Z_AXIS, normal);
    this.qB.setFromAxisAngle(normal, Math.random() * Math.PI * 2);
    d.mesh.quaternion.copy(this.qA).premultiply(this.qB);
    d.mesh.scale.set(size, size, 1);
    d.mesh.visible = true;
  }

  /* ---------------------------- effects ---------------------------- */

  /** Gunshot: 2-frame additive flash flicker + transient light + smoke wisp. */
  gunshot(pos: THREE.Vector3, dir: THREE.Vector3) {
    if (this.texMuzzle) {
      this.flash(this.texMuzzle, pos, 0.2, 0.06, 0xffd9a3);
      // second flicker frame, a touch further down the barrel
      this.vA.copy(pos).addScaledVector(dir, 0.09);
      this.flash(this.texMuzzle, this.vA, 0.28, 0.09, 0xffc27a);
    }
    if (this.texSmoke) {
      this.burst(this.texSmoke, pos, {
        count: 1,
        speed: 0.3,
        dir,
        spread: 0.55,
        life: 0.9,
        size: 0.2,
        grow: 0.35,
        tint: 0x8a8378,
        opacity: 0.28,
        yOff: 0.02,
      });
    }
    this.flashLight.position.copy(pos);
    this.lightT = FLASH_LIGHT_LIFE;
  }

  /** Bullet hits a wall/floor: additive sparks bouncing off + a dust puff. */
  impact(point: THREE.Vector3, normal: THREE.Vector3) {
    if (this.texSpark) {
      this.burst(this.texSpark, point, {
        count: 2,
        speed: 1.7,
        dir: normal,
        spread: 0.6,
        life: 0.14,
        size: 0.15,
        tint: 0xffc27a,
        opacity: 1,
        additive: true,
        spin: 4,
      });
    }
    if (this.texSmoke) {
      this.burst(this.texSmoke, point, {
        count: 2,
        speed: 0.5,
        dir: normal,
        spread: 0.5,
        life: 0.8,
        size: 0.18,
        grow: 0.3,
        tint: 0x7d7466,
        opacity: 0.26,
      });
    }
  }

  /**
   * Enemy takes a hit: sprite-sheet blood spray + a dark red mist.
   * `scale` < 1 for melee (smaller puff), > 1 for death gushes.
   */
  blood(point: THREE.Vector3, scale = 1) {
    if (this.texBloodFrames.length > 0) {
      this.burst(this.texBloodFrames[0], point, {
        count: Math.max(2, Math.round(6 * scale)),
        speed: 1.4 * scale,
        life: 0.45,
        size: 0.2 * scale,
        gravity: 7,
        drag: 1,
        tint: 0xffffff, // the sheet is already red
        opacity: 0.95,
        frames: this.texBloodFrames,
        spin: 3,
      });
    }
    if (this.texSmoke) {
      this.burst(this.texSmoke, point, {
        count: 1,
        speed: 0.25,
        life: 0.8,
        size: 0.38 * scale,
        grow: 0.5,
        tint: 0x5d0d12,
        opacity: 0.55,
      });
    }
  }

  /** Wall/floor splatter — Engine picks the spot + normal. */
  bloodDecal(point: THREE.Vector3, normal: THREE.Vector3, size: number) {
    if (this.texBloodHi) this.decal(this.texBloodHi, point, normal, size);
  }

  /** Enemy collapse: lingering smoke over the body (+ devil gets a gush). */
  deathBurst(pos: THREE.Vector3, devil: boolean) {
    if (this.texSmoke) {
      this.burst(this.texSmoke, pos, {
        count: devil ? 12 : 8,
        speed: 0.7,
        life: 1.7,
        size: 0.5,
        grow: 0.6,
        drag: 1,
        tint: devil ? 0x481118 : 0x4a443c,
        opacity: 0.5,
        yOff: 0.7,
        spin: 1,
      });
    }
    this.vA.set(pos.x, pos.y + 0.6, pos.z);
    this.blood(this.vA, devil ? 1.6 : 1);
  }

  /** Devil materialize / horror-director teleport: dark smoke, red for devil. */
  teleportPuff(pos: THREE.Vector3, devil: boolean) {
    if (!this.texSmoke) return;
    this.burst(this.texSmoke, pos, {
      count: devil ? 10 : 7,
      speed: 0.55,
      life: 1.3,
      size: 0.55,
      grow: 0.5,
      drag: 1,
      tint: devil ? 0x3c0f16 : 0x3a372f,
      opacity: 0.5,
      yOff: 0.8,
      spin: 1,
    });
  }

  /* ----------------------------- update ----------------------------- */

  /** live-particle count (dev-hook tests) */
  get aliveCount(): number {
    let n = 0;
    for (const p of this.particles) if (p.alive) n++;
    for (const d of this.decals) if (d.alive) n++;
    return n;
  }

  update(rawDt: number) {
    const dt = rawDt * this.timeScale;

    // muzzle light: squared falloff over ~80ms
    if (this.lightT > 0) {
      this.lightT -= dt;
      const k = Math.max(0, this.lightT / FLASH_LIGHT_LIFE);
      this.flashLight.intensity = 3.2 * k * k;
    }

    for (const p of this.particles) {
      if (!p.alive) continue;
      p.age += dt;
      if (p.age >= p.life) {
        p.alive = false;
        p.sprite.visible = false;
        p.mat.opacity = 0;
        continue;
      }
      const k = p.age / p.life;
      p.vel.y -= p.gravity * dt;
      if (p.drag > 0) p.vel.multiplyScalar(Math.max(0, 1 - p.drag * dt));
      p.sprite.position.addScaledVector(p.vel, dt);
      const s = p.size + p.grow * p.age;
      p.sprite.scale.set(s, s, 1);
      p.mat.opacity = p.peak * Math.min(1, p.age / p.fadeIn) * (1 - k * k);
      p.mat.rotation += p.spin * dt;
    }

    for (const d of this.decals) {
      if (!d.alive) continue;
      d.age += dt;
      if (d.age >= d.life) {
        d.alive = false;
        d.mesh.visible = false;
        d.mat.opacity = 0;
        continue;
      }
      // fast fade-in, long hold, 3s fade-out
      const fade = Math.min(1, (d.life - d.age) / 3);
      d.mat.opacity = d.peak * Math.min(1, d.age / 0.1) * fade;
    }
  }

  dispose(scene: THREE.Scene) {
    scene.remove(this.group);
    for (const p of this.particles) p.mat.dispose();
    for (const d of this.decals) d.mat.dispose();
    this.decalGeo.dispose();
    for (const t of [
      this.texMuzzle,
      this.texSmoke,
      this.texSpark,
      this.texBloodHi,
      ...this.texBloodFrames,
    ]) {
      t?.dispose();
    }
  }
}
