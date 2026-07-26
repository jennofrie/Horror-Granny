#!/usr/bin/env node
/**
 * fetchassets.mjs — Sketchfab asset acquisition for the game.
 *
 * Usage:
 *   node scripts/fetchassets.mjs search "<query>" [--animated] [--rigged] [--staffpicked] [--limit N]
 *   node scripts/fetchassets.mjs download <uid> <slug>
 *   node scripts/fetchassets.mjs info <uid>
 *
 * - Only downloadable CC0 / CC-BY models are listed (no NC/ND/SA — portal monetization safety).
 * - Downloads land in public/assets/models/<slug>/ (unzipped glTF scene).
 * - Each download appends to public/assets/manifest.json and public/assets/ATTRIBUTION.md.
 *
 * Token: reads SKETCHFAB_API from .env (default ../.env relative to repo root,
 * override with SF_ENV=/path/to/.env or SKETCHFAB_API in the environment).
 */
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODELS_DIR = path.join(ROOT, "public/assets/models");
const MANIFEST = path.join(ROOT, "public/assets/manifest.json");
const ATTRIBUTION = path.join(ROOT, "public/assets/ATTRIBUTION.md");
const API = "https://api.sketchfab.com/v3";

// Licenses we accept: CC0 and CC-BY only.
const OK_LICENSES = new Set(["cc0", "by"]);
// License slugs accepted by /v3/search (`license` param, one per request).
const LICENSE_SLUGS = ["by", "cc0"];
// License uid -> slug, from GET /v3/licenses.
const LICENSE_UID_TO_SLUG = {
  "322a749bcfa841b29dff1e8a1bb74b0b": "by",
  "7c23a1ba438d4306920229c12afcb5f9": "cc0",
};

function loadToken() {
  if (process.env.SKETCHFAB_API) return process.env.SKETCHFAB_API.trim();
  const envPath = process.env.SF_ENV || path.resolve(ROOT, "../.env");
  if (!existsSync(envPath)) die(`no .env at ${envPath} (set SKETCHFAB_API or SF_ENV)`);
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*SKETCHFAB_API\s*=\s*(.+?)\s*$/);
    if (m) return m[1].replace(/^["']|["']$/g, "");
  }
  die(`SKETCHFAB_API not found in ${envPath}`);
}

function die(msg, code = 1) {
  console.error(`error: ${msg}`);
  process.exit(code);
}

async function api(url, token) {
  const res = await fetch(url, { headers: { Authorization: `Token ${token}` } });
  if (!res.ok) die(`API ${res.status} for ${url}\n${(await res.text()).slice(0, 400)}`);
  return res.json();
}

function fmtLicense(lic) {
  return lic ? `${lic.slug} (${lic.fullName || lic.name || ""})` : "?";
}

async function search(query, opts, token) {
  const base = {
    type: "models",
    q: query,
    downloadable: "true",
    sort_by: "-likeCount",
    count: String(opts.limit),
  };
  if (opts.animated) base.animated = "true";
  if (opts.rigged) base.rigged = "true";
  if (opts.staffpicked) base.staffpicked = "true";
  // One request per accepted license slug, merged + de-duped.
  const seen = new Set();
  const results = [];
  for (const lic of LICENSE_SLUGS) {
    const p = new URLSearchParams({ ...base, license: lic });
    const data = await api(`${API}/search?${p}`, token);
    for (const r of data.results || []) {
      if (seen.has(r.uid)) continue;
      seen.add(r.uid);
      results.push(r);
    }
  }
  results.sort((a, b) => (b.likeCount || 0) - (a.likeCount || 0));
  // Server already filtered by license slug; the embedded license object only
  // carries `label`, so tag each row with the slug(s) we queried for.
  const rows = results
    .slice(0, opts.limit)
    .map((r) => ({
      uid: r.uid,
      name: r.name,
      author: r.user?.displayName || r.user?.username || "?",
      license: r.license?.label || "CC-BY/CC0",
      animated: r.animationCount > 0,
      animCount: r.animationCount || 0,
      faces: r.faceCount,
      verts: r.vertexCount,
      likes: r.likeCount,
      url: r.uri?.replace("api.sketchfab.com/v3", "sketchfab.com") || "",
    }));
  console.log(JSON.stringify(rows, null, 2));
  if (!rows.length) console.error("(no CC0/CC-BY downloadable results — try a different query)");
}

async function info(uid, token) {
  const m = await api(`${API}/models/${uid}`, token);
  console.log(
    JSON.stringify(
      {
        uid: m.uid,
        name: m.name,
        author: m.user?.displayName,
        license: fmtLicense(m.license),
        isDownloadable: m.isDownloadable,
        animationCount: m.animationCount,
        faceCount: m.faceCount,
        categories: (m.categories || []).map((c) => c.name),
        tags: (m.tags || []).map((t) => t.name).slice(0, 15),
      },
      null,
      2
    )
  );
}

async function download(uid, slug, token) {
  if (!/^[a-z0-9-]+$/.test(slug)) die("slug must be lowercase a-z 0-9 -");
  const outDir = path.join(MODELS_DIR, slug);
  if (existsSync(outDir)) die(`${outDir} already exists — remove it first to re-download`);

  const meta = await api(`${API}/models/${uid}`, token);
  // The model endpoint's license object carries uid/label; resolve uid -> slug.
  const licSlug = meta.license?.slug || LICENSE_UID_TO_SLUG[meta.license?.uid] || null;
  if (!licSlug || !OK_LICENSES.has(licSlug))
    die(`license ${meta.license?.label || "?"} not allowed (CC0/CC-BY only)`);
  if (!meta.isDownloadable) die("model is not downloadable");

  const dl = await api(`${API}/models/${uid}/download`, token);
  // Prefer GLB if offered, else the glTF zip archive.
  const gltf = dl.glb || dl.gltf;
  if (!gltf?.url) die(`no downloadable glTF/GLB in response: ${JSON.stringify(dl).slice(0, 300)}`);

  mkdirSync(outDir, { recursive: true });
  const tmpZip = path.join(outDir, "_dl.zip");
  console.log(`downloading ${meta.name} (${Math.round((gltf.size || 0) / 1024)} KiB)...`);
  const res = await fetch(gltf.url);
  if (!res.ok || !res.body) die(`download failed: ${res.status}`);
  await pipeline(res.body, createWriteStream(tmpZip));

  if (dl.glb) {
    const { renameSync } = await import("node:fs");
    renameSync(tmpZip, path.join(outDir, "scene.glb"));
  } else {
    execFileSync("unzip", ["-o", "-q", tmpZip, "-d", outDir]);
    await rm(tmpZip, { force: true });
  }

  // Locate the scene file and extract animation names from the glTF JSON.
  const files = await readdir(outDir);
  const sceneFile = files.find((f) => f.endsWith(".gltf")) || files.find((f) => f.endsWith(".glb"));
  let animations = [];
  if (sceneFile?.endsWith(".gltf")) {
    try {
      const g = JSON.parse(readFileSync(path.join(outDir, sceneFile), "utf8"));
      animations = (g.animations || []).map((a, i) => a.name || `anim_${i}`);
    } catch {}
  }

  const safeName = meta.name.replace(/\|/g, "-");
  const entry = {
    slug,
    uid,
    name: safeName,
    author: meta.user?.displayName || meta.user?.username || "?",
    license: licSlug,
    licenseName: meta.license?.fullName || meta.license?.label || "",
    source: `https://sketchfab.com/3d-models/${meta.name.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "")}-${uid}`,
    dir: `assets/models/${slug}`,
    scene: sceneFile || null,
    animations,
    faceCount: meta.faceCount || 0,
    fetchedAt: new Date().toISOString().slice(0, 10),
  };

  const manifest = existsSync(MANIFEST)
    ? JSON.parse(readFileSync(MANIFEST, "utf8"))
    : { models: [], audio: [], vfx: [] };
  manifest.models = manifest.models.filter((m) => m.slug !== slug).concat(entry);
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");

  const row = `| ${slug}/ | ${entry.name} | ${entry.author} | ${entry.license} | ${entry.source} |`;
  let attr = readFileSync(ATTRIBUTION, "utf8");
  if (!attr.includes(`| ${slug}/ |`)) {
    const marker = "| _(none yet)_ | | | | |";
    const sectionEnd = attr.indexOf("## Audio");
    if (attr.includes(marker)) attr = attr.replace(marker, row);
    else attr = attr.slice(0, sectionEnd) + row + "\n\n" + attr.slice(sectionEnd);
    writeFileSync(ATTRIBUTION, attr);
  }

  console.log(`OK -> public/assets/models/${slug}/  scene=${sceneFile}  animations=[${animations.join(", ")}]`);
}

// ---- CLI ----
const [cmd, ...args] = process.argv.slice(2);
const flags = {
  animated: args.includes("--animated"),
  rigged: args.includes("--rigged"),
  staffpicked: args.includes("--staffpicked"),
  limit: Number(args.find((a) => a.startsWith("--limit="))?.split("=")[1] || 12),
};
const positional = args.filter((a) => !a.startsWith("--"));
const token = loadToken();

if (cmd === "search" && positional[0]) await search(positional[0], flags, token);
else if (cmd === "info" && positional[0]) await info(positional[0], token);
else if (cmd === "download" && positional[0] && positional[1]) await download(positional[0], positional[1], token);
else die("usage: search <q> [--animated] [--rigged] [--limit=N] | info <uid> | download <uid> <slug>");
