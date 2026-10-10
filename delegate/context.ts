import type { ContextProvider } from "./config.ts";
import { prepareGitDiffTask } from "./review-diff.ts";

type ContextInput = {
	task: string;
	cwd: string;
	archiveDir: string;
	signal: AbortSignal;
	env?: NodeJS.Dict<string>;
};

/** Built-in, parent-owned providers; configuration never supplies executable commands. */
const providers: Record<ContextProvider, (input: ContextInput) => Promise<string>> = {
	"git-diff": input => prepareGitDiffTask(input.task, input.cwd, input.archiveDir, input.signal, input.env),
};

export async function prepareContextTask(context: readonly ContextProvider[], input: ContextInput): Promise<string> {
	let task = input.task;
	for (const name of context) {
		input.signal.throwIfAborted();
		task = await providers[name]({ ...input, task });
	}
	input.signal.throwIfAborted();
	return task;
}
