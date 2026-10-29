import { createHash } from 'node:crypto';

/**
 * SHA-256 of a migration file, ignoring a UTF-8 BOM and Windows/Unix
 * line-ending differences so the same file never "changes" just because
 * of how Git checked it out.
 */
export function checksum(content) {
  const normalized = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/** Compare dotted versions numerically: "1.10" > "1.2". */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}
