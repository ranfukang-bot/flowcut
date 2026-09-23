const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const sourceRoot = path.resolve(__dirname, "..", "src");

test("desktop license distribution supports owned primary and legacy control planes", () => {
  const client = fs.readFileSync(
    path.join(sourceRoot, "license-client.js"),
    "utf8",
  );
  const distribution = JSON.parse(
    fs.readFileSync(
      path.join(sourceRoot, "license-distribution.json"),
      "utf8",
    ),
  );
  assert.ok(distribution.defaultControlPlaneId);
  assert.ok(distribution.legacyControlPlaneId);
  assert.ok(Array.isArray(distribution.controlPlanes));
  assert.ok(distribution.controlPlanes[0].publicJwk);
  assert.match(client, /controlPlaneId/);
  assert.match(client, /LEGACY_CONTROL_PLANE_ID/);
  assert.match(client, /for \(const controlPlane of CONTROL_PLANES\)/);
  assert.match(
    client,
    /this\.saved\.controlPlaneId === LEGACY_CONTROL_PLANE_ID/,
  );
  assert.match(client, /授权中心已升级，请使用正式账号重新登录/);
});
