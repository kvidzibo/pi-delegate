import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export interface TimeoutDefaults {
	defaultTimeoutMs: number;
	maxTimeoutMs: number;
}

export function assertNotNested(env: NodeJS.Dict<string> = process.env, label = "delegate"): void {
	if (env.PI_DELEGATE_CHILD === "1") {
		throw new Error(`${label} refused: already inside a delegate child (PI_DELEGATE_CHILD=1). Nesting is forbidden.`);
	}
}

export function normalizeTimeoutMs(value: unknown, defaults: TimeoutDefaults, label = "child"): number {
	const raw = value === undefined || value === null ? defaults.defaultTimeoutMs : value;
	if (typeof raw !== "number" || !Number.isInteger(raw)) {
		throw new Error(`${label} refused: timeoutMs must be an integer.`);
	}
	if (raw < 1000) return 1000;
	if (raw > defaults.maxTimeoutMs) return defaults.maxTimeoutMs;
	return raw;
}

export function resolveChildCwd(cwd: string | undefined, parentCwd: string, label = "child"): string {
	if (!parentCwd || !isAbsolute(parentCwd)) {
		throw new Error(`${label} refused: parent cwd must be an absolute path.`);
	}
	const resolved = cwd === undefined || cwd === "" ? parentCwd : resolve(parentCwd, cwd);
	if (!isAbsolute(resolved)) throw new Error(`${label} refused: child cwd must be absolute after resolve.`);
	if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
		throw new Error(`${label} refused: cwd is not an existing directory: ${resolved}`);
	}
	return resolved;
}

export function truncateToUtf8Bytes(text: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	const buf = Buffer.from(text, "utf8");
	if (buf.byteLength <= maxBytes) return text;
	let truncated = buf.subarray(0, maxBytes).toString("utf8");
	while (Buffer.byteLength(truncated, "utf8") > maxBytes) {
		truncated = truncated.slice(0, -1);
	}
	return truncated;
}

function truncationNotice(omitted: number): string {
	return `\n\n[truncated ${omitted} bytes]`;
}

export function truncateOutput(text: string, maxBytes: number, label = "child"): string {
	if (maxBytes < 1) throw new Error(`${label} refused: maxOutputBytes must be positive.`);
	const total = Buffer.byteLength(text, "utf8");
	if (total <= maxBytes) return text;
	let bodyBytes = maxBytes;
	for (let i = 0; i < 24; i++) {
		const omitted = Math.max(1, total - bodyBytes);
		const noticeBytes = Buffer.byteLength(truncationNotice(omitted), "utf8");
		if (noticeBytes >= maxBytes) return truncateToUtf8Bytes(text, maxBytes);
		const allowedBody = maxBytes - noticeBytes;
		if (allowedBody === bodyBytes) break;
		if (allowedBody < bodyBytes) {
			bodyBytes = Math.max(0, allowedBody);
			continue;
		}
		break;
	}
	const body = truncateToUtf8Bytes(text, bodyBytes);
	const omitted = total - Buffer.byteLength(body, "utf8");
	const out = `${body}${truncationNotice(omitted)}`;
	if (Buffer.byteLength(out, "utf8") > maxBytes) return truncateToUtf8Bytes(out, maxBytes);
	return out;
}

export function isFailedChildResult(result: { exitCode: number; stopReason?: string; text?: string }): boolean {
	if (result.exitCode !== 0) return true;
	const stop = result.stopReason;
	if (
		stop === "error" ||
		stop === "aborted" ||
		stop === "timeout" ||
		stop === "protocol-error" ||
		stop === "no-assistant-output"
	) {
		return true;
	}
	return !result.text;
}

export function normalizeTask(task: unknown, maxTaskChars: number, label = "child"): string {
	if (typeof task !== "string" || task.trim().length === 0) {
		throw new Error(`${label} refused: task is required.`);
	}
	if (task.length > maxTaskChars) {
		throw new Error(`${label} refused: task exceeds ${maxTaskChars} chars.`);
	}
	return task;
}

export function isNonEmptyStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.length > 0);
}
