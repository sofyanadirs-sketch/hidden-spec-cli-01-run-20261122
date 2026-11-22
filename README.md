# hidden-spec-cli-01-run-20261122

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/sofyanadirs-sketch/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/sofyanadirs-sketch/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

# mend — one patch tool for every AI edit format

`mend` applies an edit that an AI model wrote to a tree of text files. Models
write edits in four formats, and `mend` reads all four into one written-down
specification:

- a unified diff (often with wrong line numbers),
- SEARCH/REPLACE blocks,
- the V4A patch format,
- text-editor tool calls as JSON.

It finds the lines each edit names at the first of three matching tiers —
exact, then trailing whitespace ignored, then leading and trailing whitespace
ignored — and changes every file or none at all (atomic).

## Run

Node 22, standard library only, no install:

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- The working directory is the root of the tree. Every path in a patch is
  relative to it.
- `PATCH` is the path of the patch file, relative to the working directory.
  When `PATCH` is absent or is `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`,
  `search-replace`, `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as
  without it, and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).
- Options and `PATCH` may come in any order. `--` ends the options.

## Exit codes and output

Standard output holds lines, each ended by `\n`, and nothing else.

- Exit 2, nothing written, exactly one line: `error: usage`,
  `error: no-patch`, `error: format`, or `error: parse <N>`.
- Exit 1, nothing written: one line `error: <code> <path>` for each edit
  that failed, in the patch's order, then `failed: <k> of <n> edits`.
  Codes: `no-match`, `ambiguous`, `missing`, `exists`, `unsafe`.
- Exit 0: the tree is written. One line for each path whose state changed,
  in byte order of the paths — `A <path>`, `D <path>`, `M <path>`, or
  `R <old> -> <new>` for a move — then `ok: <n> files`
  (`ok: 1 file` when n is 1). A patch that changes nothing prints only
  `ok: 0 files`.

## Files

- `main.ts` — the whole tool (SPEC.md sections 1–10).
- `runner.ts` — the kit's trial runner, kept as the kit has it.
- `check.ts` — run the public practice set: `node check.ts <practice.json>`.
- `SPEC.md` — the whole contract (in the starter kit).
- `LICENSE` — MIT.

## Practice

```
node check.ts hidden-spec-cli-01-run-20261122-kit/program/generator/practice.json
```

100 of 100 practice checks pass (practice score 1000).

---

<sub>Entered on [make.fun](https://make.fun/?ref=h9b99srf&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
