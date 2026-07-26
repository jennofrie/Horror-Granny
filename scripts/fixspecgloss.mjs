/** One-time GLB fixup: convert KHR_materials_pbrSpecularGlossiness materials
 *  to pbrMetallicRoughness so three's GLTFLoader (which dropped spec/gloss)
 *  applies the diffuse textures. Rewrites the JSON chunk in place.
 *  Usage: node scripts/fixspecgloss.mjs <scene.glb> [...more] */
import { readFileSync, writeFileSync } from "node:fs";

for (const file of process.argv.slice(2)) {
  const buf = readFileSync(file);
  const jsonLen = buf.readUInt32LE(12);
  const gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString("utf8"));

  const sg = "KHR_materials_pbrSpecularGlossiness";
  if (!(gltf.extensionsRequired ?? []).includes(sg) &&
      !(gltf.extensionsUsed ?? []).includes(sg)) {
    console.log(file, "— no spec/gloss, skipped");
    continue;
  }

  let converted = 0;
  for (const m of gltf.materials ?? []) {
    const ext = m.extensions?.[sg];
    if (!ext) continue;
    m.pbrMetallicRoughness = {
      ...(ext.diffuseFactor ? { baseColorFactor: ext.diffuseFactor } : {}),
      ...(ext.diffuseTexture ? { baseColorTexture: ext.diffuseTexture } : {}),
      metallicFactor: 0,
      // glossiness ≈ smoothness; spec highlights were ~0 anyway
      roughnessFactor: ext.glossinessFactor !== undefined
        ? Math.min(1, Math.max(0, 1 - ext.glossinessFactor))
        : 0.9,
    };
    delete m.extensions[sg];
    if (Object.keys(m.extensions).length === 0) delete m.extensions;
    converted++;
  }
  gltf.extensionsUsed = (gltf.extensionsUsed ?? []).filter((e) => e !== sg);
  gltf.extensionsRequired = (gltf.extensionsRequired ?? []).filter((e) => e !== sg);
  if (gltf.extensionsUsed.length === 0) delete gltf.extensionsUsed;
  if (gltf.extensionsRequired.length === 0) delete gltf.extensionsRequired;

  // repack the GLB (JSON chunk padded to 4 bytes with spaces)
  let json = Buffer.from(JSON.stringify(gltf), "utf8");
  const pad = (4 - (json.length % 4)) % 4;
  if (pad) json = Buffer.concat([json, Buffer.alloc(pad, 0x20)]);
  const rest = buf.subarray(20 + jsonLen); // remaining chunks (BIN)
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0); // "glTF"
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + json.length + rest.length, 8);
  header.writeUInt32LE(json.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16); // "JSON"
  writeFileSync(file, Buffer.concat([header, json, rest]));
  console.log(file, `— converted ${converted} materials`);
}
