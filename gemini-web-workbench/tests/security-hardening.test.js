const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const desktopRoot = path.resolve(__dirname, "..");
const workspaceRoot = path.resolve(desktopRoot, "..");

test("release packaging excludes the editable FlowCut source tree", () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(desktopRoot, "package.json"), "utf8"),
  );
  const siteResource = pkg.build.extraResources.find(
    (item) => item.to === "flowcut-site",
  );
  assert.deepEqual(siteResource.filter, ["dist/**/*"]);
  assert.equal(
    pkg.build.extraResources.some((item) => item.to === "seedance-engine"),
    false,
  );
  assert.deepEqual(pkg.build.files, ["dist-protected/**/*", "package.json"]);
});

test("personal desktop executors have no cloud execution permit dependency", () => {
  const main = fs.readFileSync(path.join(desktopRoot, "src", "main.js"), "utf8");
  const bridge = fs.readFileSync(
    path.join(desktopRoot, "src", "bridge-engine.js"),
    "utf8",
  );
  const seedanceBridge = fs.readFileSync(
    path.join(workspaceRoot, "vendor", "seedance-engine", "flowcut-bridge.js"),
    "utf8",
  );
  assert.doesNotMatch(main, /licenseClient|authorizeExecution/);
  assert.doesNotMatch(bridge, /authorizeJob/);
  assert.doesNotMatch(seedanceBridge, /authorizeJob/);
});

test("protected build contains bytecode without editable authorization modules", () => {
  const output = path.join(desktopRoot, "dist-protected");
  assert.equal(fs.existsSync(path.join(output, "main.jsc")), true);
  assert.equal(fs.existsSync(path.join(output, "main.bundle.cjs")), false);
  assert.equal(fs.existsSync(path.join(output, "license-client.js")), false);
  assert.equal(fs.existsSync(path.join(output, "bridge-engine.js")), false);
  assert.equal(fs.existsSync(path.join(output, "seedance-runtime.js")), false);
  const geminiPreload = fs.readFileSync(
    path.join(output, "gemini-preload.js"),
    "utf8",
  );
  assert.doesNotMatch(geminiPreload, /rich-textarea|responseMarkdown|runReferenceRemixJob/);
  assert.ok(Buffer.byteLength(geminiPreload) < 5_000);
});

test("desktop business APIs require the per-launch local token", () => {
  const worker = fs.readFileSync(
    path.join(workspaceRoot, "worker", "index.ts"),
    "utf8",
  );
  assert.match(worker, /FLOWCUT_DESKTOP_TOKEN/);
  assert.match(worker, /x-flowcut-desktop-token/);
  assert.match(worker, /constantTimeEqual/);
});
