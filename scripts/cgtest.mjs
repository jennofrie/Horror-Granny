/**
 * Verifies the CrazyGames bundle actually runs when hosted from a CDN-style
 * subfolder (CrazyGames serves uploads under a deep path, not the domain
 * root). Serves out/ at /game/, boots the game headless, starts a run.
 *
 *   node scripts/packcg.mjs && node scripts/cgtest.mjs
 */
import puppeteer from "puppeteer-core";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import { extname, join, normalize } from "node:path";

const BROWSER = [
  process.env.BROWSER,
  `${process.env.HOME}/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`,
  `${process.env.HOME}/.cache/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell`,
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
].filter(Boolean).find((p) => existsSync(p));
if (!BROWSER) {
  console.error("No browser found — set BROWSER=/path/to/chrome");
  process.exit(1);
}
const PORT = 4173;
mkdirSync("scripts/shots", { recursive: true });

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain",
  ".svg": "image/svg+xml",
};

const server = createServer(async (req, res) => {
  let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (!path.startsWith("/game/")) {
    res.writeHead(404).end();
    return;
  }
  path = path.slice("/game/".length) || "index.html";
  if (path.endsWith("/")) path += "index.html";
  try {
    const file = normalize(join("out", path));
    if (!file.startsWith("out")) throw new Error("traversal");
    const body = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(PORT, r));

const browser = await puppeteer.launch({
  executablePath: BROWSER,
  headless: true,
  args: ["--no-sandbox", "--mute-audio", "--enable-unsafe-swiftshader", "--window-size=1280,720"],
  defaultViewport: { width: 1280, height: 720 },
});
const page = await browser.newPage();
const errors = [];
const missing = [];
page.on("pageerror", (err) => errors.push(`[pageerror] ${err.message}`));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`[console] ${m.text()}`);
});
page.on("response", (r) => {
  if (r.status() >= 400) missing.push(`${r.status()} ${r.url()}`);
});

await page.goto(`http://localhost:${PORT}/game/`, { waitUntil: "domcontentloaded", timeout: 60000 });

await page.waitForFunction(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("ENTER"));
  return b && !b.disabled;
}, { timeout: 30000 });
console.log("MENU FROM SUBFOLDER: OK");

await page.evaluate(() => {
  [...document.querySelectorAll("button")].find((x) => x.textContent.includes("ENTER")).click();
});

// Production build has no __backrooms dev handle — assert via the live HUD:
// menu gone, WebGL canvas mounted, objective + kill counter rendered.
let run = false;
try {
  await page.waitForFunction(() => {
    const enter = [...document.querySelectorAll("button")].some((b) =>
      b.textContent.includes("ENTER"),
    );
    const text = document.body.innerText;
    return (
      !enter &&
      !!document.querySelector("canvas") &&
      text.includes("FIND A WEAPON") &&
      text.includes("KILLS 0/3")
    );
  }, { timeout: 20000 });
  run = true;
} catch {}
console.log("GAME BOOTED:", run ? "OK (HUD live, canvas mounted)" : "FAILED");
await new Promise((r) => setTimeout(r, 1200));

await page.screenshot({ path: "scripts/shots/cg-subfolder.png" });
console.log("404s:", missing.length ? missing.join("\n") : "none");
console.log("ERRORS:", errors.length ? errors.join("\n") : "none");

await browser.close();
server.close();
if (!run || missing.length || errors.length) process.exit(1);
