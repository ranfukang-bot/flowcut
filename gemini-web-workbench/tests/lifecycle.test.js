const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const projectRoot = path.resolve(__dirname, "..");

test("new and first-migrated personal workspaces start paused", () => {
  const source = fs.readFileSync(
    path.join(projectRoot, "src", "seedance-runtime.js"),
    "utf8",
  );
  assert.match(source, /const isFreshEmbeddedState = !fs\.existsSync/);
  assert.match(
    source,
    /running:\s*this\.startPaused \|\| isFreshEmbeddedState\s*\?\s*false\s*:\s*this\.store\.settings\.running !== false/,
  );
});

test("closing the visible FlowCut window also closes hidden login windows", () => {
  const source = fs.readFileSync(
    path.join(projectRoot, "src", "main.js"),
    "utf8",
  );
  assert.match(source, /mainWindow\.on\("closed"/);
  assert.match(source, /if \(!app\.isQuitting\) app\.quit\(\)/);
  assert.match(source, /app\.on\("before-quit"/);
  assert.match(source, /seedanceRuntime\?\.stop\(\)/);
});

test("packaged local site is isolated and automatically restarted after a crash", () => {
  const source = fs.readFileSync(
    path.join(projectRoot, "src", "main.js"),
    "utf8",
  );
  assert.match(source, /function scheduleLocalSiteRestart/);
  assert.match(source, /function startLocalSiteHealthMonitor/);
  assert.match(source, /localSiteHealthFailures < 3/);
  assert.match(source, /FlowCut 本机服务已自动恢复/);
  assert.match(source, /FLOWCUT_DESKTOP_RUNTIME: "1"/);
  assert.match(source, /wranglerCli/);
  assert.match(source, /utilityProcess\.fork/);
  assert.match(source, /persistTo:/);
  assert.match(source, /FLOWCUT_DESKTOP_TOKEN/);
  assert.match(source, /data\.desktopRuntime === true/);
});
