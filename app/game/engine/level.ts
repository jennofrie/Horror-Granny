import * as THREE from "three";
import { mulberry32, Rand } from "./rng";
import {
  DOORWAYS,
  ENTITY_SPAWN,
  FRONT_DOOR,
  FURNITURE,
  FurnitureDef,
  GRID,
  HIDING_SPOTS,
  HOUSE_OX,
  HOUSE_OZ,
  hxToWorld,
  hzToWorld,
  ITEM_SPAWNS,
  PLAYER_SPAWN,
  ROOMS,
} from "./house";
import {
  makeConcreteMaps,
  makeDoorTexture,
  makeExitSignTexture,
  makeLightPanelTexture,
  makePlasterMaps,
  makeTileMaps,
  makeWallpaperMaps,
  makeWoodFloorMaps,
} from "./textures";

export const CELL = 1; // meters per grid cell — the house is hand-planned at 1m
export const WALL_H = 2.9; // ceiling height
export const WALL_HALF = 0.12; // partition walls are 24cm thick

export const OPEN = 0;
export const SOLID = 1; // out-of-bounds / outside the house footprint
export const PILLAR = 2;

export interface Fixture {
  index: number;
  pos: THREE.Vector3;
  state: "on" | "flicker" | "off";
  /** 0..1 — how strongly the entity's presence is suppressing this light */
  aura: number;
  phase: number;
  /** HDR lamp color — warm tungsten (#ffd9a0-ish), dimmer than fluorescents */
  base: [number, number, number];
}

interface ExitInfo {
  cell: { x: number; z: number };
  doorPos: THREE.Vector3;
  facing: THREE.Vector3;
  door: THREE.Mesh;
  sign: THREE.Mesh;
  light: THREE.PointLight;
}

/** World-space item spawn candidate (later items phase picks from these). */
export interface ItemSpawn {
  id: string;
  type: "weapon" | "ammo" | "key";
  item: string;
  room: string;
  pos: THREE.Vector3;
}

/** World-space hiding spot (later AI/hiding phase consumes these). */
export interface HidingSpot {
  id: string;
  kind: "wardrobe" | "under-bed";
  room: string;
  pos: THREE.Vector3;
  yaw: number;
}

/** A furniture placeholder: plan def + its stand-in mesh (swap via `def.id`). */
export interface FurnitureInstance {
  def: FurnitureDef;
  mesh: THREE.Mesh;
}

/* Minimal indexed quad-mesh builder. */
class GeoBuilder {
  pos: number[] = [];
  nor: number[] = [];
  uv: number[] = [];
  idx: number[] = [];

  quad(
    a: number[], b: number[], c: number[], d: number[],
    n: number[],
    uvs: [number, number][],
  ) {
    const base = this.pos.length / 3;
    this.pos.push(...a, ...b, ...c, ...d);
    for (let i = 0; i < 4; i++) this.nor.push(...n);
    for (const [u, v] of uvs) this.uv.push(u, v);
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.idx);
    return g;
  }
}

/**
 * The house: a fixed, hand-designed single-floor plan (see house.ts)
 * rasterized onto the same grid + wall-edge representation the engine has
 * always used, so every consumer (player, entity, items, Engine) keeps
 * working unchanged. The seed is still accepted for deterministic texture
 * generation, but the layout never changes.
 */
export class Level {
  readonly size = GRID;
  grid: Uint8Array; // OPEN inside the house / SOLID outside
  /** wallV[x*size+z]: wall on the WEST edge of cell (x,z); x in 0..size */
  wallV: Uint8Array;
  /** wallH[x + z*size... see idx]: wall on the NORTH edge of cell (x,z); z in 0..size */
  wallH: Uint8Array;

  fixtures: Fixture[] = [];
  spawn = new THREE.Vector3();
  spawnCell = { x: 0, z: 0 };
  entitySpawnCell = { x: 0, z: 0 };
  exit!: ExitInfo;
  group = new THREE.Group();

  /** room index per cell, -1 outside the house footprint */
  readonly roomOf: Int16Array;
  /** world-space placement data for later phases (from house.ts) */
  readonly itemSpawns: ItemSpawn[] = [];
  readonly hidingSpots: HidingSpot[] = [];
  readonly furniture: FurnitureInstance[] = [];
  /** furniture id -> placeholder mesh, for the GLTF swap-in phase */
  readonly furnitureById = new Map<string, THREE.Mesh>();

  /** wall-material owner (room index) per wall edge, for per-room wallpaper */
  private wallOwnerV: Int16Array;
  private wallOwnerH: Int16Array;
  /** blocking furniture AABBs (world space) — collision only */
  private furnitureBoxes: { minX: number; maxX: number; minZ: number; maxZ: number }[] = [];

  private rng: Rand;
  private panelMesh!: THREE.InstancedMesh;
  private distFromSpawn!: Int32Array;

  constructor(public seed: number) {
    this.rng = mulberry32(seed);
    this.grid = new Uint8Array(this.size * this.size).fill(SOLID);
    this.wallV = new Uint8Array((this.size + 1) * this.size);
    this.wallH = new Uint8Array(this.size * (this.size + 1));
    this.roomOf = new Int16Array(this.size * this.size).fill(-1);
    this.wallOwnerV = new Int16Array((this.size + 1) * this.size).fill(-1);
    this.wallOwnerH = new Int16Array(this.size * (this.size + 1)).fill(-1);
    this.generate();
  }

  /* ------------------------- grid helpers ------------------------- */

  cell(x: number, z: number): number {
    if (x < 0 || z < 0 || x >= this.size || z >= this.size) return SOLID;
    return this.grid[z * this.size + x];
  }

  isBlocked(x: number, z: number): boolean {
    return this.cell(x, z) !== OPEN;
  }

  private vIdx(x: number, z: number) {
    return x * this.size + z;
  }
  private hIdx(x: number, z: number) {
    return z * this.size + x;
  }

  hasWallV(x: number, z: number): boolean {
    if (x < 0 || x > this.size || z < 0 || z >= this.size) return true;
    return this.wallV[this.vIdx(x, z)] === 1;
  }
  hasWallH(x: number, z: number): boolean {
    if (z < 0 || z > this.size || x < 0 || x >= this.size) return true;
    return this.wallH[this.hIdx(x, z)] === 1;
  }

  /** Can an agent step from cell (x,z) one cell in direction (dx,dz)? */
  canMove(x: number, z: number, dx: number, dz: number): boolean {
    const nx = x + dx, nz = z + dz;
    if (this.isBlocked(nx, nz)) return false;
    if (dx === 1) return !this.hasWallV(x + 1, z);
    if (dx === -1) return !this.hasWallV(x, z);
    if (dz === 1) return !this.hasWallH(x, z + 1);
    if (dz === -1) return !this.hasWallH(x, z);
    return true;
  }

  worldX(cx: number): number {
    return (cx - this.size / 2) * CELL + CELL / 2;
  }
  worldZ(cz: number): number {
    return (cz - this.size / 2) * CELL + CELL / 2;
  }
  cellOf(x: number, z: number): { x: number; z: number } {
    return {
      x: Math.floor(x / CELL + this.size / 2),
      z: Math.floor(z / CELL + this.size / 2),
    };
  }

  /**
   * Cell-to-cell visibility: march the segment between cell centers and
   * test every wall crossing along the way. Furniture is deliberately NOT
   * considered — placeholders are low (sofas, beds) and the entity should
   * see over them; blocking volumes only affect movement.
   */
  lineOfSight(ax: number, az: number, bx: number, bz: number): boolean {
    if (this.isBlocked(bx, bz) && !(ax === bx && az === bz)) {
      // target outside the house — treat its center as opaque
      return false;
    }
    const x0 = this.worldX(ax), z0 = this.worldZ(az);
    const x1 = this.worldX(bx), z1 = this.worldZ(bz);
    const dist = Math.hypot(x1 - x0, z1 - z0);
    if (dist < 0.01) return true;
    const steps = Math.ceil(dist / 0.5);
    let cx = ax, cz = az;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const px = x0 + (x1 - x0) * t;
      const pz = z0 + (z1 - z0) * t;
      const c = this.cellOf(px, pz);
      while (cx !== c.x) {
        const sx = Math.sign(c.x - cx);
        if (sx > 0 ? this.hasWallV(cx + 1, cz) : this.hasWallV(cx, cz)) return false;
        cx += sx;
        if (this.cell(cx, cz) === PILLAR) return false;
      }
      while (cz !== c.z) {
        const sz = Math.sign(c.z - cz);
        if (sz > 0 ? this.hasWallH(cx, cz + 1) : this.hasWallH(cx, cz)) return false;
        cz += sz;
        if (this.cell(cx, cz) === PILLAR) return false;
      }
    }
    return true;
  }

  /* --------------------------- generation --------------------------- */

  private generate() {
    const S = this.size;

    // 1) Rasterize room rects onto the grid.
    ROOMS.forEach((room, ri) => {
      const { x0, z0, x1, z1 } = room.rect;
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          const gi = (z + HOUSE_OZ) * S + (x + HOUSE_OX);
          if (this.roomOf[gi] !== -1) {
            throw new Error(
              `House plan error: rooms "${ROOMS[this.roomOf[gi]].id}" and "${room.id}" overlap at (${x},${z})`,
            );
          }
          this.roomOf[gi] = ri;
          this.grid[gi] = OPEN;
        }
      }
    });

    // 2) Walls wherever two adjacent cells belong to different rooms
    //    (or one is outside the house). Owner = room whose wallpaper shows;
    //    for interior walls the lower-indexed room owns both faces.
    const owner = (a: number, b: number) =>
      a === -1 ? b : b === -1 ? a : Math.min(a, b);
    for (let z = 0; z < S; z++) {
      for (let x = 0; x < S; x++) {
        const a = this.roomOf[z * S + x];
        const b = x + 1 < S ? this.roomOf[z * S + x + 1] : -1;
        if (a !== b) {
          this.wallV[this.vIdx(x + 1, z)] = 1;
          this.wallOwnerV[this.vIdx(x + 1, z)] = owner(a, b);
        }
        const c = z + 1 < S ? this.roomOf[(z + 1) * S + x] : -1;
        if (a !== c) {
          this.wallH[this.hIdx(x, z + 1)] = 1;
          this.wallOwnerH[this.hIdx(x, z + 1)] = owner(a, c);
        }
      }
    }

    // 3) Doorways: clear a 2m opening in the named wall edge.
    for (const d of DOORWAYS) {
      const gx = d.x + HOUSE_OX, gz = d.z + HOUSE_OZ;
      if (d.kind === "V") {
        if (!this.hasWallV(gx, gz) || !this.hasWallV(gx, gz + 1)) {
          throw new Error(`House plan error: doorway at V(${d.x},${d.z}) has no wall to open`);
        }
        this.wallV[this.vIdx(gx, gz)] = 0;
        this.wallV[this.vIdx(gx, gz + 1)] = 0;
      } else {
        if (!this.hasWallH(gx, gz) || !this.hasWallH(gx + 1, gz)) {
          throw new Error(`House plan error: doorway at H(${d.x},${d.z}) has no wall to open`);
        }
        this.wallH[this.hIdx(gx, gz)] = 0;
        this.wallH[this.hIdx(gx + 1, gz)] = 0;
      }
    }

    // 4) Sealed grid border (outside is SOLID anyway; belt and braces).
    for (let z = 0; z < S; z++) {
      this.wallV[this.vIdx(0, z)] = 1;
      this.wallV[this.vIdx(S, z)] = 1;
    }
    for (let x = 0; x < S; x++) {
      this.wallH[this.hIdx(x, 0)] = 1;
      this.wallH[this.hIdx(x, S)] = 1;
    }

    // 5) Fixed spawns (foyer / garage).
    this.spawnCell = { x: PLAYER_SPAWN.x + HOUSE_OX, z: PLAYER_SPAWN.z + HOUSE_OZ };
    this.spawn.set(this.worldX(this.spawnCell.x), 0, this.worldZ(this.spawnCell.z));
    this.entitySpawnCell = { x: ENTITY_SPAWN.x + HOUSE_OX, z: ENTITY_SPAWN.z + HOUSE_OZ };

    // 6) BFS distance field from spawn (wall-aware) — later phases use it
    //    for placement/difficulty, and it proves the plan is connected.
    this.distFromSpawn = new Int32Array(S * S).fill(-1);
    const queue: number[] = [this.spawnCell.z * S + this.spawnCell.x];
    this.distFromSpawn[queue[0]] = 0;
    let qi = 0;
    while (qi < queue.length) {
      const cur = queue[qi++];
      const cx = cur % S, cz = Math.floor(cur / S);
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (!this.canMove(cx, cz, dx, dz)) continue;
        const ni = (cz + dz) * S + (cx + dx);
        if (this.distFromSpawn[ni] === -1) {
          this.distFromSpawn[ni] = this.distFromSpawn[cur] + 1;
          queue.push(ni);
        }
      }
    }
    // Every room must be reachable — a broken doorway edit should fail loudly.
    for (let z = 0; z < S; z++) {
      for (let x = 0; x < S; x++) {
        const ri = this.roomOf[z * S + x];
        if (ri >= 0 && this.distFromSpawn[z * S + x] === -1) {
          throw new Error(
            `House plan error: room "${ROOMS[ri].id}" is unreachable from the foyer (cell ${x - HOUSE_OX},${z - HOUSE_OZ})`,
          );
        }
      }
    }

    // 7) Ceiling lamps from the plan. Warm tungsten, several burnt out.
    let fi = 0;
    for (const room of ROOMS) {
      for (const lamp of room.lamps) {
        this.fixtures.push({
          index: fi++,
          pos: new THREE.Vector3(hxToWorld(lamp.x), WALL_H - 0.02, hzToWorld(lamp.z)),
          state: lamp.state ?? "on",
          aura: 0,
          phase: this.rng() * 100,
          base: [1.75, 1.32, 0.78],
        });
      }
    }
    // The lamp nearest the spawn is always lit — never a black first room.
    let nearest: Fixture | null = null;
    let best = Infinity;
    for (const f of this.fixtures) {
      const d = f.pos.distanceToSquared(this.spawn);
      if (d < best) { best = d; nearest = f; }
    }
    if (nearest) nearest.state = "on";

    // 8) The front door (exit) on the foyer's south wall.
    this.computeExit();

    // 9) World-space placement data for later phases.
    for (const s of ITEM_SPAWNS) {
      this.itemSpawns.push({
        id: s.id,
        type: s.type,
        item: s.item,
        room: s.room,
        pos: new THREE.Vector3(hxToWorld(s.pos.x), s.pos.y, hzToWorld(s.pos.z)),
      });
    }
    for (const h of HIDING_SPOTS) {
      this.hidingSpots.push({
        id: h.id,
        kind: h.kind,
        room: h.room,
        pos: new THREE.Vector3(hxToWorld(h.pos.x), h.pos.y, hzToWorld(h.pos.z)),
        yaw: h.yaw,
      });
    }

    // 10) Blocking furniture AABBs (world space) for collide/solidAtWorld.
    for (const f of FURNITURE) {
      if (!f.blocking) continue;
      const rot = f.rotY ?? 0;
      // placeholder boxes are axis-aligned; a 90° yaw swaps the footprint
      const [w, d] = Math.abs(Math.sin(rot)) > 0.5 ? [f.d, f.w] : [f.w, f.d];
      const cx = hxToWorld(f.x + f.w / 2);
      const cz = hzToWorld(f.z + f.d / 2);
      this.furnitureBoxes.push({
        minX: cx - w / 2, maxX: cx + w / 2,
        minZ: cz - d / 2, maxZ: cz + d / 2,
      });
    }
  }

  private computeExit() {
    const cell = { x: FRONT_DOOR.cell.x + HOUSE_OX, z: FRONT_DOOR.cell.z + HOUSE_OZ };
    const facing = FRONT_DOOR.facing; // outward (south)
    const inset = CELL / 2 - WALL_HALF - 0.05;
    const wallX = this.worldX(cell.x) + facing.x * inset;
    const wallZ = this.worldZ(cell.z) + facing.z * inset;
    this.exit = {
      cell,
      doorPos: new THREE.Vector3(wallX, 1.1, wallZ),
      facing: new THREE.Vector3(-facing.x, 0, -facing.z),
    } as ExitInfo;
  }

  /* ----------------------------- meshes ----------------------------- */

  build(scene: THREE.Scene) {
    const seed = this.seed;

    // Material sets per id (cached — several rooms share ids).
    const wallSets = new Map<string, THREE.MeshStandardMaterial>();
    const wallMat = (id: string): THREE.MeshStandardMaterial => {
      let m = wallSets.get(id);
      if (m) return m;
      let maps;
      switch (id) {
        case "wp-cream": maps = makeWallpaperMaps(seed, [205, 188, 148]); break;
        case "wp-sage": maps = makeWallpaperMaps(seed + 1, [170, 182, 150]); break;
        case "wp-blue": maps = makeWallpaperMaps(seed + 2, [152, 165, 186]); break;
        case "wp-rose": maps = makeWallpaperMaps(seed + 3, [190, 160, 148]); break;
        case "wp-green": maps = makeWallpaperMaps(seed + 4, [146, 160, 130]); break;
        case "tile": maps = makeTileMaps(seed + 5, [170, 186, 192]); break;
        case "concrete": maps = makeConcreteMaps(seed + 6); break;
        default: maps = makePlasterMaps(seed + 7, [180, 174, 160]); break; // "plaster"
      }
      m = new THREE.MeshStandardMaterial({
        map: maps.map,
        normalMap: maps.normalMap,
        roughnessMap: maps.roughnessMap,
        normalScale: new THREE.Vector2(0.8, 0.8),
      });
      wallSets.set(id, m);
      return m;
    };

    const wood = makeWoodFloorMaps(seed);
    const kitchenTile = makeTileMaps(seed + 8, [176, 182, 178]);
    const garageConcrete = makeConcreteMaps(seed + 9);
    const plasterCeil = makePlasterMaps(seed + 10, [196, 190, 176]);

    const floorMats: Record<string, THREE.MeshStandardMaterial> = {
      wood: new THREE.MeshStandardMaterial({
        map: wood.map, normalMap: wood.normalMap, roughnessMap: wood.roughnessMap,
        normalScale: new THREE.Vector2(0.6, 0.6),
      }),
      tile: new THREE.MeshStandardMaterial({
        map: kitchenTile.map, normalMap: kitchenTile.normalMap, roughnessMap: kitchenTile.roughnessMap,
        normalScale: new THREE.Vector2(0.7, 0.7),
      }),
      concrete: new THREE.MeshStandardMaterial({
        map: garageConcrete.map, normalMap: garageConcrete.normalMap, roughnessMap: garageConcrete.roughnessMap,
        normalScale: new THREE.Vector2(0.7, 0.7),
      }),
    };
    const ceilMat = new THREE.MeshStandardMaterial({
      map: plasterCeil.map,
      normalMap: plasterCeil.normalMap,
      roughnessMap: plasterCeil.roughnessMap,
      normalScale: new THREE.Vector2(0.5, 0.5),
    });

    // Floor: one quad per room, grouped by that room's floor material.
    const floorBuilders = new Map<string, GeoBuilder>();
    for (const room of ROOMS) {
      let b = floorBuilders.get(room.floor);
      if (!b) { b = new GeoBuilder(); floorBuilders.set(room.floor, b); }
      const { x0, z0, x1, z1 } = room.rect;
      const wx0 = hxToWorld(x0), wx1 = hxToWorld(x1 + 1);
      const wz0 = hzToWorld(z0), wz1 = hzToWorld(z1 + 1);
      b.quad(
        [wx0, 0, wz0], [wx0, 0, wz1], [wx1, 0, wz1], [wx1, 0, wz0],
        [0, 1, 0],
        [[wx0 / 2, wz0 / 2], [wx0 / 2, wz1 / 2], [wx1 / 2, wz1 / 2], [wx1 / 2, wz0 / 2]],
      );
    }
    for (const [id, b] of floorBuilders) {
      const mesh = new THREE.Mesh(b.build(), floorMats[id]);
      mesh.receiveShadow = true;
      this.group.add(mesh);
    }

    // Ceiling: one plaster slab over the whole house footprint.
    const ceils = new GeoBuilder();
    const cx0 = hxToWorld(0), cx1 = hxToWorld(60);
    const cz0 = hzToWorld(0), cz1 = hzToWorld(44);
    ceils.quad(
      [cx0, WALL_H, cz0], [cx1, WALL_H, cz0], [cx1, WALL_H, cz1], [cx0, WALL_H, cz1],
      [0, -1, 0],
      [[cx0 / 2.4, cz0 / 2.4], [cx1 / 2.4, cz0 / 2.4], [cx1 / 2.4, cz1 / 2.4], [cx0 / 2.4, cz1 / 2.4]],
    );
    const ceilMesh = new THREE.Mesh(ceils.build(), ceilMat);
    ceilMesh.receiveShadow = true;
    this.group.add(ceilMesh);

    // Walls from wall edges, grouped into one builder per wallpaper/material
    // id (the edge owner's material). Wallpaper texture spans 4m horizontally.
    const wallBuilders = new Map<string, GeoBuilder>();
    const wallBuilder = (roomIdx: number): GeoBuilder => {
      const id = roomIdx >= 0 ? ROOMS[roomIdx].wall : "plaster";
      let b = wallBuilders.get(id);
      if (!b) { b = new GeoBuilder(); wallBuilders.set(id, b); }
      return b;
    };
    const T = WALL_HALF;

    // Vertical (north-south running) walls on cell west/east edges.
    for (let x = 0; x <= this.size; x++) {
      for (let z = 0; z < this.size; z++) {
        if (!this.hasWallV(x, z)) continue;
        const walls = wallBuilder(this.wallOwnerV[this.vIdx(x, z)]);
        const wx = this.worldX(x) - CELL / 2; // edge plane
        const z0 = this.worldZ(z) - CELL / 2 - T;
        const z1 = this.worldZ(z) + CELL / 2 + T;
        const x0 = wx - T, x1 = wx + T;
        // west face (-X), east face (+X)
        walls.quad(
          [x0, 0, z0], [x0, 0, z1], [x0, WALL_H, z1], [x0, WALL_H, z0],
          [-1, 0, 0],
          [[z0 / 4, 0], [z1 / 4, 0], [z1 / 4, 1], [z0 / 4, 1]],
        );
        walls.quad(
          [x1, 0, z1], [x1, 0, z0], [x1, WALL_H, z0], [x1, WALL_H, z1],
          [1, 0, 0],
          [[z1 / 4, 0], [z0 / 4, 0], [z0 / 4, 1], [z1 / 4, 1]],
        );
        // end caps (only where no collinear continuation — doorway jambs)
        if (!this.hasWallV(x, z - 1)) {
          walls.quad(
            [x1, 0, z0], [x0, 0, z0], [x0, WALL_H, z0], [x1, WALL_H, z0],
            [0, 0, -1],
            [[x1 / 4, 0], [x0 / 4, 0], [x0 / 4, 1], [x1 / 4, 1]],
          );
        }
        if (!this.hasWallV(x, z + 1)) {
          walls.quad(
            [x0, 0, z1], [x1, 0, z1], [x1, WALL_H, z1], [x0, WALL_H, z1],
            [0, 0, 1],
            [[x0 / 4, 0], [x1 / 4, 0], [x1 / 4, 1], [x0 / 4, 1]],
          );
        }
      }
    }
    // Horizontal (east-west running) walls on cell north/south edges.
    for (let z = 0; z <= this.size; z++) {
      for (let x = 0; x < this.size; x++) {
        if (!this.hasWallH(x, z)) continue;
        const walls = wallBuilder(this.wallOwnerH[this.hIdx(x, z)]);
        const wz = this.worldZ(z) - CELL / 2;
        const x0 = this.worldX(x) - CELL / 2 - T;
        const x1 = this.worldX(x) + CELL / 2 + T;
        const z0 = wz - T, z1 = wz + T;
        walls.quad(
          [x1, 0, z0], [x0, 0, z0], [x0, WALL_H, z0], [x1, WALL_H, z0],
          [0, 0, -1],
          [[x1 / 4, 0], [x0 / 4, 0], [x0 / 4, 1], [x1 / 4, 1]],
        );
        walls.quad(
          [x0, 0, z1], [x1, 0, z1], [x1, WALL_H, z1], [x0, WALL_H, z1],
          [0, 0, 1],
          [[x0 / 4, 0], [x1 / 4, 0], [x1 / 4, 1], [x0 / 4, 1]],
        );
        if (!this.hasWallH(x - 1, z)) {
          walls.quad(
            [x0, 0, z0], [x0, 0, z1], [x0, WALL_H, z1], [x0, WALL_H, z0],
            [-1, 0, 0],
            [[z0 / 4, 0], [z1 / 4, 0], [z1 / 4, 1], [z0 / 4, 1]],
          );
        }
        if (!this.hasWallH(x + 1, z)) {
          walls.quad(
            [x1, 0, z1], [x1, 0, z0], [x1, WALL_H, z0], [x1, WALL_H, z1],
            [1, 0, 0],
            [[z1 / 4, 0], [z0 / 4, 0], [z0 / 4, 1], [z1 / 4, 1]],
          );
        }
      }
    }

    for (const [id, b] of wallBuilders) {
      const mesh = new THREE.Mesh(b.build(), wallMat(id));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
    }

    this.buildFixtures();
    this.buildFurniture();
    this.buildExit();

    scene.add(this.group);
  }

  private buildFixtures() {
    const n = this.fixtures.length;

    // Small dome-ish ceiling lamps (placeholders, like the furniture).
    const panelGeo = new THREE.PlaneGeometry(0.42, 0.42);
    panelGeo.rotateX(Math.PI / 2); // face down
    const panelMat = new THREE.MeshBasicMaterial({ map: makeLightPanelTexture() });
    this.panelMesh = new THREE.InstancedMesh(panelGeo, panelMat, n);

    const frameGeo = new THREE.CylinderGeometry(0.3, 0.34, 0.1, 12);
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x2a2620, roughness: 0.85 });
    const frameMesh = new THREE.InstancedMesh(frameGeo, frameMat, n);

    const m = new THREE.Matrix4();
    const col = new THREE.Color();
    for (const f of this.fixtures) {
      m.makeTranslation(f.pos.x, f.pos.y, f.pos.z);
      this.panelMesh.setMatrixAt(f.index, m);
      m.makeTranslation(f.pos.x, f.pos.y + 0.05, f.pos.z);
      frameMesh.setMatrixAt(f.index, m);
      if (f.state === "off") col.setRGB(0.012, 0.012, 0.01);
      else col.setRGB(f.base[0], f.base[1], f.base[2]); // HDR — feeds bloom
      this.panelMesh.setColorAt(f.index, col);
    }
    this.panelMesh.instanceMatrix.needsUpdate = true;
    if (this.panelMesh.instanceColor) this.panelMesh.instanceColor.needsUpdate = true;
    this.group.add(this.panelMesh, frameMesh);
  }

  setFixtureColor(index: number, r: number, g: number, b: number) {
    const col = new THREE.Color(r, g, b);
    this.panelMesh.setColorAt(index, col);
    if (this.panelMesh.instanceColor) this.panelMesh.instanceColor.needsUpdate = true;
  }

  /**
   * Placeholder boxes for every furniture entry in the plan. Untextured
   * wood-ish (metal for appliances) — GLTF models replace them in a later
   * phase, keyed by `furnitureById` / `FurnitureInstance.def.id`.
   */
  private buildFurniture() {
    const woodMat = new THREE.MeshStandardMaterial({ color: 0x6f5232, roughness: 0.85 });
    const darkWoodMat = new THREE.MeshStandardMaterial({ color: 0x4a3826, roughness: 0.9 });
    const metalMat = new THREE.MeshStandardMaterial({ color: 0x60646a, roughness: 0.55, metalness: 0.5 });
    const metalIds = new Set(["car", "fridge", "tool-cabinet", "garage-shelf", "tires"]);
    const darkIds = new Set(["fireplace", "tv-stand"]);

    for (const def of FURNITURE) {
      const rot = def.rotY ?? 0;
      const mat = metalIds.has(def.id) ? metalMat : darkIds.has(def.id) ? darkWoodMat : woodMat;
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(def.w, def.h, def.d), mat);
      mesh.position.set(
        hxToWorld(def.x + def.w / 2),
        def.h / 2,
        hzToWorld(def.z + def.d / 2),
      );
      mesh.rotation.y = rot;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      this.group.add(mesh);
      this.furniture.push({ def, mesh });
      this.furnitureById.set(def.id, mesh);
    }
  }

  private buildExit() {
    const facing = this.exit.facing;
    const angle = Math.atan2(facing.x, facing.z);

    const doorGroup = new THREE.Group();
    doorGroup.position.copy(this.exit.doorPos);
    doorGroup.rotation.y = angle;

    const doorMat = new THREE.MeshStandardMaterial({
      map: makeDoorTexture(this.seed),
      roughness: 0.55,
      metalness: 0.35,
    });
    const door = new THREE.Mesh(new THREE.BoxGeometry(1.15, 2.2, 0.09), doorMat);
    door.castShadow = true;
    doorGroup.add(door);

    const frameMat = new THREE.MeshStandardMaterial({ color: 0x2c2e2a, roughness: 0.7, metalness: 0.4 });
    const sideGeo = new THREE.BoxGeometry(0.09, 2.32, 0.14);
    const left = new THREE.Mesh(sideGeo, frameMat);
    left.position.set(-0.64, 0.05, 0);
    const right = new THREE.Mesh(sideGeo, frameMat);
    right.position.set(0.64, 0.05, 0);
    const top = new THREE.Mesh(new THREE.BoxGeometry(1.38, 0.1, 0.14), frameMat);
    top.position.set(0, 1.18, 0);
    doorGroup.add(left, right, top);

    const bar = new THREE.Mesh(
      new THREE.CylinderGeometry(0.025, 0.025, 0.9),
      new THREE.MeshStandardMaterial({ color: 0x8a8d86, roughness: 0.35, metalness: 0.8 }),
    );
    bar.rotation.z = Math.PI / 2;
    bar.position.set(0, -0.08, 0.09);
    doorGroup.add(bar);

    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(0.55, 0.2),
      new THREE.MeshBasicMaterial({
        map: makeExitSignTexture(),
        color: new THREE.Color(1.6, 1.6, 1.6),
      }),
    );
    sign.position.set(0, 1.45, 0.12);
    doorGroup.add(sign);

    const light = new THREE.PointLight(0x39ff63, 2.2, 7, 2);
    light.position.set(0, 1.35, 0.45);
    doorGroup.add(light);

    this.exit.door = door;
    this.exit.sign = sign;
    this.exit.light = light;
    this.group.add(doorGroup);
  }

  /* --------------------------- collision --------------------------- */

  /**
   * Push a circle (player/entity footprint) out of walls and blocking
   * furniture. Mutates and returns `p`.
   */
  collide(p: THREE.Vector3, radius: number): THREE.Vector3 {
    const c = this.cellOf(p.x, p.z);
    const T = WALL_HALF;

    const resolveBox = (minX: number, maxX: number, minZ: number, maxZ: number) => {
      const nx = Math.max(minX, Math.min(p.x, maxX));
      const nz = Math.max(minZ, Math.min(p.z, maxZ));
      const ddx = p.x - nx;
      const ddz = p.z - nz;
      const distSq = ddx * ddx + ddz * ddz;
      if (distSq < radius * radius) {
        if (distSq > 1e-9) {
          const dist = Math.sqrt(distSq);
          p.x = nx + (ddx / dist) * radius;
          p.z = nz + (ddz / dist) * radius;
        } else {
          const pushL = p.x - minX, pushR = maxX - p.x;
          const pushB = p.z - minZ, pushF = maxZ - p.z;
          const m = Math.min(pushL, pushR, pushB, pushF);
          if (m === pushL) p.x = minX - radius;
          else if (m === pushR) p.x = maxX + radius;
          else if (m === pushB) p.z = minZ - radius;
          else p.z = maxZ + radius;
        }
      }
    };

    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cx = c.x + dx, cz = c.z + dz;

        if (cx < 0 || cz < 0 || cx >= this.size || cz >= this.size) continue;

        // west edge wall of (cx,cz)
        if (this.hasWallV(cx, cz)) {
          const wx = this.worldX(cx) - CELL / 2;
          resolveBox(
            wx - T, wx + T,
            this.worldZ(cz) - CELL / 2 - T, this.worldZ(cz) + CELL / 2 + T,
          );
        }
        // east edge wall (west wall of cx+1)
        if (this.hasWallV(cx + 1, cz)) {
          const wx = this.worldX(cx) + CELL / 2;
          resolveBox(
            wx - T, wx + T,
            this.worldZ(cz) - CELL / 2 - T, this.worldZ(cz) + CELL / 2 + T,
          );
        }
        // north edge wall of (cx,cz)
        if (this.hasWallH(cx, cz)) {
          const wz = this.worldZ(cz) - CELL / 2;
          resolveBox(
            this.worldX(cx) - CELL / 2 - T, this.worldX(cx) + CELL / 2 + T,
            wz - T, wz + T,
          );
        }
        // south edge wall (north wall of cz+1)
        if (this.hasWallH(cx, cz + 1)) {
          const wz = this.worldZ(cz) + CELL / 2;
          resolveBox(
            this.worldX(cx) - CELL / 2 - T, this.worldX(cx) + CELL / 2 + T,
            wz - T, wz + T,
          );
        }
      }
    }

    // Blocking furniture placeholders (~50 boxes — cheap enough unindexed).
    for (const b of this.furnitureBoxes) {
      resolveBox(b.minX, b.maxX, b.minZ, b.maxZ);
    }
    return p;
  }

  /** Is this world-space point inside a wall or blocking furniture? (XZ) */
  solidAtWorld(px: number, pz: number): boolean {
    const c = this.cellOf(px, pz);
    if (this.cell(c.x, c.z) === SOLID) return true;
    const T = WALL_HALF;
    if (this.hasWallV(c.x, c.z) && px - (this.worldX(c.x) - CELL / 2) <= T) return true;
    if (this.hasWallV(c.x + 1, c.z) && (this.worldX(c.x) + CELL / 2) - px <= T) return true;
    if (this.hasWallH(c.x, c.z) && pz - (this.worldZ(c.z) - CELL / 2) <= T) return true;
    if (this.hasWallH(c.x, c.z + 1) && (this.worldZ(c.z) + CELL / 2) - pz <= T) return true;
    for (const b of this.furnitureBoxes) {
      if (px >= b.minX && px <= b.maxX && pz >= b.minZ && pz <= b.maxZ) return true;
    }
    return false;
  }

  /** Random reachable open cell at least `minDistFromSpawn` walking cells out. */
  randomOpenCell(rng: Rand, minDistFromSpawn = 0): { x: number; z: number } {
    const S = this.size;
    for (let i = 0; i < 400; i++) {
      const x = 1 + Math.floor(rng() * (S - 2));
      const z = 1 + Math.floor(rng() * (S - 2));
      const d = this.distFromSpawn[z * S + x];
      if (this.cell(x, z) === OPEN && d >= minDistFromSpawn) return { x, z };
    }
    return this.spawnCell;
  }

  /**
   * A random open cell at least `minDist` WALKING cells (wall-aware BFS)
   * from (cx, cz) — later kill-chain tiers walk in from far away. Falls
   * back to the farthest reachable cell if nothing is that far out.
   */
  distantCellFrom(
    from: { x: number; z: number },
    minDist: number,
    rng: Rand,
  ): { x: number; z: number } {
    const S = this.size;
    const dist = new Int32Array(S * S).fill(-1);
    const queue: number[] = [from.z * S + from.x];
    dist[queue[0]] = 0;
    let qi = 0;
    let best = queue[0];
    while (qi < queue.length) {
      const cur = queue[qi++];
      if (dist[cur] > dist[best]) best = cur;
      const cx = cur % S, cz = Math.floor(cur / S);
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (!this.canMove(cx, cz, dx, dz)) continue;
        const ni = (cz + dz) * S + (cx + dx);
        if (dist[ni] === -1) {
          dist[ni] = dist[cur] + 1;
          queue.push(ni);
        }
      }
    }
    const far = queue.filter((i) => dist[i] >= minDist);
    const pick = far.length > 0
      ? far[Math.floor(rng() * far.length)]
      : best;
    return { x: pick % S, z: Math.floor(pick / S) };
  }
}
