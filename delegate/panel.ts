import { formatJobBoard, type ActivityItem } from "./display.ts";
import type { CardDetails } from "./cards.ts";
import type { JobSnapshot } from "./jobs.ts";

export type JobBoardState = { summary: string; cards: CardDetails[] };

// Copy only rendered tool fields, never thinking fragments or tool-call IDs.
const tool = (item: ActivityItem | undefined): ActivityItem | undefined => !item || item.name === "thinking" ? undefined
	: { mark: item.mark, name: item.name, ...(item.args ? { args: item.args } : {}) };

/** A stable, display-only projection: clocks/usage/raw thought deltas cannot repaint the panel. */
export function projectJobBoard(jobs: readonly JobSnapshot[], limits: { maxLocalConcurrent: number }): JobBoardState | undefined {
	const active = jobs.filter((job) => job.status === "running" || job.status === "queued");
	if (!active.length) return undefined;
	return {
		summary: formatJobBoard(active, limits)[0],
		cards: active.map((job) => ({
			jobId: job.id, kind: job.kind, model: job.model, task: job.task, status: job.status,
			reason: job.reason, wrapped: job.wrapped, phase: job.thinking ? "thinking" : undefined,
			current: tool(job.current), activity: job.activity.map(tool).filter((item) => item !== undefined).slice(-3),
			tg: job.local ? job.tg : undefined, recordingError: job.recordingError,
			sessionFile: job.archive?.sessionFile,
		})),
	};
}
