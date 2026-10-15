import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const npm = process.env.npm_execpath;
if (!npm) throw new Error('请通过 npm run verify 运行完整验证');

const checks = [
  ['lint', root, [npm, 'run', 'lint']],
  ['site tests (including build)', root, [npm, 'test']],
  ['desktop syntax', root, [npm, 'run', 'check', '--prefix', 'gemini-web-workbench']],
  ['desktop tests', root, [npm, 'test', '--prefix', 'gemini-web-workbench']],
  ['publisher tests (CHROMIUM_PATH supported)', fileURLToPath(new URL('../vendor/publisher/', import.meta.url)), ['--test', 'test/*.test.mjs']],
];

for (const [name, cwd, args] of checks) {
  console.log(`\n[verify] ${name}`);
  const result = spawnSync(process.execPath, args, { cwd, stdio: 'inherit', env: process.env, windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log('\n[verify] all checks passed');
