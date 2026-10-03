import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import { captureRepository, repositoryFor, repositorySnapshotStats, snapshotEnabled } from "../snapshots.ts";

test("opt-in repository captures preserve starting source/index/history, deduplicate and fail closed", async () => {
	const dir = mkdtempSync(join(tmpdir(), "delegate-snapshot-test-"));
	const repoPath = join(dir, "repo"), storage = join(dir, "storage"), worktree = join(dir, "worktree");
	mkdirSync(repoPath);
	const git = (...args: string[]) => execFileSync("git", args, { cwd: repoPath, env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, encoding: "utf8" });
	try {
		git("init", "-q", "-b", "main");
		writeFileSync(join(repoPath, "tracked"), "original\n");
		mkdirSync(join(repoPath, "deleted-dir"));
		writeFileSync(join(repoPath, "deleted-dir", "deleted"), "gone\n");
		writeFileSync(join(repoPath, ".gitignore"), "ignored\n");
		git("add", ".");
		git("-c", "user.name=Test", "-c", "user.email=test@invalid", "commit", "-qm", "base");
		const head = git("rev-parse", "HEAD").trim();
		writeFileSync(join(repoPath, "tracked"), "staged\n"); git("add", "tracked");
		writeFileSync(join(repoPath, "tracked"), "working\n");
		rmSync(join(repoPath, "deleted-dir"), { recursive: true });
		writeFileSync(join(repoPath, "untracked\n界"), Buffer.from([0, 1, 255]));
		writeFileSync(join(repoPath, "ignored"), "not captured\n");
		writeFileSync(join(repoPath, "executable"), "#!/bin/sh\n"); chmodSync(join(repoPath, "executable"), 0o755);
		symlinkSync("/outside/not-read", join(repoPath, "link"));
		const repo = (await repositoryFor(repoPath))!;
		assert.equal(snapshotEnabled(repo), false);
		assert.deepEqual(await repositorySnapshotStats(repo, storage), { count: 0, bytes: 0 });
		assert.equal(readdirSync(dir).includes("storage"), false, "disabled queries never create storage");
		assert.equal(snapshotEnabled(repo, { repositories: { [repo.configKey]: true } }), true);
		const before = git("status", "--porcelain=v1");
		const first = await captureRepository(repo, storage, "run-one");
		const manifest = JSON.parse(readFileSync(first.manifestPath, "utf8"));
		assert.equal(manifest.head, head); assert.equal(manifest.runId, "run-one");
		const contents = (path: string) => {
			const entry = manifest.entries.find((entry: any) => entry.path === path);
			return gunzipSync(readFileSync(join(storage, repo.id, "objects", `${entry.hash}.gz`)));
		};
		assert.equal(contents("tracked").toString(), "working\n");
		assert.deepEqual(contents("untracked\n界"), Buffer.from([0, 1, 255]));
		assert.equal(contents("link").toString(), "/outside/not-read");
		assert.equal(manifest.entries.find((entry: any) => entry.path === "executable").mode, 0o100755);
		assert.ok(!manifest.entries.some((entry: any) => entry.path === "ignored" || entry.path.startsWith("deleted-dir")));
		assert.match(Buffer.from(manifest.stagedPatch, "base64").toString(), /\+staged/);
		assert.doesNotMatch(Buffer.from(manifest.stagedPatch, "base64").toString(), /\+working/);
		git("bundle", "verify", join(storage, repo.id, manifest.history));
		assert.equal(git("status", "--porcelain=v1"), before, "capture never mutates the checkout or index");
		const objects = readdirSync(join(storage, repo.id, "objects"));
		const second = await captureRepository(repo, storage, "run-two");
		assert.equal(first.treeHash, second.treeHash); assert.notEqual(first.snapshotId, second.snapshotId);
		assert.deepEqual(readdirSync(join(storage, repo.id, "objects")), objects);
		assert.equal(readdirSync(join(storage, repo.id, "history")).length, 1);
		const stats = await repositorySnapshotStats(repo, storage);
		assert.equal(stats.count, 2); assert.ok(stats.bytes > 0);
		const bundlePath = join(storage, repo.id, manifest.history), bundleBytes = readFileSync(bundlePath);
		writeFileSync(bundlePath, "corrupt");
		await assert.rejects(captureRepository(repo, storage, "corrupt-history"), /history is corrupt/);
		assert.equal((await repositorySnapshotStats(repo, storage)).count, 2);
		writeFileSync(bundlePath, bundleBytes);
		const blob = git("rev-parse", "HEAD:tracked").trim();
		execFileSync("git", ["update-index", "--index-info"], { cwd: repoPath, input: `0 ${"0".repeat(40)}\ttracked\n100644 ${blob} 1\ttracked\n100644 ${blob} 2\ttracked\n100644 ${blob} 3\ttracked\n` });
		await assert.rejects(captureRepository(repo, storage, "conflicted"), /unmerged Git indexes/);
		assert.equal((await repositorySnapshotStats(repo, storage)).count, 2);
		git("reset", "-q", "HEAD");
		git("worktree", "add", "-q", "--detach", worktree, "HEAD");
		const linked = (await repositoryFor(worktree))!;
		assert.equal(linked.id, repo.id); assert.equal(linked.configKey, repo.configKey);
		const separate = join(dir, "separate"), gitData = join(dir, "separate-git-data"), separateLinked = join(dir, "separate-linked");
		git("init", "-q", "-b", "main", "--separate-git-dir", gitData, separate);
		git("-C", separate, "-c", "user.name=Test", "-c", "user.email=test@invalid", "commit", "-q", "--allow-empty", "-m", "base");
		git("-C", separate, "worktree", "add", "-q", "--detach", separateLinked);
		const separateRepo = (await repositoryFor(separate))!, separateWorktree = (await repositoryFor(separateLinked))!;
		assert.equal(separateRepo.configKey, gitData);
		assert.equal(separateWorktree.configKey, separateRepo.configKey);
		assert.equal(separateWorktree.id, separateRepo.id);
		assert.equal(snapshotEnabled(separateWorktree, { repositories: { [separateRepo.configKey]: true } }), true);
		await assert.rejects(captureRepository(repo, join(repoPath, "snapshots"), "bad"), /outside the repository/);
		const aborted = new AbortController(); aborted.abort();
		await assert.rejects(captureRepository(repo, storage, "cancelled", aborted.signal));
		assert.equal((await repositorySnapshotStats(repo, storage)).count, 2);
		// Refuse unsupported special files rather than blocking on a FIFO or silently omitting it.
		writeFileSync(join(repoPath, "fifo"), "tracked regular file\n"); git("add", "fifo");
		rmSync(join(repoPath, "fifo")); execFileSync("mkfifo", [join(repoPath, "fifo")]);
		await assert.rejects(captureRepository(repo, storage, "fifo"), /unsupported file/);
		assert.equal((await repositorySnapshotStats(repo, storage)).count, 2);
		assert.ok(!readdirSync(join(storage, repo.id)).some(name => name.startsWith(".capture-")));
		rmSync(join(repoPath, "fifo")); git("reset", "-q", "HEAD");
		// Swap an ancestor after validation, open the leaf, then restore it before the next scan.
		// Both scans can be fooled with pathname reads; pinned parent descriptors retain inside bytes.
		const nested = join(repoPath, "nested"), parked = join(repoPath, "parked"), outside = join(dir, "outside");
		mkdirSync(nested); mkdirSync(outside);
		writeFileSync(join(nested, "race-source"), "inside\n"); writeFileSync(join(outside, "race-source"), "external-secret\n");
		const fsPromises = createRequire(import.meta.url)("node:fs/promises"), originalOpen = fsPromises.open;
		let swaps = 0;
		fsPromises.open = async (path: unknown, ...args: unknown[]) => {
			if (!String(path).endsWith("/race-source")) return originalOpen(path, ...args);
			renameSync(nested, parked); symlinkSync(outside, nested); swaps++;
			try { return await originalOpen(path, ...args); }
			finally { rmSync(nested); renameSync(parked, nested); }
		};
		syncBuiltinESMExports();
		try {
			const safe = await captureRepository(repo, storage, "ancestor-swap");
			const safeManifest = JSON.parse(readFileSync(safe.manifestPath, "utf8"));
			const entry = safeManifest.entries.find((entry: any) => entry.path === "nested/race-source");
			assert.equal(gunzipSync(readFileSync(join(storage, repo.id, "objects", `${entry.hash}.gz`))).toString(), "inside\n");
			assert.equal(swaps, 2, "both scan reads exercise the ancestor replacement race");
		} finally { fsPromises.open = originalOpen; syncBuiltinESMExports(); }
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
