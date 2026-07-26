/** Repair broken skins in a Sketchfab FBX->glTF conversion: the inverse bind
 *  matrices don't match the (resampled) node rest pose, so the skinned mesh
 *  explodes. Fix: pick one trusted joint's transform as the mesh's bind
 *  placement (M = restWorld(joint) * IBM(joint)) and rewrite every IBM as
 *  IBM_i = inverse(restWorld_i) * M. At rest the mesh is then coherent;
 *  animation deforms it relative to that pose.
 *  Usage: node scripts/fixskin.mjs <scene.glb> <anchorJointNameSubstring> */
import { readFileSync, writeFileSync } from "node:fs";
import { Matrix4, Vector3, Quaternion } from "../node_modules/three/build/three.core.js";

const [file, anchorSub] = process.argv.slice(2);
const buf = readFileSync(file);
const jsonLen = buf.readUInt32LE(12);
const gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
const binStart = 20 + jsonLen + 8;

// node rest world matrices
const world = new Map();
const walk = (ni, parent) => {
  const n = gltf.nodes[ni];
  const t = n.translation ?? [0, 0, 0];
  const q = n.rotation ?? [0, 0, 0, 1];
  const s = n.scale ?? [1, 1, 1];
  const m = new Matrix4().compose(new Vector3(...t), new Quaternion(...q), new Vector3(...s));
  const w = parent.clone().multiply(m);
  world.set(ni, w);
  (n.children ?? []).forEach((c) => walk(c, w));
};
gltf.scenes[gltf.scene ?? 0].nodes.forEach((n) => walk(n, new Matrix4()));

for (const skin of gltf.skins ?? []) {
  const acc = gltf.accessors[skin.inverseBindMatrices];
  const bv = gltf.bufferViews[acc.bufferView];
  const off = binStart + (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const ibm = new Float32Array(buf.buffer, buf.byteOffset + off, acc.count * 16);

  const anchorIdx = skin.joints.findIndex((j) => (gltf.nodes[j].name ?? "").includes(anchorSub));
  if (anchorIdx < 0) throw new Error(`anchor joint "${anchorSub}" not found`);
  const readM = (i) => new Matrix4().fromArray(ibm, i * 16);
  const M = world.get(skin.joints[anchorIdx]).clone().multiply(readM(anchorIdx));
  console.log("anchor:", gltf.nodes[skin.joints[anchorIdx]].name, "M=", M.elements.map((v) => +v.toFixed(3)));

  for (let i = 0; i < skin.joints.length; i++) {
    const fixed = world.get(skin.joints[i]).clone().invert().multiply(M);
    fixed.toArray(ibm, i * 16);
  }
}
writeFileSync(file, buf);
console.log(file, "— skin(s) repaired");
