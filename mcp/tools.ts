import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { DelegateService } from '../delegate/service.ts';
import { registerSettings, type DelegateSettings } from './settings.ts';
import { registerJobResource } from './resources.ts';

const uuid = z.string().uuid();
const nonblank = (max: number) => z.string().max(max).refine((value) => value.trim().length > 0, 'Must not be blank');
const jobValue = z.record(z.string(), z.unknown());
const jobOutput = z.object({ job: jobValue });

function success(value: Record<string, unknown>, text: string) {
  return { structuredContent: value, content: [{ type: 'text' as const, text: `${text}\n${JSON.stringify(value)}` }] };
}

function failure(error: unknown) {
  const message = (error instanceof Error ? error.message : String(error)).trim().slice(0, 500);
  return {
    isError: true,
    content: [{ type: 'text' as const, text: message || 'Delegate service error' }],
  };
}

/** Create the narrow MCP surface for submitting and observing delegate jobs. */
export function createMcpServer(service: DelegateService, version: string, settings?: DelegateSettings): McpServer {
  const server = new McpServer({ name: 'pi-delegate', version }, {
    instructions: [
      'Delegate self-contained tasks to one worker; do not ask workers to create nested delegates.',
      'Collect and validate worker output; job snapshots describe execution status, not task correctness.',
      'Retry delegate_start with the same requestId and identical parameters to recover the same job only within this connection. Never replay uncertain implementation jobs after restart.',
      'Use delegate_status to observe or wait; cancelling an observation does not cancel its worker.',
      'Workers are unsandboxed and retain system permissions. Read-only roles are a prompt instruction, not a security boundary.',
      'Eval repository snapshots and model-writable configuration/approval are disabled. Role models come from configuration; per-job model overrides require operator opt-in. Disabled roles cannot be launched, even with a model override.',
      'Role context providers run automatically before dispatch; review defaults to context [git-diff]. git-diff supplies a private whole-checkout diff against the main/master merge base, including non-ignored untracked files; exclude secrets before calling. Capture failures block launch. Outside Git, supply your own context.',
      'Jobs belong to this server connection/process and are not adopted after restart.',
    ].join(' '),
  });

  server.registerTool('delegate_start', {
    title: 'Start a delegate job',
    description: 'Start one recon, implement, review, or oracle job. Returns its receipt immediately.',
    inputSchema: z.object({
      kind: z.enum(['recon', 'implement', 'review', 'oracle']),
      task: nonblank(20_000),
      requestId: nonblank(128),
      cwd: z.string().optional(),
      model: z.string().max(256).refine((value) => value.trim().length > 0 && /^[^/\s]+\/[^\s]+$/.test(value), 'Expected provider/model').optional(),
    }).strict(),
    outputSchema: z.object({ job: jobValue, reused: z.boolean() }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, async ({ kind, task, requestId, cwd, model }, ctx) => {
    try {
      if (ctx.mcpReq.signal.aborted) throw new Error('Start request cancelled before acceptance; no job was launched.');
      const result = service.start({ kind, task, requestId, cwd, model });
      return success({ job: result.job, reused: result.reused }, `${result.reused ? 'Reused' : 'Started'} job ${result.job.jobId} (${result.job.status}).`);
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool('delegate_status', {
    title: 'Observe delegate jobs',
    description: 'Get one job status, optionally waiting up to 20 seconds, or list jobs using cursor pagination.',
    inputSchema: z.object({
      jobId: uuid.optional(),
      waitMs: z.number().int().min(0).max(20_000).default(0),
      cursor: z.number().int().nonnegative().optional(),
    }).strict().refine((input) => input.jobId ? input.cursor === undefined : input.waitMs === 0, {
      message: 'cursor is only for listing; waitMs is only for an individual job',
    }),
    outputSchema: z.object({ job: jobValue.optional(), jobs: z.array(jobValue).optional(), nextCursor: z.number().int().nonnegative().optional() }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input, ctx) => {
    try {
      if (input.jobId) {
        const result = await service.status(input.jobId, input.waitMs, ctx.mcpReq.signal);
        return success({ job: result.job }, `Job ${result.job.jobId}: ${result.job.status}.`);
      }
      const result = service.list(input.cursor);
      return success({ jobs: result.jobs, ...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }) }, `Listed ${result.jobs.length} job${result.jobs.length === 1 ? '' : 's'}.`);
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool('delegate_control', {
    title: 'Control a delegate job',
    description: 'Explicitly wrap or cancel a job. Wrapping is advisory; wrapping a queued job cancels it.',
    inputSchema: z.object({ jobId: uuid, action: z.enum(['wrap', 'cancel']) }).strict(),
    outputSchema: jobOutput,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ jobId, action }) => {
    try {
      const result = service.control(jobId, action);
      return success({ job: result.job }, `${action === 'wrap' ? 'Wrap requested for' : 'Cancellation requested for'} job ${result.job.jobId} (${result.job.status}).`);
    } catch (error) {
      return failure(error);
    }
  });

  registerJobResource(server, service);
  if (settings) registerSettings(server, settings);
  return server;
}
