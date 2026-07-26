import * as THREE from "three";
import { GLTFLoader, GLTF } from "three/addons/loaders/GLTFLoader.js";
import * as SkeletonUtils from "three/addons/utils/SkeletonUtils.js";

/**
 * GLTF loading for animated characters. Each `scene.glb` is fetched and
 * parsed once per session (cached promise); `instantiate` clones the cached
 * scene (SkeletonUtils handles skinned meshes) and hands out a ready mixer.
 * Nothing here runs per-frame — the per-frame cost is `mixer.update` only.
 *
 * URLs are RELATIVE (`./assets/...`) on purpose: the CrazyGames export
 * (CG_EXPORT=1, assetPrefix "./") serves the bundle from a CDN subfolder,
 * and the game route is `/`, so the same relative path resolves in dev,
 * in the Vercel build, and in the static export.
 */

export interface GltfInstance {
  /** Cloned scene graph, safe to add to the world. */
  root: THREE.Group;
  mixer: THREE.AnimationMixer;
  /** clip name -> action (all clips from the source file) */
  actions: Map<string, THREE.AnimationAction>;
  /** clip name -> duration in seconds */
  durations: Map<string, number>;
}

const loader = new GLTFLoader();
const cache = new Map<string, Promise<GLTF>>();

export function loadGLTF(url: string): Promise<GLTF> {
  let p = cache.get(url);
  if (!p) {
    p = loader.loadAsync(url);
    cache.set(url, p);
  }
  return p;
}

/** Warm the cache (fire-and-forget) so a later spawn doesn't hitch. */
export function preloadModel(slug: string): void {
  void loadGLTF(`./assets/models/${slug}/scene.glb`).catch(() => {
    cache.delete(`./assets/models/${slug}/scene.glb`); // allow retry on failure
  });
}

export async function instantiate(slug: string): Promise<GltfInstance> {
  const url = `./assets/models/${slug}/scene.glb`;
  const gltf = await loadGLTF(url);
  const root = SkeletonUtils.clone(gltf.scene) as THREE.Group;
  const mixer = new THREE.AnimationMixer(root);
  const actions = new Map<string, THREE.AnimationAction>();
  const durations = new Map<string, number>();
  for (const clip of gltf.animations) {
    actions.set(clip.name, mixer.clipAction(clip));
    durations.set(clip.name, clip.duration);
  }
  return { root, mixer, actions, durations };
}
