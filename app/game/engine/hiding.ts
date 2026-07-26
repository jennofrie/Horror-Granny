import * as THREE from "three";
import { Level, HidingSpot } from "./level";

/* -------------------------------------------------------------------------
 * Hiding spots (P5): wardrobes and under-beds the player can climb into.
 * This module is a small state bag + geometry helpers; the gameplay flow
 * (enter/exit, caught-entering, input gating) lives in Engine, and the AI
 * side (spot checks, search paranoia) in Enemy.
 * ------------------------------------------------------------------------- */

/** eye height while hidden, meters off the floor */
export const SPOT_EYE: Record<HidingSpot["kind"], number> = {
  wardrobe: 1.5,
  "under-bed": 0.35,
};

/** seconds the climb-out takes — no pop-in/out cheese */
export const HIDE_EXIT_TIME = 0.5;

/** how far in front of the opening the player lands on exit */
const EXIT_CLEARANCE: Record<HidingSpot["kind"], number> = {
  wardrobe: 1.15,
  "under-bed": 1.9,
};

/** enemy stand-off when checking a spot (in front of the opening) */
export const CHECK_STANDOFF: Record<HidingSpot["kind"], number> = {
  wardrobe: 1.3,
  "under-bed": 2.0,
};

/** Runtime state of one spot. `occupied` is read by the AI mid-check. */
export class HideSpotState {
  /** aim point for the interactable cone test (spot pos raised to eye level) */
  readonly anchor: THREE.Vector3;
  occupied = false;

  constructor(readonly def: HidingSpot) {
    this.anchor = def.pos
      .clone()
      .add(new THREE.Vector3(0, def.kind === "wardrobe" ? 1.2 : 0.3, 0));
  }

  get eyeY(): number {
    return SPOT_EYE[this.def.kind];
  }

  /** unit vector the opening faces: (sin(yaw), 0, cos(yaw)) */
  facing(out: THREE.Vector3): THREE.Vector3 {
    return out.set(Math.sin(this.def.yaw), 0, Math.cos(this.def.yaw));
  }
}

export class Hiding {
  readonly spots: HideSpotState[];
  /** the spot the player is currently in (also true during the exit lerp) */
  active: HideSpotState | null = null;
  /** >0 while the climb-out lerp runs */
  exitT = 0;
  exitFrom = new THREE.Vector3();
  exitTo = new THREE.Vector3();
  /** flashlight state to restore on exit (hiding in the dark is the point) */
  torchWasOn = false;

  constructor(level: Level) {
    this.spots = level.hidingSpots.map((def) => new HideSpotState(def));
  }

  get exiting(): boolean {
    return this.exitT > 0;
  }

  /** begin the climb-out lerp toward the front of the opening */
  beginExit(from: THREE.Vector3) {
    const spot = this.active;
    if (!spot || this.exiting) return;
    this.exitT = HIDE_EXIT_TIME;
    this.exitFrom.copy(from);
    const f = spot.facing(this.exitTo);
    const clear = EXIT_CLEARANCE[spot.def.kind];
    this.exitTo.set(
      spot.def.pos.x + f.x * clear,
      0,
      spot.def.pos.z + f.z * clear,
    );
  }

  /** tear down hidden state without moving the player (death, dispose) */
  clear() {
    if (this.active) this.active.occupied = false;
    this.active = null;
    this.exitT = 0;
  }
}
