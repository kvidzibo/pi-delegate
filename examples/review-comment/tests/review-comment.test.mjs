import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync, existsSync, mkdirSync, symlinkSync, readdirSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../review-comment.mjs', import.meta.url));

test('review comment CLI preserves review history through add, resolve and render', () => {
  const dir = mkdtempSync('/tmp/review-comment-test-');
  const history = join(dir, 'history.json');
  const inputFile = join(dir, 'input.json');
  const responseFile = join(dir, 'response.json');
  const base = 'a'.repeat(40);
  const head = 'b'.repeat(40);
  const commit = 'c'.repeat(40);
  const pr = 'https://forge.example/team/repo/pulls/17';
  const first = {
    pr_url: pr, id: 'first', outcome: 'changes_required',
    model: 'provider/reviewer', reasoning: 'high', duration_ms: 60219,
    base, head, validation: ['Ran unit tests'], limits: [],
  };
  const response = {
    scope: 'Changed files',
    findings: [{ severity: 'high', path: 'src/a b#c.ts', start_line: 3, end_line: 5,
      finding: 'Pipe | newline\n<script>bad</script> **bold** (literal) $math$',
      evidence: 'Observed | failure\nsecond line' }],
    checks: [{ check: 'Unit tests', result: 'passed', details: 'All passed' }],
    verification_limits: [], verdict: 'fix_first',
  };
  const clean = { ...first, id: 'second', outcome: 'clean', duration_ms: 37235 };
  const cleanResponse = { ...response, findings: [], verdict: 'ship' };
  const write = (path, value) => writeFileSync(path, JSON.stringify(value));
  const state = () => JSON.parse(readFileSync(history, 'utf8'));
  const invoke = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 10000 });
  const ok = (...args) => {
    const result = invoke(...args);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const add = (input, report, target = history) => {
    write(inputFile, input);
    if (report !== undefined) write(responseFile, report);
    return ok('add', target, inputFile, ...(report === undefined ? [] : [responseFile]));
  };
  const rejected = (args, target = history) => {
    const before = readFileSync(target);
    const result = invoke(...args);
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0, `unexpected success: ${args.join(' ')}`);
    assert.equal(result.stdout, '', 'failure must not emit a partial comment');
    assert.deepEqual(readFileSync(target), before, 'failure must not mutate history');
    assert.equal(existsSync(`${target}.lock`), false, 'acquired lock must be removed');
  };
  const badAdd = (input, report = response) => {
    write(inputFile, input);
    if (report !== undefined) write(responseFile, report);
    rejected(['add', history, inputFile, ...(report === undefined ? [] : [responseFile])]);
  };
  try {
    assert.equal(ok('--version').trim(), '1.0.0');
    const help = ok('--help');
    for (const command of ['add', 'render', 'resolve']) assert.ok(help.includes(`review-comment.mjs ${command} `));
    const initial = add({ ...first, pr_url: `${pr}/` }, response);
    assert.match(initial, /### Review 1 — reviewer · Reasoning: high/);
    assert.match(initial, /\*\*Duration:\*\*\s*60s\b/);
    assert.ok(initial.includes(`https://forge.example/team/repo/compare/${base}...${head}`));
    assert.ok(initial.includes(`/src/commit/${head}/src/a%20b%23c.ts#L3-L5`));
    assert.match(initial, /Unresolved/);
    assert.doesNotMatch(initial, /<script>/);
    assert.doesNotMatch(initial.split('<details><summary>Details</summary>')[0], /\*\*bold\*\*|Pipe \| newline|newline\n/);
    assert.ok(initial.includes('&#40;literal&#41; &#36;math&#36;'), 'punctuation must not invoke Forgejo math rendering');
    for (const label of ['Validation', 'Limits', 'Outcome']) assert.ok(initial.includes(`**${label}:**`));
    assert.match(initial, /changes_required/);
    assert.equal(statSync(history).mode & 0o777, 0o600);
    assert.equal(state().pr_url, pr);
    assert.deepEqual(state().runs[0].resolutions, ['Unresolved']);

    const second = add(clean, cleanResponse);
    assert.ok(second.indexOf('### Review 2') < second.indexOf('### Review 1'));
    assert.match(second, /\*\*Duration:\*\*\s*37s\b/);
    assert.match(second.split('### Review 1')[0], /\*\*Outcome:\*\* clean/);
    assert.doesNotMatch(second.split('### Review 1')[0], /\|\s*Severity\s*\|/i);
    assert.deepEqual(state().runs.map(run => run.number), [1, 2]);

    const beforeResolve = state();
    const resolution = `Fixed in ${commit}; awaiting re-review`;
    const resolved = ok('resolve', history, 'first', '1', resolution);
    assert.ok(resolved.includes(`https://forge.example/team/repo/commit/${commit}`));
    const expected = structuredClone(beforeResolve);
    expected.runs[0].resolutions[0] = resolution;
    assert.deepEqual(state(), expected, 'resolve changes only the requested resolution');
    assert.match(resolved, /changes_required/);
    assert.ok(resolved.includes('Pipe'));
    const resolvedBytes = readFileSync(history);
    assert.equal(add(first, response), resolved, 'duplicate remains idempotent after resolution');
    assert.deepEqual(readFileSync(history), resolvedBytes);
    assert.equal(ok('render', history), resolved);
    const output = join(dir, 'draft.md');
    assert.equal(ok('render', history, output), resolved);
    assert.equal(readFileSync(output, 'utf8'), resolved);
    assert.equal(statSync(output).mode & 0o777, 0o600);
    rejected(['resolve', history, 'missing-run', '1', 'must not apply', output]);
    assert.equal(readFileSync(output, 'utf8'), resolved, 'a failed correction must not truncate the draft');
    assert.equal(ok('resolve', history, 'first', '1', resolution, output), resolved);
    assert.equal(readFileSync(output, 'utf8'), resolved);
    rejected(['render', history, history]);
    const renderInput = readFileSync(history);
    writeFileSync(history, '{broken');
    rejected(['render', history, output]);
    assert.equal(readFileSync(output, 'utf8'), resolved, 'a failed refresh must preserve the draft');
    writeFileSync(history, renderInput);
    rmSync(output);

    badAdd({ ...first, id: 'bad', outcome: 'unknown' });
    badAdd({ ...clean, id: 'bad' }, response);
    badAdd({ ...first, id: 'bad', base: 'ABC123' });
    for (const path of ['../escape.ts', '/absolute.ts', 'src\\file.ts']) {
      badAdd({ ...first, id: 'bad' }, { ...response, findings: [{ ...response.findings[0], path }] });
    }
    badAdd({ ...first, id: 'bad', pr_url: 'https://forge.example/team/repo/pulls/18' });
    badAdd({ ...first, duration_ms: 1 });
    badAdd({ ...first, id: 'bad', extra: true });
    badAdd({ ...clean, id: 'bad', validation: [] }, cleanResponse);
    badAdd({ ...clean, id: 'bad', limits: ['Missing workflow check'] }, cleanResponse);
    badAdd({ ...clean, id: 'bad' }, { ...cleanResponse, verification_limits: ['Missing check'] });
    badAdd({ ...clean, id: 'bad' }, { ...cleanResponse, checks: [{ check: 'Workflow', result: 'inconclusive', details: '' }] });
    badAdd({ ...first, id: 'bad' }, { ...response, verdict: 'blocked', verification_limits: ['Blocked check'] });
    for (const pr_url of ['https://user:pass@forge.example/team/repo/pulls/17', `${pr}?x=1`, `${pr}#hash`, 'ftp://forge.example/team/repo/pulls/17']) {
      badAdd({ ...first, id: 'bad', pr_url });
    }
    rejected(['resolve', history, 'first', '2', 'Invalid finding']);

    const saved = readFileSync(history);
    for (const invalid of ['{broken', JSON.stringify({ ...state(), version: 2 }), JSON.stringify({ ...state(), extra: true })]) {
      writeFileSync(history, invalid);
      rejected(['render', history]);
      write(inputFile, clean);
      write(responseFile, cleanResponse);
      rejected(['add', history, inputFile, responseFile]);
      writeFileSync(history, saved);
    }
    mkdirSync(`${history}.lock`);
    const locked = invoke('resolve', history, 'first', '1', 'must not apply');
    assert.notEqual(locked.status, 0);
    assert.equal(locked.stdout, '');
    assert.deepEqual(readFileSync(history), saved);
    assert.ok(statSync(`${history}.lock`).isDirectory(), 'must not steal existing lock');
    rmSync(`${history}.lock`, { recursive: true });
    const link = join(dir, 'symlink.json');
    symlinkSync(history, link);
    rejected(['add', link, inputFile, responseFile], link);

    const failed = { ...first, id: 'failed', outcome: 'failed', duration_ms: null, limits: ['Process failed'] };
    const failedComment = add(failed);
    assert.match(failedComment, /\*\*Duration:\*\*\s*Unknown/);
    assert.match(failedComment, /\*\*Outcome:\*\*\s*failed/);
    const notRun = { pr_url: pr, id: 'skipped', outcome: 'not_run', validation: [], limits: ['Not requested'] };
    const skippedComment = add(notRun);
    const skippedSection = skippedComment.split('### Review 3')[0];
    assert.match(skippedSection, /### Review 4 — Not run/);
    assert.doesNotMatch(skippedSection, /Reasoning:|\*\*Diff:|\*\*Duration:/);
    assert.deepEqual(state().runs.map(run => run.number), [1, 2, 3, 4]);
    assert.equal(ok('render', history), skippedComment);

    const github = join(dir, 'github.json');
    const githubComment = add({ ...first, pr_url: 'https://github.com/team/repo/pull/17', base: 'd'.repeat(64), head: 'e'.repeat(64) }, response, github);
    assert.ok(githubComment.includes(`/blob/${'e'.repeat(64)}/src/a%20b%23c.ts#L3-L5`));
    assert.ok(githubComment.includes(`/compare/${'d'.repeat(64)}...${'e'.repeat(64)}`));
    assert.equal(ok('render', github), githubComment);
    const incomplete = { ...first, id: 'blocked', outcome: 'incomplete' };
    const blocked = { ...cleanResponse, verdict: 'blocked', verification_limits: ['Coverage gap'] };
    const blockedComment = add(incomplete, blocked);
    assert.match(blockedComment.split('### Review 4')[0], /\*\*Outcome:\*\* incomplete/);
    assert.ok(blockedComment.includes('Coverage gap'));
    assert.equal(state().runs[4].response.verdict, 'blocked');
    const outputFailureHistory = join(dir, 'output-failure.json');
    write(inputFile, clean);
    write(responseFile, cleanResponse);
    const full = openSync('/dev/full', 'w');
    try {
      const failure = spawnSync(process.execPath, [script, 'add', outputFailureHistory, inputFile, responseFile], { encoding: 'utf8', stdio: ['ignore', full, 'pipe'] });
      assert.notEqual(failure.status, 0);
      assert.match(failure.stderr, /History saved.*use render/);
      assert.doesNotMatch(failure.stderr, /Unhandled 'error'/);
    } finally { closeSync(full); }
    const recovered = ok('render', outputFailureHistory);
    assert.equal(ok('add', outputFailureHistory, inputFile, responseFile), recovered);
    assert.equal(JSON.parse(readFileSync(outputFailureHistory, 'utf8')).runs.length, 1);
    rmSync(outputFailureHistory);
    const dispositionsHistory = join(dir, 'dispositions.json');
    const limitReport = { ...cleanResponse, verification_limits: ['No PR was posted; posting is parent-owned.'] };
    const dispositions = ['Publication is outside the local generator review scope; parent verified Forgejo rendering separately.'];
    const disposed = add({ ...clean, limit_resolutions: dispositions }, limitReport, dispositionsHistory);
    assert.ok(disposed.includes('No PR was posted; posting is parent-owned.'));
    assert.ok(disposed.includes('Parent disposition: Publication is outside'));
    assert.match(disposed, /\*\*Outcome:\*\* clean/);
    assert.equal(JSON.parse(readFileSync(dispositionsHistory, 'utf8')).runs[0].response.verification_limits[0], limitReport.verification_limits[0]);
    badAdd({ ...clean, id: 'bad', limit_resolutions: [] }, limitReport);
    badAdd({ ...clean, id: 'bad', limits: ['Still unverified'], limit_resolutions: dispositions }, limitReport);
    rmSync(dispositionsHistory);
    assert.deepEqual(readdirSync(dir).sort(), ['github.json', 'history.json', 'input.json', 'response.json', 'symlink.json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
