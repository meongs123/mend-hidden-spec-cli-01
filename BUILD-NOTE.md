# mend — build note

Entry for make.fun bounty `hidden-spec-cli-01-run-20261122` ("mend", SPEC v1).
`main.ts` is a single file, Node 22 stdlib only, no network, deterministic.
`runner.ts` is the kit's file, kept byte-for-byte as provided.

## What was built

- **CLI (§1–§2, §10).** Argument parsing exactly as specified: `--format=NAME`
  (only with `=`), `--check`, `--strict`, `--` ending options (a second `--`
  is itself a positional), `-` meaning stdin, duplicate/unknown options and
  extra positionals as `error: usage`. Error precedence usage → no-patch →
  format → parse; parse errors before any file is looked at. Edits apply in
  patch order to an in-memory tree layered over disk; a failed edit is rolled
  back from a snapshot and later edits still run; exit 1 writes nothing,
  exit 0 writes everything (skipped under `--check`).
- **Line model (§3).** One `splitFile`/`renderFile` pair: a file's break is
  CRLF when its first line feed follows a carriage return, else LF; the final
  break is tracked per file and preserved unless a unified hunk says
  otherwise; an empty file has no lines and is written empty. Paths are
  checked safe (non-empty, no leading `/`, no `\`, no empty/`.`/`..`
  segment) before anything else about the edit. The tree keeps "anything
  exists at this path" apart from "regular-file bytes", so a create/move
  target naming a directory reports `exists` and a change naming one
  reports `missing`.
- **Matcher (§5, shared core).** One `findOcc` scans the three tiers in
  order and returns the tier plus every (possibly overlapping) occurrence
  at that tier; one `buildNew` writes context lines as the file's own
  matched lines and re-indents every other new line at tier 2 by the F/P
  rule (leading spaces/tabs of the file's first matched line vs the old
  block's first line). Unified takes the occurrence nearest to `A - 1 + d`
  (earlier on a tie); SEARCH/REPLACE requires exactly one; V4A takes the
  first at/after the cursor.
- **Unified (§6).** A single-pass scanner: `diff --git` lines validated
  strictly (`diff --git a/<X> b/<Y>`, nothing else), `--- `/`+++ ` pairs
  (path = text after four chars, to first tab, trimmed, one leading `a/`/`b/`
  stripped, `/dev/null` = no file), `rename from/to`, `new/deleted file
  mode`, with `---`/`+++` beating rename beating `diff --git` per path.
  A second pair before any hunk starts a new section; a section with no
  hunks is still one edit (no-op change, empty create, plain delete/move).
  Hunk bodies strip trailing empty lines; a `\` line after the hunk's last
  context/`+` line controls the final break, literally (a `\` after a `-`
  line is inert); empty-O insertions clamp to `[0, file length]`; `d`
  tracks the running line delta. Creation files are the `+` lines only;
  deletion hunks are parsed structurally but never matched.
- **SEARCH/REPLACE (§7).** Markers matched with trailing whitespace
  removed only (leading whitespace is not tolerated). The path is the
  nearest non-blank, non-fence line before SEARCH (a fence line is one
  whose trimmed form starts with three backticks); a block with no such
  line inherits the previous block's path, and the first block with none
  is `error: parse <SEARCH line>`. A SEARCH with no `=======` before a
  `>>>>>>> REPLACE`, a second SEARCH, or the end of the patch is a parse
  error at the SEARCH line. Empty old lines mean create; otherwise the
  old lines must occur at their tier exactly once (`ambiguous` above one).
- **V4A (§8).** Strict scanner: first non-blank line must be
  `*** Begin Patch`, last non-blank line `*** End Patch` (else
  `error: parse <lines+1>`); blank lines at the end of a section are
  stripped from the section's raw lines before chunking. Add takes `+`
  lines and empty lines; Delete takes no lines; Update takes an optional
  `*** Move to:` as its immediate next line, then chunks starting at `@@`
  lines (anchor = text after `@@`, trimmed; empty = no anchor) or at the
  first body line. `*** End of File` with no open chunk is a parse error;
  an Update section with no chunk and no Move to is a parse error at its
  header line. Chunks resolve anchors then occurrences through the shared
  matcher at/after a cursor that advances past what was written; an
  end-of-file chunk's tier is chosen among occurrences ending at the last
  line only.
- **JSON (§9).** Array form (any fault → parse at the line where the array
  starts) or JSON Lines (per-line faults); a pretty-printed single object
  is neither shape. `create` writes `file_text` byte for byte;
  `str_replace` is exact (no tiers) with CRLF conversion both ways and
  overlapping occurrences counted; `insert` inserts after the first
  `insert_line` lines (0 = top, `lines` = append), non-integer is a parse
  fault, out-of-range is `no-match`.
- **Output rows (§2).** `R` lines are computed from the before/after tree
  plus recorded successful moves: a move qualifies when its old path is
  absent afterwards, its new path is present afterwards, and its new path
  was absent before; it replaces that pair's `D`/`A` lines and sorts by
  the new path. Chained moves therefore report `R B -> C` plus `D A`
  for A→B→C; a move followed by a modify of the new path reports only
  the `R` line. Everything else is `A`/`D`/`M` by before/after bytes, in
  UTF-8 byte order of the path.

## Fix: V4A Add File trailing `+` empty lines (F1, 2026-11-22)

- **Finding (Red Team, REVISION REQUIRED).** `parseV4a`'s Add File branch
  stripped trailing `''` from the *interpreted* file lines, so a trailing
  `+` patch line (an empty line of the file, SPEC §8) was dropped:
  `+alpha` / `+` / End produced `alpha\n` instead of `alpha\n\n`. The
  same failure hit Add with only `+` lines, `+alpha` / `+` / bare-blank /
  End, and `+alpha` / `+` mid-patch before the next section. Every other
  branch kept trailing empty lines (SR create `['a','']` → `a\n\n`,
  unified creation trailing `+` → `alpha\n\n`); only V4A Add popped them.
- **Fix.** The Add File branch now collects its raw patch lines first,
  strips trailing blank (empty-string) *raw* lines — the same pattern the
  Update branch already uses — and only then interprets them into file
  lines (`+<line>` → `<line>`, bare empty → `''`). Interpreted file lines
  are never popped. No other branch changed.
- **Verified (byte-exact, fresh temp dir per case).**
  - `+alpha` / `+` / End → `alpha\n\n` (hex `616c7068610a0a`)
  - `+` / `+` / End → `\n\n` (hex `0a0a`)
  - `+alpha` / `+` / bare-blank / End → `alpha\n\n` (the bare blank is
    the section terminator, not a file line)
  - `+alpha` / `+` mid-patch before the next section → `alpha\n\n`
    (other file in the same patch unaffected, `x\n`)
  - Guard: `+alpha` followed only by bare blanks → `alpha\n` (trailing
    bare blanks still stripped); Update branch trailing-blank behaviour
    unchanged.
- **Regression.** Full kit practice set re-run after the fix:
  **100 of 100 passed, practice score 1000** (no change).

## Verification

- Kit practice set: **100 of 100 passed, practice score 1000**
  (`node check.ts ../program/generator/practice.json`, run twice with
  identical results).
- A private 23-case ambiguity suite (one case per risky SPEC sentence:
  no-hunk sections, header `---` line numbers, malformed `diff --git`,
  creation `\ No newline`, negative empty-O insertion, deletion hunks
  ignored, `\` after a `-` line, prose SR paths, missing `=======`, V4A
  End-of-File with no chunk, missing End Patch, empty Update section,
  empty Add File, EOF-chunk tier choice, `[]`, pretty-printed single
  object, chained moves, move-then-modify, `--` handling, unsafe paths):
  **23 of 23 passed** under the recommended readings.

## Known gaps / riskiest readings

- **Chained moves (§2, note item 26).** The `R`-line rule is the murkiest
  sentence in the spec; the chosen reading (per-move qualification on
  end states, no netting into `R A -> C`) matches the research note but
  a strict "old existed before the patch" reading would give `D A` +
  `A C` for A→B→C instead.
- **V4A end-of-file tier (§8, item 19).** The tier is chosen among
  occurrences ending at the last line only; if the house instead takes
  the first tier with any occurrence and then fails when none of those
  ends at the last line, an EOF chunk that matches at the end only at
  tier 2 would differ.
- **V4A `*** End of File` with no open chunk (§8, item 17).** Treated as
  a parse error; an empty end-of-file chunk reading would make it a
  no-op instead.
- **Unrepresentable trees (§3, item 27).** A patch that would leave both
  a file at `a/b` and a file at `a/b/c.txt` cannot exist on disk; the
  write phase never crashes on it (failed writes are skipped) but the
  resulting on-disk tree is a guess.
- **No BOM handling (§3, item 28).** A BOM is not special-cased; detection
  uses trimmed comparisons, so a BOM before `*** Begin Patch` or `{`/`[`
  still detects, but a BOM before `diff --git ` breaks detection and a
  BOM on a file's first line breaks tier-0 matching of that line.
- The sealed pool tests sentences the practice set does not show; the
  readings above are the best literal interpretations available, but
  several (notably the three listed first) have no practice check to
  confirm them against the house reference.

## Hardening pass (run 2, 2026-11-24 — surgical, no rewrite)

Baseline locked in first: working copy verified at `633579b`, remote HEAD
matched, `main.ts` snapshotted to `~/workspace/makefun/mend-baseline-633579b/`,
full kit practice grade under Node 22 **100 of 100, score 1000** before any
change. Three residual ambiguities decided as written verdicts, each with a
failing-then-passing test (harness `~/workspace/makefun/mend-hardening-tests.mjs`,
25 cases, expected outcomes written before running):

- **Verdict (a) — chained-move R lines (§2): OLD BEHAVIOR WRONG, FIXED.**
  SPEC §2: "`R <old> -> <new>` a file moved by a move edit ... that
  succeeded, when `<old>` existed before the patch and does not after it,
  and `<new>` did not exist before it and does after it." All four
  conditions are patch-level. The old code checked only three (it never
  verified the old path existed before the patch), so A→B→C reported
  `R B -> C` although B never existed before the patch, and create-then-move
  reported `R A -> B` although A never existed before it. Fix: the R
  qualification now also requires `tree.content(m.old) !== null`. Tests A1
  (chained move → `D a.txt` + `A c.txt`) and A2 (create-then-move →
  `A b.txt`); controls A3 (single move still `R`) and A4 (move-then-modify
  still `R`) unchanged.
- **Verdict (b) — V4A EOF-chunk tier (§8 + §5): OLD BEHAVIOR WRONG, FIXED.**
  SPEC §8: "The chunk takes the first occurrence of O at or after the
  cursor, at the first tier with one; an end-of-file chunk takes only an
  occurrence that ends at the file's last line." §5 fixes the tier as "the
  first of three tiers at which it occurs at least once" — an unqualified
  occurrence — so the tier is set among all occurrences at/after the cursor
  and the EOF sentence only restricts which occurrence is taken at that
  tier. The old code chose the tier among EOF-ending occurrences only, so a
  chunk whose tier-0 occurrence sat off-EOF succeeded via tier 2 instead of
  failing. Fix: `findOcc` no longer takes an EOF filter (parameter removed);
  the V4A update path takes the EOF-ending position at the found tier and
  fails `no-match` when there is none. Test B1 (tier-0 hit off-EOF +
  tier-2 hit at EOF → `no-match`, file unchanged); controls B2 (no tier-0
  hit, tier-2 EOF hit → succeeds) and B3 (non-EOF chunk unchanged).
- **Verdict (c) — `*** End of File` with no chunk (§8): OLD BEHAVIOR
  CORRECT, NO CODE CHANGE.** "A `*** End of File` line ends a chunk and
  anchors it to the end of the file" presupposes an open chunk, and a chunk
  only "starts at an `@@` line ... or, for the first chunk, at a body line",
  so a bare End of File starts and ends nothing and falls under "Any other
  line is `error: parse <its line>`". Test C1 proves `error: parse 3`;
  C2 proves the neighboring valid form (`@@` + End of File = valid empty
  EOF chunk, `ok: 0 files`).
- **Extra fix — V4A Add trailing blank lines (§8 intro):** "Blank lines at
  the end of a section ... are not part of it", blank = empty or only
  whitespace. The Add branch stripped only empty (`''`) trailing raw lines,
  so a trailing whitespace-only line threw a parse error. Fix: collect raw
  lines, strip trailing blank lines, then validate each remaining line
  (`+` or empty, else parse at its line). Tests D1 (trailing ws-only line
  stripped, file `alpha\n`) and D2 (middle ws-only line still parse error).

Other hardening areas re-checked sentence-by-sentence with tests and found
already correct (no change): unified nearest-hunk + tie-break to earlier
(U1), `\` + EOF interaction incl. `\` after a `-` line inert (U2–U4), CRLF
preservation (U5), drift accumulation between hunks (U6), empty-O insert
clamping (U7), tier-2 re-indent leaving empty/ws-only new lines as-is (S1),
S/R path fallback + first-block-no-path parse error (S2–S3), S/R ambiguous
(S4), V4A anchor/cursor (V1), empty-O insert at cursor vs EOF (V2), V4A
Move to (V3).

**Verification after the pass.** Harness 25/25; kit practice grade under
Node 22 **100 of 100, score 1000**, run twice with identical results
(deterministic). `runner.ts` untouched (sha256 matches the kit). `main.ts`
31,829 bytes, within the 1 MiB cap. Commit on top of `633579b`, pushed;
remote HEAD equals local HEAD, tree clean.
