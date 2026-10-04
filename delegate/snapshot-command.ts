import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ConfigPaths, DelegateConfig, SnapshotConfig } from "./config.ts";
import { saveDelegateSnapshots } from "./config.ts";
import type { SnapshotAuditActions } from "./snapshot-audit.ts";
import { assertSnapshotLocation, formatSnapshotBytes, repositoryFor, repositorySnapshotStats, snapshotDirectory, snapshotEnabled, snapshotSettings } from "./snapshots.ts";

/** Snapshot settings UI; audit work is delegated to the parent-owned audit actions. */
export async function snapshotCommand(args: string, ctx: ExtensionCommandContext, config: DelegateConfig, paths: ConfigPaths, agentDir: string, signal: AbortSignal, audit: SnapshotAuditActions): Promise<void> {
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
			const overridden = Object.hasOwn(current.repositories, repo.configKey);
			const explicitEnabled = overridden && current.repositories[repo.configKey] === true;
			const toggle = enabled ? "Disable capture for this repository" : "Audit repository before enabling capture";
			const manual = "Enable capture anyway (manual approval)";
			const reset = "Use global default for this repository";
			const defaultToggle = `Offer first-use audits by default — ${current.defaultEnabled ? "on" : "off"}`;
			const storage = `Storage directory — ${directory}`;
			const status = explicitEnabled ? "explicitly enabled" : overridden ? "disabled by repository override" : `disabled · inherits global default (${current.defaultEnabled ? "audit offered" : "off"})`;
			const choice = await ctx.ui.select(`${feedback ? `${feedback}\n` : ""}Eval snapshots — ${status} · ${stats.count} snapshots · ${formatSnapshotBytes(stats.bytes)}`, [toggle, ...(!enabled ? [manual] : []), ...(overridden ? [reset] : []), ...(enabled ? ["Re-audit this repository"] : []), defaultToggle, storage, "Back"], { signal });
			if (choice === undefined || choice === "Back" || signal.aborted) return;
			let next: SnapshotConfig;
			if (choice === toggle) {
				if (enabled) {
					next = { ...current, repositories: { ...current.repositories, [repo.configKey]: false } };
				} else {
					await audit.request(ctx, repo, signal);
					return;
				}
			} else if (choice === manual) {
				if (!await ctx.ui.confirm("Warning: enable snapshots without a current audit?",
					`Repository: ${JSON.stringify(repo.root)}\nA stale or incomplete audit is not a current safety approval, even if no issues were reported. Snapshots preserve source and Git history and may contain secrets. Enabling manually accepts the risk of missed or newly introduced secrets. Snapshots stay private, are not uploaded, and are retained until you delete them. Hard capture/storage checks still apply. Enable capture anyway?`, { signal })) continue;
				if (signal.aborted) return;
				const live = await repositoryFor(ctx.cwd, signal);
				if (!live || live.root !== repo.root || live.id !== repo.id) throw new Error("Repository changed during manual approval; reopen /pi-delegate snapshots.");
				assertSnapshotLocation(live, directory);
				await repositorySnapshotStats(live, directory, signal);
				next = { ...current, repositories: { ...current.repositories, [repo.configKey]: true } };
			} else if (choice === "Re-audit this repository") {
				await audit.request(ctx, repo, signal);
				return;
			} else if (choice === reset) {
				const repositories = { ...current.repositories };
				delete repositories[repo.configKey];
				next = { ...current, repositories };
			} else if (choice === defaultToggle) {
				if (!current.defaultEnabled && !await ctx.ui.confirm("Offer first-use repository audits?", "Repositories without an explicit setting will be offered a user-approved audit before capture can be enabled. This does not capture automatically. Existing repository overrides are preserved.", { signal })) continue;
				next = { ...current, defaultEnabled: !current.defaultEnabled };
			} else if (choice === storage) {
				const value = await ctx.ui.input("Snapshot storage directory (absolute; global setting)", directory, { signal });
				if (value === undefined || signal.aborted) continue;
				if (!await ctx.ui.confirm("Change snapshot storage?", "Applies to future delegates in explicitly enabled repositories. Existing snapshots stay in their previous directory.", { signal })) continue;
				next = { ...current, directory: value.trim() };
			} else continue;
			if (signal.aborted) return;
			audit.cancel(choice === manual ? "The user chose manual capture approval instead of the audit." : "Snapshot settings changed during the audit.");
			saveDelegateSnapshots(paths, current, next);
			config.snapshots = next;
			feedback = choice === manual ? "Capture enabled by manual approval (not an audited safety guarantee)" : "Snapshot settings saved";
			if (choice === reset && next.defaultEnabled) {
				await audit.request(ctx, repo, signal);
				return;
			}
			if (choice === defaultToggle && next.defaultEnabled && !Object.hasOwn(next.repositories, repo.configKey)) {
				await audit.request(ctx, repo, signal);
				return;
			}
		} catch (error) {
			feedback = error instanceof Error ? error.message : "Snapshot settings failed";
			ctx.ui.notify(feedback, "error");
			return;
		}
	}
}
