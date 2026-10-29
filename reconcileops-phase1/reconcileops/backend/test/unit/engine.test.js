import test from 'node:test';
import assert from 'node:assert/strict';
import { splitStatements } from '../../src/engine/sqlSplit.js';
import { checksum, compareVersions } from '../../src/engine/checksum.js';
import { analyzeMigration } from '../../src/engine/sqlAnalyzer.js';
import { evaluateMigration } from '../../src/engine/compatibility.js';
import { diffSchemas } from '../../src/engine/schemaDiff.js';
import { reconcile } from '../../src/engine/reconciler.js';

const kinds = (sql) => analyzeMigration(sql).findings.map((f) => `${f.kind}:${f.severity}`);

test('splitStatements respects strings, comments and dollar quotes', () => {
  const sql = `-- header; not a statement
    INSERT INTO t VALUES ('a;b'); /* x; y */
    CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql;
    SELECT 1`;
  const out = splitStatements(sql);
  assert.equal(out.length, 3);
  assert.match(out[0], /'a;b'/);
  assert.match(out[1], /RETURN 1; END;/);
});

test('checksum ignores line endings and BOM; versions compare numerically', () => {
  assert.equal(checksum('a\r\nb'), checksum('\uFEFFa\nb'));
  assert.notEqual(checksum('a'), checksum('b'));
  assert.equal(compareVersions('1.10', '1.2'), 1);
  assert.equal(compareVersions('2', '2.0'), 0);
});

test('analyzer: expand-phase changes are safe and reversible', () => {
  const a = analyzeMigration('ALTER TABLE products ADD COLUMN price_cents integer; CREATE INDEX CONCURRENTLY idx_p ON products(sku);');
  assert.equal(a.severity, 'SAFE');
  assert.equal(a.reversible, true);
  assert.equal(a.phase, 'expand');
});

test('analyzer: NOT NULL column needs a default', () => {
  assert.deepEqual(kinds('ALTER TABLE orders ADD COLUMN status text NOT NULL'), ['ADD_COLUMN_NOT_NULL_NO_DEFAULT:BREAKING']);
  assert.deepEqual(kinds("ALTER TABLE orders ADD COLUMN status text NOT NULL DEFAULT 'new'"), ['ADD_COLUMN:SAFE']);
});

test('analyzer: destructive changes are breaking and irreversible', () => {
  for (const sql of ['ALTER TABLE products DROP COLUMN price', 'DROP TABLE products', 'TRUNCATE products', 'DELETE FROM products']) {
    const a = analyzeMigration(sql);
    assert.equal(a.severity, 'BREAKING', sql);
    assert.equal(a.reversible, false, sql);
  }
  assert.deepEqual(kinds('ALTER TABLE products RENAME COLUMN price TO price_old'), ['RENAME_COLUMN:BREAKING']);
  assert.deepEqual(kinds('ALTER TABLE products ALTER COLUMN price TYPE bigint'), ['ALTER_TYPE:BREAKING']);
});

test('analyzer: comma-separated ALTER actions and CASCADE', () => {
  assert.deepEqual(kinds('ALTER TABLE p ADD COLUMN a numeric(10,2) DEFAULT 0, ADD COLUMN b text'), ['ADD_COLUMN:SAFE', 'ADD_COLUMN:SAFE']);
  assert.equal(analyzeMigration('DROP VIEW v CASCADE').severity, 'BREAKING');
});

test('analyzer: index without CONCURRENTLY is risky; unknown SQL is never assumed safe', () => {
  assert.deepEqual(kinds('CREATE INDEX i ON products(sku)'), ['CREATE_INDEX:RISKY']);
  assert.equal(analyzeMigration('GRANT ALL ON products TO bob').severity, 'RISKY');
  assert.equal(analyzeMigration('UPDATE products SET a = 1').severity, 'RISKY');
});

test('analyzer: mixing contract with expand is flagged', () => {
  const a = analyzeMigration('ALTER TABLE p ADD COLUMN x int; ALTER TABLE p DROP COLUMN y;');
  assert.ok(a.warnings.some((w) => w.startsWith('MIXED_PHASES')));
});

const orderContract = { service: 'order-service', version: '1.0', reads: { products: ['id', 'price'] }, writes: { orders: ['*'] } };

test('compatibility: dropping a column a deployed service reads is BLOCKED', () => {
  const r = evaluateMigration({ sql: 'ALTER TABLE products DROP COLUMN price', contracts: [orderContract] });
  assert.equal(r.verdict, 'BLOCK');
  assert.equal(r.violations[0].service, 'order-service');
});

test('compatibility: same drop passes the contract check once consumers moved (still needs review: irreversible)', () => {
  const moved = { ...orderContract, reads: { products: ['id', 'price_cents'] } };
  const r = evaluateMigration({ sql: 'ALTER TABLE products DROP COLUMN price', contracts: [moved] });
  assert.equal(r.violations.length, 0);
  assert.equal(r.verdict, 'REVIEW');
});

test('compatibility: inactive contracts are ignored; safe expand is SAFE', () => {
  const r1 = evaluateMigration({ sql: 'ALTER TABLE products DROP COLUMN price', contracts: [{ ...orderContract, active: false }] });
  assert.equal(r1.violations.length, 0);
  const r2 = evaluateMigration({ sql: 'ALTER TABLE products ADD COLUMN price_cents integer', contracts: [orderContract] });
  assert.equal(r2.verdict, 'SAFE');
});

test('compatibility: new NOT NULL rule breaks writers', () => {
  const r = evaluateMigration({ sql: 'ALTER TABLE orders ALTER COLUMN note SET NOT NULL', contracts: [orderContract] });
  assert.equal(r.verdict, 'BLOCK');
});

test('diffSchemas finds missing, unexpected and changed objects', () => {
  const expected = { tables: { products: { columns: { id: { type: 'integer', nullable: false }, price: { type: 'numeric', nullable: true } } } } };
  const actual = { tables: { products: { columns: { id: { type: 'bigint', nullable: false }, extra: { type: 'text', nullable: true } } }, stray: { columns: {} } } };
  const types = diffSchemas(expected, actual).map((d) => d.type).sort();
  assert.deepEqual(types, ['COLUMN_MISSING', 'COLUMN_TYPE_MISMATCH', 'COLUMN_UNEXPECTED', 'TABLE_UNEXPECTED']);
  assert.deepEqual(diffSchemas(expected, expected), []);
});

const f = (version, sum = version) => ({ version, filename: `V${version}__x.sql`, checksum: sum });
const h = (version, sum = version, success = true) => ({ version, checksum: sum, success });
const safe = { verdict: 'SAFE', violations: [], warnings: [], reversible: true, severity: 'SAFE' };
const schema = { tables: {} };

test('reconcile: IN_SYNC and PENDING', () => {
  assert.equal(reconcile({ files: [f('1')], history: [h('1')], expectedSchema: schema, actualSchema: schema }).state, 'IN_SYNC');
  const r = reconcile({ files: [f('1'), f('2')], history: [h('1')], expectedSchema: schema, actualSchema: schema, evaluations: { 2: safe } });
  assert.equal(r.state, 'PENDING');
  assert.deepEqual(r.plan.map((p) => p.action), ['APPLY']);
});

test('reconcile: edited applied migration blocks everything', () => {
  const r = reconcile({ files: [f('1', 'new'), f('2')], history: [h('1', 'old')], expectedSchema: schema, actualSchema: schema, evaluations: { 2: safe } });
  assert.equal(r.state, 'BLOCKED');
  assert.ok(r.items.some((i) => i.code === 'CHECKSUM_MISMATCH'));
  assert.equal(r.plan[0].action, 'HOLD');
});

test('reconcile: failed migration, out-of-order and missing file are detected', () => {
  assert.ok(reconcile({ files: [f('1')], history: [h('1', '1', false)], expectedSchema: schema, actualSchema: schema }).items.some((i) => i.code === 'FAILED_MIGRATION'));
  assert.ok(reconcile({ files: [f('1'), f('2')], history: [h('2')], expectedSchema: schema, actualSchema: schema }).items.some((i) => i.code === 'OUT_OF_ORDER'));
  assert.ok(reconcile({ files: [], history: [h('1')], expectedSchema: schema, actualSchema: schema }).items.some((i) => i.code === 'MISSING_FILE'));
});

test('reconcile: drift is reported and blocks the plan', () => {
  const exp = { tables: { products: { columns: { id: { type: 'integer', nullable: false } } } } };
  const r = reconcile({ files: [f('1'), f('2')], history: [h('1')], expectedSchema: exp, actualSchema: schema, evaluations: { 2: safe } });
  assert.equal(r.state, 'DRIFTED');
  assert.equal(r.plan[0].action, 'HOLD');
});

test('reconcile: blocked migration holds all later ones; review needs approval', () => {
  const block = { verdict: 'BLOCK', violations: [{ reason: 'order-service uses it' }], warnings: [], reversible: false, severity: 'BREAKING' };
  const review = { verdict: 'REVIEW', violations: [], warnings: [], reversible: false, severity: 'RISKY' };
  const base = { history: [], expectedSchema: schema, actualSchema: schema };
  const r1 = reconcile({ ...base, files: [f('1'), f('2')], evaluations: { 1: block, 2: safe } });
  assert.deepEqual(r1.plan.map((p) => p.action), ['BLOCKED', 'HOLD']);
  const r2 = reconcile({ ...base, files: [f('1')], evaluations: { 1: review } });
  assert.equal(r2.plan[0].action, 'NEEDS_APPROVAL');
  const r3 = reconcile({ ...base, files: [f('1')], evaluations: { 1: review }, approvals: new Set(['1']) });
  assert.equal(r3.plan[0].action, 'APPLY');
});
