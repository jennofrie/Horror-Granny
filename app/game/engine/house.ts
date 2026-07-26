/**
 * THE HOUSE — fixed, hand-designed single-floor level (replaces the
 * procedural backrooms maze). Pure data + tiny coordinate helpers; no
 * three.js imports so later phases (items, hiding, AI) can consume the
 * plan without pulling in the renderer.
 *
 * Coordinate conventions
 * ----------------------
 * The plan is authored in HOUSE-LOCAL units: 1 unit = 1 grid cell = 1 m.
 * Origin is the NW corner of the house footprint; x grows east, z grows
 * south. The house is 60 x 44 m and sits inside a 64 x 64 cell grid at
 * offset (HOUSE_OX, HOUSE_OZ), so the footprint exactly covers world
 * x [-30, 30], z [-22, 22]. Everything outside the footprint is SOLID.
 *
 * Room rects are inclusive cell ranges: { x0, z0, x1, z1 }.
 * Doorways name a wall EDGE in house-local cells and clear a 2 m (2 cell)
 * opening in it:
 *   kind "V": vertical wall between (x-1,z) and (x,z) — clears z and z+1
 *   kind "H": horizontal wall between (x,z-1) and (x,z) — clears x and x+1
 *
 * Layout (60 wide x 44 deep):
 *
 *   z=0  ┌──────────┬─────────┬────────┬──────────────────┐
 *        │  garage  │ kitchen │ study  │     bedroom1     │
 *        │          ├─────────┼────────┤                  │
 *   z=10 │          │ dining  │ bed2   ├──────────┬───────┤
 *   z=12 │          │         │        │ bathroom │storage│
 *   z=19 ├──────────┴─────────┴────────┴──────────┴───────┤
 *        │                   hallway                      │
 *   z=22 ├──────────────┬────────────────┬────────────────┤
 *        │    living    │     foyer      │    bedroom3    │
 *   z=44 └──────────────┴──────front door┴────────────────┘
 */

export const GRID = 64; // cells per side (1 m cells)
export const HOUSE_OX = 2; // footprint offset inside the grid (cells)
export const HOUSE_OZ = 10;

/** House-local continuous meters -> world meters (matches Level.worldX/Z). */
export function hxToWorld(hx: number): number {
  return hx - 30;
}
export function hzToWorld(hz: number): number {
  return hz - 22;
}

export type FloorMatId = "wood" | "tile" | "concrete";
export type WallMatId =
  | "wp-cream"
  | "wp-sage"
  | "wp-blue"
  | "wp-rose"
  | "wp-green"
  | "plaster"
  | "tile"
  | "concrete";

export interface Lamp {
  /** house-local, meters (fractional ok) */
  x: number;
  z: number;
  /** default "on"; "off" = burnt out, "flicker" = dying */
  state?: "on" | "off" | "flicker";
}

export interface RoomDef {
  id: string;
  name: string;
  /** inclusive cell rect, house-local */
  rect: { x0: number; z0: number; x1: number; z1: number };
  floor: FloorMatId;
  wall: WallMatId;
  lamps: Lamp[];
}

export interface DoorwayDef {
  kind: "V" | "H";
  x: number;
  z: number;
  /** rooms it connects (documentation / validation only) */
  between: [string, string];
}

export interface FurnitureDef {
  id: string;
  name: string;
  room: string;
  /** house-local AABB: min corner + size, meters */
  x: number;
  z: number;
  w: number;
  d: number;
  /** box height, meters */
  h: number;
  /** yaw for the eventual GLTF swap-in; placeholder boxes are axis-aligned */
  rotY?: number;
  /** blocks movement (collision AABB). LOS ignores furniture — documented in level.ts */
  blocking: boolean;
}

export interface ItemSpawnDef {
  id: string;
  type: "weapon" | "ammo" | "key";
  /** item key, e.g. "axe", "handgun", "ammo-9mm", "key-frontdoor" */
  item: string;
  room: string;
  /** house-local; y is a resting height (table top, shelf, floor) */
  pos: { x: number; y: number; z: number };
}

export interface HidingSpotDef {
  id: string;
  kind: "wardrobe" | "under-bed";
  room: string;
  /** house-local floor position */
  pos: { x: number; y: number; z: number };
  /** facing of the spot's opening: (sin(yaw), 0, cos(yaw)) */
  yaw: number;
}

/* ------------------------------- rooms ------------------------------- */

export const ROOMS: RoomDef[] = [
  {
    id: "garage",
    name: "Garage",
    rect: { x0: 0, z0: 0, x1: 13, z1: 18 },
    floor: "concrete",
    wall: "concrete",
    lamps: [
      { x: 6.5, z: 5, state: "on" },
      { x: 6.5, z: 14, state: "off" },
    ],
  },
  {
    id: "kitchen",
    name: "Kitchen",
    rect: { x0: 14, z0: 0, x1: 26, z1: 9 },
    floor: "tile",
    wall: "plaster",
    lamps: [{ x: 20, z: 4.5, state: "on" }],
  },
  {
    id: "dining",
    name: "Dining Room",
    rect: { x0: 14, z0: 10, x1: 26, z1: 18 },
    floor: "wood",
    wall: "wp-rose",
    lamps: [{ x: 20, z: 14, state: "on" }],
  },
  {
    id: "study",
    name: "Study",
    rect: { x0: 27, z0: 0, x1: 38, z1: 9 },
    floor: "wood",
    wall: "wp-green",
    lamps: [{ x: 32.5, z: 4.5, state: "on" }],
  },
  {
    id: "bedroom2",
    name: "Bedroom 2",
    rect: { x0: 27, z0: 10, x1: 38, z1: 18 },
    floor: "wood",
    wall: "wp-cream",
    lamps: [{ x: 32.5, z: 14, state: "on" }],
  },
  {
    id: "bedroom1",
    name: "Master Bedroom",
    rect: { x0: 39, z0: 0, x1: 59, z1: 11 },
    floor: "wood",
    wall: "wp-blue",
    lamps: [
      { x: 44, z: 5.5, state: "on" },
      { x: 54, z: 5.5, state: "off" },
    ],
  },
  {
    id: "bathroom",
    name: "Bathroom",
    rect: { x0: 39, z0: 12, x1: 48, z1: 18 },
    floor: "tile",
    wall: "tile",
    lamps: [{ x: 43.5, z: 15, state: "on" }],
  },
  {
    id: "storage",
    name: "Storage Room",
    rect: { x0: 49, z0: 12, x1: 59, z1: 18 },
    floor: "concrete",
    wall: "plaster",
    lamps: [{ x: 54, z: 15, state: "off" }],
  },
  {
    id: "hallway",
    name: "Hallway",
    rect: { x0: 0, z0: 19, x1: 59, z1: 21 },
    floor: "wood",
    wall: "wp-cream",
    lamps: [
      { x: 8, z: 20, state: "on" },
      { x: 24, z: 20, state: "on" },
      { x: 40, z: 20, state: "flicker" },
      { x: 54, z: 20, state: "off" },
    ],
  },
  {
    id: "living",
    name: "Living Room",
    rect: { x0: 0, z0: 22, x1: 19, z1: 43 },
    floor: "wood",
    wall: "wp-sage",
    lamps: [
      { x: 9.5, z: 28, state: "on" },
      { x: 9.5, z: 37, state: "on" },
    ],
  },
  {
    id: "foyer",
    name: "Foyer",
    rect: { x0: 20, z0: 22, x1: 39, z1: 43 },
    floor: "wood",
    wall: "wp-cream",
    lamps: [
      { x: 29.5, z: 28, state: "on" },
      { x: 29.5, z: 38, state: "on" },
    ],
  },
  {
    id: "bedroom3",
    name: "Bedroom 3",
    rect: { x0: 40, z0: 22, x1: 59, z1: 43 },
    floor: "wood",
    wall: "wp-sage",
    lamps: [
      { x: 49.5, z: 27, state: "on" },
      { x: 49.5, z: 38, state: "flicker" },
    ],
  },
];

/* ------------------------------ doorways ------------------------------ */
// Every room has at least one doorway; key rooms have two or more so
// chases can loop (garage 3, dining 3, master bedroom 3, living 3, foyer 4).

export const DOORWAYS: DoorwayDef[] = [
  { kind: "V", x: 14, z: 4, between: ["garage", "kitchen"] },
  { kind: "V", x: 14, z: 13, between: ["garage", "dining"] },
  { kind: "V", x: 27, z: 4, between: ["kitchen", "study"] },
  { kind: "V", x: 27, z: 13, between: ["dining", "bedroom2"] },
  { kind: "V", x: 39, z: 4, between: ["study", "bedroom1"] },
  { kind: "V", x: 20, z: 27, between: ["living", "foyer"] },
  { kind: "V", x: 20, z: 36, between: ["living", "foyer"] },
  { kind: "V", x: 40, z: 27, between: ["foyer", "bedroom3"] },
  { kind: "H", x: 19, z: 10, between: ["kitchen", "dining"] },
  { kind: "H", x: 31, z: 10, between: ["study", "bedroom2"] },
  { kind: "H", x: 42, z: 12, between: ["bedroom1", "bathroom"] },
  { kind: "H", x: 53, z: 12, between: ["bedroom1", "storage"] },
  { kind: "H", x: 5, z: 19, between: ["garage", "hallway"] },
  { kind: "H", x: 19, z: 19, between: ["dining", "hallway"] },
  { kind: "H", x: 31, z: 19, between: ["bedroom2", "hallway"] },
  { kind: "H", x: 41, z: 19, between: ["bathroom", "hallway"] },
  { kind: "H", x: 53, z: 19, between: ["storage", "hallway"] },
  { kind: "H", x: 8, z: 22, between: ["hallway", "living"] },
  { kind: "H", x: 24, z: 22, between: ["hallway", "foyer"] },
  { kind: "H", x: 34, z: 22, between: ["hallway", "foyer"] },
  { kind: "H", x: 50, z: 22, between: ["hallway", "bedroom3"] },
];

/**
 * The front door: on the foyer's south wall, centered on cells x=29..30.
 * It stays a WALL (locked) — this only tells the Level where to build the
 * door mesh. `cell` is the foyer cell touching the door, `facing` points
 * outward (south).
 */
export const FRONT_DOOR = {
  cell: { x: 29, z: 43 },
  facing: { x: 0, z: 1 },
};

/** Player spawn: mid-foyer, facing the house interior. */
export const PLAYER_SPAWN = { x: 30, z: 38 };
/** Entity spawn: deep in the garage, diagonally opposite the foyer. */
export const ENTITY_SPAWN = { x: 6, z: 9 };

/* ------------------------------ furniture ------------------------------ */
// Placeholder colliders + boxes; GLTF models replace these in a later
// phase via the stable `id` keys.

export const FURNITURE: FurnitureDef[] = [
  // garage
  { id: "workbench", name: "Workbench", room: "garage", x: 4, z: 0.4, w: 5, d: 1.2, h: 0.95, blocking: true },
  { id: "garage-shelf", name: "Metal Shelf", room: "garage", x: 12.6, z: 5, w: 1.2, d: 4, h: 1.8, blocking: true },
  { id: "tool-cabinet", name: "Tool Cabinet", room: "garage", x: 0.3, z: 7, w: 0.9, d: 3, h: 1.6, blocking: true },
  { id: "car", name: "Old Car", room: "garage", x: 3.5, z: 11.5, w: 4.6, d: 1.9, h: 1.35, blocking: true },
  { id: "tires", name: "Tire Stack", room: "garage", x: 12.5, z: 14.5, w: 1.1, d: 1.1, h: 0.8, blocking: true },
  { id: "garage-crates", name: "Crates", room: "garage", x: 0.4, z: 15, w: 1.4, d: 1.4, h: 0.9, blocking: true },
  // kitchen
  { id: "kitchen-counter", name: "Kitchen Counter", room: "kitchen", x: 14.3, z: 0.3, w: 12.4, d: 0.9, h: 0.95, blocking: true },
  { id: "kitchen-island", name: "Kitchen Island", room: "kitchen", x: 19, z: 4.5, w: 3, d: 1.2, h: 0.95, blocking: true },
  { id: "fridge", name: "Fridge", room: "kitchen", x: 25.9, z: 7.5, w: 0.9, d: 0.9, h: 1.9, blocking: true },
  // dining
  { id: "dining-table", name: "Dining Table", room: "dining", x: 17.5, z: 12.5, w: 5, d: 1.8, h: 0.78, blocking: true },
  { id: "dining-chair-1", name: "Chair", room: "dining", x: 18.5, z: 11.7, w: 0.5, d: 0.5, h: 1, blocking: true },
  { id: "dining-chair-2", name: "Chair", room: "dining", x: 21, z: 11.7, w: 0.5, d: 0.5, h: 1, blocking: true },
  { id: "dining-chair-3", name: "Chair", room: "dining", x: 18.5, z: 14.5, w: 0.5, d: 0.5, h: 1, blocking: true },
  { id: "dining-chair-4", name: "Chair", room: "dining", x: 21, z: 14.5, w: 0.5, d: 0.5, h: 1, blocking: true },
  { id: "sideboard", name: "Sideboard", room: "dining", x: 14.3, z: 15.5, w: 0.7, d: 3, h: 1.1, blocking: true },
  // study
  { id: "study-desk", name: "Desk", room: "study", x: 31, z: 2.5, w: 2.6, d: 1.2, h: 0.78, blocking: true },
  { id: "office-chair", name: "Office Chair", room: "study", x: 31.8, z: 4.2, w: 0.6, d: 0.6, h: 1, blocking: true },
  { id: "study-bookshelf-a", name: "Bookshelf", room: "study", x: 27.3, z: 6.5, w: 0.6, d: 3, h: 2.1, blocking: true },
  { id: "study-bookshelf-b", name: "Bookshelf", room: "study", x: 37.4, z: 2, w: 0.6, d: 3, h: 2.1, blocking: true },
  { id: "study-armchair", name: "Armchair", room: "study", x: 29.5, z: 7.5, w: 1.1, d: 1.1, h: 0.9, blocking: true },
  // master bedroom
  { id: "bed1-bed", name: "Double Bed", room: "bedroom1", x: 47, z: 2, w: 2.2, d: 3.4, h: 0.6, blocking: true },
  { id: "bed1-nightstand", name: "Nightstand", room: "bedroom1", x: 45.8, z: 2.2, w: 0.9, d: 0.9, h: 0.6, blocking: true },
  { id: "bed1-wardrobe", name: "Wardrobe", room: "bedroom1", x: 57.6, z: 0.4, w: 1.4, d: 2.2, h: 2.2, blocking: true },
  { id: "bed1-dresser", name: "Dresser", room: "bedroom1", x: 51, z: 0.4, w: 2.4, d: 0.7, h: 0.95, blocking: true },
  // bathroom
  { id: "bathtub", name: "Bathtub", room: "bathroom", x: 39.3, z: 15.5, w: 1.1, d: 2.2, h: 0.6, blocking: true },
  { id: "bath-sink", name: "Sink Cabinet", room: "bathroom", x: 39.5, z: 12.3, w: 1.1, d: 0.6, h: 0.85, blocking: true },
  { id: "toilet", name: "Toilet", room: "bathroom", x: 45.5, z: 12.3, w: 0.55, d: 0.75, h: 0.75, blocking: true },
  // storage
  { id: "storage-shelf-a", name: "Shelf", room: "storage", x: 49.3, z: 12.4, w: 0.8, d: 4, h: 1.9, blocking: true },
  { id: "storage-shelf-b", name: "Shelf", room: "storage", x: 52.5, z: 12.4, w: 0.8, d: 4, h: 1.9, blocking: true },
  { id: "storage-crates", name: "Crates", room: "storage", x: 55.5, z: 13.5, w: 1.4, d: 1.4, h: 0.9, blocking: true },
  { id: "storage-wardrobe", name: "Wardrobe", room: "storage", x: 58.2, z: 15.5, w: 1.4, d: 2.2, h: 2.2, blocking: true },
  // bedroom 2
  { id: "bed2-bed", name: "Bed", room: "bedroom2", x: 33, z: 14, w: 2.2, d: 3.2, h: 0.6, blocking: true },
  { id: "bed2-wardrobe", name: "Wardrobe", room: "bedroom2", x: 27.3, z: 15.8, w: 1.3, d: 2.2, h: 2.2, blocking: true },
  { id: "bed2-desk", name: "Desk", room: "bedroom2", x: 34.5, z: 17.3, w: 2.4, d: 0.8, h: 0.78, blocking: true },
  // bedroom 3
  { id: "bed3-bed", name: "Double Bed", room: "bedroom3", x: 47, z: 25, w: 2.4, d: 3.4, h: 0.6, blocking: true },
  { id: "bed3-wardrobe-a", name: "Wardrobe", room: "bedroom3", x: 40.3, z: 40.5, w: 1.4, d: 2.2, h: 2.2, blocking: true },
  { id: "bed3-wardrobe-b", name: "Wardrobe", room: "bedroom3", x: 57.6, z: 40.5, w: 1.4, d: 2.2, h: 2.2, blocking: true },
  { id: "bed3-dresser", name: "Dresser", room: "bedroom3", x: 52, z: 22.4, w: 2.4, d: 0.7, h: 0.95, blocking: true },
  { id: "bed3-armchair", name: "Armchair", room: "bedroom3", x: 42, z: 24.5, w: 1.1, d: 1.1, h: 0.9, blocking: true },
  // living room
  { id: "sofa", name: "Sofa", room: "living", x: 3, z: 28, w: 4.5, d: 1.6, h: 0.85, blocking: true },
  { id: "loveseat", name: "Loveseat", room: "living", x: 10, z: 33.5, w: 3, d: 1.5, h: 0.85, blocking: true },
  { id: "coffee-table", name: "Coffee Table", room: "living", x: 4.5, z: 30.5, w: 2, d: 1, h: 0.45, blocking: true },
  { id: "tv-stand", name: "TV Stand", room: "living", x: 3, z: 22.4, w: 3, d: 0.6, h: 0.6, blocking: true },
  { id: "living-bookshelf", name: "Bookshelf", room: "living", x: 18.4, z: 30, w: 0.6, d: 4, h: 2, blocking: true },
  { id: "living-armchair", name: "Armchair", room: "living", x: 12.5, z: 27, w: 1.1, d: 1.1, h: 0.9, blocking: true },
  { id: "fireplace", name: "Fireplace", room: "living", x: 0.2, z: 33, w: 0.8, d: 3, h: 1.3, blocking: true },
  // hallway
  { id: "hall-console", name: "Console Table", room: "hallway", x: 15, z: 19.25, w: 2, d: 0.5, h: 0.85, blocking: true },
  // foyer
  { id: "foyer-bench", name: "Bench", room: "foyer", x: 24, z: 41.5, w: 2.6, d: 0.8, h: 0.5, blocking: true },
  { id: "foyer-console", name: "Console Table", room: "foyer", x: 38.4, z: 37, w: 0.6, d: 2.4, h: 0.85, blocking: true },
  { id: "foyer-plant", name: "Potted Plant", room: "foyer", x: 21, z: 23, w: 0.6, d: 0.6, h: 1.4, blocking: true },
];

/* ------------------------- item spawn candidates ------------------------ */
// Typed points for a later items phase — each in a room that fits the
// fiction (axe in the garage, handgun in the study, …). `y` is the resting
// height of the surface they sit on.

export const ITEM_SPAWNS: ItemSpawnDef[] = [
  { id: "spawn-axe", type: "weapon", item: "axe", room: "garage", pos: { x: 6, y: 0.98, z: 1 } },
  { id: "spawn-handgun", type: "weapon", item: "handgun", room: "study", pos: { x: 32, y: 0.82, z: 3.1 } },
  { id: "spawn-ammo-study", type: "ammo", item: "ammo-9mm", room: "study", pos: { x: 37.7, y: 1.4, z: 3.5 } },
  { id: "spawn-ammo-bed1", type: "ammo", item: "ammo-9mm", room: "bedroom1", pos: { x: 52, y: 0.98, z: 0.75 } },
  { id: "spawn-ammo-garage", type: "ammo", item: "ammo-9mm", room: "garage", pos: { x: 13, y: 1.2, z: 7 } },
  { id: "spawn-shovel", type: "weapon", item: "shovel", room: "storage", pos: { x: 51, y: 0.9, z: 16.5 } },
  { id: "spawn-key-kitchen", type: "key", item: "key-frontdoor", room: "kitchen", pos: { x: 20, y: 0.98, z: 0.75 } },
  { id: "spawn-key-storage", type: "key", item: "key-frontdoor", room: "storage", pos: { x: 56, y: 0.95, z: 14 } },
  { id: "spawn-key-bathroom", type: "key", item: "key-frontdoor", room: "bathroom", pos: { x: 40, y: 0.9, z: 12.6 } },
];

/* ------------------------------ hiding spots ---------------------------- */

export const HIDING_SPOTS: HidingSpotDef[] = [
  { id: "hide-bed1-wardrobe", kind: "wardrobe", room: "bedroom1", pos: { x: 58.3, y: 0, z: 1.5 }, yaw: -Math.PI / 2 },
  { id: "hide-bed1-underbed", kind: "under-bed", room: "bedroom1", pos: { x: 48.1, y: 0, z: 3.7 }, yaw: 0 },
  { id: "hide-bed2-wardrobe", kind: "wardrobe", room: "bedroom2", pos: { x: 27.95, y: 0, z: 16.9 }, yaw: Math.PI / 2 },
  { id: "hide-bed2-underbed", kind: "under-bed", room: "bedroom2", pos: { x: 34.1, y: 0, z: 15.6 }, yaw: 0 },
  { id: "hide-bed3-wardrobe-a", kind: "wardrobe", room: "bedroom3", pos: { x: 41, y: 0, z: 41.6 }, yaw: Math.PI / 2 },
  { id: "hide-bed3-wardrobe-b", kind: "wardrobe", room: "bedroom3", pos: { x: 58.3, y: 0, z: 41.6 }, yaw: -Math.PI / 2 },
  { id: "hide-bed3-underbed", kind: "under-bed", room: "bedroom3", pos: { x: 48.2, y: 0, z: 26.7 }, yaw: 0 },
  { id: "hide-storage-wardrobe", kind: "wardrobe", room: "storage", pos: { x: 58.9, y: 0, z: 16.6 }, yaw: -Math.PI / 2 },
];
