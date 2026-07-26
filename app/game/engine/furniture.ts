import * as THREE from "three";
import { Level } from "./level";
import { hxToWorld, hzToWorld } from "./house";
import { loadGLTF } from "./gltf";

/* -------------------------------------------------------------------------
 * Furniture GLTF swap-in (P5): the plan's placeholder boxes are replaced by
 * real models, keyed by the stable furniture ids. Colliders are untouched —
 * the AABBs from the plan still drive collide()/solidAtWorld, only the
 * placeholder mesh is hidden. Placement fits the model into the def's AABB
 * (uniform scale, aspect preserved) and yaws it to face the room.
 * ------------------------------------------------------------------------- */

interface FurnSpec {
  slug: string;
  /** yaw of the placed model, rad — 0 faces the model's authored front to +Z */
  yaw: number;
  /** contain = fit the whole bbox in the AABB; footprint = fit XZ only */
  fit: "contain" | "footprint";
}

const PI = Math.PI;

/** slugs prewarmed by the engine so the swap resolves without a hitch */
export const FURNITURE_SLUGS = [
  "wardrobe",
  "bed",
  "sofa",
  "table",
  "chair",
  "bookshelf",
  "fridge",
];

const SPECS: Record<string, FurnSpec> = {
  // --- the 8 hiding spots (wardrobes face their HIDING_SPOTS yaw)
  "bed1-wardrobe": { slug: "wardrobe", yaw: -PI / 2, fit: "contain" },
  "storage-wardrobe": { slug: "wardrobe", yaw: -PI / 2, fit: "contain" },
  "bed2-wardrobe": { slug: "wardrobe", yaw: PI / 2, fit: "contain" },
  "bed3-wardrobe-a": { slug: "wardrobe", yaw: PI / 2, fit: "contain" },
  "bed3-wardrobe-b": { slug: "wardrobe", yaw: -PI / 2, fit: "contain" },
  "bed1-bed": { slug: "bed", yaw: 0, fit: "footprint" },
  "bed2-bed": { slug: "bed", yaw: 0, fit: "footprint" },
  "bed3-bed": { slug: "bed", yaw: 0, fit: "footprint" },
  // --- other placeholders with a downloaded model on disk
  sofa: { slug: "sofa", yaw: PI, fit: "footprint" },
  loveseat: { slug: "sofa", yaw: -PI / 2, fit: "footprint" },
  "dining-table": { slug: "table", yaw: 0, fit: "footprint" },
  "dining-chair-1": { slug: "chair", yaw: 0, fit: "footprint" },
  "dining-chair-2": { slug: "chair", yaw: 0, fit: "footprint" },
  "dining-chair-3": { slug: "chair", yaw: PI, fit: "footprint" },
  "dining-chair-4": { slug: "chair", yaw: PI, fit: "footprint" },
  "office-chair": { slug: "chair", yaw: PI, fit: "footprint" },
  "study-bookshelf-a": { slug: "bookshelf", yaw: PI / 2, fit: "contain" },
  "study-bookshelf-b": { slug: "bookshelf", yaw: -PI / 2, fit: "contain" },
  "living-bookshelf": { slug: "bookshelf", yaw: -PI / 2, fit: "contain" },
  fridge: { slug: "fridge", yaw: -PI / 2, fit: "contain" },
};

/**
 * Fire-and-forget: each mapped placeholder swaps for its model as the GLB
 * lands (the cache is prewarmed, so these resolve within a frame or two).
 */
export function loadFurnitureModels(level: Level) {
  for (const inst of level.furniture) {
    const spec = SPECS[inst.def.id];
    if (!spec) continue;
    const def = inst.def;
    void loadGLTF(`./assets/models/${spec.slug}/scene.glb`)
      .then((gltf) => {
        const root = gltf.scene.clone(true);
        const box = new THREE.Box3().setFromObject(root);
        const dim = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        // AABB dims in the model's rotated frame (90° yaw swaps footprint)
        const swap = Math.abs(Math.sin(spec.yaw)) > 0.5;
        const aw = swap ? def.d : def.w;
        const ad = swap ? def.w : def.d;
        const s =
          spec.fit === "contain"
            ? Math.min(aw / dim.x, def.h / dim.y, ad / dim.z)
            : Math.min(aw / dim.x, ad / dim.z);
        root.scale.setScalar(s);
        root.position.set(-center.x * s, -box.min.y * s, -center.z * s);
        const g = new THREE.Group();
        g.add(root);
        g.rotation.y = spec.yaw;
        g.position.set(hxToWorld(def.x + def.w / 2), 0, hzToWorld(def.z + def.d / 2));
        g.traverse((o) => {
          if ((o as THREE.Mesh).isMesh) {
            o.castShadow = true;
            o.receiveShadow = true;
          }
        });
        level.group.add(g);
        inst.mesh.visible = false; // collider AABB stays — visual only
      })
      .catch((err) => console.error(`failed to load furniture ${spec.slug}:`, err));
  }
}
