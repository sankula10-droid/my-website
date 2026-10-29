import { compareVersions } from './checksum.js';
import { diffSchemas } from './schemaDiff.js';

/**
 * State reconciliation: compare four things and say what must happen next.
 *
 *   files           desired state   [{ version, filename, checksum }]   (from Git / the repo)
 *   history         recorded state  [{ version, checksum, success }]    (what actually ran)
 *   expectedSchema  schema we get by replaying the *successfully applied* migrations
 *   actualSchema    schema read from the live database right now
 *   evaluations     { [version]: result of evaluateMigration() } for pending files
 *   approvals       Set of versions a human approved despite a REVIEW verdict
 *
 * Returns { state, items, plan }.
 *   state: BLOCKED > DRIFTED > PENDING > IN_SYNC
 *   plan : ordered steps for pending migrations. Migrations are strictly
 *          sequential, so once one step cannot proceed every later step is HOLD.
 */
export function reconcile({ files, history, expectedSchema, actualSchema, evaluations = {}, approvals = new Set() }) {
  const items = [];
  const byVersion = new Map(history.map((h) => [h.version, h]));
  const fileVersions = new Set(files.map((f) => f.version));
  const sortedFiles = [...files].sort((a, b) => compareVersions(a.version, b.version));

  const appliedOk = history.filter((h) => h.success);
  const highestApplied = appliedOk.map((h) => h.version).sort(compareVersions).at(-1) ?? null;

  const pending = [];
  for (const f of sortedFiles) {
    const h = byVersion.get(f.version);
    if (!h) {
      if (highestApplied !== null && compareVersions(f.version, highestApplied) < 0) {
        items.push({ code: 'OUT_OF_ORDER', severity: 'error', version: f.version, message: `Version ${f.version} is older than the latest applied version ${highestApplied} but was never applied.` });
      } else {
        pending.push(f);
        items.push({ code: 'PENDING', severity: 'info', version: f.version, message: `Version ${f.version} (${f.filename}) has not been applied.` });
      }
      continue;
    }
    if (!h.success) {
      items.push({ code: 'FAILED_MIGRATION', severity: 'error', version: f.version, message: `Version ${f.version} previously failed and must be resolved (retry or repair) before anything else runs.` });
      continue;
    }
    if (h.checksum !== f.checksum) {
      items.push({ code: 'CHECKSUM_MISMATCH', severity: 'error', version: f.version, message: `Version ${f.version} was edited after it was applied. Applied migrations are immutable; add a new version instead.` });
    }
  }
  for (const h of history) {
    if (!fileVersions.has(h.version)) {
      items.push({ code: 'MISSING_FILE', severity: 'warning', version: h.version, message: `Version ${h.version} is recorded as applied but its file is missing from the repository.` });
    }
  }

  const drift = diffSchemas(expectedSchema, actualSchema);
  for (const d of drift) {
    items.push({ code: 'SCHEMA_DRIFT', severity: 'error', table: d.table, column: d.column ?? null, detail: d, message: `Live schema differs from what the migration history implies: ${d.type} on ${d.table}${d.column ? '.' + d.column : ''}.` });
  }

  const hasBlocking = items.some((i) => ['FAILED_MIGRATION', 'CHECKSUM_MISMATCH', 'OUT_OF_ORDER'].includes(i.code));
  const hasDrift = drift.length > 0;

  const plan = [];
  let halted = hasBlocking || hasDrift;
  let haltReason = hasBlocking ? 'An earlier error blocks all migrations.' : hasDrift ? 'Schema drift must be resolved first.' : null;
  for (const f of pending) {
    const ev = evaluations[f.version];
    let action;
    let reason;
    if (halted) {
      action = 'HOLD'; reason = haltReason;
    } else if (!ev) {
      action = 'HOLD'; reason = 'Not validated yet.';
    } else if (ev.verdict === 'BLOCK') {
      action = 'BLOCKED'; reason = ev.violations.map((v) => v.reason).join(' ');
    } else if (ev.verdict === 'REVIEW' && !approvals.has(f.version)) {
      action = 'NEEDS_APPROVAL'; reason = [...ev.warnings, ev.reversible ? null : 'Not reversible.', ev.severity !== 'SAFE' ? `Static severity ${ev.severity}.` : null].filter(Boolean).join(' ');
    } else {
      action = 'APPLY'; reason = ev.verdict === 'REVIEW' ? 'Approved by a human.' : 'Validated as backward compatible and reversible.';
    }
    plan.push({ version: f.version, filename: f.filename, action, reason });
    if (action !== 'APPLY') { halted = true; haltReason = `Version ${f.version} cannot proceed (${action}).`; }
  }

  let state = 'IN_SYNC';
  if (pending.length > 0) state = 'PENDING';
  if (hasDrift) state = 'DRIFTED';
  if (hasBlocking) state = 'BLOCKED';
  return { state, items, plan };
}
