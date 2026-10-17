const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

// Separate processes exercise both module orders without a warm require cache.
// The composer-first order matches SeedanceRuntime during desktop startup.
const scenario = `
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const [source, root, order] = process.argv.slice(1);
for (const name of order === 'composer-first'
  ? ['dual-video-composer', 'video-review'] : ['video-review', 'dual-video-composer']) {
  require(path.join(source, name));
}
const {VideoReview, reviewDirectory} = require(path.join(source, 'video-review'));
const {segmentDirectory, probe} = require(path.join(source, 'dual-video-composer'));
assert.equal(segmentDirectory(root, 'clip-a', 1), path.join(reviewDirectory(root, 'clip-a'), 'segments', '1'));
const ids = ['clip-a', 'clip-b'];
const sources = ids.map((id, index) => {
  const folder = reviewDirectory(root, id);
  fs.mkdirSync(folder, {recursive: true});
  const file = path.join(folder, 'input.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i',
    'color=c=' + (index ? 'blue' : 'red') + ':s=128x256:r=30:d=1.2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', file], {windowsHide: true});
  return {id, download_path: file};
});
const actions = [];
const review = new VideoReview({userData: root, request: async (_route, init) => {
  const body = JSON.parse(init.body);
  actions.push(body.action);
  return body.action === 'concat-reserve' ? {sources} : {ok: true};
}});
(async () => {
  const result = await review.concat('group', ids, true, 'joined');
  const media = await probe(result.file);
  assert.ok(Math.abs(Number(media.format.duration) - 2.4) < 0.3);
  assert.deepEqual(actions, ['concat-reserve', 'concat-finish']);
  assert.ok(sources.every(item => fs.existsSync(item.download_path)));
  console.log(JSON.stringify({pass: true, order, duration: Number(media.format.duration)}));
})().catch(error => {console.error(error); process.exitCode = 1;});
`;

for (const order of ['composer-first', 'review-first']) {
  test(`default video review concatenates real clips after ${order} startup`, {timeout: 60000}, t => {
    const prefix = path.join(os.tmpdir(), 'flowcut-concat-startup-');
    const root = fs.mkdtempSync(prefix);
    t.after(() => {
      assert.ok(path.resolve(root).startsWith(path.resolve(prefix)));
      fs.rmSync(root, {recursive: true, force: true});
    });
    const child = spawnSync(process.execPath, ['-e', scenario, path.resolve(__dirname, '../src'), root, order],
      {encoding: 'utf8', windowsHide: true, timeout: 55000});
    assert.equal(child.status, 0, child.stderr || String(child.error));
    assert.equal(JSON.parse(child.stdout.trim()).pass, true);
    assert.doesNotMatch(child.stderr, /circular dependency/);
  });
}
