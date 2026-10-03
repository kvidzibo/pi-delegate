import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readFile, readdir, readlink, realpath, rm, writeFile, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { gzip, gunzip } from "node:zlib";
import type { SnapshotConfig } from "./config.ts";

const compress = promisify(gzip), decompress = promisify(gunzip);
const MAX_FILE = 128 * 1024 * 1024, MAX_TOTAL = 2 * 1024 * 1024 * 1024;
const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
export interface Repository { root: string; configKey: string; id: string }
export interface SnapshotRef { version: 1; repositoryId: string; snapshotId: string; manifestPath: string; treeHash: string }
interface Entry { path: string; mode: number; type: "file" | "symlink"; hash: string; size: number }

async function git(cwd: string, args: string[], signal?: AbortSignal): Promise<Buffer> {
	// No inherited Git overrides, credentials, shell configuration or environment dump.
	const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8",
		GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
	signal?.throwIfAborted();
	return new Promise((accept, reject) => {
		const child = execFile("git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args],
			{ cwd, env, encoding: "buffer", maxBuffer: 64 * 1024 * 1024, detached: process.platform !== "win32" },
			(error, stdout) => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", stop);
				if (error || signal?.aborted || timedOut) reject(new Error(`Snapshot Git operation failed (${args[0]}${signal?.aborted ? "; cancelled" : timedOut ? "; timeout" : ""}).`));
				else accept(stdout);
			});
		let timedOut = false;
		const stop = () => {
			try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); }
			catch { /* already exited */ }
		};
		child.once("exit", stop); // Also reap pack-objects descendants after timeout/maxBuffer failures.
		const timer = setTimeout(() => { timedOut = true; stop(); }, 60000);
		signal?.addEventListener("abort", stop, { once: true });
		if (signal?.aborted) stop();
	});
}

export async function repositoryFor(cwd: string, signal?: AbortSignal): Promise<Repository | undefined> {
	signal?.throwIfAborted();
	let candidate = await realpath(cwd);
	while (true) {
		signal?.throwIfAborted();
		try { await lstat(join(candidate, ".git")); break; }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		if (dirname(candidate) === candidate) return undefined;
		candidate = dirname(candidate);
	}
	const root = await realpath((await git(cwd, ["rev-parse", "--show-toplevel"], signal)).toString().trim());
	const common = await realpath((await git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"], signal)).toString().trim());
	// Git cannot recover the primary source path from every separate-git-dir layout.
	// In that layout the shared Git directory itself is the stable key for all worktrees.
	const configKey = basename(common) === ".git" ? dirname(common) : common;
	return { root, configKey, id: hash(common) };
}

export function snapshotSettings(config?: SnapshotConfig): SnapshotConfig {
	return config ?? { repositories: {} };
}
export function snapshotDirectory(agentDir: string, config?: SnapshotConfig): string {
	return config?.directory ?? join(agentDir, "delegate-snapshots");
}
export function snapshotEnabled(repo: Repository | undefined, config?: SnapshotConfig): boolean {
	return !!repo && config?.repositories[repo.configKey] === true;
}

function checkPrivate(stat: Awaited<ReturnType<typeof lstat>>, directory: boolean): void {
	if ((directory ? !stat.isDirectory() : !stat.isFile()) || stat.isSymbolicLink()
		|| (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) {
		throw new Error("Snapshot storage must contain private, owned regular files/directories (no symlinks).");
	}
}
async function privateDir(path: string): Promise<void> {
	await mkdir(path, { recursive: true, mode: 0o700 });
	checkPrivate(await lstat(path), true);
	if (await realpath(path) !== resolve(path)) throw new Error("Snapshot storage path must not traverse symlinks.");
}
async function privateFile(path: string): Promise<Buffer> {
	const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try { checkPrivate(await fd.stat(), false); return await fd.readFile(); }
	finally { await fd.close(); }
}
function inside(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

const DIR_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const descriptorPath = (fd: FileHandle) => `/proc/self/fd/${fd.fd}`;

/** Linux descriptor-relative traversal: never reopen an already-validated ancestor by pathname. */
async function pinnedDirectory(path: string): Promise<FileHandle> {
	if (process.platform !== "linux") throw new Error("Repository capture requires Linux /proc descriptor-relative reads.");
	let fd = await open("/", DIR_FLAGS);
	try {
		for (const component of resolve(path).split("/").filter(Boolean)) {
			const next = await open(`${descriptorPath(fd)}/${component}`, DIR_FLAGS);
			await fd.close(); fd = next;
		}
		return fd;
	} catch (error) { await fd.close(); throw error; }
}

async function sourceFile(root: FileHandle, path: string): Promise<{ entry: Entry; data: Buffer } | undefined> {
	const parts = path.split("/");
	if (!path || isAbsolute(path) || parts.some(p => !p || p === "." || p === ".." || p === ".git")) throw new Error("Unsafe snapshot source path.");
	const opened: FileHandle[] = [];
	let parent = root;
	try {
		for (const component of parts.slice(0, -1)) {
			try { parent = await open(`${descriptorPath(parent)}/${component}`, DIR_FLAGS); opened.push(parent); }
			catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
		}
		const full = `${descriptorPath(parent)}/${parts.at(-1)}`;
		let stat;
		try { stat = await lstat(full); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
		if (stat.isSymbolicLink()) {
			const data = await readlink(full, { encoding: "buffer" });
			return { entry: { path, mode: 0o120000, type: "symlink", hash: hash(data), size: data.length }, data };
		}
		if (!stat.isFile()) throw new Error("Snapshot encountered a submodule, nested repository or unsupported file; capture refused.");
		const fd = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			const before = await fd.stat();
			if (!before.isFile() || before.size > MAX_FILE || before.dev !== stat.dev || before.ino !== stat.ino) throw new Error("Snapshot requires stable regular files of at most 128 MiB.");
			const data = Buffer.alloc(before.size + 1);
			let length = 0;
			while (length < data.length) {
				const result = await fd.read(data, length, data.length - length, length);
				if (!result.bytesRead) break;
				length += result.bytesRead;
			}
			const after = await fd.stat();
			if (length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("Repository changed during snapshot capture; retry the delegate.");
			const bytes = data.subarray(0, length);
			return { entry: { path, mode: before.mode & 0o111 ? 0o100755 : 0o100644, type: "file", hash: hash(bytes), size: length }, data: bytes };
		} finally { await fd.close(); }
	} finally { for (const fd of opened.reverse()) await fd.close(); }
}

async function headAt(root: string, signal?: AbortSignal): Promise<string | null> {
	try {
		const head = (await git(root, ["rev-parse", "--verify", "HEAD"], signal)).toString().trim();
		if (!/^[a-f0-9]{40,64}$/.test(head)) throw new Error("Invalid Git HEAD.");
		return head;
	} catch (error) {
		signal?.throwIfAborted();
		// An unborn repository is supported; broken existing refs are not.
		const ref = (await git(root, ["symbolic-ref", "HEAD"], signal)).toString().trim();
		const refs = await git(root, ["for-each-ref", "--format=%(objectname)", ref], signal);
		if (refs.length) throw error;
		return null;
	}
}
async function scan(root: FileHandle, signal: AbortSignal | undefined, save?: (entry: Entry, data: Buffer) => Promise<void>) {
	signal?.throwIfAborted();
	const cwd = `/proc/${process.pid}/fd/${root.fd}`;
	const head = await headAt(cwd, signal);
	if ((await git(cwd, ["ls-files", "--unmerged", "-z"], signal)).length) throw new Error("Snapshot capture refuses unmerged Git indexes; resolve conflicts first.");
	const index = await git(cwd, ["ls-files", "--stage", "-z"], signal);
	const staged = await git(cwd, ["diff", "--cached", "--binary", "--no-ext-diff", "--no-textconv", ...(head ? [head] : []), "--"], signal);
	const listed = await git(cwd, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], signal);
	const paths = [...new Set(new TextDecoder("utf-8", { fatal: true }).decode(listed).split("\0").filter(Boolean))].sort();
	if (paths.length > 100000) throw new Error("Snapshot exceeds 100,000 files.");
	const entries: Entry[] = [];
	let bytes = 0;
	for (const path of paths) {
		signal?.throwIfAborted();
		const file = await sourceFile(root, path);
		if (!file) continue;
		bytes += file.entry.size;
		if (bytes > MAX_TOTAL) throw new Error("Snapshot source exceeds 2 GiB.");
		entries.push(file.entry);
		await save?.(file.entry, file.data);
	}
	return { head, entries, staged, index, treeHash: hash(JSON.stringify({ head, entries, staged: hash(staged), index: hash(index) })) };
}

/** Exclusive publication, safe for concurrent sessions capturing the same repository. */
async function publish(temp: string, target: string, expected?: Buffer): Promise<void> {
	try { await link(temp, target); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		checkPrivate(await lstat(target), false);
		if (expected && !(await decompress(await privateFile(target), { maxOutputLength: MAX_FILE })).equals(expected)) throw new Error("Existing snapshot object is corrupt.");
	}
}

async function fileHash(path: string, signal?: AbortSignal): Promise<string> {
	const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		checkPrivate(await fd.stat(), false);
		const digest = createHash("sha256");
		for await (const chunk of fd.createReadStream({ autoClose: false })) { signal?.throwIfAborted(); digest.update(chunk); }
		return digest.digest("hex");
	} finally { await fd.close(); }
}

export async function captureRepository(repo: Repository, directory: string, runId: string, signal?: AbortSignal): Promise<SnapshotRef> {
	if (!isAbsolute(directory) || inside(repo.root, resolve(directory)) || inside(repo.configKey, resolve(directory))) {
		throw new Error("Snapshot directory must be absolute and outside the repository.");
	}
	await privateDir(directory);
	const root = join(directory, repo.id);
	await privateDir(root);
	for (const name of ["objects", "history", "captures"]) await privateDir(join(root, name));
	const temp = join(root, `.capture-${randomUUID()}`);
	await privateDir(temp);
	let sourceRoot: FileHandle | undefined;
	try {
		sourceRoot = await pinnedDirectory(repo.root);
		const cwd = `/proc/${process.pid}/fd/${sourceRoot.fd}`;
		const first = await scan(sourceRoot, signal, async (entry, data) => {
			const path = join(temp, `${entry.hash}.gz`);
			await writeFile(path, await compress(data), { mode: 0o600 });
		});
		if (first.head) {
			const bundle = join(temp, "base.bundle");
			await git(cwd, ["bundle", "create", bundle, "HEAD"], signal);
			const bundledHead = (await git(cwd, ["bundle", "list-heads", bundle], signal)).toString().trim();
			if (bundledHead !== `${first.head} HEAD`) throw new Error("Repository HEAD changed during snapshot capture.");
			// Git-created bundle defaults to umask permissions: make private before publication.
			const fd = await open(bundle, constants.O_RDONLY | constants.O_NOFOLLOW);
			try { await fd.chmod(0o600); } finally { await fd.close(); }
		}
		const second = await scan(sourceRoot, signal);
		const currentRoot = await lstat(repo.root), pinnedRoot = await sourceRoot.stat();
		if (currentRoot.dev !== pinnedRoot.dev || currentRoot.ino !== pinnedRoot.ino || first.treeHash !== second.treeHash) throw new Error("Repository changed during snapshot capture; retry the delegate.");
		signal?.throwIfAborted();
		for (const entry of first.entries) {
			const blob = join(temp, `${entry.hash}.gz`);
			await publish(blob, join(root, "objects", `${entry.hash}.gz`), await decompress(await readFile(blob), { maxOutputLength: MAX_FILE }));
		}
		let history: string | null = null;
		if (first.head) {
			const digest = await fileHash(join(temp, "base.bundle"), signal);
			history = `history/${first.head}.${digest}.bundle`;
			const target = join(root, history);
			await publish(join(temp, "base.bundle"), target);
			if (await fileHash(target, signal) !== digest) throw new Error("Existing snapshot history is corrupt.");
		}
		const snapshotId = randomUUID();
		const manifestPath = join(root, "captures", `${snapshotId}.json`);
		const manifest = { version: 1, snapshotId, runId, repositoryId: repo.id, repositoryRoot: repo.root,
			repositoryKey: repo.configKey, capturedAt: new Date().toISOString(), head: first.head, treeHash: first.treeHash,
			consistency: "double-read-verified", coverage: "tracked-and-nonignored-untracked", entries: first.entries,
			stagedPatch: first.staged.toString("base64"), indexEntries: first.index.toString("base64"), history };
		const path = join(temp, "manifest.json");
		await writeFile(path, `${JSON.stringify(manifest)}\n`, { mode: 0o600, flag: "wx" });
		await publish(path, manifestPath);
		return { version: 1, repositoryId: repo.id, snapshotId, manifestPath, treeHash: first.treeHash };
	} finally { await sourceRoot?.close(); await rm(temp, { recursive: true, force: true }); }
}

export async function repositorySnapshotStats(repo: Repository, directory: string, signal?: AbortSignal): Promise<{ count: number; bytes: number }> {
	signal?.throwIfAborted();
	const root = join(directory, repo.id);
	try {
		checkPrivate(await lstat(directory), true);
		if (await realpath(directory) !== resolve(directory)) throw new Error("Snapshot storage path must not traverse symlinks.");
		checkPrivate(await lstat(root), true);
	}
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { count: 0, bytes: 0 }; throw error; }
	let count = 0, bytes = 0;
	for (const name of ["captures", "objects", "history"]) {
		signal?.throwIfAborted();
		const dir = join(root, name);
		try { checkPrivate(await lstat(dir), true); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
		for (const item of await readdir(dir)) {
			signal?.throwIfAborted();
			const stat = await lstat(join(dir, item));
			checkPrivate(stat, false);
			bytes += stat.size;
			if (name === "captures" && item.endsWith(".json")) count++;
		}
	}
	return { count, bytes };
}
export function formatSnapshotBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KiB", "MiB", "GiB"];
	let value = bytes / 1024, i = 0;
	while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
	return `${value.toFixed(1)} ${units[i]}`;
}
