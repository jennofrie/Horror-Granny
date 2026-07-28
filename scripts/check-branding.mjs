import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const skipped = new Set([".git", ".next", "node_modules", "out"]);
const errors = [];

function walk(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && skipped.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(absolute));
    else files.push(absolute);
  }
  return files;
}

function read(file) {
  return fs.readFileSync(path.join(root, file), "utf8");
}

function requireFile(file) {
  if (!fs.existsSync(path.join(root, file))) errors.push(`missing required file: ${file}`);
}

const required = [
  "README.md",
  "LICENSE",
  "TRADEMARKS.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "ROADMAP.md",
  "CHANGELOG.md",
  "public/assets/ATTRIBUTION.md",
  "public/assets/manifest.json",
  ".github/CODEOWNERS",
  ".github/workflows/quality.yml",
];
required.forEach(requireFile);

const markdown = walk(root).filter((file) => path.extname(file).toLowerCase() === ".md");
const notice = [
  "Horror Granny™",
  "Copyright © 2026 Profexor",
  "trademark rights",
];

for (const file of markdown) {
  const contents = fs.readFileSync(file, "utf8").toLowerCase();
  for (const part of notice) {
    if (!contents.includes(part.toLowerCase())) {
      errors.push(`${path.relative(root, file)} is missing notice text: ${part}`);
    }
  }
}

if (fs.existsSync(path.join(root, "LICENSE"))) {
  const license = read("LICENSE");
  if (!license.startsWith("MIT License")) errors.push("LICENSE is not MIT");
  if (!license.includes("Copyright (c) 2026 Profexor")) {
    errors.push("LICENSE is missing the Profexor copyright");
  }
}

if (fs.existsSync(path.join(root, "package.json"))) {
  const pkg = JSON.parse(read("package.json"));
  if (pkg.author !== "Profexor") errors.push("package author must be Profexor");
  if (pkg.license !== "MIT") errors.push("package license must be MIT");
}

const ownedSurfaces = [
  "README.md",
  "app/layout.tsx",
  "app/game/GameShell.tsx",
  "package.json",
].filter((file) => fs.existsSync(path.join(root, file)))
  .map(read)
  .join("\n")
  .toLowerCase();

const retiredCredits = [
  ["a game by ", "Jen", "nofrie"].join(""),
  ["name: \"", "Jen", "nofrie", "\""].join(""),
  ["creator: \"", "Jen", "nofrie", "\""].join(""),
  ["by [", "Jen", "nofrie", "]"].join(""),
];
for (const retired of retiredCredits) {
  if (ownedSurfaces.includes(retired.toLowerCase())) {
    errors.push("a retired project-author credit remains");
  }
}

if (fs.existsSync(path.join(root, "public/assets/ATTRIBUTION.md"))) {
  const attribution = read("public/assets/ATTRIBUTION.md");
  for (const requiredText of ["CC-BY", "Kevin MacLeod", "Steel Wasp", "Vlasov Daniil"]) {
    if (!attribution.includes(requiredText)) {
      errors.push(`required third-party attribution is missing: ${requiredText}`);
    }
  }
}

if (errors.length) {
  console.error("Ownership integrity check failed:\n");
  errors.forEach((error) => console.error(`  - ${error}`));
  process.exit(1);
}

console.log(`Ownership integrity passed: ${markdown.length} Markdown files checked.`);
console.log("MIT owner: Profexor. Project identity: Horror Granny™.");
console.log("Required third-party asset attribution is present.");
