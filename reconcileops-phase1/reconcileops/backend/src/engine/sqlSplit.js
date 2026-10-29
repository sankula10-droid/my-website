/**
 * Split a SQL script into statements.
 * Understands: single-quoted strings, double-quoted identifiers,
 * line comments (--), block comments, and $tag$ ... $tag$ dollar-quoted
 * bodies (used by PL/pgSQL functions). Comments are removed from the output.
 */
export function splitStatements(sql) {
  const out = [];
  let buf = '';
  let i = 0;
  let dollarTag = null;
  const n = sql.length;
  const push = () => {
    const s = buf.trim();
    if (s) out.push(s);
    buf = '';
  };

  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];

    if (dollarTag) {
      if (sql.startsWith(dollarTag, i)) {
        buf += dollarTag;
        i += dollarTag.length;
        dollarTag = null;
      } else {
        buf += c;
        i++;
      }
      continue;
    }
    if (c === '-' && next === '-') {
      while (i < n && sql[i] !== '\n') i++;
      buf += ' ';
      continue;
    }
    if (c === '/' && next === '*') {
      const end = sql.indexOf('*' + '/', i + 2);
      i = end === -1 ? n : end + 2;
      buf += ' ';
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") { j += 2; continue; }
          break;
        }
        j++;
      }
      buf += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '"') {
      const j = sql.indexOf('"', i + 1);
      const end = j === -1 ? n - 1 : j;
      buf += sql.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (c === '$') {
      const m = /^\$[A-Za-z_]*\$/.exec(sql.slice(i, i + 64));
      if (m) {
        dollarTag = m[0];
        buf += dollarTag;
        i += dollarTag.length;
        continue;
      }
    }
    if (c === ';') {
      push();
      i++;
      continue;
    }
    buf += c;
    i++;
  }
  push();
  return out;
}

/** Split on commas that are not inside parentheses (ALTER TABLE a, b, c). */
export function splitTopLevelCommas(str) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of str) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}
