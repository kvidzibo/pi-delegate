import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ConfigPaths, DelegateConfig, SnapshotConfig } from "./config.ts";
import { saveDelegateSnapshots } from "./config.ts";
import { formatSnapshotBytes, repositoryFor, repositorySnapshotStats, snapshotDirectory, snapshotEnabled, snapshotSettings } from "./snapshots.ts";

/** Configuration only: browsing/enabling never captures or launches a child. */
export async function snapshotCommand(args: string, ctx: ExtensionCommandContext, config: DelegateConfig, paths: ConfigPaths, agentDir: string, signal: AbortSignal): Promise<void> {
	if (args.trim()) { ctx.ui.notify("Usage: /pi-delegate snapshots", "warning"); return; }
	if (!ctx.hasUI) { ctx.ui.notify("Snapshot settings require an interactive UI; edit delegate.json instead.", "warning"); return; }
	const repo = await repositoryFor(ctx.cwd);
	if (!repo) { ctx.ui.notify("Repository snapshots require a Git working tree.", "warning"); return; }
	let feedback = "";
	while (!signal.aborted) {
		try {
			const current = snapshotSettings(config.snapshots);
			const directory = snapshotDirectory(agentDir, current);
			const stats = await repositorySnapshotStats(repo, directory);
			const enabled = snapshotEnabled(repo, current);
			const toggle = `${enabled ? "Disable" : "Enable"} capture for this repository`;
			const storage = `Storage directory — ${directory}`;
			const choice = await ctx.ui.select(`${feedback ? `${feedback}\n` : ""}Eval snapshots — ${enabled ? "enabled" : "disabled"} · ${stats.count} snapshots · ${formatSnapshotBytes(stats.bytes)}`, [toggle, storage, "Back"], { signal });
			if (choice === undefined || choice === "Back" || signal.aborted) return;
			let next: SnapshotConfig;
			if (choice === toggle) {
				if (!enabled && !await ctx.ui.confirm("Enable repository snapshots?", `Repository: ${repo.configKey}\nStorage: ${directory}\nCaptures tracked and non-ignored untracked source before each delegate starts. Code and Git history may contain secrets; retention is indefinite. Failed captures block launch.`, { signal })) continue;
				next = { ...current, repositories: { ...current.repositories, [repo.configKey]: !enabled } };
			} else if (choice === storage) {
				const value = await ctx.ui.input("Snapshot storage directory (absolute; global setting)", directory, { signal });
				if (value === undefined || signal.aborted) continue;
				if (!await ctx.ui.confirm("Change snapshot storage?", "Applies to future delegates across all enabled repositories. Existing snapshots stay in their previous directory.", { signal })) continue;
				next = { ...current, directory: value.trim() };
			} else continue;
			if (signal.aborted) return;
			saveDelegateSnapshots(paths, current, next);
			config.snapshots = next;
			feedback = "Snapshot settings saved";
		} catch (error) {
			feedback = error instanceof Error ? error.message : "Snapshot settings failed";
			ctx.ui.notify(feedback, "error");
			return;
		}
	}
}
