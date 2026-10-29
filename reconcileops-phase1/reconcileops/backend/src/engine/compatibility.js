import { analyzeMigration } from './sqlAnalyzer.js';

/**
 * Consumer contracts describe what each deployed service version needs from
 * the database:
 *   { service, version, active, reads: { table: [cols] }, writes: { table: [cols] } }
 * Use ['*'] for "all columns". Only contracts with active !== false count.
 */

const touches = (map, table, column) => {
  const cols = map?.[table];
  if (!cols) return false;
  if (!column) return true;
  return cols.includes('*') || cols.includes(column);
};

const READ_WRITE_KINDS = new Set(['DROP_COLUMN', 'RENAME_COLUMN', 'ALTER_TYPE']);
const TABLE_KINDS = new Set(['DROP_TABLE', 'RENAME_TABLE', 'TRUNCATE']);

export function checkCompatibility(findings, contracts = []) {
  const violations = [];
  const active = contracts.filter((c) => c.active !== false);

  for (const f of findings) {
    for (const c of active) {
      const who = { service: c.service, version: c.version ?? null, kind: f.kind, table: f.table, column: f.column, sql: f.sql };

      if (READ_WRITE_KINDS.has(f.kind) && (touches(c.reads, f.table, f.column) || touches(c.writes, f.table, f.column))) {
        violations.push({ ...who, reason: `${c.service} still uses ${f.table}.${f.column}, which this migration ${f.kind === 'DROP_COLUMN' ? 'removes' : f.kind === 'RENAME_COLUMN' ? 'renames' : 'retypes'}.` });
      } else if (TABLE_KINDS.has(f.kind) && (touches(c.reads, f.table) || touches(c.writes, f.table))) {
        violations.push({ ...who, reason: `${c.service} still uses table ${f.table}, which this migration removes, renames or empties.` });
      } else if ((f.kind === 'SET_NOT_NULL' || f.kind === 'ADD_COLUMN_NOT_NULL_NO_DEFAULT') && touches(c.writes, f.table)) {
        violations.push({ ...who, reason: `${c.service} writes to ${f.table} and does not know about the new NOT NULL rule; its INSERT/UPDATE statements would fail.` });
      }
    }
  }
  return violations;
}

/**
 * Full evaluation used by the pipeline.
 *   BLOCK   a deployed service would break
 *   REVIEW  nothing breaks today, but a human should look (risky, irreversible, mixed phases, empty)
 *   SAFE    backward compatible and reversible
 */
export function evaluateMigration({ sql, contracts = [] }) {
  const analysis = analyzeMigration(sql);
  const violations = checkCompatibility(analysis.findings, contracts);
  let verdict = 'SAFE';
  if (analysis.severity !== 'SAFE' || !analysis.reversible || analysis.warnings.length > 0) verdict = 'REVIEW';
  if (violations.length > 0) verdict = 'BLOCK';
  return { ...analysis, violations, verdict };
}
