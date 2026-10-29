/**
 * Snapshot shape:
 *   { tables: { <table>: { columns: { <col>: { type, nullable } } } } }
 * Column defaults are intentionally not compared in this version.
 */
export function diffSchemas(expected, actual) {
  const items = [];
  const exp = expected?.tables ?? {};
  const act = actual?.tables ?? {};

  for (const t of Object.keys(exp)) {
    if (!act[t]) { items.push({ type: 'TABLE_MISSING', table: t }); continue; }
    const ec = exp[t].columns ?? {};
    const ac = act[t].columns ?? {};
    for (const c of Object.keys(ec)) {
      if (!ac[c]) { items.push({ type: 'COLUMN_MISSING', table: t, column: c, expected: ec[c] }); continue; }
      if (ec[c].type !== ac[c].type) items.push({ type: 'COLUMN_TYPE_MISMATCH', table: t, column: c, expected: ec[c].type, actual: ac[c].type });
      if (Boolean(ec[c].nullable) !== Boolean(ac[c].nullable)) items.push({ type: 'NULLABILITY_MISMATCH', table: t, column: c, expected: Boolean(ec[c].nullable), actual: Boolean(ac[c].nullable) });
    }
    for (const c of Object.keys(ac)) {
      if (!ec[c]) items.push({ type: 'COLUMN_UNEXPECTED', table: t, column: c, actual: ac[c] });
    }
  }
  for (const t of Object.keys(act)) {
    if (!exp[t]) items.push({ type: 'TABLE_UNEXPECTED', table: t });
  }
  return items;
}
