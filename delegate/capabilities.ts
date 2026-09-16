import { truncateOutput } from "../child-runtime/policy.ts";

const BUILTINS = new Set(["read", "grep", "find", "ls", "bash", "powershell", "write", "edit"]);
const SHELL = ["bash", "powershell"];
const WRITE = ["write", "edit"];
const MAX_TOOLS = 64, MAX_NAME_BYTES = 128;
const fitsName = (name: string) => Buffer.byteLength(JSON.stringify(name)) <= MAX_NAME_BYTES;

/** Requested CLI allowlist, never proof of child readiness, permissions or command availability. */
export interface CapabilityManifest {
	source: "configured";
	tools: string[];
	omittedTools: number;
	shellTools: string[];
	writeTools: string[];
	unknownTools: number;
	filesystemSandbox: false;
}

export function describeCapabilities(configuredTools: readonly string[]): CapabilityManifest {
	// Match Pi CLI --tools parsing (join, split, trim, ignore empties), then exact-name selection.
	const names = new Set(configuredTools.flatMap(value => value.split(",").map(name => name.trim()).filter(Boolean)));
	const tools = [...names].filter(fitsName).slice(0, MAX_TOOLS);
	return { source: "configured", tools, omittedTools: names.size - tools.length,
		shellTools: SHELL.filter(name => names.has(name)), writeTools: WRITE.filter(name => names.has(name)),
		unknownTools: [...names].filter(name => !BUILTINS.has(name)).length, filesystemSandbox: false };
}

export function copyCapabilities(value: unknown): CapabilityManifest | undefined {
	const raw = value as Partial<CapabilityManifest> | undefined;
	const names = (list: unknown, allowed?: string[]): list is string[] => Array.isArray(list) && list.length <= MAX_TOOLS
		&& list.every(name => typeof name === "string" && name.length > 0 && fitsName(name)
			&& name.trim() === name && !name.includes(",") && (!allowed || allowed.includes(name)))
		&& new Set(list).size === list.length;
	const count = (number: unknown): number is number => Number.isSafeInteger(number) && (number as number) >= 0;
	if (!raw || raw.source !== "configured" || raw.filesystemSandbox !== false || !names(raw.tools)
		|| !names(raw.shellTools, SHELL) || !names(raw.writeTools, WRITE) || !count(raw.omittedTools) || !count(raw.unknownTools)) return;
	const visibleUnknown = raw.tools.filter(name => !BUILTINS.has(name)).length;
	const missing = [...raw.shellTools, ...raw.writeTools].filter(name => !raw.tools!.includes(name)).length;
	// Known builtin names fit the name-byte limit; only a full count-limited list can omit them.
	if ((missing > 0 && raw.tools.length < MAX_TOOLS)
		|| !Number.isSafeInteger(raw.tools.length + raw.omittedTools) || raw.unknownTools < visibleUnknown
		|| raw.unknownTools - visibleUnknown + missing > raw.omittedTools
		|| SHELL.some(name => raw.tools!.includes(name) && !raw.shellTools!.includes(name))
		|| WRITE.some(name => raw.tools!.includes(name) && !raw.writeTools!.includes(name))) return;
	return { source: "configured", tools: [...raw.tools], omittedTools: raw.omittedTools,
		shellTools: [...raw.shellTools], writeTools: [...raw.writeTools], unknownTools: raw.unknownTools, filesystemSandbox: false };
}

/** Separate bounded data block: never consumes the preceding report's text budget. */
export function capabilityContent(value: unknown): Array<{ type: "text"; text: string }> {
	const caps = copyCapabilities(value);
	if (!caps) return [];
	const quote = (name: string) => JSON.stringify(name).replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
		char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
	const text = [
		"Configured capabilities only; not child-verified. No filesystem sandbox.",
		`Shell tools: ${caps.shellTools.join(", ") || "none listed"}; direct write/edit tools: ${caps.writeTools.join(", ") || "none listed"}.`,
		...(caps.shellTools.length ? ["Shell access can modify files; read-only intent is not write protection."] : []),
		...(caps.unknownTools ? [`Other configured names: ${caps.unknownTools}; availability and effects unknown.`] : []),
		`Tools: ${caps.tools.map(quote).join(", ") || "(none listed)"}${caps.omittedTools ? `; ${caps.omittedTools} names omitted` : ""}`,
	].join("\n");
	return [{ type: "text", text: truncateOutput(text, 512) }];
}
