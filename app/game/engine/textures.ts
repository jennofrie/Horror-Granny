import * as THREE from "three";
import { mulberry32, randRange, ValueNoise } from "./rng";

/**
 * 100% procedural asset generation. No image files — every surface in the
 * game is painted onto canvases at boot: albedo, plus normal + roughness maps
 * derived from a height field so the flashlight raking across walls reveals
 * believable surface relief.
 */

export interface PBRMaps {
  map: THREE.CanvasTexture;
  normalMap: THREE.CanvasTexture;
  roughnessMap: THREE.CanvasTexture;
}

function makeCanvas(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return { canvas: c, ctx: c.getContext("2d")! };
}

function tex(
  canvas: HTMLCanvasElement,
  opts: { srgb?: boolean; repeat?: boolean; anisotropy?: number } = {},
): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(canvas);
  if (opts.srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (opts.repeat !== false) {
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
  }
  t.anisotropy = opts.anisotropy ?? 8;
  t.needsUpdate = true;
  return t;
}

/** Sobel filter over a grayscale height array -> tangent-space normal map. */
function normalFromHeight(
  height: Float32Array,
  w: number,
  h: number,
  strength: number,
): HTMLCanvasElement {
  const { canvas, ctx } = makeCanvas(w, h);
  const img = ctx.createImageData(w, h);
  const d = img.data;
  const at = (x: number, y: number) =>
    height[((y + h) % h) * w + ((x + w) % w)];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx =
        at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) -
        (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
      const dy =
        at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) -
        (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
      let nx = -dx * strength;
      let ny = -dy * strength;
      let nz = 1;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx /= len;
      ny /= len;
      nz /= len;
      const i = (y * w + x) * 4;
      d[i] = (nx * 0.5 + 0.5) * 255;
      d[i + 1] = (ny * 0.5 + 0.5) * 255;
      d[i + 2] = (nz * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

function grayCanvas(values: Float32Array, w: number, h: number): HTMLCanvasElement {
  const { canvas, ctx } = makeCanvas(w, h);
  const img = ctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const v = Math.max(0, Math.min(1, values[i])) * 255;
    img.data[i * 4] = v;
    img.data[i * 4 + 1] = v;
    img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/* ------------------------------------------------------------------ */
/*  WALLPAPER — worn, damp at the bottom, baseboard. Per-room tints.   */
/* ------------------------------------------------------------------ */

export function makeWallpaperMaps(
  seed: number,
  tint: [number, number, number],
): PBRMaps {
  const S = 1024;
  const rng = mulberry32(seed);
  const n1 = new ValueNoise(seed + 1);
  const n2 = new ValueNoise(seed + 2);
  const n3 = new ValueNoise(seed + 3);

  const { canvas, ctx } = makeCanvas(S, S);
  const img = ctx.createImageData(S, S);
  const d = img.data;
  const height = new Float32Array(S * S);
  const rough = new Float32Array(S * S);

  // Texture spans 4m wide x ~3m tall (one wall segment). 1px ≈ 3.9mm/2.9mm.
  // Repeating vertical chevron columns, muted two-tone, in the room's tint.
  const baseboardPx = Math.floor(S * 0.045); // ~14cm baseboard at the bottom
  const stripeW = S / 28; // ~14cm chevron columns
  const chevPeriod = S / 36; // ~8cm vertical repeat
  for (let y = 0; y < S; y++) {
    const vy = y / S; // 0 = top of wall, 1 = floor
    for (let x = 0; x < S; x++) {
      const i = y * S + x;

      // Chevron: within each column, bands rise toward the column center.
      const inStripe = ((x % stripeW) + stripeW) % stripeW;
      const triangle = Math.abs(inStripe - stripeW / 2) / (stripeW / 2); // 0 center, 1 edges
      const chev = Math.sin(((y + triangle * chevPeriod * 0.9) / chevPeriod) * Math.PI * 2);
      const chevBand = 0.965 + (chev * 0.5 + 0.5) * 0.05; // muted two-tone
      const seam = triangle > 0.94 ? 0.965 : 1; // faint line between columns
      const grain = n1.fbm(x * 0.045, y * 0.045, 4) * 0.14 + 0.93;
      const mottle = n2.fbm(x * 0.008, y * 0.008, 4); // large patchiness

      let [r, g, b] = tint;
      const shade = chevBand * seam * grain * (0.9 + mottle * 0.16);
      r *= shade; g *= shade; b *= shade;

      // Rising damp: darken + brown the lower part with a blotchy edge.
      const dampLine = 0.68 + n3.noise(x * 0.012, 7.7) * 0.2;
      if (vy > dampLine) {
        const t = Math.min(1, (vy - dampLine) / (1 - dampLine));
        const blotch = 0.6 + n3.fbm(x * 0.02, y * 0.02, 3) * 0.5;
        const k = t * blotch * 0.45;
        r *= 1 - k * 0.55;
        g *= 1 - k * 0.62;
        b *= 1 - k * 0.55;
      }

      // Faint grime band near the ceiling.
      if (vy < 0.04) {
        const k = (1 - vy / 0.04) * 0.22;
        r *= 1 - k; g *= 1 - k; b *= 1 - k;
      }

      // Baseboard: dark, dusty vinyl strip.
      const fromBottom = S - 1 - y;
      if (fromBottom < baseboardPx) {
        const t = fromBottom / baseboardPx;
        const bn = n1.noise(x * 0.05, y * 0.05) * 14;
        r = 52 + t * 12 + bn;
        g = 48 + t * 11 + bn;
        b = 40 + t * 9 + bn;
        if (t > 0.92) { r += 26; g += 24; b += 20; } // top highlight edge
      }

      d[i * 4] = r;
      d[i * 4 + 1] = g;
      d[i * 4 + 2] = b;
      d[i * 4 + 3] = 255;

      height[i] = grain * 0.55 + (chev * 0.5 + 0.5) * 0.12 + mottle * 0.28;
      rough[i] = 0.94 - mottle * 0.08 + (vy > dampLine ? -0.16 : 0);
    }
  }
  ctx.putImageData(img, 0, 0);

  // Scuffs and scratches — dark strokes low on the wall.
  ctx.globalAlpha = 0.16;
  ctx.strokeStyle = "#3a3322";
  for (let s = 0; s < 26; s++) {
    ctx.lineWidth = randRange(rng, 0.6, 2.4);
    const sy = S * randRange(rng, 0.55, 0.95);
    const sx = rng() * S;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.quadraticCurveTo(
      sx + randRange(rng, -70, 70),
      sy + randRange(rng, -16, 16),
      sx + randRange(rng, -150, 150),
      sy + randRange(rng, -28, 28),
    );
    ctx.stroke();
  }
  // A few long drip stains from the ceiling line.
  ctx.globalAlpha = 0.1;
  for (let s = 0; s < 7; s++) {
    const sx = rng() * S;
    const len = randRange(rng, 80, 420);
    const grad = ctx.createLinearGradient(0, 0, 0, len);
    grad.addColorStop(0, "rgba(70,58,30,0.8)");
    grad.addColorStop(1, "rgba(70,58,30,0)");
    ctx.fillStyle = grad;
    ctx.save();
    ctx.translate(sx, 0);
    ctx.fillRect(-randRange(rng, 2, 7), 0, randRange(rng, 4, 14), len);
    ctx.restore();
  }
  ctx.globalAlpha = 1;

  return {
    map: tex(canvas, { srgb: true }),
    normalMap: tex(normalFromHeight(height, S, S, 1.4)),
    roughnessMap: tex(grayCanvas(rough, S, S)),
  };
}

/* ------------------------------------------------------- */
/*  WOOD FLOOR — worn planks, gaps, per-board shade drift   */
/* ------------------------------------------------------- */

export function makeWoodFloorMaps(seed: number): PBRMaps {
  const S = 1024; // covers 2m x 2m
  const rng = mulberry32(seed);
  const n1 = new ValueNoise(seed + 11);
  const n2 = new ValueNoise(seed + 12);

  const { canvas, ctx } = makeCanvas(S, S);
  const img = ctx.createImageData(S, S);
  const d = img.data;
  const height = new Float32Array(S * S);
  const rough = new Float32Array(S * S);

  const plankH = S / 6; // ~33cm wide boards running along x
  const boardLen = S / 2; // ~1m boards, staggered joints
  for (let y = 0; y < S; y++) {
    const row = Math.floor(y / plankH);
    const inRow = y - row * plankH;
    // Per-board shade: stable hash of row (+column for the joint halves).
    const jointOff = (row % 2) * (boardLen / 2);
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      const col = Math.floor(((x + jointOff) % S) / boardLen);
      const boardTone = 0.82 + n2.noise(row * 3.1 + 40, col * 7.7) * 0.3;

      // Grain: streaks along the board, plus fine speckle.
      const grain = n1.noise(x * 0.014, y * 0.75 + row * 13) * 0.5 + 0.75;
      const speck = n1.noise(x * 0.6, y * 0.6) * 0.12;
      const k = (grain + speck) * boardTone;

      let r = 124 * k, g = 93 * k, b = 58 * k;

      // Gaps between planks + board end joints.
      const gapRow = inRow < 2 || inRow > plankH - 3;
      const jx = (x + jointOff) % boardLen;
      const gapCol = jx < 2;
      let h = 0.55 + grain * 0.3 + boardTone * 0.15;
      let ro = 0.62 + n2.fbm(x * 0.01, y * 0.01, 3) * 0.25;
      if (gapRow || gapCol) {
        r *= 0.28; g *= 0.28; b *= 0.28;
        h = 0.1;
        ro = 0.95;
      }

      d[i * 4] = r;
      d[i * 4 + 1] = g;
      d[i * 4 + 2] = b;
      d[i * 4 + 3] = 255;
      height[i] = h;
      rough[i] = ro;
    }
  }
  ctx.putImageData(img, 0, 0);

  // Scuffs and dark worn patches from decades of feet.
  for (let s = 0; s < 10; s++) {
    const sx = rng() * S, sy = rng() * S, rad = randRange(rng, 20, 110);
    const grad = ctx.createRadialGradient(sx, sy, rad * 0.2, sx, sy, rad);
    grad.addColorStop(0, "rgba(30,20,10,0.28)");
    grad.addColorStop(1, "rgba(30,20,10,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(sx - rad, sy - rad, rad * 2, rad * 2);
  }

  return {
    map: tex(canvas, { srgb: true }),
    normalMap: tex(normalFromHeight(height, S, S, 1.0)),
    roughnessMap: tex(grayCanvas(rough, S, S)),
  };
}

/* ----------------------------------------------------------- */
/*  PLASTER — ceilings and utility walls: trowel mottle, stains */
/* ----------------------------------------------------------- */

export function makePlasterMaps(
  seed: number,
  tint: [number, number, number],
): PBRMaps {
  const S = 1024; // covers 2.4m x 2.4m
  const rng = mulberry32(seed);
  const n1 = new ValueNoise(seed + 21);
  const n2 = new ValueNoise(seed + 22);

  const { canvas, ctx } = makeCanvas(S, S);
  const img = ctx.createImageData(S, S);
  const d = img.data;
  const height = new Float32Array(S * S);
  const rough = new Float32Array(S * S);

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      const speck = n1.noise(x * 0.5, y * 0.5);
      const broad = n1.fbm(x * 0.008, y * 0.008, 4);
      const trowel = n2.fbm(x * 0.02 + 60, y * 0.02, 3);
      const k = 0.86 + speck * 0.1 + broad * 0.12 + trowel * 0.08;
      d[i * 4] = tint[0] * k;
      d[i * 4 + 1] = tint[1] * k;
      d[i * 4 + 2] = tint[2] * k;
      d[i * 4 + 3] = 255;
      height[i] = 0.5 + broad * 0.35 + trowel * 0.15;
      rough[i] = 0.94;
    }
  }
  ctx.putImageData(img, 0, 0);

  // Old brown water stains — every old house ceiling has a few.
  for (let s = 0; s < 4; s++) {
    const tx = rng() * S, ty = rng() * S;
    let rad = randRange(rng, 40, 120);
    for (let ring = 0; ring < 3; ring++) {
      ctx.beginPath();
      ctx.arc(tx + randRange(rng, -12, 12), ty + randRange(rng, -12, 12), rad, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(122,86,38,${0.22 - ring * 0.05})`;
      ctx.lineWidth = randRange(rng, 2, 6);
      ctx.stroke();
      rad *= randRange(rng, 0.7, 0.88);
    }
  }

  return {
    map: tex(canvas, { srgb: true }),
    normalMap: tex(normalFromHeight(height, S, S, 0.9)),
    roughnessMap: tex(grayCanvas(rough, S, S)),
  };
}

/* ----------------------------------------------------------- */
/*  TILE — kitchen/bathroom: satin squares, recessed grout      */
/* ----------------------------------------------------------- */

export function makeTileMaps(
  seed: number,
  tint: [number, number, number],
): PBRMaps {
  const S = 1024; // covers 2m x 2m => 4x4 tiles of 50cm
  const rng = mulberry32(seed);
  const n1 = new ValueNoise(seed + 25);

  const { canvas, ctx } = makeCanvas(S, S);
  const img = ctx.createImageData(S, S);
  const d = img.data;
  const height = new Float32Array(S * S);
  const rough = new Float32Array(S * S);
  const tileSz = S / 4;

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      const tx = Math.floor(x / tileSz);
      const ty = Math.floor(y / tileSz);
      const lx = x % tileSz;
      const ly = y % tileSz;
      const edge = Math.min(lx, tileSz - lx, ly, tileSz - ly);

      // Stable per-tile shade jitter + fine speckle, a few hairline cracks.
      const tone = 0.88 + n1.noise(tx * 9.3 + 7, ty * 5.1 + 3) * 0.2;
      const speck = n1.noise(x * 0.7, y * 0.7) * 0.08;
      const k = tone + speck;
      let r = tint[0] * k, g = tint[1] * k, b = tint[2] * k;
      let h = 0.6 + speck;
      let ro = 0.42 + n1.fbm(x * 0.01, y * 0.01, 3) * 0.2; // satin glaze

      if (edge < 3) {
        const gk = 0.35 + (edge / 3) * 0.25; // dark recessed grout
        r *= gk; g *= gk; b *= gk;
        h = 0.12;
        ro = 0.92;
      }

      d[i * 4] = r;
      d[i * 4 + 1] = g;
      d[i * 4 + 2] = b;
      d[i * 4 + 3] = 255;
      height[i] = h;
      rough[i] = ro;
    }
  }
  ctx.putImageData(img, 0, 0);

  // Grime caught in a few grout corners.
  for (let s = 0; s < 8; s++) {
    const sx = Math.floor(rng() * 4) * tileSz, sy = Math.floor(rng() * 4) * tileSz;
    const grad = ctx.createRadialGradient(sx, sy, 4, sx, sy, tileSz * 0.6);
    grad.addColorStop(0, "rgba(40,34,22,0.30)");
    grad.addColorStop(1, "rgba(40,34,22,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(sx - tileSz, sy - tileSz, tileSz * 2, tileSz * 2);
  }

  return {
    map: tex(canvas, { srgb: true }),
    normalMap: tex(normalFromHeight(height, S, S, 1.2)),
    roughnessMap: tex(grayCanvas(rough, S, S)),
  };
}

/* ----------------------------------------------------------- */
/*  CONCRETE — garage/storage: mottled gray, cracks, oil stains */
/* ----------------------------------------------------------- */

export function makeConcreteMaps(seed: number): PBRMaps {
  const S = 1024; // covers 2m x 2m
  const rng = mulberry32(seed);
  const n1 = new ValueNoise(seed + 27);

  const { canvas, ctx } = makeCanvas(S, S);
  const img = ctx.createImageData(S, S);
  const d = img.data;
  const height = new Float32Array(S * S);
  const rough = new Float32Array(S * S);

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      const mottle = n1.fbm(x * 0.012, y * 0.012, 4);
      const fine = n1.noise(x * 0.55, y * 0.55);
      const k = 0.78 + mottle * 0.3 + fine * 0.1;
      const v = 148 * k;
      d[i * 4] = v;
      d[i * 4 + 1] = v * 0.99;
      d[i * 4 + 2] = v * 0.96;
      d[i * 4 + 3] = 255;
      height[i] = 0.45 + mottle * 0.35 + fine * 0.2;
      rough[i] = 0.9 + mottle * 0.06;
    }
  }
  ctx.putImageData(img, 0, 0);

  // Hairline cracks — dark wandering strokes.
  ctx.strokeStyle = "rgba(35,33,30,0.55)";
  for (let s = 0; s < 6; s++) {
    ctx.lineWidth = randRange(rng, 0.7, 1.8);
    let px = rng() * S, py = rng() * S;
    ctx.beginPath();
    ctx.moveTo(px, py);
    const segs = 4 + Math.floor(rng() * 5);
    for (let g = 0; g < segs; g++) {
      px += randRange(rng, -140, 140);
      py += randRange(rng, -140, 140);
      ctx.lineTo(px, py);
    }
    ctx.stroke();
  }
  // Oil stains.
  for (let s = 0; s < 5; s++) {
    const sx = rng() * S, sy = rng() * S, rad = randRange(rng, 24, 100);
    const grad = ctx.createRadialGradient(sx, sy, rad * 0.15, sx, sy, rad);
    grad.addColorStop(0, "rgba(18,16,14,0.5)");
    grad.addColorStop(0.75, "rgba(18,16,14,0.18)");
    grad.addColorStop(1, "rgba(18,16,14,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(sx - rad, sy - rad, rad * 2, rad * 2);
  }

  return {
    map: tex(canvas, { srgb: true }),
    normalMap: tex(normalFromHeight(height, S, S, 0.8)),
    roughnessMap: tex(grayCanvas(rough, S, S)),
  };
}

/* ------------------------------------------------ */
/*  FLUORESCENT PANEL — emissive diffuser + frame    */
/* ------------------------------------------------ */

export function makeLightPanelTexture(): THREE.CanvasTexture {
  const W = 256, H = 128;
  const { canvas, ctx } = makeCanvas(W, H);
  ctx.fillStyle = "#2a2a26";
  ctx.fillRect(0, 0, W, H);
  // Diffuser area
  ctx.fillStyle = "#fef6d8";
  ctx.fillRect(10, 8, W - 20, H - 16);
  // Two brighter tube bands behind the diffuser
  for (const ty of [H * 0.32, H * 0.68]) {
    const grad = ctx.createLinearGradient(0, ty - 14, 0, ty + 14);
    grad.addColorStop(0, "rgba(255,255,255,0)");
    grad.addColorStop(0.5, "rgba(255,255,240,0.95)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(10, ty - 14, W - 20, 28);
  }
  // Prismatic grid lines on the diffuser
  ctx.strokeStyle = "rgba(180,170,130,0.22)";
  ctx.lineWidth = 1;
  for (let x = 10; x < W - 10; x += 9) {
    ctx.beginPath(); ctx.moveTo(x, 8); ctx.lineTo(x, H - 8); ctx.stroke();
  }
  for (let y = 8; y < H - 8; y += 9) {
    ctx.beginPath(); ctx.moveTo(10, y); ctx.lineTo(W - 10, y); ctx.stroke();
  }
  // A couple of dead-fly shadows. Disgusting. Perfect.
  ctx.fillStyle = "rgba(60,50,30,0.5)";
  ctx.beginPath(); ctx.ellipse(W * 0.31, H * 0.74, 5, 3, 0.5, 0, 7); ctx.fill();
  ctx.beginPath(); ctx.ellipse(W * 0.66, H * 0.28, 4, 2.5, 1.2, 0, 7); ctx.fill();
  return tex(canvas, { srgb: true, repeat: false });
}

/* ------------------------------- */
/*  EXIT DOOR + glowing EXIT sign   */
/* ------------------------------- */

export function makeDoorTexture(seed: number): THREE.CanvasTexture {
  const W = 512, H = 1024;
  const rng = mulberry32(seed + 41);
  const n = new ValueNoise(seed + 42);
  const { canvas, ctx } = makeCanvas(W, H);

  // Institutional gray-green steel with vertical brushing.
  const img = ctx.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const brush = n.noise(x * 0.9, y * 0.06);
      const broad = n.fbm(x * 0.008, y * 0.008, 3);
      const k = 0.75 + brush * 0.14 + broad * 0.2;
      img.data[i] = 72 * k;
      img.data[i + 1] = 78 * k;
      img.data[i + 2] = 70 * k;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  // Panel inset lines.
  ctx.strokeStyle = "rgba(20,24,20,0.55)";
  ctx.lineWidth = 4;
  ctx.strokeRect(46, 60, W - 92, H * 0.38);
  ctx.strokeRect(46, H * 0.5, W - 92, H * 0.34);
  // Kick plate.
  ctx.fillStyle = "rgba(120,124,116,0.6)";
  ctx.fillRect(20, H - 130, W - 40, 110);
  // Scratches.
  ctx.strokeStyle = "rgba(30,30,26,0.5)";
  for (let s = 0; s < 22; s++) {
    ctx.lineWidth = randRange(rng, 0.5, 2);
    ctx.beginPath();
    const sx = rng() * W, sy = rng() * H;
    ctx.moveTo(sx, sy);
    ctx.lineTo(sx + randRange(rng, -90, 90), sy + randRange(rng, -30, 30));
    ctx.stroke();
  }
  // Grime around the handle area.
  const grad = ctx.createRadialGradient(W - 90, H * 0.52, 6, W - 90, H * 0.52, 90);
  grad.addColorStop(0, "rgba(25,22,16,0.5)");
  grad.addColorStop(1, "rgba(25,22,16,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(W - 190, H * 0.52 - 100, 200, 200);

  return tex(canvas, { srgb: true, repeat: false });
}

export function makeExitSignTexture(): THREE.CanvasTexture {
  const W = 256, H = 96;
  const { canvas, ctx } = makeCanvas(W, H);
  ctx.fillStyle = "#0a1f0c";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#48ff6a";
  ctx.font = "bold 64px Arial, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("EXIT", W / 2, H / 2 + 4);
  ctx.strokeStyle = "rgba(60,255,110,0.6)";
  ctx.lineWidth = 4;
  ctx.strokeRect(4, 4, W - 8, H - 8);
  return tex(canvas, { srgb: true, repeat: false });
}

/**
 * The OTHER exit signs — red, grimy, pointing at nothing. They lie.
 * `arrow` flips the chevron so different signs send you different ways.
 */
export function makeFalseExitSignTexture(
  seed: number,
  arrow: -1 | 1,
): THREE.CanvasTexture {
  const W = 256, H = 96;
  const rng = mulberry32(seed * 7 + 13);
  const { canvas, ctx } = makeCanvas(W, H);
  ctx.fillStyle = "#160505";
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = "#ff2a22";
  ctx.font = "bold 56px Arial, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("EXIT", W / 2 - arrow * 22, H / 2 + 4);

  // chevron arrow
  ctx.beginPath();
  const ax = arrow === 1 ? W - 46 : 46;
  ctx.moveTo(ax - arrow * 14, H / 2 - 20);
  ctx.lineTo(ax + arrow * 12, H / 2 + 2);
  ctx.lineTo(ax - arrow * 14, H / 2 + 24);
  ctx.lineWidth = 9;
  ctx.strokeStyle = "#ff2a22";
  ctx.stroke();

  ctx.strokeStyle = "rgba(255,50,40,0.45)";
  ctx.lineWidth = 4;
  ctx.strokeRect(4, 4, W - 8, H - 8);

  // grime streaks + a dead patch in the lettering — these have been here a while
  ctx.globalCompositeOperation = "destination-out";
  for (let i = 0; i < 26; i++) {
    ctx.fillStyle = `rgba(0,0,0,${0.25 + rng() * 0.5})`;
    const x = rng() * W, y = rng() * H;
    ctx.fillRect(x, y, 2 + rng() * 14, 1 + rng() * 3);
  }
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = "rgba(20,4,4,0.55)";
  ctx.fillRect(rng() * W * 0.7, 0, 14 + rng() * 30, H);

  return tex(canvas, { srgb: true, repeat: false });
}

/* ---------------------------------------------------------- */
/*  WALL ART — things previous visitors drew. black + red ink  */
/* ---------------------------------------------------------- */

/**
 * One scrawled drawing on a transparent canvas: shaky hand, ink that
 * skips, red that sometimes runs. Motif picked from a small creepy set.
 */
export function makeWallArtTexture(seed: number): THREE.CanvasTexture {
  const S = 384;
  const rng = mulberry32(seed);
  const { canvas, ctx } = makeCanvas(S, S);

  const BLACK = "#16120c";
  const RED = "#6e1410";
  const ink = rng() < 0.42 ? RED : BLACK;
  const isRed = ink === RED;

  /** Shaky multi-pass stroke through the given points (unit space 0..1). */
  const stroke = (pts: [number, number][], w: number, alpha = 1, color = ink) => {
    for (let pass = 0; pass < 2; pass++) {
      ctx.strokeStyle = color;
      ctx.lineWidth = w * (0.75 + rng() * 0.5);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.globalAlpha = alpha * (0.45 + rng() * 0.35);
      ctx.beginPath();
      pts.forEach(([px, py], i) => {
        const jx = px * S + (rng() - 0.5) * 3.5;
        const jy = py * S + (rng() - 0.5) * 3.5;
        if (i === 0) ctx.moveTo(jx, jy);
        else {
          // bow each segment a little — nobody draws straight lines scared
          const [qx, qy] = pts[i - 1];
          const mx = ((qx + px) / 2) * S + (rng() - 0.5) * 6;
          const my = ((qy + py) / 2) * S + (rng() - 0.5) * 6;
          ctx.quadraticCurveTo(mx, my, jx, jy);
        }
      });
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  };

  const circle = (cx: number, cy: number, r: number, w: number, color = ink) => {
    const pts: [number, number][] = [];
    const turns = 1 + rng() * 0.15;
    for (let a = 0; a <= turns * Math.PI * 2 + 0.2; a += 0.5) {
      pts.push([cx + Math.cos(a) * r * (0.9 + rng() * 0.2), cy + Math.sin(a) * r * (0.9 + rng() * 0.2)]);
    }
    stroke(pts, w, 1, color);
  };

  /** Red ink runs — thin streaks dripping from a point. */
  const drip = (x: number, y: number, color = RED) => {
    const len = 0.06 + rng() * 0.16;
    const g = ctx.createLinearGradient(0, y * S, 0, (y + len) * S);
    g.addColorStop(0, color);
    g.addColorStop(1, "rgba(110,20,16,0)");
    ctx.fillStyle = g;
    ctx.globalAlpha = 0.5 + rng() * 0.3;
    ctx.fillRect(x * S - 1.2, y * S, 2.4 * (0.6 + rng() * 0.8), len * S);
    ctx.globalAlpha = 1;
  };

  const stickFigure = (cx: number, cy: number, h: number, w: number, tall = false) => {
    const headR = h * (tall ? 0.07 : 0.12);
    const neckY = cy - h / 2 + headR * 2;
    circle(cx, cy - h / 2 + headR, headR, w);
    stroke([[cx, neckY], [cx, cy + h * 0.18]], w); // spine
    const armY = neckY + h * (tall ? 0.06 : 0.1);
    const span = h * (tall ? 0.34 : 0.22);
    const droop = tall ? h * 0.3 : h * 0.06;
    stroke([[cx - span, armY + droop], [cx, armY], [cx + span, armY + droop]], w);
    stroke([[cx, cy + h * 0.18], [cx - h * 0.14, cy + h / 2]], w);
    stroke([[cx, cy + h * 0.18], [cx + h * 0.14, cy + h / 2]], w);
  };

  const motif = Math.floor(rng() * 7);
  switch (motif) {
    case 0: {
      // family portrait — small ones, and the long one standing behind
      const n = 2 + Math.floor(rng() * 2);
      for (let i = 0; i < n; i++) {
        stickFigure(0.2 + (0.6 / Math.max(1, n - 1)) * i, 0.62, 0.3 + rng() * 0.08, 3.2);
      }
      stickFigure(0.3 + rng() * 0.4, 0.42, 0.66, 3.0, true);
      if (rng() < 0.6) circle(0.5, 0.5, 0.42, 4.5, RED); // someone circled it
      break;
    }
    case 1: {
      // the big eye, lashes like cracks
      circle(0.5, 0.5, 0.26, 4.5);
      circle(0.5, 0.5, 0.09, 4);
      ctx.fillStyle = ink;
      ctx.globalAlpha = 0.8;
      ctx.beginPath();
      ctx.arc(0.5 * S, 0.5 * S, 0.045 * S, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      for (let i = 0; i < 11; i++) {
        const a = rng() * Math.PI * 2;
        stroke(
          [
            [0.5 + Math.cos(a) * 0.28, 0.5 + Math.sin(a) * 0.28],
            [0.5 + Math.cos(a) * (0.36 + rng() * 0.1), 0.5 + Math.sin(a) * (0.36 + rng() * 0.1)],
          ],
          2.6,
        );
      }
      break;
    }
    case 2: {
      // spiral, drawn until the hand gave up
      const pts: [number, number][] = [];
      const turns = 3.5 + rng() * 2;
      for (let a = 0; a < turns * Math.PI * 2; a += 0.4) {
        const r = 0.04 + (a / (turns * Math.PI * 2)) * 0.38;
        pts.push([0.5 + Math.cos(a) * r, 0.5 + Math.sin(a) * r * 0.92]);
      }
      stroke(pts, 3.6);
      break;
    }
    case 3: {
      // a door — crossed out
      stroke([[0.3, 0.78], [0.3, 0.2], [0.68, 0.2], [0.68, 0.78]], 4);
      stroke([[0.62, 0.5], [0.65, 0.5]], 4.5); // knob
      stroke([[0.22, 0.16], [0.76, 0.82]], 5, 1, RED);
      stroke([[0.76, 0.18], [0.22, 0.8]], 5, 1, RED);
      if (rng() < 0.7) drip(0.4 + rng() * 0.2, 0.5 + rng() * 0.2);
      break;
    }
    case 4: {
      // tally marks — counting something. days? encounters?
      let y = 0.24 + rng() * 0.1;
      for (let row = 0; row < 3; row++) {
        let x = 0.16 + rng() * 0.08;
        const groups = 2 + Math.floor(rng() * 2);
        for (let gI = 0; gI < groups; gI++) {
          for (let t = 0; t < 4; t++) {
            stroke([[x + t * 0.035, y], [x + t * 0.035 + 0.012, y + 0.13]], 3);
          }
          stroke([[x - 0.015, y + 0.1], [x + 0.13, y + 0.03]], 3);
          x += 0.2;
        }
        y += 0.22;
      }
      break;
    }
    case 5: {
      // handprint — someone touched the wall with a wet red hand
      const cx = 0.5, cy = 0.55;
      ctx.fillStyle = RED;
      ctx.globalAlpha = 0.6;
      ctx.beginPath();
      ctx.ellipse(cx * S, cy * S, 0.11 * S, 0.13 * S, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      for (let f = 0; f < 5; f++) {
        const a = -Math.PI / 2 + (f - 2) * 0.32 + (rng() - 0.5) * 0.08;
        const lx = cx + Math.cos(a) * 0.13, ly = cy + Math.sin(a) * 0.15;
        const ex = cx + Math.cos(a) * (0.24 + rng() * 0.04);
        const ey = cy + Math.sin(a) * (0.26 + rng() * 0.04);
        stroke([[lx, ly], [ex, ey]], 9 - Math.abs(f - 2) * 1.4, 0.75, RED);
      }
      drip(cx - 0.06 + rng() * 0.12, cy + 0.1);
      drip(cx - 0.06 + rng() * 0.12, cy + 0.12);
      break;
    }
    default: {
      // arrows that disagree about the way out
      const n = 2 + Math.floor(rng() * 3);
      for (let i = 0; i < n; i++) {
        const y = 0.2 + (0.6 / n) * i + rng() * 0.08;
        const dir = rng() < 0.5 ? 1 : -1;
        const x0 = 0.5 - dir * 0.3, x1 = 0.5 + dir * 0.3;
        stroke([[x0, y], [x1, y]], 4);
        stroke([[x1 - dir * 0.09, y - 0.06], [x1, y], [x1 - dir * 0.09, y + 0.06]], 4);
      }
      if (rng() < 0.5) circle(0.5, 0.5, 0.4, 3, RED);
      break;
    }
  }

  // red ink runs even when the drawing was black — the wall sweats
  if (isRed || rng() < 0.3) {
    for (let i = 0; i < 1 + Math.floor(rng() * 3); i++) {
      drip(0.25 + rng() * 0.5, 0.3 + rng() * 0.35);
    }
  }

  // age it: eat random specks out so the ink looks worn into the wallpaper
  ctx.globalCompositeOperation = "destination-out";
  for (let i = 0; i < 900; i++) {
    ctx.globalAlpha = 0.12 + rng() * 0.3;
    const x = rng() * S, y = rng() * S;
    ctx.fillRect(x, y, 1 + rng() * 2.5, 1 + rng() * 2);
  }
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;

  const t = tex(canvas, { srgb: true, repeat: false });
  return t;
}
