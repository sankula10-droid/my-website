import { splitStatements, splitTopLevelCommas } from './sqlSplit.js';

/**
 * Static analysis of a PostgreSQL migration script.
 *
 * This is deliberately a *conservative pattern analyzer*, not a full SQL
 * parser. Anything it does not recognise is reported as UNKNOWN and sent to
 * human review rather than being assumed safe.
 *
 * Each finding has:
 *   kind        what the statement does (ADD_COLUMN, DROP_COLUMN, ...)
 *   severity    SAFE | RISKY | BREAKING   (static, before looking at consumers)
 *   phase       expand | migrate | contract | other   (expand-and-contract)
 *   reversible  false unless we are sure it can be undone without data loss
 *   lock        none | brief | heavy | data   (how much it may block traffic)
 */

const ID = String.raw`(?:"[^"]+"|[A-Za-z_][\w$]*)`;
const REF = String.raw`(?:${ID}\.)?(${ID})`; // captures table name, schema stripped
const rx = (src) => new RegExp(src, 'i');
const unq = (s) => s.replace(/^"|"$/g, '').toLowerCase();

const RE = {
  createTable: rx(String.raw`^create (?:unlogged |temp |temporary )?table (?:if not exists )?${REF}`),
  dropTable: rx(String.raw`^drop table (?:if exists )?${REF}`),
  alterTable: rx(String.raw`^alter table (?:if exists )?(?:only )?${REF} (.+)$`),
  createIndex: rx(String.raw`^create (?:unique )?index (concurrently )?(?:if not exists )?(?:${ID} )?on (?:only )?${REF}`),
  dropIndex: rx(String.raw`^drop index`),
  update: rx(String.raw`^update (?:only )?${REF} set `),
  insert: rx(String.raw`^insert into ${REF}`),
  delete: rx(String.raw`^delete from (?:only )?${REF}`),
  truncate: rx(String.raw`^truncate (?:table )?(?:only )?${REF}`),
  createObj: rx(String.raw`^create (or replace )?(?:materialized )?(view|function|procedure|trigger|extension|type|sequence|schema)\b`),
  dropObj: rx(String.raw`^drop (view|materialized view|function|procedure|trigger|extension|type|sequence|schema|database)\b`),
  comment: rx(String.raw`^comment on `),
  noop: rx(String.raw`^(begin|commit|start transaction|set |analyze|vacuum)\b`),
};

const ACT = {
  addConstraint: rx(String.raw`^add (?:constraint|primary key|foreign key|unique|check|exclude)\b`),
  addColumn: rx(String.raw`^add (?:column )?(?:if not exists )?(${ID}) (.+)$`),
  dropConstraint: rx(String.raw`^drop constraint\b`),
  dropColumn: rx(String.raw`^drop (?:column )?(?:if exists )?(${ID})(?: .*)?$`),
  renameConstraint: rx(String.raw`^rename constraint\b`),
  renameTable: rx(String.raw`^rename to (${ID})$`),
  renameColumn: rx(String.raw`^rename (?:column )?(${ID}) to (${ID})$`),
  alterType: rx(String.raw`^alter (?:column )?(${ID}) (?:set data )?type (.+)$`),
  setNotNull: rx(String.raw`^alter (?:column )?(${ID}) set not null\b`),
  dropNotNull: rx(String.raw`^alter (?:column )?(${ID}) drop not null\b`),
  defaultChange: rx(String.raw`^alter (?:column )?(${ID}) (?:set|drop) default\b`),
};

const VOLATILE_DEFAULT = /\b(random|gen_random_uuid|uuid_generate_v\d|clock_timestamp|nextval)\s*\(/i;

function finding(base) {
  return { column: null, lock: 'none', ...base };
}

function analyzeAlterAction(action, table, ctx) {
  const a = action.replace(/\s+/g, ' ').trim();
  let m;

  if (ACT.addConstraint.test(a)) {
    const notValid = /\bnot valid\b/i.test(a);
    return finding({
      ...ctx, table, kind: 'ADD_CONSTRAINT', severity: 'RISKY', phase: 'expand',
      reversible: true, lock: notValid ? 'brief' : 'heavy',
      message: 'Adds a constraint; existing rows may violate it and validation can block writes.',
      recommendation: notValid
        ? 'Run VALIDATE CONSTRAINT in a later step.'
        : 'Add with NOT VALID, then VALIDATE CONSTRAINT separately to avoid long locks.',
    });
  }
  if (ACT.dropConstraint.test(a)) {
    return finding({
      ...ctx, table, kind: 'DROP_CONSTRAINT', severity: 'RISKY', phase: 'contract',
      reversible: false, lock: 'brief',
      message: 'Drops a constraint; its definition is lost unless stored elsewhere.',
      recommendation: 'Keep the constraint definition in a down-script or note.',
    });
  }
  if (ACT.renameConstraint.test(a)) {
    return finding({
      ...ctx, table, kind: 'RENAME_CONSTRAINT', severity: 'SAFE', phase: 'other',
      reversible: true, lock: 'brief', message: 'Renames a constraint.',
    });
  }
  if ((m = ACT.renameTable.exec(a))) {
    return finding({
      ...ctx, table, kind: 'RENAME_TABLE', severity: 'BREAKING', phase: 'contract',
      reversible: true, lock: 'brief',
      message: `Renames table ${table}; every consumer using the old name breaks immediately.`,
      recommendation: 'Create the new table, dual-write/backfill, migrate consumers, then drop the old one.',
    });
  }
  if ((m = ACT.renameColumn.exec(a))) {
    const column = unq(m[1]);
    return finding({
      ...ctx, table, column, kind: 'RENAME_COLUMN', severity: 'BREAKING', phase: 'contract',
      reversible: true, lock: 'brief',
      message: `Renames ${table}.${column}; consumers using the old name break immediately.`,
      recommendation: 'Expand: add the new column and sync it. Contract: drop the old column after all consumers moved.',
    });
  }
  if ((m = ACT.setNotNull.exec(a))) {
    const column = unq(m[1]);
    return finding({
      ...ctx, table, column, kind: 'SET_NOT_NULL', severity: 'BREAKING', phase: 'contract',
      reversible: true, lock: 'heavy',
      message: `Makes ${table}.${column} NOT NULL; fails if NULLs exist and rejects old writers that omit it.`,
      recommendation: 'Backfill first, deploy writers that always set it, then add a CHECK ... NOT VALID and validate.',
    });
  }
  if ((m = ACT.dropNotNull.exec(a))) {
    return finding({
      ...ctx, table, column: unq(m[1]), kind: 'DROP_NOT_NULL', severity: 'SAFE', phase: 'expand',
      reversible: true, lock: 'brief', message: 'Relaxes a NOT NULL constraint.',
    });
  }
  if ((m = ACT.defaultChange.exec(a))) {
    return finding({
      ...ctx, table, column: unq(m[1]), kind: 'CHANGE_DEFAULT', severity: 'SAFE', phase: 'other',
      reversible: false, lock: 'brief', message: 'Changes a column default (previous default is not recorded).',
    });
  }
  if ((m = ACT.alterType.exec(a))) {
    const column = unq(m[1]);
    return finding({
      ...ctx, table, column, kind: 'ALTER_TYPE', severity: 'BREAKING', phase: 'contract',
      reversible: false, lock: 'heavy',
      message: `Changes the type of ${table}.${column}; may rewrite the table and break consumers that expect the old type.`,
      recommendation: 'Expand: add a new column of the new type, backfill, switch consumers, contract: drop the old one.',
    });
  }
  // Order matters: ADD ... must be tested after ADD CONSTRAINT, DROP ... after DROP CONSTRAINT.
  if ((m = ACT.addColumn.exec(a))) {
    const column = unq(m[1]);
    const rest = m[2];
    const notNull = /\bnot null\b/i.test(rest);
    const hasDefault = /\bdefault\b|^(?:big|small)?serial\b|\bgenerated\b/i.test(rest);
    const volatile = VOLATILE_DEFAULT.test(rest);
    const heavyInline = /\bunique\b|\bprimary key\b|\breferences\b/i.test(rest);
    if (notNull && !hasDefault) {
      return finding({
        ...ctx, table, column, kind: 'ADD_COLUMN_NOT_NULL_NO_DEFAULT', severity: 'BREAKING', phase: 'expand',
        reversible: true, lock: 'heavy',
        message: `Adds NOT NULL column ${table}.${column} without a default; fails on non-empty tables and breaks old INSERTs.`,
        recommendation: 'Add the column as nullable (or with a default), backfill, then tighten later.',
      });
    }
    return finding({
      ...ctx, table, column, kind: 'ADD_COLUMN',
      severity: volatile || heavyInline ? 'RISKY' : 'SAFE', phase: 'expand',
      reversible: true, lock: volatile ? 'heavy' : 'brief',
      message: volatile
        ? 'Adds a column with a volatile default, which rewrites the whole table.'
        : heavyInline
          ? 'Adds a column with an inline unique/key/reference that builds an index or validates rows.'
          : `Adds column ${table}.${column} (backward compatible).`,
    });
  }
  if ((m = ACT.dropColumn.exec(a))) {
    const column = unq(m[1]);
    return finding({
      ...ctx, table, column, kind: 'DROP_COLUMN', severity: 'BREAKING', phase: 'contract',
      reversible: false, lock: 'brief',
      message: `Drops ${table}.${column}; data is lost and consumers still reading it break.`,
      recommendation: 'Only drop in a later "contract" release after no deployed version uses the column; back up first.',
    });
  }
  return finding({
    ...ctx, table, kind: 'UNKNOWN_ALTER', severity: 'RISKY', phase: 'other', reversible: false, lock: 'brief',
    message: 'Unrecognised ALTER TABLE action; needs human review.',
  });
}

export function analyzeStatement(sql, statementIndex = 0) {
  const s = sql.replace(/\s+/g, ' ').trim();
  const ctx = { statementIndex, sql: s };
  let m;
  let findings;

  if ((m = RE.createTable.exec(s))) {
    findings = [finding({ ...ctx, table: unq(m[1]), kind: 'CREATE_TABLE', severity: 'SAFE', phase: 'expand', reversible: true, message: `Creates table ${unq(m[1])}.` })];
  } else if ((m = RE.dropTable.exec(s))) {
    findings = [finding({ ...ctx, table: unq(m[1]), kind: 'DROP_TABLE', severity: 'BREAKING', phase: 'contract', reversible: false, lock: 'brief', message: `Drops table ${unq(m[1])} and all of its data.`, recommendation: 'Only after no consumer uses it; take a backup first.' })];
  } else if ((m = RE.alterTable.exec(s))) {
    const table = unq(m[1]);
    findings = splitTopLevelCommas(m[2]).map((act) => analyzeAlterAction(act, table, ctx));
  } else if ((m = RE.createIndex.exec(s))) {
    const concurrent = Boolean(m[1]);
    findings = [finding({
      ...ctx, table: unq(m[2]), kind: 'CREATE_INDEX', severity: concurrent ? 'SAFE' : 'RISKY', phase: 'expand',
      reversible: true, lock: concurrent ? 'none' : 'heavy',
      message: concurrent ? 'Builds an index without blocking writes.' : 'CREATE INDEX without CONCURRENTLY blocks writes while it builds.',
      recommendation: concurrent ? 'Must run outside a transaction.' : 'Use CREATE INDEX CONCURRENTLY.',
    })];
  } else if (RE.dropIndex.test(s)) {
    findings = [finding({ ...ctx, table: null, kind: 'DROP_INDEX', severity: 'SAFE', phase: 'contract', reversible: false, lock: 'brief', message: 'Drops an index (definition is not recorded).' })];
  } else if ((m = RE.update.exec(s))) {
    const hasWhere = /\bwhere\b/i.test(s);
    findings = [finding({
      ...ctx, table: unq(m[1]), kind: 'UPDATE', severity: hasWhere ? 'SAFE' : 'RISKY', phase: 'migrate',
      reversible: false, lock: 'data',
      message: hasWhere ? 'Data backfill/update with a WHERE clause.' : 'UPDATE without WHERE rewrites every row in one transaction.',
      recommendation: hasWhere ? undefined : 'Backfill in batches.',
    })];
  } else if ((m = RE.insert.exec(s))) {
    findings = [finding({ ...ctx, table: unq(m[1]), kind: 'INSERT', severity: 'SAFE', phase: 'migrate', reversible: true, lock: 'data', message: 'Inserts rows.' })];
  } else if ((m = RE.delete.exec(s))) {
    const hasWhere = /\bwhere\b/i.test(s);
    findings = [finding({
      ...ctx, table: unq(m[1]), kind: 'DELETE', severity: hasWhere ? 'RISKY' : 'BREAKING', phase: 'migrate',
      reversible: false, lock: 'data',
      message: hasWhere ? 'Deletes rows; not recoverable without a backup.' : 'DELETE without WHERE removes every row.',
    })];
  } else if ((m = RE.truncate.exec(s))) {
    findings = [finding({ ...ctx, table: unq(m[1]), kind: 'TRUNCATE', severity: 'BREAKING', phase: 'contract', reversible: false, lock: 'heavy', message: 'TRUNCATE removes all rows.' })];
  } else if ((m = RE.createObj.exec(s))) {
    findings = [finding({ ...ctx, table: null, kind: 'CREATE_OBJECT', severity: 'SAFE', phase: 'expand', reversible: !m[1], message: `Creates a ${m[2].toLowerCase()}${m[1] ? ' (or replaces an existing one; old definition is lost)' : ''}.` })];
  } else if ((m = RE.dropObj.exec(s))) {
    findings = [finding({ ...ctx, table: null, kind: 'DROP_OBJECT', severity: 'RISKY', phase: 'contract', reversible: false, lock: 'brief', message: `Drops a ${m[1].toLowerCase()}.` })];
  } else if (RE.comment.test(s) || RE.noop.test(s)) {
    findings = [finding({ ...ctx, table: null, kind: 'NOOP', severity: 'SAFE', phase: 'other', reversible: true, message: 'No schema impact.' })];
  } else {
    findings = [finding({ ...ctx, table: null, kind: 'UNKNOWN', severity: 'RISKY', phase: 'other', reversible: false, message: 'Statement not recognised by the analyzer; needs human review.' })];
  }

  if (/^(drop|alter)\b/i.test(s) && /\bcascade\b/i.test(s)) {
    findings = findings.map((f) => ({
      ...f, severity: 'BREAKING', reversible: false,
      message: `${f.message} CASCADE also removes dependent objects.`,
    }));
  }
  return findings;
}

const RANK = { SAFE: 0, RISKY: 1, BREAKING: 2 };
const worst = (list) => list.reduce((w, f) => (RANK[f.severity] > RANK[w] ? f.severity : w), 'SAFE');

export function analyzeMigration(sql) {
  const statements = splitStatements(sql);
  const findings = statements.flatMap((st, i) => analyzeStatement(st, i));
  const phases = [...new Set(findings.map((f) => f.phase).filter((p) => p !== 'other'))].sort();
  const warnings = [];
  if (statements.length === 0) warnings.push('EMPTY: the migration contains no SQL statements.');
  if (phases.includes('contract') && phases.length > 1) {
    warnings.push('MIXED_PHASES: contract-phase changes are combined with expand/migrate changes. Ship them in separate releases.');
  }
  return {
    statementCount: statements.length,
    findings,
    severity: worst(findings),
    reversible: findings.length > 0 && findings.every((f) => f.reversible),
    phase: phases.length ? phases.join('+') : 'none',
    warnings,
  };
}
