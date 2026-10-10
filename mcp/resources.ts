import { ProtocolError, type McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { DelegateService } from '../delegate/service.ts';

export const JOBS_URI = 'delegate://jobs';
export const JOBS_MIME = 'application/vnd.pi-delegate.jobs+json';

/** One stdio client owns the subscription, just as it owns the jobs. */
export function registerJobResource(server: McpServer, service: DelegateService): void {
  let subscribed = false;
  let last = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  server.registerResource('Delegate jobs', JOBS_URI, {
    mimeType: JOBS_MIME,
    description: 'Live delegate job summaries (schemaVersion 1). Execution state, not verified task success.',
  }, () => ({ contents: [{ uri: JOBS_URI, mimeType: JOBS_MIME, text: JSON.stringify(service.jobBoard()) }] }));
  server.server.registerCapabilities({ resources: { subscribe: true } });
  const params = z.object({ uri: z.string(), _meta: z.record(z.string(), z.unknown()).optional() });
  server.server.setRequestHandler('resources/subscribe', { params }, input => {
    if (input.uri !== JOBS_URI) throw new ProtocolError(-32602, 'Unknown resource');
    subscribed = true;
    last = JSON.stringify(service.jobBoard());
    return {};
  });
  server.server.setRequestHandler('resources/unsubscribe', { params }, input => {
    if (input.uri !== JOBS_URI) throw new ProtocolError(-32602, 'Unknown resource');
    subscribed = false;
    if (timer) clearTimeout(timer);
    timer = undefined;
    return {};
  });
  const detach = service.onJobsChanged(() => {
    if (!subscribed || timer) return;
    // Coalesce bursts, but do not postpone forever while a worker streams.
    timer = setTimeout(() => {
      timer = undefined;
      const next = JSON.stringify(service.jobBoard());
      if (!subscribed || next === last) return;
      last = next;
      void server.server.sendResourceUpdated({ uri: JOBS_URI }).catch(() => { /* Transport owns disconnect cleanup. */ });
    }, 100);
    timer.unref();
  });
  const onclose = server.server.onclose;
  server.server.onclose = () => {
    subscribed = false;
    if (timer) clearTimeout(timer);
    detach();
    onclose?.();
  };
}
