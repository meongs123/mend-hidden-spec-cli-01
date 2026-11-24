// mend: one CLI patch tool for every AI edit format.
//
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks,
// V4A, JSON edits), finds the lines each edit names at the first of three
// matching tiers, and writes every change or none. SPEC.md is the contract.
//
// Node 22, standard library only. Run as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node main.ts` with MAKEFUN_ENV_URL set, and
// then this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** Thrown to answer exit 2 with one line. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** Thrown by an edit that fails; the run reports it and keeps going. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines (SPEC section 3): split at \n, one trailing \r removed
 *  per line, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

function checkSafe(p: string): void {
  if (!safe(p)) throw new Fail('unsafe', p);
}

const leadWs = (s: string): string => (s.match(/^[ \t]*/) ?? [''])[0]!;
const trailTrim = (s: string): string => s.replace(/[ \t]+$/, '');
const bothTrim = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const wsOnly = (s: string): boolean => /^[ \t]*$/.test(s);

/** A file as lines: its line break, its lines, whether it ends with a break. */
interface FileModel {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileModel {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function renderFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted),
 *  the rest read from disk. Existence (anything at the path, file or
 *  directory) is kept apart from file contents, so a create or move target
 *  naming a directory reports `exists` and a change naming one `missing`. */
class Tree {
  private readonly origContent = new Map<string, string | null>();
  private readonly origExists = new Map<string, boolean>();
  readonly now = new Map<string, string | null>();
  readonly moves: { old: string; nw: string }[] = [];

  /** The file's original bytes, or null when it is not a regular file. */
  content(p: string): string | null {
    if (!this.origContent.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.origContent.set(p, v);
    }
    return this.origContent.get(p)!;
  }

  /** Whether anything at all (file or directory) sat at the path. */
  existed(p: string): boolean {
    if (!this.origExists.has(p)) {
      let v = false;
      try {
        statSync(p);
        v = true;
      } catch {
        v = false;
      }
      this.origExists.set(p, v);
    }
    return this.origExists.get(p)!;
  }

  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.content(p);
  }

  existsNow(p: string): boolean {
    if (this.now.has(p)) return this.now.get(p) !== null;
    return this.existed(p);
  }
}

type Edit = (tree: Tree) => void;

/** One body line of a hunk or chunk: context, old, new, or a `\` line. */
interface BodyItem {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
}

const norm = (s: string, tier: number): string => (tier === 0 ? s : tier === 1 ? trailTrim(s) : bothTrim(s));

interface Found {
  tier: number;
  positions: number[];
}

/** The first tier at which O occurs in `lines` (at or after `from`), and
 *  every occurrence position at that tier (absolute, overlapping allowed). */
function findOcc(O: string[], lines: string[], strict: boolean, from = 0): Found | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const normO = O.map((l) => norm(l, t));
    const normF = lines.map((l) => norm(l, t));
    const pos: number[] = [];
    const last = lines.length - O.length;
    for (let i = from; i <= last; i++) {
      let ok = true;
      for (let j = 0; j < O.length; j++) {
        if (normF[i + j] !== normO[j]) {
          ok = false;
          break;
        }
      }
      if (ok) pos.push(i);
    }
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}

/** Split body items into O (context + old) and N (context + new). */
function splitBody(items: BodyItem[]): { o: BodyItem[]; n: BodyItem[] } {
  return {
    o: items.filter((it) => it.kind === 'ctx' || it.kind === 'old'),
    n: items.filter((it) => it.kind === 'ctx' || it.kind === 'new'),
  };
}

/** Build the replacement lines for an occurrence at `pos` of tier `tier`:
 *  context lines are the file's own matched lines; every other line of N
 *  is re-indented at tier 2 (F/P rule) and written as it is at tiers 0/1. */
function buildNew(n: BodyItem[], o: BodyItem[], fileLines: string[], pos: number, tier: number): string[] {
  const oCtxIdx: number[] = [];
  o.forEach((it, idx) => {
    if (it.kind === 'ctx') oCtxIdx.push(idx);
  });
  const F = leadWs(fileLines[pos] ?? '');
  const P = o.length > 0 ? leadWs(o[0]!.text) : '';
  const out: string[] = [];
  let m = 0;
  for (const it of n) {
    if (it.kind === 'ctx') {
      out.push(fileLines[pos + oCtxIdx[m]!]!);
      m += 1;
    } else if (tier === 2) {
      const t = it.text;
      if (t !== '' && !wsOnly(t) && t.startsWith(P)) out.push(F + t.slice(P.length));
      else out.push(t);
    } else {
      out.push(it.text);
    }
  }
  return out;
}

/** Format detection (SPEC section 4). */
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

/* ---------------- JSON edits (SPEC section 9) ---------------- */

/** One JSON edit object, or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  const p = o.path;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    const text = o.file_text;
    return (tree) => {
      checkSafe(p);
      if (tree.existsNow(p)) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      checkSafe(p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + toLf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    const lineNo = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      checkSafe(p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const model = splitFile(before);
      if (lineNo < 0 || lineNo > model.lines.length) throw new Fail('no-match', p);
      model.lines.splice(lineNo, 0, ...add);
      tree.now.set(p, renderFile(model.lines, model.br, model.final));
    };
  }
  return null;
}

function parseJson(text: string, lines: string[]): Edit[] {
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

/* ---------------- Unified diffs (SPEC section 6) ---------------- */

interface Hunk {
  a: number;
  items: BodyItem[];
  noEol: boolean;
}

interface Section {
  /** Old path from the ---/+++ pair: undefined = no pair, null = /dev/null. */
  oldDash: string | null | undefined;
  newDash: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  diffOld: string | undefined;
  diffNew: string | undefined;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_RE = /^diff --git a\/([^ \t]+) b\/([^ \t]+)$/;

/** A ---/+++ path: text after the four characters, up to the first tab,
 *  surrounding spaces removed, a leading a/ or b/ removed; /dev/null is null. */
function dashPath(line: string): string | null {
  let p = line.slice(4).split('\t', 1)[0]!.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p === '/dev/null' ? null : p;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  let hasDashPair = false;
  let hunk: Hunk | null = null;

  const finishHunk = (): void => {
    if (hunk === null) return;
    while (hunk.items.length > 0) {
      const last = hunk.items[hunk.items.length - 1]!;
      if (last.kind === 'ctx' && last.text === '') hunk.items.pop();
      else break;
    }
    let lastCtxNew = -1;
    hunk.items.forEach((it, k) => {
      if (it.kind === 'ctx' || it.kind === 'new') lastCtxNew = k;
    });
    hunk.noEol = lastCtxNew >= 0 && hunk.items[lastCtxNew + 1]?.kind === 'bs';
    hunk = null;
  };

  const startSection = (oldP: string | null, newP: string | null, fromPair: boolean): void => {
    finishHunk();
    cur = {
      oldDash: fromPair ? oldP : undefined,
      newDash: fromPair ? newP : undefined,
      renameFrom: undefined,
      renameTo: undefined,
      diffOld: fromPair ? undefined : (oldP ?? undefined),
      diffNew: fromPair ? undefined : (newP ?? undefined),
      create: false,
      del: false,
      hunks: [],
    };
    sections.push(cur);
    inHeader = true;
    hasDashPair = fromPair;
  };

  const isBodyLine = (l: string): boolean =>
    l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith('@@')) {
      const m = HUNK_RE.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      finishHunk();
      hunk = { a: Number(m[1]), items: [], noEol: false };
      cur.hunks.push(hunk);
      inHeader = false;
      continue;
    }
    if (hunk !== null) {
      if (line.startsWith('diff --git ') || (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) {
        finishHunk();
      } else if (isBodyLine(line)) {
        const kind: BodyItem['kind'] =
          line === '' || line[0] === ' ' ? 'ctx' : line[0] === '-' ? 'old' : line[0] === '+' ? 'new' : 'bs';
        hunk.items.push({ kind, text: line === '' ? '' : line.slice(1) });
        continue;
      } else {
        finishHunk();
      }
    }
    if (line.startsWith('diff --git ')) {
      const m = DIFF_RE.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      startSection(m[1]!, m[2]!, false);
      continue;
    }
    if (line.startsWith('--- ')) {
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        if (cur !== null && inHeader && !hasDashPair) {
          cur.oldDash = dashPath(line);
          cur.newDash = dashPath(lines[i + 1]!);
          hasDashPair = true;
          i += 1;
          continue;
        }
        startSection(dashPath(line), dashPath(lines[i + 1]!), true);
        i += 1;
        continue;
      }
      if (cur !== null && inHeader) throw new Exit2(`error: parse ${i + 2}`);
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('rename from ')) {
        cur.renameFrom = line.slice('rename from '.length).trim();
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameTo = line.slice('rename to '.length).trim();
        continue;
      }
      if (line === 'new file mode' || line.startsWith('new file mode ')) {
        cur.create = true;
        continue;
      }
      if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) {
        cur.del = true;
        continue;
      }
      continue;
    }
  }
  finishHunk();
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedEdit(s, strict));
}

/** Apply a section's hunks in order to a file's text. */
function applyHunks(content: string, hunks: Hunk[], strict: boolean, path: string): string {
  const model = splitFile(content);
  let d = 0;
  for (const h of hunks) {
    const { o, n } = splitBody(h.items);
    if (o.length === 0) {
      const idx = Math.min(Math.max(h.a + d, 0), model.lines.length);
      const atEnd = idx === model.lines.length;
      const add = n.map((it) => it.text);
      model.lines.splice(idx, 0, ...add);
      if (atEnd) model.final = !h.noEol;
      d += n.length;
    } else {
      const found = findOcc(
        o.map((it) => it.text),
        model.lines,
        strict,
      );
      if (!found) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.positions[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.positions) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const atEnd = best + o.length === model.lines.length;
      const rep = buildNew(n, o, model.lines, best, found.tier);
      model.lines.splice(best, o.length, ...rep);
      if (atEnd) model.final = !h.noEol;
      d += n.length - o.length;
    }
  }
  return renderFile(model.lines, model.br, model.final);
}

function unifiedEdit(s: Section, strict: boolean): Edit {
  const oldRaw: string | null = s.oldDash !== undefined ? s.oldDash : (s.renameFrom ?? s.diffOld ?? '');
  const newRaw: string | null = s.newDash !== undefined ? s.newDash : (s.renameTo ?? s.diffNew ?? '');
  const isCreate = oldRaw === null || s.create;
  const isDelete = !isCreate && (newRaw === null || s.del);
  const isMove = !isCreate && !isDelete && oldRaw !== newRaw;
  const oldP: string = oldRaw ?? '';
  const newP: string = newRaw === null ? '/dev/null' : newRaw;
  return (tree) => {
    if (isCreate) {
      checkSafe(newP);
      if (tree.existsNow(newP)) throw new Fail('exists', newP);
      const plus: string[] = [];
      for (const h of s.hunks) {
        for (const it of h.items) if (it.kind === 'new') plus.push(it.text);
      }
      let noEol = false;
      outer: for (let hi = s.hunks.length - 1; hi >= 0; hi--) {
        const items = s.hunks[hi]!.items;
        for (let k = items.length - 1; k >= 0; k--) {
          if (items[k]!.kind === 'new') {
            noEol = items[k + 1]?.kind === 'bs';
            break outer;
          }
        }
      }
      tree.now.set(newP, renderFile(plus, '\n', plus.length > 0 && !noEol));
      return;
    }
    if (isDelete) {
      checkSafe(oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (isMove) {
      checkSafe(oldP);
      checkSafe(newP);
      const cur = tree.get(oldP);
      if (cur === null) throw new Fail('missing', oldP);
      if (tree.existsNow(newP)) throw new Fail('exists', newP);
      const out = applyHunks(cur, s.hunks, strict, oldP);
      tree.now.set(newP, out);
      tree.now.set(oldP, null);
      tree.moves.push({ old: oldP, nw: newP });
      return;
    }
    checkSafe(oldP);
    const cur = tree.get(oldP);
    if (cur === null) throw new Fail('missing', oldP);
    tree.now.set(oldP, applyHunks(cur, s.hunks, strict, oldP));
  };
}

/* ---------------- SEARCH/REPLACE blocks (SPEC section 7) ---------------- */

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    checkSafe(path);
    if (oldLines.length === 0) {
      if (tree.existsNow(path)) throw new Fail('exists', path);
      tree.now.set(path, renderFile(newLines, '\n', newLines.length > 0));
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const model = splitFile(cur);
    const found = findOcc(oldLines, model.lines, strict);
    if (!found) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const rep = buildNew(
      newLines.map((t) => ({ kind: 'new' as const, text: t })),
      oldLines.map((t) => ({ kind: 'old' as const, text: t })),
      model.lines,
      found.positions[0]!,
      found.tier,
    );
    model.lines.splice(found.positions[0]!, oldLines.length, ...rep);
    tree.now.set(path, renderFile(model.lines, model.br, model.final));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  for (;;) {
    let s = -1;
    for (let k = i; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '<<<<<<< SEARCH') {
        s = k;
        break;
      }
    }
    if (s < 0) break;
    let eq = -1;
    for (let k = s + 1; k < lines.length; k++) {
      const t = lines[k]!.trimEnd();
      if (t === '=======') {
        eq = k;
        break;
      }
      if (t === '<<<<<<< SEARCH' || t === '>>>>>>> REPLACE') throw new Exit2(`error: parse ${s + 1}`);
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let k = eq + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    let path: string | null = null;
    for (let k = s - 1; k > prevReplaceEnd; k--) {
      const l = lines[k]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    prevPath = path;
    edits.push(srEdit(path, lines.slice(s + 1, eq), lines.slice(eq + 1, rep), strict));
    prevReplaceEnd = rep;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/* ---------------- V4A patches (SPEC section 8) ---------------- */

interface VChunk {
  anchor: string | null;
  items: BodyItem[];
  eof: boolean;
}

const isSectionHead = (l: string): boolean =>
  l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    checkSafe(path);
    if (tree.existsNow(path)) throw new Fail('exists', path);
    tree.now.set(path, renderFile(fileLines, '\n', fileLines.length > 0));
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    checkSafe(path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    checkSafe(path);
    if (moveTo !== null) checkSafe(moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.existsNow(moveTo)) throw new Fail('exists', moveTo);
    const model = splitFile(cur);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const found = findOcc([ch.anchor], model.lines, strict, cursor);
        if (!found) throw new Fail('no-match', path);
        cursor = found.positions[0]! + 1;
      }
      const { o, n } = splitBody(ch.items);
      if (o.length === 0) {
        const idx = ch.eof ? model.lines.length : cursor;
        const add = n.map((it) => it.text);
        model.lines.splice(idx, 0, ...add);
        cursor = idx + add.length;
      } else {
        const found = findOcc(
          o.map((it) => it.text),
          model.lines,
          strict,
          cursor,
        );
        if (!found) throw new Fail('no-match', path);
        // SPEC section 8: the tier is the first tier with an occurrence
        // (section 5); an end-of-file chunk takes only an occurrence that
        // ends at the file's last line, at that tier.
        const pos = ch.eof
          ? found.positions.find((p) => p + o.length === model.lines.length)
          : found.positions[0]!;
        if (pos === undefined) throw new Fail('no-match', path);
        const rep = buildNew(n, o, model.lines, pos, found.tier);
        model.lines.splice(pos, o.length, ...rep);
        cursor = pos + rep.length;
      }
    }
    const out = renderFile(model.lines, model.br, model.final);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      tree.moves.push({ old: path, nw: moveTo });
    } else {
      tree.now.set(path, out);
    }
  };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  for (;;) {
    while (i < last && blank(lines[i]!)) i += 1;
    if (i >= last) break;
    const line = lines[i]!;
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      i += 1;
      const rawStart = i;
      while (i < last && !isSectionHead(lines[i]!)) i += 1;
      const raw = lines.slice(rawStart, i);
      // SPEC section 8: blank lines at the end of a section are not part
      // of it; a blank line is empty or only whitespace.
      while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
      const fileLines = raw.map((l, k) => {
        if (l.startsWith('+')) return l.slice(1);
        if (l === '') return '';
        throw new Exit2(`error: parse ${rawStart + k + 1}`);
      });
      edits.push(v4aAddEdit(path, fileLines));
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      i += 1;
      while (i < last) {
        const l = lines[i]!;
        if (isSectionHead(l)) break;
        if (blank(l)) {
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      edits.push(v4aDeleteEdit(path));
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const headerLine = i + 1;
      const path = line.slice('*** Update File: '.length).trim();
      i += 1;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i += 1;
      }
      const rawStart = i;
      while (i < last) {
        if (isSectionHead(lines[i]!)) break;
        i += 1;
      }
      const raw = lines.slice(rawStart, i);
      while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
      const chunks: VChunk[] = [];
      let chunk: VChunk | null = null;
      for (let k = 0; k < raw.length; k++) {
        const l = raw[k]!;
        if (l === '*** End of File') {
          if (chunk === null) throw new Exit2(`error: parse ${rawStart + k + 1}`);
          chunk.eof = true;
          chunks.push(chunk);
          chunk = null;
          continue;
        }
        if (l.startsWith('@@')) {
          if (chunk !== null) chunks.push(chunk);
          const at = l.slice(2).trim();
          chunk = { anchor: at === '' ? null : at, items: [], eof: false };
          continue;
        }
        if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (chunk === null) chunk = { anchor: null, items: [], eof: false };
          const kind: BodyItem['kind'] = l === '' || l[0] === ' ' ? 'ctx' : l[0] === '-' ? 'old' : 'new';
          chunk.items.push({ kind, text: l === '' ? '' : l.slice(1) });
          continue;
        }
        throw new Exit2(`error: parse ${rawStart + k + 1}`);
      }
      if (chunk !== null) chunks.push(chunk);
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/* ---------------- The run (SPEC sections 1, 2, 10) ---------------- */

const byteCmp = (a: string, b: string): number => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

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
    edits =
      kind === 'json'
        ? parseJson(text, lines)
        : kind === 'unified'
          ? parseUnified(lines, strict)
          : kind === 'search-replace'
            ? parseSearchReplace(lines, strict)
            : parseV4a(lines, strict);
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
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }
  const rows: { key: string; text: string }[] = [];
  const covered = new Set<string>();
  for (const m of tree.moves) {
    if (tree.content(m.old) !== null && tree.get(m.old) === null && tree.get(m.nw) !== null && tree.content(m.nw) === null) {
      rows.push({ key: m.nw, text: `R ${m.old} -> ${m.nw}` });
      covered.add(m.old);
      covered.add(m.nw);
    }
  }
  for (const p of tree.now.keys()) {
    if (covered.has(p)) continue;
    const was = tree.content(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteCmp(a.key, b.key));
  const out = [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`];
  if (!check) {
    const changed = [...tree.now.keys()];
    const dels = changed.filter((p) => tree.now.get(p) === null).sort((a, b) => b.split('/').length - a.split('/').length);
    const writes = changed.filter((p) => tree.now.get(p) !== null).sort((a, b) => a.split('/').length - b.split('/').length);
    for (const p of dels) {
      try {
        rmSync(p, { force: true });
      } catch {
        /* a tree the disk cannot hold (file under a file); never crash */
      }
    }
    for (const p of writes) {
      try {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, tree.now.get(p)!);
      } catch {
        /* a tree the disk cannot hold (file under a file); never crash */
      }
    }
  }
  return { code: 0, out };
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
