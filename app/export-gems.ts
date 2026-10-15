import { gemExportFiles } from '../lib/gem-export';
export { gemExportFiles } from '../lib/gem-export';
export async function exportAllGems(gems: Parameters<typeof gemExportFiles>[0]) {
  const desktop = (window as unknown as { flowcutDesktop?: { exportAllGems?: () => Promise<unknown> } }).flowcutDesktop;
  if (desktop?.exportAllGems) return desktop.exportAllGems();
  for (const file of gemExportFiles(gems)) {
    const url = URL.createObjectURL(new Blob([file.content], { type: file.type + ';charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = file.name; document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
}
