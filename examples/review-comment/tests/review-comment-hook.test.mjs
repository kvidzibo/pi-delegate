import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../review-comment.mjs', import.meta.url));

test('automatic review hook records archived acceptance context and terminal reviewer outcomes', () => {
  const cwd = mkdtempSync('/tmp/review-comment-hook-');
  const task = join(cwd, 'archived-task.md');
  const base = 'a'.repeat(40);
  const head = 'b'.repeat(40);
  const repository = 'https://github.com/owner/repo';
  const context = { repository, base, head, validation: [{ check: 'Parent ran focused tests', result: 'passed', details: '' }] };
  const report = {
    scope: 'Feature diff', findings: [],
    checks: [{ check: 'Focused reviewer tests', result: 'passed', details: 'Passed locally' }],
    verification_limits: [], verdict: 'ship',
  };
  const payload = {
    version: 1, event: 'delegate.completed', role: 'review', status: 'done',
    runId: 'review-clean', jobId: 'job-clean', model: 'provider/reviewer',
    requestedModel: 'provider/requested', reasoning: 'high', cwd, durationMs: 37600,
    paths: { task }, recordingError: null,
    response: { schemaValidated: true, json: report, text: 'Worker prose is not the review schema.' },
  };
  const archive = (value = context) => writeFileSync(task, `Review this accepted diff.\nReview-comment: ${JSON.stringify(value)}\n`);
  const invoke = value => spawnSync(process.execPath, [script, 'hook'], {
    cwd, input: JSON.stringify(value), encoding: 'utf8', timeout: 10000,
  });
  let directory;
  let history;
  let comment;
  const state = () => JSON.parse(readFileSync(history, 'utf8'));
  const snapshot = () => [readFileSync(history), readFileSync(comment)];
  const unchanged = before => assert.deepEqual(snapshot(), before, 'rejection must preserve both artifacts byte-for-byte');
  const reject = value => {
    const before = snapshot();
    const result = invoke(value);
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0, 'invalid completion unexpectedly accepted');
    assert.equal(result.stdout, '');
    unchanged(before);
    assert.equal(existsSync(`${history}.lock`), false);
    assert.deepEqual(readdirSync(directory).sort(), ['comment.md', 'history.json']);
  };
  const accept = (value, outcome) => {
    const result = invoke(value);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '', 'pi-delegate discards hook stdout');
    assert.ok(result.stderr.includes(history));
    assert.ok(result.stderr.includes(comment));
    const latest = state().runs.at(-1);
    assert.equal(latest.input.id, value.runId);
    assert.equal(latest.input.outcome, outcome);
    assert.deepEqual(readdirSync(directory).sort(), ['comment.md', 'history.json'], 'no temporary files or lock remain');
    for (const path of [history, comment]) assert.equal(statSync(path).mode & 0o777, 0o600);
    return latest;
  };
  let sequence = 0;
  const completion = (response = report, overrides = {}) => ({
    ...payload, runId: `review-${++sequence}`, jobId: `job-${sequence}`,
    response: { schemaValidated: true, json: response, text: 'Untrusted partial prose' }, ...overrides,
  });
  try {
    const init = spawnSync('git', ['init', '-b', 'feature'], { cwd, encoding: 'utf8' });
    assert.equal(init.error, undefined);
    assert.equal(init.status, 0, init.stderr);
    const gitDir = spawnSync('git', ['rev-parse', '--absolute-git-dir'], { cwd, encoding: 'utf8' });
    assert.equal(gitDir.status, 0, gitDir.stderr);
    directory = join(gitDir.stdout.trim(), 'pi-review-comment');
    history = join(directory, 'history.json');
    comment = join(directory, 'comment.md');
    archive();
    // No commits exist: acceptance-time SHAs, not HEAD, must drive the draft.
    const first = accept(payload, 'clean');
    assert.deepEqual(first.input, {
      pr_url: repository, id: payload.runId, model: payload.model, reasoning: payload.reasoning,
      duration_ms: payload.durationMs, base, head, outcome: 'clean', validation: ['Parent ran focused tests: passed'], limits: [],
    });
    assert.deepEqual(first.response, report);
    assert.equal(state().version, 1);
    assert.equal(state().pr_url, repository);
    const initialComment = readFileSync(comment, 'utf8');
    assert.match(initialComment, /### Review 1 — reviewer · Reasoning: high/);
    assert.match(initialComment, /\*\*Duration:\*\* 38s\b/);
    assert.ok(initialComment.includes(`${repository}/compare/${base}...${head}`));
    assert.doesNotMatch(initialComment, /\/pulls?\/\d+|provider\//);
    const initial = snapshot();
    accept(payload, 'clean');
    unchanged(initial);
    reject({ ...payload, durationMs: 1 }); // Stable run ID cannot overwrite prior metadata.

    const sentinel = join(cwd, 'must-not-exist');
    const malicious = `$(touch ${sentinel}); touch ${sentinel}`;
    archive({ ...context, validation: [...context.validation, { check: malicious, result: 'passed', details: '' }] });
    const finding = {
      severity: 'high', path: 'src/a b#c.ts', start_line: 3, end_line: 5,
      finding: malicious, evidence: 'Observed a reproducible failure',
    };
    const changes = { ...report, findings: [finding], verdict: 'fix_first' };
    const changed = accept(completion(changes, { response: { schemaValidated: true, json: changes, text: malicious } }), 'changes_required');
    assert.deepEqual(changed.response.findings, [finding]);
    const markdown = readFileSync(comment, 'utf8');
    assert.ok(markdown.includes(`${repository}/blob/${head}/src/a%20b%23c.ts#L3-L5`));
    assert.ok(markdown.indexOf('### Review 2') < markdown.indexOf('### Review 1'));
    assert.equal(existsSync(sentinel), false, 'neither task context nor response text may execute shell commands');
    archive();
    accept(completion({ ...report, verdict: 'fix_first' }), 'changes_required');
    accept(completion({ ...report, findings: [finding] }), 'changes_required');
    accept(completion({ ...report, verdict: 'blocked' }), 'incomplete');
    accept(completion({ ...report, verification_limits: ['Unable to exercise integration'] }), 'incomplete');
    for (const result of ['failed', 'inconclusive']) {
      accept(completion({ ...report, checks: [{ check: 'Reviewer tests', result, details: '' }] }), 'incomplete');
    }
    for (const result of ['failed', 'inconclusive']) {
      archive({ ...context, validation: [{ check: 'Parent check', result, details: 'Not passed' }] });
      accept(completion(), 'incomplete');
    }
    archive({ ...context, validation: [] });
    accept(completion(), 'incomplete');
    archive();
    accept(completion(report, { recordingError: 'Recording could not be saved' }), 'incomplete');
    for (const text of ['Worker failed with partial findings', 'Worker cancelled']) {
      const failed = accept(completion(report, {
        status: 'failed', response: { schemaValidated: false, json: { partial: text }, text: `${text}: ${malicious}` },
      }), 'failed');
      assert.equal(failed.response, null, 'failed/cancelled prose must never become findings');
      assert.deepEqual(failed.resolutions, []);
    }
    const unvalidated = accept(completion(report, {
      response: { schemaValidated: false, json: report, text: malicious },
    }), 'failed');
    assert.equal(unvalidated.response, null, 'apparently clean JSON without schema validation is not a clean review');
    assert.equal(existsSync(sentinel), false);

    for (const contents of [
      'No acceptance context\n',
      ` Review-comment: ${JSON.stringify(context)}\n`,
      `Review-comment: ${JSON.stringify(context)}\nReview-comment: ${JSON.stringify(context)}\n`,
      `Review-comment: ${JSON.stringify(context)}\nReview-comment:${JSON.stringify(context)}\n`,
      `Review-comment: ${JSON.stringify(context)}\n Review-comment: ${JSON.stringify(context)}\n`,
      `Review-comment: ${JSON.stringify(context)}\nreview-comment: ${JSON.stringify(context)}\n`,
    ]) {
      writeFileSync(task, contents);
      reject(completion());
    }
    for (const invalid of [
      { ...context, base: 'HEAD' }, { ...context, validation: 'not an array' },
      { ...context, validation: ['Parent tests failed'] },
      { ...context, validation: [{ check: 'Test', result: 'unknown', details: '' }] },
      { ...context, repository: `${repository}/pull/123` }, { ...context, extra: true },
    ]) {
      archive(invalid);
      reject(completion());
    }
    archive();
    for (const overrides of [
      { role: 'implement' }, { version: 2 }, { model: 42 }, { durationMs: -1 }, { runId: '' },
      { response: { json: report, text: 'Missing schema validation metadata' } },
    ]) reject(completion(report, overrides));
    reject(completion({ ...report, extra: true }));
    reject(completion({ ...report, checks: [{ check: 'Test', result: 'unknown', details: '' }] }));
    reject(completion({ ...report, findings: [{ ...finding, path: '../escape.ts' }] }));

    const beforeLock = snapshot();
    mkdirSync(`${history}.lock`);
    try {
      const locked = invoke(completion());
      assert.equal(locked.error, undefined, 'existing lock must fail fast, not time out');
      assert.notEqual(locked.status, 0);
      assert.equal(locked.stdout, '');
      assert.ok(statSync(`${history}.lock`).isDirectory(), 'must not steal an existing lock');
      unchanged(beforeLock);
    } finally {
      rmSync(`${history}.lock`, { recursive: true });
    }
    assert.deepEqual(state().runs.map(run => run.number), state().runs.map((_, index) => index + 1));
    assert.deepEqual(readdirSync(directory).sort(), ['comment.md', 'history.json']);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
