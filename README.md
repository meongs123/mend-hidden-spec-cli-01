# mend — one CLI patch tool for every AI edit format

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/meongs123/mend-hidden-spec-cli-01/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/meongs123/mend-hidden-spec-cli-01/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

Entry for the [make.fun](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) bounty **"mend"** (`hidden-spec-cli-01-run-20261122`).

`mend` applies an edit that an AI model wrote to a tree of text files. Models
write edits in four formats, and this one tool reads all of them: a unified
diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch
format, and text-editor tool calls as JSON. It finds the lines each edit names
at the first of three matching tiers (exact, trailing-whitespace-insensitive,
fully-whitespace-insensitive), and writes every change or none.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- `PATCH` is a path relative to the working directory (the tree root). Absent,
  or `-`, means read the patch from stdin.
- `--format=NAME` reads the patch as `unified`, `search-replace`, `v4a`,
  `json`, or `auto` (the default, which detects the format).
- `--check` does everything but write: same output and exit code, no file
  created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Exit codes: `0` the tree is written (`A`/`D`/`M`/`R` lines, then
`ok: <n> file(s)`); `1` one or more edits failed (one
`error: <code> <path>` line per failed edit, then
`failed: <k> of <n> edits`, nothing written); `2` usage, unreadable patch,
undetected format, or unparsable patch (exactly one `error: …` line).

## Files

- `main.ts` — the CLI. Node 22, standard library only, no dependencies, no
  network, deterministic. See `SPEC.md` in the kit for the contract it
  implements (the spec is not shipped in this repo; the kit carries it).
- `runner.ts` — the kit's trial runner, kept exactly as provided. When
  `MAKEFUN_ENV_URL` is set, `main.ts` hands over to it.

## Local check

The kit's practice set (100 checks) scores **1000/1000** with this entry:

    node check.ts ../program/generator/practice.json   # from the kit's starter/

See `BUILD-NOTE.md` for the per-format approach and the known gaps.
