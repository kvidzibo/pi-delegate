import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertFilesUnchanged, type FileBundle } from "./full-files.ts";

export interface DocsProposal {
	files: Array<{ path: string; content: string }>;
	summary: string[];
	concerns: string[];
}
function object(value: unknown, keys: string[]): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value)
		&& Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string" && item.isWellFormed());

/** A proposal is data, not write authority. Incomplete/wrapped prose cannot be applied as JSON. */
export function parseDocsProposal(text: string, bundle: FileBundle, maxBytes: number): DocsProposal {
	if (Buffer.byteLength(text) > maxBytes) throw new Error("Documentation output exceeds the byte limit.");
	const raw: unknown = JSON.parse(text);
	if (!object(raw, ["files", "summary", "concerns"]) || !Array.isArray(raw.files) || !strings(raw.summary) || !strings(raw.concerns)) {
		throw new Error("Documentation output must contain only files, summary and concerns.");
	}
	const sources = new Map(bundle.files.map(file => [file.path, file]));
	const seen = new Set<string>();
	for (const file of raw.files) {
		if (!object(file, ["path", "content"]) || typeof file.path !== "string" || typeof file.content !== "string" || !file.content.isWellFormed()) {
			throw new Error("Each documentation replacement must contain a path and complete UTF-8 content.");
		}
		const source = sources.get(file.path);
		if (!source || seen.has(file.path)) throw new Error("Documentation output contains a duplicate or out-of-scope path.");
		if (source.content.trim() && !file.content.trim()) throw new Error("Documentation output must not blank a nonempty source.");
		seen.add(file.path);
	}
	return raw as unknown as DocsProposal;
}

export async function archiveDocsProposal(text: string, bundle: FileBundle, archiveDir: string, maxBytes: number): Promise<DocsProposal> {
	const proposal = parseDocsProposal(text, bundle, maxBytes);
	await assertFilesUnchanged(bundle);
	await writeFile(join(archiveDir, "docs-proposal.json"), JSON.stringify(proposal) + "\n", { flag: "wx", mode: 0o600 });
	return proposal;
}
