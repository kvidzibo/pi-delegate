import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../review-comment.mjs', import.meta.url));
const normalize = value => value.replace(/\s+/g, ' ').trim();
// Decode brief summary cells; expanded literal blocks are checked separately.
const plain = value => value.replace(/\[([^\]\n]*)\]\([^\s)]*\)/g, '$1')
  .replace(/<a href="[^"]*">([^<]*)<\/a>/g, '$1')
  .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const excerpt = value => {
  const words = normalize(value).split(' ');
  return words.slice(0, 15).join(' ') + (words.length > 15 ? '…' : '');
};

test('compact review CLI keeps excerpts visible and complete review history expandable', () => {
  const dir = mkdtempSync('/tmp/review-comment-compact-');
  const history = join(dir, 'history.json');
  const inputFile = join(dir, 'input.json');
  const responseFile = join(dir, 'response.json');
  const base = 'a'.repeat(40);
  const head = 'b'.repeat(40);
  const repo = 'https://forge.example/team/repo';
  const input = {
    pr_url: `${repo}/pulls/17`, id: 'first', outcome: 'changes_required',
    model: 'provider/reviewer', reasoning: 'high', duration_ms: 60219,
    base, head, validation: ['Parent validation sentinel passed locally'],
    limits: ['Parent limitation sentinel remains unverified'],
  };
  const findings = [
    {
      severity: 'high', path: 'src/a b#c.ts', start_line: 3, end_line: 5,
      finding: 'One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen hidden finding tail sentinel',
      evidence: '\nEvidence sentinel | observed\n<script>unsafe</script> & **literal** failure\n  indented line\n\n\tcode line',
    },
    {
      severity: 'medium', path: 'src/other.ts', start_line: 8, end_line: 8,
      finding: '<details><summary>injected</summary></details>\t[link](https://evil.example) | **bold** `code` & <script>bad</script>\r\none two three four five six seven eight nine ten hidden markup tail sentinel',
      evidence: 'Second evidence sentinel with <summary>literal</summary> and $math$',
    },
  ];
  const response = {
    scope: 'Scope sentinel: selected changed files only', findings,
    checks: [{ check: 'Check sentinel', result: 'passed', details: 'Check detail sentinel all assertions passed' }],
    verification_limits: ['Reviewer limitation sentinel outside local coverage'], verdict: 'fix_first',
  };
  const commit = 'c'.repeat(40);
  const resolution = `Fixed one two three four five six seven eight nine ten eleven twelve thirteen fourteen hidden resolution tail sentinel <details><summary>unsafe</summary></details> ${commit}`;
  const state = () => JSON.parse(readFileSync(history, 'utf8'));
  const ok = (...args) => {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const add = (metadata, report) => {
    writeFileSync(inputFile, JSON.stringify(metadata));
    if (report !== undefined) writeFileSync(responseFile, JSON.stringify(report));
    return ok('add', history, inputFile, ...(report === undefined ? [] : [responseFile]));
  };
  const inspect = (markdown, number, resolutions) => {
    const heading = markdown.indexOf(`### Review ${number} —`);
    assert.ok(heading >= 0);
    const start = markdown.indexOf('<details><summary>Details</summary>', heading);
    assert.ok(start > heading, 'each review has one expandable Details section');
    const end = markdown.indexOf('</details>', start);
    assert.ok(end > start);
    const visible = markdown.slice(heading, start);
    const details = markdown.slice(start, end);
    assert.match(visible, new RegExp(`^### Review ${number} — reviewer · Reasoning: high\\n`));
    const metadata = visible.split('\n').filter(line => /\*\*(?:Outcome|Duration|Diff):\*\*/.test(line));
    assert.equal(metadata.length, 1, 'all metadata belongs on one line');
    for (const pattern of [/\*\*Outcome:\*\* changes_required/, /\*\*Duration:\*\* 60s\b/, /\*\*Diff:\*\*/]) {
      assert.match(metadata[0], pattern);
    }
    assert.ok(metadata[0].includes(`${repo}/compare/${base}...${head}`));
    assert.match(visible, /\n\n\*\*Findings:\*\* 1 high · 1 medium\n\n/);
    assert.match(visible, /\|\s*Finding\s*\|\s*Resolution\s*\|/);
    const rows = visible.split('\n').filter(line => /^\|\s*\d+\s*\|/.test(line));
    assert.equal(rows.length, findings.length);
    rows.forEach((row, index) => {
      const cells = row.split('|').slice(1, -1).map(cell => cell.trim());
      assert.equal(cells.length, 4, 'literal pipes cannot create extra columns');
      const finding = plain(cells[2]);
      const resolved = plain(cells[3]);
      assert.equal(finding, excerpt(findings[index].finding), 'finding is a deterministic fifteen-word excerpt');
      assert.equal(resolved, excerpt(resolutions[index]), 'resolution is a deterministic excerpt');
      assert.ok(normalize(finding).split(' ').length <= 15);
      assert.ok(normalize(resolved).split(' ').length <= 15);
      const source = `${repo}/src/commit/${head}/${index ? 'src/other.ts#L8' : 'src/a%20b%23c.ts#L3-L5'}`;
      assert.ok(cells[2].startsWith('[') && cells[2].endsWith(`](${source})`), 'the excerpt itself links to pinned source');
      const literal = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      assert.ok(details.includes(`<pre><code>${literal(findings[index].finding)}</code></pre>`), 'full finding retained literally');
      assert.ok(details.includes(`<pre><code>${literal(findings[index].evidence)}</code></pre>`), 'expanded evidence preserves line breaks and indentation');
      const fullResolution = literal(resolutions[index]).replace(/\b[a-f0-9]{40}\b/g, sha => `<a href="${repo}/commit/${sha}">${sha}</a>`);
      assert.ok(details.includes(`<pre><code>${fullResolution}</code></pre>`), 'full resolution retained literally');
      assert.ok(plain(details).includes(findings[index].path), 'full source path retained');
    });
    for (const label of ['Scope', 'Finding', 'Evidence', 'Resolution', 'Validation', 'Limits']) {
      assert.match(details, new RegExp(`\\b${label}\\b`, 'i'));
    }
    for (const hidden of ['Scope sentinel: selected changed files only', 'hidden finding tail sentinel', 'hidden markup tail sentinel', 'Evidence sentinel',
      'Second evidence sentinel', 'Parent validation sentinel', 'Check sentinel', 'Check detail sentinel',
      'Parent limitation sentinel', 'Reviewer limitation sentinel', ...(resolutions[0] === resolution ? ['hidden resolution tail sentinel'] : [])]) {
      assert.ok(!visible.includes(hidden), `${hidden} must not be visible`);
      assert.ok(plain(details).includes(hidden), `${hidden} must remain in Details`);
    }
    assert.doesNotMatch(visible, /\*\*(?:Validation|Limits):\*\*|\*\*bold\*\*|\[link\]\(https:\/\/evil\.example\)/);
    if (resolutions[0] === resolution) assert.ok(details.includes(`<a href="${repo}/commit/${commit}">${commit}</a>`), 'expanded commit labels remain full length');
    assert.ok(markdown.slice(start).match(/^<details><summary>Details<\/summary>\n\s*\n/), 'GFM needs a blank line before expanded Markdown');
    assert.match(markdown.slice(heading, end + '</details>'.length), /\n\s*\n<\/details>$/);
  };
  try {
    const initial = add(input, response);
    inspect(initial, 1, ['Unresolved', 'Unresolved']);
    const beforeResolve = state();
    const resolved = ok('resolve', history, 'first', '1', resolution);
    inspect(resolved, 1, [resolution, 'Unresolved']);
    const expected = structuredClone(beforeResolve);
    expected.runs[0].resolutions[0] = resolution;
    assert.deepEqual(state(), expected, 'only the requested resolution changes');
    assert.deepEqual(state().runs[0].response, response, 'original response remains unabridged');
    const originalRun = structuredClone(state().runs[0]);

    const second = add({ ...input, id: 'second' }, response);
    inspect(second, 2, ['Unresolved', 'Unresolved']);
    inspect(second, 1, [resolution, 'Unresolved']);
    const firstWrapper = '<details><summary>Review 1 — changes_required | Findings: 1 high · 1 medium</summary>';
    assert.ok(second.indexOf('### Review 2') < second.indexOf(firstWrapper));
    assert.equal((second.match(/<details>/g) ?? []).length, 3);
    assert.deepEqual(state().runs[0], originalRun);

    const skipped = { pr_url: input.pr_url, id: 'third', outcome: 'not_run', validation: [], limits: ['Not requested sentinel'] };
    const third = add(skipped);
    assert.match(third, /^### Review 3 — Not run\n/);
    const secondWrapper = '<details><summary>Review 2 — changes_required | Findings: 1 high · 1 medium</summary>';
    assert.ok(third.indexOf('### Review 3') < third.indexOf(secondWrapper));
    assert.ok(third.indexOf(secondWrapper) < third.indexOf(firstWrapper));
    const newest = third.slice(0, third.indexOf(secondWrapper));
    assert.doesNotMatch(newest, /Reasoning:|\*\*Duration:|\*\*Diff:/);
    assert.match(newest, /\*\*Outcome:\*\* not_run/);
    assert.match(newest, /\*\*Findings:\*\* not assessed/);
    assert.doesNotMatch(newest, /\*\*Findings:\*\* 0/);
    assert.ok(newest.indexOf('Not requested sentinel') > newest.indexOf('<details><summary>Details</summary>'));
    inspect(third, 2, ['Unresolved', 'Unresolved']);
    inspect(third, 1, [resolution, 'Unresolved']);
    assert.equal((third.match(/<details><summary>Details<\/summary>/g) ?? []).length, 3);
    assert.equal((third.match(/<details>/g) ?? []).length, 5, 'two old wrappers plus three Details sections');
    assert.equal((third.match(/<\/details>/g) ?? []).length, 5);
    for (const wrapper of [firstWrapper, secondWrapper]) {
      const inner = third.slice(third.indexOf(wrapper) + wrapper.length);
      assert.match(inner, /^\n\s*\n### Review/, 'closed old review wrapper supports GFM');
    }
    const stack = [];
    for (const match of third.matchAll(/<details><summary>([^<]+)<\/summary>|<\/details>|### Review (\d+) —/g)) {
      if (match[1]) stack.push(match[1]);
      else if (match[2]) {
        assert.deepEqual(stack, match[2] === '3' ? [] : [`Review ${match[2]} — changes_required | Findings: 1 high · 1 medium`],
          'newest heading is open; each older heading is inside only its own closed wrapper');
      } else {
        assert.ok(stack.length, 'every close tag has a matching details opener');
        stack.pop();
      }
    }
    assert.deepEqual(stack, [], 'all Details and older review wrappers close correctly');
    assert.doesNotMatch(third, /<details\s+open\b|<script>|<summary>injected<\/summary>|<summary>unsafe<\/summary>/i);
    assert.ok(third.includes('&lt;details&gt;&lt;summary&gt;injected&lt;/summary&gt;&lt;/details&gt;'));
    assert.deepEqual(state().runs[0], originalRun, 'adding reviews never rewrites earlier content');
    assert.deepEqual(state().runs.map(run => run.number), [1, 2, 3]);
    const saved = readFileSync(history);
    assert.equal(ok('render', history), third);
    assert.equal(ok('render', history), third, 'render order and excerpts are stable');
    assert.deepEqual(readFileSync(history), saved, 'render does not mutate history bytes');

    const mixed = { ...response, findings: ['low', 'medium', 'high', 'medium', 'critical', 'medium'].map(severity => ({ ...findings[0], severity })) };
    const fourth = add({ ...input, id: 'mixed' }, mixed);
    assert.match(fourth, /\*\*Findings:\*\* 1 critical · 1 high · 3 medium · 1 low/);
    assert.match(fourth, /<summary>Review 3 — not_run \| Findings: not assessed<\/summary>/);
    const empty = add({ ...input, id: 'empty', outcome: 'clean', limits: [] }, { ...response, findings: [], verification_limits: [], verdict: 'ship' });
    assert.match(empty, /\*\*Findings:\*\* 0/);
    assert.match(empty, /<summary>Review 4 — changes_required \| Findings: 1 critical · 1 high · 3 medium · 1 low<\/summary>/);
    const sixth = add({ ...input, id: 'last' }, response);
    assert.match(sixth, /<summary>Review 5 — clean \| Findings: 0<\/summary>/);
    assert.deepEqual(state().runs[0], originalRun, 'severity summaries do not alter historical data');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
