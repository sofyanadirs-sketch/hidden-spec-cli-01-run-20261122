// mend: one patch tool for every AI edit format.
//
// Node 22, standard library only; run as `node main.ts [options] [PATCH]`.
// The working directory is the root of a tree of text files. mend reads a patch
// in one of four formats (unified diff, SEARCH/REPLACE blocks, V4A, JSON edits),
// finds the lines each edit names at the first of three matching tiers, and
// writes every change or none. SPEC.md is the whole contract.
//
// This file implements SPEC.md sections 1-10: the command line, output and exit
// codes, safe paths, format detection, three-tier line matching, the four patch
// readers, and the all-or-nothing write. The trial hand-over to runner.ts at the
// bottom is kept as the kit has it.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

// ---------- Files: lines, line break, final break (SPEC section 3) ----------

interface FileState {
  lines: string[];
  br: '\n' | '\r\n';
  final: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br: '\n' | '\r\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function renderFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

// ---------- Three-tier matching (SPEC section 5) ----------

const trimRightWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimRightWs(a) === trimRightWs(b);
  return trimWs(a) === trimWs(b);
}

/** Positions where O occurs in `file` at exactly this tier, at or after `from`. */
function occurrencesAt(file: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  outer: for (let i = from; i + o.length <= file.length; i++) {
    for (let k = 0; k < o.length; k++) {
      if (!lineEq(file[i + k], o[k], tier)) continue outer;
    }
    out.push(i);
  }
  return out;
}

/**
 * The first tier (0, then 1, then 2; 0 only with --strict) at which O occurs at
 * least once at or after `from`, with its positions. When `eof` is set only
 * occurrences ending at the file's last line count.
 */
function tierOccurrences(
  file: string[],
  o: string[],
  strict: boolean,
  from: number,
  eof = false,
): { tier: number; occ: number[] } | null {
  const maxTier = strict ? 0 : 2;
  for (let tier = 0; tier <= maxTier; tier++) {
    const occ = occurrencesAt(file, o, tier, from).filter((p) => !eof || p + o.length === file.length);
    if (occ.length > 0) return { tier, occ };
  }
  return null;
}

/** One line of N: a context line (the file's own line at O index `ctx`) or a new line. */
interface NewLine {
  text: string;
  ctx: number | null;
}

/**
 * Replace O at `pos` by N. Context lines are written as the file's own matched
 * lines; at tier 2 every other line of N is re-indented from O's first line's
 * leading whitespace to the file's first matched line's.
 */
function buildReplacement(file: string[], pos: number, o: string[], n: NewLine[], tier: number): string[] {
  const f = tier === 2 ? leadWs(file[pos]) : '';
  const p = tier === 2 ? leadWs(o[0]) : '';
  const rep: string[] = [];
  for (const item of n) {
    if (item.ctx !== null) {
      rep.push(file[pos + item.ctx]);
      continue;
    }
    let t = item.text;
    if (tier === 2 && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
    rep.push(t);
  }
  return [...file.slice(0, pos), ...rep, ...file.slice(pos + o.length)];
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { from: string; to: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------- JSON edits (SPEC section 9) ----------

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------- Unified diffs (SPEC section 6) ----------

interface BodyLine {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
}

interface Hunk {
  a: number;
  o: string[];
  n: NewLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noNewline: boolean;
  /** A `\` line follows the hunk's last `+` line. */
  lastPlusNoNewline: boolean;
}

function buildHunk(a: number, body: BodyLine[]): Hunk {
  const o: string[] = [];
  const n: NewLine[] = [];
  for (const b of body) {
    if (b.kind === ' ') {
      o.push(b.text);
      n.push({ text: b.text, ctx: o.length - 1 });
    } else if (b.kind === '-') o.push(b.text);
    else if (b.kind === '+') n.push({ text: b.text, ctx: null });
  }
  let lastCtxPlus = -1;
  let lastPlus = -1;
  for (let k = 0; k < body.length; k++) {
    if (body[k].kind === ' ' || body[k].kind === '+') lastCtxPlus = k;
    if (body[k].kind === '+') lastPlus = k;
  }
  const noNewline = lastCtxPlus >= 0 && body[lastCtxPlus + 1] !== undefined && body[lastCtxPlus + 1].kind === '\\';
  const lastPlusNoNewline = lastPlus >= 0 && body[lastPlus + 1] !== undefined && body[lastPlus + 1].kind === '\\';
  return { a, o, n, noNewline, lastPlusNoNewline };
}

interface Section {
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renameOld: string | undefined;
  renameNew: string | undefined;
  diffOld: string | undefined;
  diffNew: string | undefined;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

function blankSection(): Section {
  return {
    pairOld: undefined,
    pairNew: undefined,
    renameOld: undefined,
    renameNew: undefined,
    diffOld: undefined,
    diffNew: undefined,
    isCreate: false,
    isDelete: false,
    hunks: [],
  };
}

/** A `--- ` / `+++ ` path: text after the four characters, up to the first tab, trimmed. */
function headerPath(raw: string): string | null {
  const t = raw.split('\t')[0].trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) return t.slice(2);
  return t;
}

function applyHunks(f: FileState, hunks: Hunk[], strict: boolean, path: string): FileState {
  let cur = f;
  let d = 0;
  for (const h of hunks) {
    if (h.o.length === 0) {
      const pos = Math.max(0, Math.min(h.a + d, cur.lines.length));
      const atEnd = pos >= cur.lines.length;
      const add = h.n.map((x) => x.text);
      const lines = [...cur.lines.slice(0, pos), ...add, ...cur.lines.slice(pos)];
      cur = { lines, br: cur.br, final: atEnd ? !h.noNewline : cur.final };
      d += h.n.length;
      continue;
    }
    const found = tierOccurrences(cur.lines, h.o, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.occ[0];
    let bestDist = Math.abs(best - target);
    for (const p of found.occ) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const atEnd = best + h.o.length >= cur.lines.length;
    const lines = buildReplacement(cur.lines, best, h.o, h.n, found.tier);
    cur = { lines, br: cur.br, final: atEnd ? !h.noNewline : cur.final };
    d += h.n.length - h.o.length;
  }
  return cur;
}

function unifiedEdit(s: Section, strict: boolean): Edit {
  return (tree) => {
    const oldRaw = s.pairOld !== undefined ? s.pairOld : s.renameOld !== undefined ? s.renameOld : s.diffOld;
    const newRaw = s.pairNew !== undefined ? s.pairNew : s.renameNew !== undefined ? s.renameNew : s.diffNew;
    const oldP = oldRaw === undefined || oldRaw === '/dev/null' ? null : oldRaw;
    const newP = newRaw === undefined || newRaw === '/dev/null' ? null : newRaw;
    const isCreate = s.isCreate || oldP === null;
    const isDelete = !isCreate && (s.isDelete || newP === null);
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if (isCreate) {
      if (newP === null) throw new Fail('unsafe', '/dev/null');
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      let lastPlusNoNl = false;
      for (const h of s.hunks) {
        let hasPlus = false;
        for (const item of h.n) {
          if (item.ctx === null) {
            plus.push(item.text);
            hasPlus = true;
          }
        }
        if (hasPlus) lastPlusNoNl = h.lastPlusNoNewline;
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (lastPlusNoNl ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const op = oldP as string;
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    const op = oldP as string;
    const before = tree.get(op);
    if (before === null) throw new Fail('missing', op);
    const isMove = newP !== null && newP !== op;
    if (isMove && tree.get(newP as string) !== null) throw new Fail('exists', newP as string);
    const content = renderFile(applyHunks(parseFile(before), s.hunks, strict, op));
    if (isMove) {
      const np = newP as string;
      tree.now.set(op, null);
      tree.now.set(np, content);
      tree.moves.push({ from: op, to: np });
    } else {
      tree.now.set(op, content);
    }
  };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  let headerHasPair = false;
  const startSection = (s: Section): void => {
    sections.push(s);
    cur = s;
    inHeader = true;
    headerHasPair = false;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = blankSection();
      s.diffOld = m[1];
      s.diffNew = m[2];
      startSection(s);
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldP = headerPath(line.slice(4));
      const newP = headerPath(lines[i + 1].slice(4));
      if (cur !== null && inHeader && !headerHasPair) {
        cur.pairOld = oldP;
        cur.pairNew = newP;
        headerHasPair = true;
      } else {
        const s = blankSection();
        s.pairOld = oldP;
        s.pairNew = newP;
        startSection(s);
        headerHasPair = true;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      const body: BodyLine[] = [];
      i++;
      while (i < lines.length) {
        const bl = lines[i];
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '' || bl[0] === ' ' || bl[0] === '-' || bl[0] === '+' || bl[0] === '\\') {
          body.push({ kind: (bl === '' ? ' ' : bl[0]) as BodyLine['kind'], text: bl === '' ? '' : bl.slice(1) });
          i++;
          continue;
        }
        break;
      }
      while (body.length > 0 && body[body.length - 1].kind === ' ' && body[body.length - 1].text === '') body.pop();
      cur.hunks.push(buildHunk(Number(m[1]), body));
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) cur.renameOld = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameNew = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.isCreate = true;
      else if (line.startsWith('deleted file mode')) cur.isDelete = true;
      i++;
      continue;
    }
    i++;
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

// ---------- SEARCH/REPLACE blocks (SPEC section 7) ----------

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = parseFile(before);
    const found = tierOccurrences(f.lines, oldLines, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const nItems: NewLine[] = newLines.map((t) => ({ text: t, ctx: null }));
    const rep = buildReplacement(f.lines, found.occ[0], oldLines, nItems, found.tier);
    tree.now.set(path, renderFile({ lines: rep, br: f.br, final: f.final }));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchNo = i + 1;
    let path: string | null = null;
    for (let k = i - 1; k >= prevEnd; k--) {
      const t = lines[k];
      if (blank(t)) continue;
      if (t.trim().startsWith('```')) continue;
      path = t.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchNo}`);
      path = prevPath;
    }
    let j = i + 1;
    while (j < lines.length && lines[j].trimEnd() !== '=======') j++;
    if (j >= lines.length) throw new Exit2(`error: parse ${searchNo}`);
    const oldLines = lines.slice(i + 1, j);
    let k = j + 1;
    while (k < lines.length && lines[k].trimEnd() !== '>>>>>>> REPLACE') k++;
    if (k >= lines.length) throw new Exit2(`error: parse ${searchNo}`);
    const newLines = lines.slice(j + 1, k);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = k + 1;
    i = k + 1;
  }
  return edits;
}

// ---------- V4A patches (SPEC section 8) ----------

interface VChunk {
  anchor: string | null;
  o: string[];
  n: NewLine[];
  eof: boolean;
}

function vAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function vDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function vUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let f = parseFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const anchor = ch.anchor;
        let foundAt: number | null = null;
        const maxTier = strict ? 0 : 2;
        for (let tier = 0; tier <= maxTier && foundAt === null; tier++) {
          for (let k = cursor; k < f.lines.length; k++) {
            if (lineEq(f.lines[k], anchor, tier)) {
              foundAt = k;
              break;
            }
          }
        }
        if (foundAt === null) throw new Fail('no-match', path);
        cursor = foundAt + 1;
      }
      if (ch.o.length === 0) {
        const pos = ch.eof ? f.lines.length : cursor;
        const add = ch.n.map((x) => x.text);
        f = { lines: [...f.lines.slice(0, pos), ...add, ...f.lines.slice(pos)], br: f.br, final: f.final };
        cursor = pos + add.length;
        continue;
      }
      const found = tierOccurrences(f.lines, ch.o, strict, cursor, ch.eof);
      if (found === null) throw new Fail('no-match', path);
      const pos = found.occ[0];
      const rep = buildReplacement(f.lines, pos, ch.o, ch.n, found.tier);
      f = { lines: rep, br: f.br, final: f.final };
      cursor = pos + ch.n.length;
    }
    const content = renderFile(f);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, content);
      tree.moves.push({ from: path, to: moveTo });
    } else {
      tree.now.set(path, content);
    }
  };
}

/** Parse one Update File section's body (lines[start..end), trailing blanks already trimmed). */
function parseV4aUpdate(lines: string[], start: number, end: number, updateLine: number): { moveTo: string | null; chunks: VChunk[] } {
  let moveTo: string | null = null;
  const chunks: VChunk[] = [];
  let i = start;
  let cur: VChunk | null = null;
  let started = false;
  const closeChunk = (): void => {
    if (cur !== null) {
      chunks.push(cur);
      cur = null;
    }
  };
  if (i < end && lines[i].startsWith('*** Move to: ')) {
    moveTo = lines[i].slice('*** Move to: '.length).trim();
    i++;
  }
  while (i < end) {
    const l = lines[i];
    if (l.startsWith('@@')) {
      closeChunk();
      const anchor = l.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, o: [], n: [], eof: false };
      started = true;
      i++;
      continue;
    }
    if (l === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      cur.eof = true;
      closeChunk();
      i++;
      continue;
    }
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      if (cur === null) {
        if (started) throw new Exit2(`error: parse ${i + 1}`);
        cur = { anchor: null, o: [], n: [], eof: false };
        started = true;
      }
      const text = l === '' ? '' : l.slice(1);
      if (l === '' || l[0] === ' ') {
        cur.o.push(text);
        cur.n.push({ text, ctx: cur.o.length - 1 });
      } else if (l[0] === '-') cur.o.push(text);
      else cur.n.push({ text, ctx: null });
      i++;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  closeChunk();
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
  return { moveTo, chunks };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first].trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k])) {
      last = k;
      break;
    }
  }
  if (lines[last].trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i];
    if (blank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: ') || line.startsWith('*** Update File: ')) {
      const isAdd = line.startsWith('*** Add File: ');
      const isDelete = line.startsWith('*** Delete File: ');
      const prefix = isAdd ? '*** Add File: ' : isDelete ? '*** Delete File: ' : '*** Update File: ';
      const path = line.slice(prefix.length).trim();
      const updateLine = i + 1;
      const start = i + 1;
      let end = start;
      while (end < last && !isSectionStart(lines[end])) end++;
      let e = end;
      while (e > start && blank(lines[e - 1])) e--;
      if (isAdd) {
        const fileLines: string[] = [];
        for (let k = start; k < e; k++) {
          const l = lines[k];
          if (l === '') {
            fileLines.push('');
            continue;
          }
          if (l.startsWith('+')) {
            fileLines.push(l.slice(1));
            continue;
          }
          throw new Exit2(`error: parse ${k + 1}`);
        }
        edits.push(vAddEdit(path, fileLines));
      } else if (isDelete) {
        for (let k = start; k < e; k++) throw new Exit2(`error: parse ${k + 1}`);
        edits.push(vDeleteEdit(path));
      } else {
        const { moveTo, chunks } = parseV4aUpdate(lines, start, e, updateLine);
        edits.push(vUpdateEdit(path, moveTo, chunks, strict));
      }
      i = end;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

// ---------- Run (SPEC sections 1, 2 and 10) ----------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const byPath = new Map<string, string>();
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    byPath.set(p, `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
  }
  const rows: { key: string; text: string }[] = [];
  for (const [p, t] of byPath) rows.push({ key: p, text: t });
  for (const m of tree.moves) {
    if (tree.original(m.from) !== null && tree.get(m.from) === null && tree.original(m.to) === null && tree.get(m.to) !== null) {
      const oi = rows.findIndex((r) => r.key === m.from);
      if (oi >= 0) rows.splice(oi, 1);
      const ni = rows.findIndex((r) => r.key === m.to);
      if (ni >= 0) rows.splice(ni, 1);
      rows.push({ key: m.to, text: `R ${m.from} -> ${m.to}` });
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outRows = rows.map((r) => r.text);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outRows, `ok: ${outRows.length} ${outRows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
