// Edge-case tests for mend, beyond the public practice set: each case runs
// `node main.ts` in a fresh temp dir and checks exit code, stdout and files.
// Run: node tests/edge.mjs
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'main.ts');

let passed = 0;
let failed = 0;

function runCase(name, { argv = [], stdin = '', files = {}, expectExit, expectStdout, expectFiles = null }) {
  const dir = mkdtempSync(join(tmpdir(), 'mend-edge-'));
  try {
    for (const [p, text] of Object.entries(files)) {
      const f = join(dir, ...p.split('/'));
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, text);
    }
    const r = spawnSync(process.execPath, [MAIN, ...argv], { cwd: dir, input: stdin, encoding: 'utf8' });
    const gotFiles = {};
    const walk = (d, rel = '') => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        const rp = rel ? `${rel}/${n}` : n;
        if (statSync(p).isDirectory()) walk(p, rp);
        else gotFiles[rp] = readFileSync(p, 'utf8');
      }
    };
    walk(dir);
    const problems = [];
    if (r.status !== expectExit) problems.push(`exit ${r.status}, expected ${expectExit}`);
    if (r.stdout !== expectStdout) problems.push(`stdout ${JSON.stringify(r.stdout)}, expected ${JSON.stringify(expectStdout)}`);
    if (expectFiles !== null) {
      const want = { ...files, ...expectFiles };
      for (const [k, v] of Object.entries(expectFiles)) if (v === null) delete want[k];
      for (const p of new Set([...Object.keys(want), ...Object.keys(gotFiles)])) {
        if (want[p] === undefined) problems.push(`${p} should not exist`);
        else if (gotFiles[p] === undefined) problems.push(`${p} is missing`);
        else if (gotFiles[p] !== want[p]) problems.push(`${p} differs: expected ${JSON.stringify(want[p])}, got ${JSON.stringify(gotFiles[p])}`);
      }
    }
    if (problems.length === 0) {
      passed++;
      console.log(`ok   ${name}`);
    } else {
      failed++;
      console.log(`FAIL ${name}\n  ${problems.join('\n  ')}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const src = 'function a() {\n  return 1;\n}\n\nfunction b() {\n  return 2;\n}\n';

// 1. unified: line numbers completely wrong, nearest occurrence wins (second b)
runCase('u-wrong-numbers-nearest', {
  argv: ['fix.patch'],
  files: { 'fix.patch': '--- a.js\n+++ b/a.js\n@@ -99,3 +99,3 @@\n function b() {\n-  return 2;\n+  return 22;\n }\n', 'a.js': src },
  expectExit: 0,
  expectStdout: 'M a.js\nok: 1 file\n',
  expectFiles: { 'a.js': 'function a() {\n  return 1;\n}\n\nfunction b() {\n  return 22;\n}\n' },
});

// 2. unified: tier-2 indent mismatch, new line re-indented to the file's indent
runCase('u-tier2-reindent', {
  argv: ['fix.patch'],
  files: {
    'fix.patch': '--- a.js\n+++ b/a.js\n@@ -1,3 +1,3 @@\n function a() {\n-  return 1;\n+    return 10;\n }\n',
    'a.js': 'function a() {\n    return 1;\n}\n',
  },
  expectExit: 0,
  expectStdout: 'M a.js\nok: 1 file\n',
  expectFiles: { 'a.js': 'function a() {\n    return 10;\n}\n' },
});

// 3. unified: file does not exist
runCase('u-missing-file', {
  argv: ['fix.patch'],
  files: { 'fix.patch': '--- nope.js\n+++ b/nope.js\n@@ -1,2 +1,2 @@\n x\n-y\n+z\n' },
  expectExit: 1,
  expectStdout: 'error: missing nope.js\nfailed: 1 of 1 edits\n',
  expectFiles: {},
});

// 4. empty patch on stdin
runCase('empty-patch-format', {
  argv: ['-'], stdin: '',
  files: {},
  expectExit: 2,
  expectStdout: 'error: format\n',
  expectFiles: {},
});

// 5. JSON tool calls: JSON Lines with str_replace + insert + create
runCase('json-lines-mixed', {
  argv: ['-'],
  stdin: '{"command":"str_replace","path":"a.js","old_str":"return 1;","new_str":"return 10;"}\n{"command":"insert","path":"a.js","insert_line":3,"new_str":"// note"}\n{"command":"create","path":"new.txt","file_text":"hi\\n"}\n',
  files: { 'a.js': src },
  expectExit: 0,
  expectStdout: 'M a.js\nA new.txt\nok: 2 files\n',
  expectFiles: {
    'a.js': 'function a() {\n  return 10;\n}\n// note\n\nfunction b() {\n  return 2;\n}\n',
    'new.txt': 'hi\n',
  },
});

// 6. CRLF file keeps CRLF through a unified hunk
runCase('u-crlf-preserved', {
  argv: ['fix.patch'],
  files: {
    'fix.patch': '--- a.js\n+++ b/a.js\n@@ -1,3 +1,3 @@\n function a() {\n-  return 1;\n+  return 10;\n }\n',
    'a.js': 'function a() {\r\n  return 1;\r\n}\r\n',
  },
  expectExit: 0,
  expectStdout: 'M a.js\nok: 1 file\n',
  expectFiles: { 'a.js': 'function a() {\r\n  return 10;\r\n}\r\n' },
});

// 7. unified rename prints an R line, sorted by the new path
runCase('u-rename-R-line', {
  argv: ['fix.patch'],
  files: {
    'fix.patch': 'diff --git a/old.js b/new/deep.js\nrename from old.js\nrename to new/deep.js\n--- a/old.js\n+++ b/new/deep.js\n@@ -1,2 +1,2 @@\n x\n-y\n+z\n',
    'old.js': 'x\ny\n',
  },
  expectExit: 0,
  expectStdout: 'R old.js -> new/deep.js\nok: 1 file\n',
  expectFiles: { 'old.js': null, 'new/deep.js': 'x\nz\n' },
});

// 8. --strict: trailing-whitespace mismatch is a no-match
runCase('strict-trailing-ws', {
  argv: ['--strict', 'fix.patch'],
  files: {
    'fix.patch': '--- a.js\n+++ b/a.js\n@@ -1,3 +1,3 @@\n function a() {\n-  return 1;  \n+  return 10;\n }\n',
    'a.js': 'function a() {\n  return 1;\n}\n',
  },
  expectExit: 1,
  expectStdout: 'error: no-match a.js\nfailed: 1 of 1 edits\n',
  expectFiles: {},
});

// 9. --check with a failing edit writes nothing
runCase('check-fail-writes-nothing', {
  argv: ['--check', '-'],
  stdin: 'a.js\n<<<<<<< SEARCH\n  return 1;\n=======\n  return 10;\n>>>>>>> REPLACE\n\nmissing.js\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE\n',
  files: { 'a.js': src },
  expectExit: 1,
  expectStdout: 'error: missing missing.js\nfailed: 1 of 2 edits\n',
  expectFiles: {},
});

// 10. usage error: unknown option
runCase('usage-unknown-option', {
  argv: ['--bogus', '-'], stdin: '',
  files: {},
  expectExit: 2,
  expectStdout: 'error: usage\n',
  expectFiles: {},
});

// 11. SEARCH/REPLACE ambiguous: old lines occur twice
runCase('sr-ambiguous', {
  argv: ['fix.patch'],
  files: {
    'fix.patch': 'a.js\n<<<<<<< SEARCH\n  return 1;\n=======\n  return 10;\n>>>>>>> REPLACE\n',
    'a.js': 'function a() {\n  return 1;\n}\n\nfunction a() {\n  return 1;\n}\n',
  },
  expectExit: 1,
  expectStdout: 'error: ambiguous a.js\nfailed: 1 of 1 edits\n',
  expectFiles: {},
});

// 12. V4A: Add + Delete + Update with Move to in one patch
runCase('v4a-add-delete-move', {
  argv: ['fix.patch'],
  files: {
    'fix.patch': '*** Begin Patch\n*** Add File: added.txt\n+hello\n+world\n*** Delete File: gone.txt\n*** Update File: old.js\n*** Move to: moved.js\n@@ // header\n function a() {\n-  return 1;\n+  return 10;\n*** End Patch\n',
    'gone.txt': 'bye\n',
    'old.js': '// header\n' + src,
  },
  expectExit: 0,
  expectStdout: 'A added.txt\nD gone.txt\nR old.js -> moved.js\nok: 3 files\n',
  expectFiles: {
    'added.txt': 'hello\nworld\n',
    'gone.txt': null,
    'old.js': null,
    'moved.js': '// header\nfunction a() {\n  return 10;\n}\n\nfunction b() {\n  return 2;\n}\n',
  },
});

// 13. patch file cannot be read
runCase('no-patch-file', {
  argv: ['does-not-exist.patch'],
  files: {},
  expectExit: 2,
  expectStdout: 'error: no-patch\n',
  expectFiles: {},
});

// 14. --format=json forced on a unified patch
runCase('forced-json-on-diff', {
  argv: ['--format=json', 'fix.patch'],
  files: { 'fix.patch': '--- a.js\n+++ b/a.js\n@@ -1,2 +1,2 @@\n x\n-y\n+z\n' },
  expectExit: 2,
  expectStdout: 'error: parse 1\n',
  expectFiles: {},
});

// 15. unified creation with no-newline marker: created file has no final break
runCase('u-create-no-newline', {
  argv: ['fix.patch'],
  files: { 'fix.patch': '--- /dev/null\n+++ b/new.js\n@@ -0,0 +1,2 @@\n+line one\n+line two\n\\ No newline at end of file\n' },
  expectExit: 0,
  expectStdout: 'A new.js\nok: 1 file\n',
  expectFiles: { 'new.js': 'line one\nline two' },
});

// 16. SEARCH/REPLACE with empty old lines creates the file
runCase('sr-create', {
  argv: ['fix.patch'],
  files: { 'fix.patch': 'fresh.txt\n<<<<<<< SEARCH\n=======\nfirst\nsecond\n>>>>>>> REPLACE\n' },
  expectExit: 0,
  expectStdout: 'A fresh.txt\nok: 1 file\n',
  expectFiles: { 'fresh.txt': 'first\nsecond\n' },
});

// 17. V4A update with anchor + end-of-file chunk, file without a final break
// (the anchor precedes the chunk; the chunk's span must end at the last line)
runCase('v4a-anchor-eof-noeol', {
  argv: ['fix.patch'],
  files: {
    'fix.patch': '*** Begin Patch\n*** Update File: a.js\n@@ function a() {\n function b() {\n-  return 2;\n+  return 22;\n }\n*** End of File\n*** End Patch\n',
    'a.js': 'function a() {\n  return 1;\n}\n\nfunction b() {\n  return 2;\n}',
  },
  expectExit: 0,
  expectStdout: 'M a.js\nok: 1 file\n',
  expectFiles: { 'a.js': 'function a() {\n  return 1;\n}\n\nfunction b() {\n  return 22;\n}' },
});

// 18. unsafe path: unified edit escaping the tree
runCase('u-unsafe-path', {
  argv: ['fix.patch'],
  files: { 'fix.patch': '--- ../evil.js\n+++ b/../evil.js\n@@ -1,1 +1,1 @@\n-x\n+y\n' },
  expectExit: 1,
  expectStdout: 'error: unsafe ../evil.js\nfailed: 1 of 1 edits\n',
  expectFiles: {},
});

// 19. unified hunk with an empty old line inside the body (blank context kept)
runCase('u-blank-context-line', {
  argv: ['fix.patch'],
  files: {
    'fix.patch': '--- a.js\n+++ b/a.js\n@@ -1,5 +1,5 @@\n function a() {\n   return 1;\n }\n \n-function b() {\n+function c() {\n',
    'a.js': src,
  },
  expectExit: 0,
  expectStdout: 'M a.js\nok: 1 file\n',
  expectFiles: { 'a.js': 'function a() {\n  return 1;\n}\n\nfunction c() {\n  return 2;\n}\n' },
});

// 20. JSON array form with a bad element reports the array's start line
runCase('json-array-bad-element', {
  argv: ['-'],
  stdin: '\n[{"command":"create","path":"x.txt","file_text":"a"},\n {"command":"bogus","path":"y.txt"}]\n',
  files: {},
  expectExit: 2,
  expectStdout: 'error: parse 2\n',
  expectFiles: {},
});

console.log(`${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
