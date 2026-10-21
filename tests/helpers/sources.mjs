import fs from 'node:fs';

const read = (dir, filter) => fs.readdirSync(dir).filter(filter).sort()
  .map(name => fs.readFileSync(new URL(name, dir), 'utf8').replace(/\r\n/g, '\n')).join('\n');

// The studio UI is split across app/*.tsx files (one per page). Source checks
// that used to read app/studio-app.tsx read all of them together.
export function uiSource() {
  return read(new URL('../../app/', import.meta.url), name => name.endsWith('.tsx'));
}

// /api/gemini-bridge only routes; the logic lives in lib/gemini-bridge/.
export function bridgeSource() {
  return [fs.readFileSync(new URL('../../app/api/gemini-bridge/route.ts', import.meta.url), 'utf8'),
    read(new URL('../../lib/gemini-bridge/', import.meta.url), name => name.endsWith('.ts'))].join('\n');
}
