import * as THREE from "three";
import { Level } from "./level";
import { loadGLTF } from "./gltf";
import { mulberry32, shuffle } from "./rng";
import { AMMO_PER_BOX, WEAPONS, WeaponId } from "./weapons";
import { HideSpotState } from "./hiding";

export type Interactable =
  | { type: "pickup"; index: number; label: string }
  | { type: "hiding"; index: number; label: string }
  | { type: "door"; label: string };

/** A weapon or ammo crate floating/spinning in the world, waiting for [E]. */
export interface Pickup {
  spawnId: string;
  kind: "weapon" | "ammo";
  /** weapon id or "ammo-9mm" */
  item: string;
  label: string;
  group: THREE.Group;
  basePos: THREE.Vector3;
  phase: number;
  taken: boolean;
  /** cloned materials, emissive-pulsed so pickups read in the dark */
  mats: THREE.MeshStandardMaterial[];
}

/** item id -> GLTF slug for pickup models */
const PICKUP_SLUGS: Record<string, string> = {
  handgun: "handgun",
  axe: "axe",
  shovel: "shovel",
  "ammo-9mm": "ammo-box",
};
/** pickup model size (longest axis, meters) when not a configured weapon */
const PICKUP_FALLBACK_SIZE = 0.38;

export class Items {
  pickups: Pickup[] = [];
  exitOpen = false;
  /** the kill chain released the front door (devil is dead) */
  exitUnlocked = false;

  private doorSwing = 0;
  private beyondLight!: THREE.PointLight;
  private beyondGlow!: THREE.Mesh;
  private vTo = new THREE.Vector3(); // scratch — called every frame

  constructor(
    private level: Level,
    seed: number,
    scene: THREE.Scene,
    private hideSpots: HideSpotState[] = [],
  ) {
    // --- pickups: weapons at their fixed fiction spots, ammo at a
    // seeded 2-3 of the candidates. Key candidates stay unused — the exit
    // unlocks via the kill chain (devil death), not a key-door mechanic.
    const rng = mulberry32(seed ^ 0x9e3779b9);
    const weaponSpawns = this.level.itemSpawns.filter((s) => s.type === "weapon");
    const ammoCands = shuffle(
      rng,
      this.level.itemSpawns.filter((s) => s.type === "ammo"),
    );
    const ammoCount = Math.min(ammoCands.length, 2 + Math.floor(rng() * 2)); // 2-3
    for (const s of [...weaponSpawns, ...ammoCands.slice(0, ammoCount)]) {
      const isWeapon = s.type === "weapon";
      const label = isWeapon
        ? (WEAPONS[s.item as WeaponId]?.pickupName ?? `TAKE ${s.item.toUpperCase()}`)
        : `TAKE 9MM AMMO (${AMMO_PER_BOX})`;
      const group = new THREE.Group();
      group.position.copy(s.pos);
      scene.add(group);
      const pickup: Pickup = {
        spawnId: s.id,
        kind: s.type as "weapon" | "ammo",
        item: s.item,
        label,
        group,
        basePos: s.pos.clone(),
        phase: rng() * 10,
        taken: false,
        mats: [],
      };
      this.pickups.push(pickup);
      this.loadPickupModel(pickup);
    }

    // The white unknown waiting behind the exit door.
    const facing = this.level.exit.facing;
    const behind = this.level.exit.doorPos.clone().addScaledVector(facing, -0.6);
    this.beyondGlow = new THREE.Mesh(
      new THREE.PlaneGeometry(2.2, 3),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(1.7, 1.7, 1.55) }),
    );
    this.beyondGlow.position.set(behind.x, 1.4, behind.z);
    this.beyondGlow.lookAt(
      this.level.exit.doorPos.clone().addScaledVector(facing, 2),
    );
    this.beyondGlow.visible = false;
    scene.add(this.beyondGlow);

    this.beyondLight = new THREE.PointLight(0xfff8e8, 0, 9, 1.6);
    this.beyondLight.position.set(
      this.level.exit.doorPos.x + facing.x,
      1.6,
      this.level.exit.doorPos.z + facing.z,
    );
    scene.add(this.beyondLight);
  }

  /**
   * Async fire-and-forget GLTF load for a pickup (the engine prewarms the
   * cache, so this resolves fast). Normalized like the weapon viewmodels:
   * longest axis to size, centered, feet on the group's y=0 so the item
   * rests on whatever surface the spawn point marks.
   */
  private loadPickupModel(pickup: Pickup) {
    const slug = PICKUP_SLUGS[pickup.item];
    if (!slug) return;
    const size =
      pickup.kind === "weapon"
        ? (WEAPONS[pickup.item as WeaponId]?.pickupSize ?? PICKUP_FALLBACK_SIZE)
        : PICKUP_FALLBACK_SIZE;
    void loadGLTF(`./assets/models/${slug}/scene.glb`)
      .then((gltf) => {
        if (pickup.taken) return;
        const root = gltf.scene.clone(true);
        const box = new THREE.Box3().setFromObject(root);
        const dim = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const s = size / Math.max(dim.x, dim.y, dim.z, 1e-6);
        root.scale.setScalar(s);
        root.position.set(-center.x * s, -box.min.y * s, -center.z * s);
        root.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh) return;
          mesh.castShadow = false;
          // Clone materials (the GLTF cache shares them) so the emissive
          // pulse doesn't leak into every instance of the model.
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          const cloned = mats.map((m) => {
            const c = m.clone() as THREE.MeshStandardMaterial;
            if ("emissive" in c) {
              c.emissive = new THREE.Color(0xffe0a0);
              c.emissiveIntensity = 0.1;
              pickup.mats.push(c);
            }
            return c;
          });
          mesh.material = Array.isArray(mesh.material) ? cloned : cloned[0];
        });
        pickup.group.add(root);
      })
      .catch((err) => console.error(`failed to load pickup ${slug}:`, err));
  }

  /** Cheap cone test — what the player could grab right now. */
  findInteractable(camPos: THREE.Vector3, camDir: THREE.Vector3): Interactable | null {
    for (let i = 0; i < this.pickups.length; i++) {
      const p = this.pickups[i];
      if (p.taken) continue;
      const to = this.vTo.subVectors(p.group.position, camPos);
      const d = to.length();
      if (d < 2.4 && to.normalize().dot(camDir) > 0.72) {
        return { type: "pickup", index: i, label: p.label };
      }
    }
    for (let i = 0; i < this.hideSpots.length; i++) {
      const s = this.hideSpots[i];
      if (s.occupied) continue;
      const to = this.vTo.subVectors(s.anchor, camPos);
      const d = to.length();
      // generous cone — you face a big piece of furniture, not a page
      const need = s.def.kind === "wardrobe" ? 0.5 : 0.32;
      if (d < 2.5 && to.normalize().dot(camDir) > need) {
        return {
          type: "hiding",
          index: i,
          label: s.def.kind === "wardrobe" ? "HIDE IN WARDROBE" : "HIDE UNDER BED",
        };
      }
    }
    const toDoor = this.vTo.subVectors(this.level.exit.doorPos, camPos);
    const dd = toDoor.length();
    if (dd < 3 && toDoor.normalize().dot(camDir) > 0.7) {
      return this.exitUnlocked
        ? { type: "door", label: this.exitOpen ? "ESCAPE" : "PUSH THE DOOR" }
        : { type: "door", label: "LOCKED — SOMETHING HOLDS IT SHUT" };
    }
    return null;
  }

  /** [E] on a weapon/ammo pickup — the engine feeds it to the inventory. */
  takePickup(index: number): Pickup {
    const p = this.pickups[index];
    p.taken = true;
    p.group.visible = false;
    return p;
  }

  openExit() {
    if (this.exitOpen) return;
    this.exitOpen = true;
    this.beyondGlow.visible = true;
    this.beyondLight.intensity = 9;
  }

  update(dt: number, time: number) {
    // Pickups hover and turn slowly, glowing faintly — "thing", not
    // "furniture", at the edge of the torch cone.
    for (const p of this.pickups) {
      if (p.taken) continue;
      p.group.rotation.y = time * 0.9 + p.phase;
      p.group.position.y = p.basePos.y + 0.07 + Math.sin(time * 2 + p.phase) * 0.03;
      const glow = 0.08 + (Math.sin(time * 2.1 + p.phase) + 1) * 0.06;
      for (const m of p.mats) m.emissiveIntensity = glow;
    }

    // Door swings open once the player pushes it.
    if (this.exitOpen && this.doorSwing < 1) {
      this.doorSwing = Math.min(1, this.doorSwing + dt * 0.8);
      const ease = 1 - Math.pow(1 - this.doorSwing, 3);
      this.level.exit.door.rotation.y = -ease * 1.9;
      this.level.exit.door.position.x = -Math.sin(ease * 1.9) * 0.55;
      this.level.exit.door.position.z = -(1 - Math.cos(ease * 1.9)) * 0.55;
    }

    // Pulse the exit light once the kill chain has released the door.
    if (this.exitUnlocked && !this.exitOpen) {
      this.level.exit.light.intensity = 5 + Math.sin(time * 3.2) * 2.4;
    }
  }
}
