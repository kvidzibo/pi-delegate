#!/usr/bin/env node
// Review-comment generator 1.0.0. Node.js 22+, standard library only.
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const VERSION = '1.0.0';
const OUTCOMES = ['clean', 'changes_required', 'incomplete', 'failed', 'not_run'];
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
let savedHistory;
const HELP = `Review-comment generator ${VERSION} (Node.js 22+)
Usage:
  review-comment.mjs hook                  # pi-delegate completion JSON on stdin
  review-comment.mjs add HISTORY.json INPUT.json [RESPONSE.json]
  review-comment.mjs resolve HISTORY.json RUN_ID FINDING_NUMBER RESOLUTION_TEXT [COMMENT.md]
  review-comment.mjs render HISTORY.json [COMMENT.md]
  review-comment.mjs --version

Writes private per-PR JSON history and prints the full Markdown comment.
Never posts or accesses the network. See the adjacent README.md for setup and input fields.
`;

function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}
function object(value, keys, label) {
  requireThat(value !== null && typeof value === 'object' && !Array.isArray(value), `${label}: expected object`);
  requireThat(Object.keys(value).every(key => keys.includes(key)) && keys.every(key => Object.hasOwn(value, key)), `${label}: unexpected or missing fields`);
}
function string(value, label, empty = false) {
  requireThat(typeof value === 'string' && (empty || value.trim().length > 0) && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value), `${label}: expected ${empty ? '' : 'nonempty '}text without control characters`);
}
function strings(value, label) {
  requireThat(Array.isArray(value), `${label}: expected array`);
  value.forEach(item => string(item, label));
}
function prInfo(value) {
  string(value, 'pr_url');
  requireThat(/^https?:\/\//.test(value) && !/\s/.test(value), 'pr_url: expected an absolute HTTP(S) URL without whitespace');
  const url = new URL(value);
  requireThat(['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash, 'pr_url: expected HTTP(S) PR URL without credentials, query or fragment');
  const match = url.pathname.match(/^\/([^/]+)\/([^/]+)(?:\/(pull|pulls)\/([1-9][0-9]*))?\/?$/);
  requireThat(match, 'pr_url: expected /owner/repo, /owner/repo/pull/N or /owner/repo/pulls/N');
  // Reject URL normalization that would hide traversal or ambiguous separators.
  requireThat(!/%(?:2f|5c|2e)/i.test(value) && !value.includes('\\') && !/\/(?:\.|\.\.)\//.test(value), 'pr_url: unsafe path');
  const repo = `${url.origin}/${match[1]}/${match[2]}`.replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return { url: match[3] ? `${repo}/${match[3]}/${match[4]}` : repo, repo, github: match[3] === 'pull' || (!match[3] && url.hostname === 'github.com') };
}
function validateChecks(checks, label) {
  requireThat(Array.isArray(checks), `${label}: expected array`);
  for (const check of checks) {
    object(check, ['check', 'result', 'details'], label);
    string(check.check, 'check');
    string(check.details, 'details', true);
    requireThat(['passed', 'failed', 'inconclusive'].includes(check.result), `${label}: invalid result`);
  }
}
function validateResponse(response) {
  object(response, ['scope', 'findings', 'checks', 'verification_limits', 'verdict'], 'response');
  string(response.scope, 'scope');
  requireThat(Array.isArray(response.findings) && Array.isArray(response.checks), 'response: findings/checks must be arrays');
  requireThat(['ship', 'fix_first', 'blocked'].includes(response.verdict), 'response: invalid verdict');
  strings(response.verification_limits, 'verification_limits');
  for (const finding of response.findings) {
    object(finding, ['severity', 'path', 'start_line', 'end_line', 'finding', 'evidence'], 'finding');
    requireThat(['critical', 'high', 'medium', 'low'].includes(finding.severity), 'finding: invalid severity');
    string(finding.path, 'path');
    requireThat(!/[\\\s]/.test(finding.path[0]) && !finding.path.startsWith('/') && !finding.path.includes('\\') && !/^[a-z]:/i.test(finding.path) && finding.path.split('/').every(part => part && part !== '.' && part !== '..') && !/[\r\n\t]/.test(finding.path), 'finding: path must be repository-relative without traversal');
    requireThat(Number.isSafeInteger(finding.start_line) && finding.start_line >= 1 && Number.isSafeInteger(finding.end_line) && finding.end_line >= finding.start_line, 'finding: invalid line range');
    string(finding.finding, 'finding');
    string(finding.evidence, 'evidence');
  }
  validateChecks(response.checks, 'checks');
}
function validateInput(input, response) {
  const unattempted = input?.outcome === 'not_run';
  const keys = ['pr_url', 'id', 'outcome', 'validation', 'limits'];
  if (input && Object.hasOwn(input, 'limit_resolutions')) keys.push('limit_resolutions');
  if (!unattempted) keys.push('model', 'reasoning', 'duration_ms', 'base', 'head');
  object(input, keys, 'input');
  const pr = prInfo(input.pr_url);
  requireThat(input.pr_url === pr.url, 'pr_url: history/input must use canonical URL');
  string(input.id, 'id');
  requireThat(OUTCOMES.includes(input.outcome), 'input: invalid outcome');
  strings(input.validation, 'validation');
  strings(input.limits, 'limits');
  if (!unattempted) {
    string(input.model, 'model');
    string(input.reasoning, 'reasoning');
    requireThat(input.model.split('/').at(-1).trim(), 'model: empty model name');
    requireThat(input.duration_ms === null || (Number.isSafeInteger(input.duration_ms) && input.duration_ms >= 0), 'duration_ms: expected nonnegative integer milliseconds or null');
    requireThat(typeof input.base === 'string' && typeof input.head === 'string' && SHA.test(input.base) && SHA.test(input.head), 'base/head: expected full lowercase commit SHAs');
  }
  if (response !== null) validateResponse(response);
  if (Object.hasOwn(input, 'limit_resolutions')) {
    strings(input.limit_resolutions, 'limit_resolutions');
    requireThat(response !== null && input.limit_resolutions.length === response.verification_limits.length, 'limit_resolutions: provide one parent disposition per reviewer limit');
  }
  if (['clean', 'changes_required'].includes(input.outcome)) requireThat(response !== null, 'outcome requires a validated review response');
  if (['failed', 'not_run'].includes(input.outcome)) requireThat(response === null, 'failed/not_run must not include a review response');
  if (['incomplete', 'failed', 'not_run'].includes(input.outcome)) requireThat(input.limits.length > 0 || (response?.verification_limits.length ?? 0) > 0, 'outcome requires an explanation in limits');
  if (response?.verdict === 'blocked') requireThat(input.outcome === 'incomplete', 'blocked review must be incomplete');
  if (input.outcome === 'clean') {
    requireThat(response.verdict === 'ship' && response.findings.length === 0 && (response.verification_limits.length === 0 || input.limit_resolutions?.length === response.verification_limits.length) && input.limits.length === 0 && response.checks.length > 0 && response.checks.every(check => check.result === 'passed') && input.validation.length > 0, 'clean contradicts findings, verdict, limits, checks or missing parent validation');
  }
}
function validateHistory(history) {
  object(history, ['version', 'pr_url', 'runs'], 'history');
  requireThat(history.version === 1, 'history: unsupported version');
  requireThat(prInfo(history.pr_url).url === history.pr_url && Array.isArray(history.runs) && history.runs.length > 0, 'history: invalid PR or empty runs');
  const ids = new Set();
  history.runs.forEach((run, index) => {
    object(run, ['number', 'input', 'response', 'resolutions'], 'run');
    validateInput(run.input, run.response);
    requireThat(run.number === index + 1 && run.input.pr_url === history.pr_url && !ids.has(run.input.id), 'history: invalid numbering, PR or duplicate run ID');
    ids.add(run.input.id);
    strings(run.resolutions, 'resolutions');
    requireThat(run.resolutions.length === (run.response?.findings.length ?? 0), 'history: resolution count differs from findings');
  });
}
function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}
function readHistory(path, optional = false) {
  try {
    requireThat(!lstatSync(path).isSymbolicLink(), 'history: symlinks are not supported');
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    throw error;
  }
  const history = readJson(path);
  validateHistory(history);
  return history;
}
function html(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function text(value) {
  // Entities keep punctuation literal in both CommonMark and Forgejo's math parser.
  return html(value.replace(/\s+/g, ' ').trim()).replace(/[\\`*_{}\[\]()#!|~$]/g, char => `&#${char.codePointAt(0)};`);
}
function fullText(value, repo) {
  const content = html(value);
  return `<pre><code>${repo ? content.replace(/\b(?:[a-f0-9]{64}|[a-f0-9]{40})\b/g, sha => `<a href="${repo}/commit/${sha}">${sha}</a>`) : content}</code></pre>`;
}
function urlPart(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}
function resolutionText(value, repo) {
  // Only full commit IDs become links; all other text is escaped, never raw Markdown.
  return text(value).replace(/\b(?:[a-f0-9]{64}|[a-f0-9]{40})\b/g, sha => `[\`${sha.slice(0, 7)}\`](${repo}/commit/${sha})`);
}
function excerpt(value) {
  const words = value.trim().split(/\s+/);
  return words.slice(0, 15).join(' ') + (words.length > 15 ? '…' : '');
}
function render(history) {
  const pr = prInfo(history.pr_url);
  return [...history.runs].reverse().map((run, position) => {
    const { input, response } = run;
    const findings = response?.findings ?? [];
    const severityCounts = ['critical', 'high', 'medium', 'low'].flatMap(severity => {
      const count = findings.filter(finding => finding.severity === severity).length;
      return count ? [`${count} ${severity}`] : [];
    }).join(' · ');
    const findingSummary = response ? severityCounts || '0' : 'not assessed';
    const sources = findings.map(finding => `${pr.repo}/${pr.github ? 'blob' : 'src/commit'}/${input.head}/${finding.path.split('/').map(urlPart).join('/')}#L${finding.start_line}${finding.end_line === finding.start_line ? '' : `-L${finding.end_line}`}`);
    const lines = input.outcome === 'not_run'
      ? [`### Review ${run.number} — Not run`, `**Outcome:** ${input.outcome}`]
      : [
        `### Review ${run.number} — ${text(input.model.includes('/') ? input.model.slice(input.model.indexOf('/') + 1) : input.model)} · Reasoning: ${text(input.reasoning)}`,
        `**Outcome:** ${input.outcome} · **Duration:** ${input.duration_ms === null ? 'Unknown' : `${Math.round(input.duration_ms / 1000)}s`} · **Diff:** [\`${input.base.slice(0, 7)}…${input.head.slice(0, 7)}\`](${pr.repo}/compare/${input.base}...${input.head})`,
      ];
    lines.push('', `**Findings:** ${findingSummary}`);
    if (findings.length) {
      lines.push('', '| # | Severity | Finding | Resolution |', '|---|---|---|---|');
      findings.forEach((finding, index) => {
        lines.push(`| ${index + 1} | ${finding.severity} | [${text(excerpt(finding.finding))}](${sources[index]}) | ${resolutionText(excerpt(run.resolutions[index]), pr.repo)} |`);
      });
    }
    lines.push('', '<details><summary>Details</summary>', '');
    if (response) lines.push('**Scope:**', '', fullText(response.scope), '', `**Reviewer verdict:** ${response.verdict}`, '');
    findings.forEach((finding, index) => {
      const label = `${text(finding.path)}:${finding.start_line}${finding.end_line === finding.start_line ? '' : `–${finding.end_line}`}`;
      lines.push(`**Finding ${index + 1} — ${finding.severity}:** [${label}](${sources[index]})`, '',
        fullText(finding.finding), '', '**Evidence:**', '', fullText(finding.evidence), '',
        '**Resolution:**', '', fullText(run.resolutions[index], pr.repo), '');
    });
    const validation = [
      ...(response?.checks.map(check => `${check.check}: ${check.result}${check.details ? ` — ${check.details}` : ''}`) ?? []),
      ...input.validation,
    ];
    const limits = [
      ...(response?.verification_limits.map((limit, index) => input.limit_resolutions ? `${limit} — Parent disposition: ${input.limit_resolutions[index]}` : limit) ?? []),
      ...input.limits,
    ];
    lines.push('', '**Validation:**', ...validation.map(item => `\n${fullText(item)}\n`));
    if (!validation.length) lines.push('None recorded.');
    lines.push('', '**Limits:**', ...limits.map(item => `\n${fullText(item)}\n`));
    if (!limits.length) lines.push('None reported.');
    lines.push('', '</details>');
    const section = lines.join('\n');
    if (position === 0) return section;
    return `<details><summary>Review ${run.number} — ${input.outcome} | Findings: ${findingSummary}</summary>\n\n${section}\n\n</details>`;
  }).join('\n\n') + '\n';
}
function locked(path, operation) {
  const lock = `${path}.lock`;
  mkdirSync(lock, { mode: 0o700 });
  try { return operation(); } finally { rmdirSync(lock); }
}
function mutate(path, operation, artifactPath) {
  return locked(path, () => {
    let temporary;
    try {
      const history = operation(readHistory(path, true));
      validateHistory(history);
      const markdown = render(history);
      temporary = `${path}.${randomUUID()}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(history, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      renameSync(temporary, path);
      savedHistory = path;
      temporary = undefined;
      if (artifactPath) atomicFile(artifactPath, markdown);
      return markdown;
    } finally { if (temporary) unlinkSync(temporary); }
  });
}
function addRun(path, input, response, artifactPath) {
  input.pr_url = prInfo(input.pr_url).url;
  validateInput(input, response);
  return mutate(path, history => {
    history ??= { version: 1, pr_url: input.pr_url, runs: [] };
    requireThat(history.pr_url === input.pr_url, 'history belongs to another PR or repository');
    const prior = history.runs.find(run => run.input.id === input.id);
    if (prior) {
      requireThat(isDeepStrictEqual(prior.input, input) && isDeepStrictEqual(prior.response, response), 'conflicting reuse of run ID');
    } else {
      history.runs.push({ number: history.runs.length + 1, input, response, resolutions: response?.findings.map(() => 'Unresolved') ?? [] });
    }
    return history;
  }, artifactPath);
}
function atomicFile(path, content) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
function completionHook(payload) {
  requireThat(payload?.version === 1 && payload.event === 'delegate.completed' && payload.role === 'review', 'hook: expected a version-1 review completion');
  requireThat(payload.status === 'done' || payload.status === 'failed', 'hook: worker must be terminal');
  string(payload.runId, 'runId');
  string(payload.cwd, 'cwd');
  string(payload.paths?.task, 'task archive path');
  requireThat(typeof payload.response?.schemaValidated === 'boolean', 'hook: missing response validation status');
  // Read only the acceptance-time task, never the worker's prose or current HEAD.
  const lines = readFileSync(payload.paths.task, 'utf8').split(/\r?\n/).filter(line => /^\s*Review-comment\s*:/i.test(line));
  requireThat(lines.length === 1 && lines[0].startsWith('Review-comment: '), 'hook: task must have exactly one well-formed Review-comment: JSON context line');
  const context = JSON.parse(lines[0].slice('Review-comment: '.length));
  object(context, ['repository', 'base', 'head', 'validation'], 'hook context');
  validateChecks(context.validation, 'parent validation');
  const target = prInfo(context.repository);
  requireThat(target.url === target.repo, 'hook context: use a repository URL, not a PR URL');
  let response = null;
  const input = {
    pr_url: target.repo, id: payload.runId, model: payload.model ?? payload.requestedModel ?? 'Unknown',
    reasoning: payload.reasoning ?? 'Unknown', duration_ms: payload.durationMs ?? null,
    base: context.base, head: context.head, outcome: 'failed',
    validation: context.validation.map(check => `${check.check}: ${check.result}${check.details ? ` — ${check.details}` : ''}`), limits: [],
  };
  if (payload.status === 'done' && payload.response.schemaValidated) {
    response = payload.response.json;
    validateResponse(response);
    input.outcome = response.verdict === 'blocked' ? 'incomplete'
      : response.verdict === 'fix_first' || response.findings.length ? 'changes_required' : 'clean';
    if (context.validation.some(check => check.result !== 'passed') || !response.checks.length || response.checks.some(check => check.result !== 'passed') || response.verification_limits.length || !context.validation.length) input.outcome = 'incomplete';
    if (input.outcome === 'incomplete' && !response.verification_limits.length) input.limits.push('The reviewer blocked a conclusion or parent/reviewer validation is incomplete.');
  } else {
    input.limits.push(`Worker ${payload.status}; no successful schema-validated review report is available.`);
  }
  if (payload.recordingError) {
    string(payload.recordingError, 'recordingError');
    input.limits.push(payload.recordingError);
    if (input.outcome === 'clean') input.outcome = 'incomplete';
  }
  validateInput(input, response);
  // Each feature worktree has its own Git directory, so unrelated PRs cannot mix.
  const gitDir = execFileSync('git', ['-C', payload.cwd, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8', timeout: 5000 }).trim();
  const directory = join(gitDir, 'pi-review-comment');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const historyPath = join(directory, 'history.json');
  const commentPath = join(directory, 'comment.md');
  addRun(historyPath, input, response, commentPath);
  process.stderr.write(`Review comment: ${commentPath}\nHistory: ${historyPath}\n`);
  return '';
}
function main(args) {
  if (args.length === 1 && args[0] === '--version') return `${VERSION}\n`;
  if (args.length === 1 && args[0] === '--help') return HELP;
  const [command, file, ...rest] = args;
  requireThat(file, HELP);
  const path = resolve(file);
  if (command === 'render' && rest.length <= 1) {
    if (!rest.length) return render(readHistory(path));
    const output = resolve(rest[0]);
    requireThat(output !== path, 'comment output must differ from history');
    return locked(path, () => {
      const markdown = render(readHistory(path));
      atomicFile(output, markdown);
      return markdown;
    });
  }
  if (command === 'add' && (rest.length === 1 || rest.length === 2)) {
    const input = readJson(rest[0]);
    return addRun(path, input, rest.length === 2 ? readJson(rest[1]) : null);
  }
  if (command === 'resolve' && (rest.length === 3 || rest.length === 4)) {
    const [id, number, resolution, file] = rest;
    const output = file === undefined ? undefined : resolve(file);
    requireThat(output !== path, 'comment output must differ from history');
    string(resolution, 'resolution');
    requireThat(/^[1-9][0-9]*$/.test(number) && Number.isSafeInteger(Number(number)), 'finding number must be a positive integer');
    return mutate(path, history => {
      requireThat(history !== null, 'history does not exist');
      const run = history.runs.find(entry => entry.input.id === id);
      requireThat(run && Number(number) <= run.resolutions.length, 'unknown run or finding number');
      run.resolutions[Number(number) - 1] = resolution;
      return history;
    }, output);
  }
  throw new Error(HELP);
}

try {
  const args = process.argv.slice(2);
  const markdown = args.length === 1 && args[0] === 'hook' ? completionHook(JSON.parse(readFileSync(0, 'utf8'))) : main(args);
  await new Promise((done, fail) => {
    process.stdout.once('error', fail);
    process.stdout.write(markdown, error => error ? fail(error) : done());
  });
} catch (error) {
  process.stderr.write(`review-comment: ${error.message}\n`);
  if (savedHistory) process.stderr.write(`History saved to ${savedHistory}; use render to recover the comment, or retry the identical input.\n`);
  process.exitCode = 1;
}
