import { formatJobBoard, type ActivityItem } from "./display.ts";
import type { CardDetails } from "./cards.ts";
import type { JobSnapshot } from "./jobs.ts";

export type JobBoardState = { summary: string; cards: CardDetails[] };

// Copy only rendered tool fields, never thinking fragments or tool-call IDs.
const tool = (item: ActivityItem | undefined): ActivityItem | undefined => !item || item.name === "thinking" ? undefined
	: { mark: item.mark, name: item.name, ...(item.args ? { args: item.args } : {}) };

/** Display-only state: an optional TUI clock adds whole seconds; usage/raw thought deltas stay private. */
export function projectJobBoard(jobs: readonly JobSnapshot[], limits: { maxLocalConcurrent: number }, now?: number): JobBoardState | undefined {
	const active = jobs.filter((job) => job.status === "running" || job.status === "queued");
	if (!active.length) return undefined;
	return {
		summary: formatJobBoard(active, limits)[0],
		cards: active.map((job) => {
			const since = job.status === "queued" ? job.queuedAt : job.startedAt;
			return {
				elapsedMs: now !== undefined && typeof since === "number" && Number.isFinite(since) ? Math.floor(Math.max(0, now - since) / 1000) * 1000 : undefined,
				jobId: job.id, kind: job.kind, model: job.model, reasoning: job.reasoning, task: job.task, status: job.status,
				reason: job.reason, wrapped: job.wrapped, cancellationRequested: job.cancellationRequested,
				phase: job.thinking ? "thinking" : undefined,
				current: tool(job.current), activity: job.activity.map(tool).filter((item) => item !== undefined).slice(-3),
				tg: job.local ? job.tg : undefined, recordingError: job.recordingError,
				resource: job.resource ? { key: job.resource.key } : undefined, resourceError: job.resourceError,
				sessionFile: job.archive?.sessionFile,
			};
		}),
	};
}
