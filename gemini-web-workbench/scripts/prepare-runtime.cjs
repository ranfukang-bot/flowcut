const fs = require("node:fs");
const path = require("node:path");

const desktopRoot = path.resolve(__dirname, "..");
const sourceRoot = path.resolve(desktopRoot, "..", "node_modules");
const output = path.join(desktopRoot, "runtime-deps", "node_modules");
if (!output.startsWith(desktopRoot + path.sep)) throw new Error("Invalid runtime output");
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
const visited = new Set();
let bytes = 0;
function copyTree(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    // Nested dependencies are selected separately, at their original resolution path.
    if (entry.name === "node_modules" || entry.name === ".cache") continue;
    const from = path.join(source, entry.name), to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else if (entry.isFile()) { fs.copyFileSync(from, to); bytes += fs.statSync(from).size; }
  }
}
function resolvePackage(name, from) {
  for (let dir = from; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", name);
    if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
    if (path.dirname(dir) === dir) throw new Error(`Missing runtime dependency: ${name}`);
  }
}
function include(name, from, optional = false) {
  let source;
  try { source = resolvePackage(name, from); } catch (error) { if (optional) return; throw error; }
  if (visited.has(source)) return;
  const relative = path.relative(sourceRoot, source);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Dependency outside workspace: ${name}`);
  const pkg = JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8"));
  const accepts = (values, actual) => !values || (!values.includes(`!${actual}`) && (values.every(v => v.startsWith("!")) || values.includes(actual)));
  if (optional && (!accepts(pkg.os, process.platform) || !accepts(pkg.cpu, process.arch))) return;
  visited.add(source);
  copyTree(source, path.join(output, relative));
  for (const dependency of Object.keys(pkg.dependencies || {})) include(dependency, source, Boolean(pkg.optionalDependencies?.[dependency]));
  for (const dependency of Object.keys(pkg.optionalDependencies || {})) include(dependency, source, true);
  for (const dependency of Object.keys(pkg.peerDependencies || {})) {
    if (!pkg.peerDependenciesMeta?.[dependency]?.optional) include(dependency, source);
  }
}
include("wrangler", path.dirname(sourceRoot));
fs.writeFileSync(path.join(desktopRoot, "runtime-deps", "manifest.json"), JSON.stringify({
  packages: [...visited].map(p => path.relative(sourceRoot, p)), bytes,
}, null, 2));
console.log(`Runtime prepared: ${visited.size} packages, ${(bytes / 1048576).toFixed(1)} MiB`);
