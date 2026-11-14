import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileResponseSchema } from '../../../child-runtime/response-schema.ts';
import { runCompletionHook } from '../../../delegate/completion-hook.ts';

const script = fileURLToPath(new URL('../review-comment.mjs', import.meta.url));
const schema = JSON.parse(readFileSync(new URL('../response-schema.json', import.meta.url), 'utf8'));

test('schema-validated completions produce private, pinned clean and incomplete review drafts', async () => {
  const cwd = mkdtempSync('/tmp/review-comment-integration-');
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    git('init', '-b', 'feature');
    writeFileSync(join(cwd, 'fixture.txt'), 'base\n');
    git('add', 'fixture.txt');
    git('-c', 'user.name=Integration Test', '-c', 'user.email=test@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '-m', 'Base fixture');
    const base = git('rev-parse', 'HEAD');
    writeFileSync(join(cwd, 'fixture.txt'), 'base\nhead\n');
    git('add', 'fixture.txt');
    git('-c', 'user.name=Integration Test', '-c', 'user.email=test@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '-m', 'Head fixture');
    const head = git('rev-parse', 'HEAD');
    for (const sha of [base, head]) assert.match(sha, /^[a-f0-9]{40}$/);
    git('diff', '--check', base, head);
    const check = { check: 'Fixture whitespace', result: 'passed', details: `git diff --check ${base} ${head}: exit 0` };
    const repository = 'https://github.com/owner/repo';
    const task = join(cwd, 'accepted-task.md');
    writeFileSync(task, `Review the fixture diff.\nReview-comment: ${JSON.stringify({
      repository, base, head, validation: [check],
    })}\n`);
    const directory = join(git('rev-parse', '--absolute-git-dir'), 'pi-review-comment');
    const historyPath = join(directory, 'history.json');
    const draftPath = join(directory, 'comment.md');
    const validate = compileResponseSchema(schema);
    const runIds: string[] = [];
    assert.ok(isAbsolute(process.execPath));
    assert.ok(isAbsolute(script));
    for (const [index, checks] of [[check], []].entries()) {
      const report = { scope: 'Fixture diff', findings: [], checks, verification_limits: [], verdict: 'ship' };
      assert.equal(validate(report), true, JSON.stringify(validate.errors));
      const runId = randomUUID();
      runIds.push(runId);
      const result = await runCompletionHook({ command: [process.execPath, script, 'hook'], timeoutMs: 10000 }, {
        version: 1, event: 'delegate.completed', role: 'review', status: 'done',
        runId, jobId: `fixture-${index}`, model: 'fixture/reviewer', reasoning: 'high', cwd,
        durationMs: 1, paths: { task }, recordingError: null,
        response: { schemaValidated: true, json: report, text: JSON.stringify(report) },
      }, cwd);
      assert.equal(result.status, 'succeeded', JSON.stringify(result));
      const history = JSON.parse(readFileSync(historyPath, 'utf8'));
      assert.deepEqual(history.runs.map((run: { input: { id: string } }) => run.input.id), runIds);
      assert.equal(history.runs.length, index + 1);
      const latest = history.runs.at(-1);
      assert.equal(latest.input.id, runId);
      assert.equal(latest.input.outcome, index === 0 ? 'clean' : 'incomplete');
      assert.deepEqual(latest.response, report);
      assert.deepEqual(history.runs.map((run: { input: { outcome: string } }) => run.input.outcome),
        index === 0 ? ['clean'] : ['clean', 'incomplete']);
      const draft = readFileSync(draftPath, 'utf8');
      assert.ok(draft.includes(`**Outcome:** ${index === 0 ? 'clean' : 'incomplete'}`));
      assert.ok(draft.includes(`${repository}/compare/${base}...${head}`));
      assert.doesNotMatch(draft, /\/compare\/[^\s)]*(?:HEAD|main|feature)/);
      for (const path of [historyPath, draftPath]) {
        assert.equal(statSync(path).mode & 0o777, 0o600);
        assert.ok(result.stderrTail?.includes(path));
      }
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
