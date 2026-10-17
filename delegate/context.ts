import type { ContextProvider } from "./config.ts";
import { prepareGitDiffTask } from "./review-diff.ts";
import { prepareFullFiles, type FileBundle } from "./full-files.ts";

type ContextInput = {
	task: string;
	cwd: string;
	archiveDir: string;
	signal: AbortSignal;
	env?: NodeJS.Dict<string>;
	base?: string;
	head?: string;
	files?: string[];
};

/** Built-in, parent-owned providers; configuration never supplies executable commands. */
export async function prepareContextTask(context: readonly ContextProvider[], input: ContextInput): Promise<{ task: string; files?: FileBundle }> {
	let task = input.task;
	let files: FileBundle | undefined;
	for (const provider of context) {
		input.signal.throwIfAborted();
		if (provider === "git-diff") task = await prepareGitDiffTask(task, input.cwd, input.archiveDir, input.signal, input.env);
		else {
			const prepared = await prepareFullFiles({ ...input, spec: provider });
			files = prepared.bundle;
			task += "\n\n" + prepared.context;
		}
	}
	input.signal.throwIfAborted();
	return { task, files };
}
