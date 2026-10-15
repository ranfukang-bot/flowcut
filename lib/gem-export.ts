export function gemExportFiles(gems: Array<{ id: string; name: string; content: string }>) {
  return [{ name: 'FlowCut-Gems.json', content: JSON.stringify({ format: 'FlowCutGems', version: 1, exportedAt: new Date().toISOString(), gems }, null, 2), type: 'application/json' },
    ...gems.map((gem, index) => ({ name: `${String(index + 1).padStart(3, '0')}-${gem.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80) || 'Gem'}.txt`, content: gem.content, type: 'text/plain' }))];
}
