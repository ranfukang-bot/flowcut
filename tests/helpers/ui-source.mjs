import fs from 'node:fs';

// The studio UI is split across app/*.tsx files (one per page). Source checks
// that used to read app/studio-app.tsx read all of them together.
export function uiSource() {
  const dir = new URL('../../app/', import.meta.url);
  return fs.readdirSync(dir).filter(name => name.endsWith('.tsx')).sort()
    .map(name => fs.readFileSync(new URL(name, dir), 'utf8').replace(/\r\n/g, '\n')).join('\n');
}
