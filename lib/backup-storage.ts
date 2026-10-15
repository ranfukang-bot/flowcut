export const BACKUP_WARNING_BYTES = 5_000_000_000;
export type BackupMetadata = { path: string; mediaCount: number; createdAt: string };
export type BackupStorage = {
  directory?: string;
  busy?: boolean;
  backupCount: number;
  totalBytes: number;
  overLimit: boolean;
  latest: { path: string; zipBytes: number; mediaCount: number | null; createdAt: string } | null;
};

export function summarizeBackupStorage(files: Array<{ path: string; name: string; bytes: number }>, metadata: BackupMetadata | null = null): BackupStorage {
  const ordered = [...files].sort((a, b) => b.name.localeCompare(a.name));
  const totalBytes = ordered.reduce((total, file) => total + file.bytes, 0);
  const file = ordered[0], known = file && metadata?.path === file.path;
  return {
    backupCount: ordered.length, totalBytes, overLimit: totalBytes > BACKUP_WARNING_BYTES,
    latest: file ? { path: file.path, zipBytes: file.bytes, mediaCount: known ? metadata!.mediaCount : null, createdAt: known ? metadata!.createdAt : '' } : null,
  };
}

export function formatBackupBytes(bytes: number) {
  for (const [unit, size] of [['GB', 1e9], ['MB', 1e6], ['KB', 1e3]] as const) if (bytes >= size) return `${(bytes / size).toFixed(2)} ${unit}`;
  return `${bytes} B`;
}

export function backupCompletionSummary(result: { zipBytes: number; backupCount: number; totalBytes: number; mediaCount: number }) {
  return `本份 ZIP ${formatBackupBytes(result.zipBytes)}，保留 ${result.backupCount} 份合计 ${formatBackupBytes(result.totalBytes)}，媒体对象 ${result.mediaCount} 个`;
}
