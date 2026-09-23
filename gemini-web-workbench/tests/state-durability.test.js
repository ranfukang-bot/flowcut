const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { Store } = require("../src/store");
const { WorkbenchStore } = require("../../vendor/seedance-engine/store");

function tempDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "flowcut-durability-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function truncate(file) {
  const text = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, text.slice(0, Math.floor(text.length / 2)));
}

function patchFs(t, name, replacement) {
  const original = fs[name];
  fs[name] = (...args) => replacement(original, ...args);
  const restore = () => {
    fs[name] = original;
  };
  t.after(restore);
  return restore;
}

function lockError(code = "EPERM") {
  return Object.assign(new Error(`${code}: operation not permitted`), { code });
}

test("a half-written main config is restored from its backup with the same accounts and keys", (t) => {
  const directory = tempDirectory(t);
  const app = { getPath: () => directory };
  const first = new Store(app);
  first.addAccount("Gemini A");
  first.addAccount("Gemini B");
  const keys = { ...first.state.settings };
  const file = path.join(directory, "workbench-state.json");
  truncate(file); // crash during a write

  const restored = new Store(app);
  assert.equal(restored.blocked, null);
  assert.deepEqual(restored.state.accounts.map((account) => account.name), ["Gemini A", "Gemini B"]);
  assert.equal(restored.state.settings.bridgeKey, keys.bridgeKey);
  assert.equal(restored.state.settings.credentialsMasterKey, keys.credentialsMasterKey);
  const preserved = fs.readdirSync(directory).filter((name) => name.includes(".corrupt-"));
  assert.equal(preserved.length, 1, "the damaged file is kept for inspection");

  // Later saves rotate the recovered (valid) state into the backup, never the damaged file.
  restored.log("after recovery");
  restored.log("second save");
  const backup = JSON.parse(fs.readFileSync(`${file}.bak`, "utf8"));
  assert.equal(backup.settings.bridgeKey, keys.bridgeKey);
  assert.equal(backup.accounts.length, 2);
});

test("a damaged main config without a valid backup stops startup and is left untouched", (t) => {
  const directory = tempDirectory(t);
  const app = { getPath: () => directory };
  const first = new Store(app);
  first.addAccount("Gemini A");
  const file = path.join(directory, "workbench-state.json");
  fs.rmSync(`${file}.bak`, { force: true });
  fs.writeFileSync(`${file}.bak`, "{\"settings\":{}}"); // a backup that fails validation
  truncate(file);
  const damaged = fs.readFileSync(file);
  const before = fs.readdirSync(directory).sort();

  const blocked = new Store(app);
  assert.ok(blocked.blocked, "startup is blocked");
  assert.match(blocked.blocked.message, /已停止启动/);
  assert.equal(blocked.state, null);
  assert.equal(blocked.save(), false);
  assert.deepEqual(fs.readFileSync(file), damaged, "damaged file is byte-for-byte unchanged");
  assert.deepEqual(fs.readdirSync(directory).sort(), before, "no file was created or renamed");
});

test("a missing main config next to existing site data is not treated as a first install", (t) => {
  const directory = tempDirectory(t);
  const siteData = path.join(directory, "site-runtime", "data");
  fs.mkdirSync(siteData, { recursive: true });
  const blocked = new Store({ getPath: () => directory }, { priorDataPaths: [siteData] });
  assert.ok(blocked.blocked);
  assert.equal(blocked.blocked.reason, "missing");
  assert.equal(fs.existsSync(path.join(directory, "workbench-state.json")), false);
});

test("a genuine first start still initializes new keys", (t) => {
  const directory = tempDirectory(t);
  const siteData = path.join(directory, "site-runtime", "data");
  const store = new Store({ getPath: () => directory }, { priorDataPaths: [siteData] });
  assert.ok(!store.blocked);
  assert.match(store.state.settings.bridgeKey, /^[a-f0-9]{64}$/);
  assert.ok(fs.existsSync(path.join(directory, "workbench-state.json")));
});

test("a briefly locked state file is retried instead of failing the save", (t) => {
  const directory = tempDirectory(t);
  const store = new WorkbenchStore(directory);
  let locks = 2;
  patchFs(t, "renameSync", (original, from, to) => {
    if (locks > 0 && String(to).endsWith("workbench-state.json")) {
      locks -= 1;
      throw lockError("EPERM");
    }
    return original(from, to);
  });
  store.upsertTask({ id: "t1", status: "generating", taskId: "7390000000000000123", logs: [] });
  assert.equal(store.persistError, null);
  const reloaded = new WorkbenchStore(directory);
  assert.equal(reloaded.getTask("t1").taskId, "7390000000000000123");
});

test("a save that keeps failing is reported once and does not throw into task logic", (t) => {
  const directory = tempDirectory(t);
  const events = [];
  const store = new WorkbenchStore(directory, {
    onPersistError: (problem) => events.push(["error", problem.code]),
    onPersistRecovered: () => events.push(["recovered"]),
  });
  let locked = true;
  patchFs(t, "renameSync", (original, from, to) => {
    if (locked && String(to).endsWith("workbench-state.json")) throw lockError("EBUSY");
    return original(from, to);
  });
  assert.doesNotThrow(() => store.upsertTask({ id: "t1", status: "generating", logs: [] }));
  assert.doesNotThrow(() => store.log("still running"));
  assert.deepEqual(events, [["error", "EBUSY"]]);
  assert.equal(store.getTask("t1").status, "generating", "memory keeps the newest state");
  locked = false;
  store.log("disk available again");
  assert.deepEqual(events, [["error", "EBUSY"], ["recovered"]]);
  assert.equal(new WorkbenchStore(directory).getTask("t1").status, "generating");
});

test("a damaged Seedance task list is restored from backup instead of emptied", (t) => {
  const directory = tempDirectory(t);
  const store = new WorkbenchStore(directory);
  store.upsertTask({ id: "t1", status: "generating", taskId: "7390000000000000123", logs: [] });
  store.upsertTask({ id: "t2", status: "success", logs: [] });
  truncate(path.join(directory, "workbench-state.json"));

  const restored = new WorkbenchStore(directory);
  assert.equal(restored.blocked, null);
  assert.equal(restored.loadResult.status, "recovered");
  assert.equal(restored.getTask("t1").taskId, "7390000000000000123");
});

test("a damaged Seedance task list without backup blocks instead of saving an empty list", (t) => {
  const directory = tempDirectory(t);
  const store = new WorkbenchStore(directory);
  store.upsertTask({ id: "t1", status: "generating", taskId: "7390000000000000123", logs: [] });
  const file = path.join(directory, "workbench-state.json");
  fs.rmSync(`${file}.bak`, { force: true });
  truncate(file);
  const damaged = fs.readFileSync(file);

  const blocked = new WorkbenchStore(directory);
  assert.ok(blocked.blocked);
  blocked.upsertTask({ id: "x", status: "queued", logs: [] });
  assert.deepEqual(fs.readFileSync(file), damaged);
});

test("a state file that cannot be read is not replaced by an older backup", (t) => {
  const directory = tempDirectory(t);
  const store = new WorkbenchStore(directory);
  store.upsertTask({ id: "old", status: "queued", logs: [] });
  store.upsertTask({ id: "new", status: "generating", taskId: "7390000000000000999", logs: [] });
  const file = path.join(directory, "workbench-state.json");
  const current = fs.readFileSync(file);
  const restore = patchFs(t, "readFileSync", (original, target, ...rest) => {
    if (target === file) throw lockError("EBUSY");
    return original(target, ...rest);
  });
  const blocked = new WorkbenchStore(directory);
  restore();
  assert.equal(blocked.blocked?.reason, "unreadable");
  assert.equal(blocked.save(), false);
  assert.deepEqual(fs.readFileSync(file), current, "the locked file keeps its newer data");
});

test("only a Seedance store with no files at all counts as a fresh workspace", (t) => {
  const directory = tempDirectory(t);
  assert.equal(new WorkbenchStore(directory).loadResult.status, "fresh");
  assert.equal(new WorkbenchStore(directory).loadResult.status, "loaded");
  fs.rmSync(path.join(directory, "workbench-state.json"));
  // The backup of an existing workspace is not a first start: the queue keeps its setting.
  assert.equal(new WorkbenchStore(directory).loadResult.status, "recovered");
});
