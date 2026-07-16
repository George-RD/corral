import { $ } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function command(name: string, args: string[], cwd?: string) {
	const result = await $`${name} ${args}`.quiet().nothrow().cwd(cwd ?? process.cwd());
	if (result.exitCode !== 0) {
		throw new Error(`${name} ${args.join(" ")} failed: ${result.stderr.toString().trim() || result.stdout.toString().trim()}`);
	}
	return { stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

async function textCommand(name: string, args: string[], cwd?: string): Promise<string> {
	const result = await command(name, args, cwd);
	return `${result.stdout}${result.stderr}`;
}

function json(result: { stdout: string }): Record<string, unknown> {
	return JSON.parse(result.stdout) as Record<string, unknown>;
}
const root = await mkdtemp(join(tmpdir(), "corral-smoke-"));
const worktree = join(root, ".corral", "worktrees", "hand");
let paneId: string | undefined;
try {
	await command("git", ["init", "-q", "-b", "main"], root);
	await command("git", ["config", "user.email", "corral-smoke@example.com"], root);
	await command("git", ["config", "user.name", "corral-smoke"], root);
	await Bun.write(join(root, "README"), "smoke\n");
	await command("git", ["add", "README"], root);
	await command("git", ["commit", "-qm", "initial"], root);
	await command("git", ["worktree", "add", "-b", "corral/smoke", worktree, "main"], root);

	const split = json(await command("herdr", ["pane", "split", "--current", "--direction", "right", "--cwd", worktree, "--no-focus"]));
	const splitResult = split.result as Record<string, unknown>;
	const pane = splitResult.pane as Record<string, unknown>;
	paneId = String(pane.pane_id);
	if (!paneId || paneId === "undefined") throw new Error("herdr pane split returned no pane_id");
	console.log(`created pane=${paneId} cwd=${worktree}`);
	await command("herdr", ["pane", "run", paneId, "printf 'hello-from-corral\\\\n'"], worktree);
	await command("herdr", ["wait", "output", paneId, "--match", "hello-from-corral", "--source", "recent-unwrapped", "--timeout", "15000"]);
	const recent = await textCommand("herdr", ["pane", "read", paneId, "--source", "recent-unwrapped", "--lines", "20"]);
	const readOutput = recent || (await textCommand("herdr", ["pane", "read", paneId, "--source", "visible", "--lines", "20"]));
	console.log(`recent-unwrapped=${JSON.stringify(recent)}`);
	console.log(`read=${readOutput.trim()}`);
	if (!readOutput.includes("hello-from-corral")) throw new Error("pane read did not contain smoke marker");
	console.log("SMOKE OK: worktree + pane split + run + wait + read");
} finally {
	if (paneId) await command("herdr", ["pane", "close", paneId]).catch(() => undefined);
	await command("git", ["worktree", "remove", "--force", worktree], root).catch(() => undefined);
	await rm(root, { recursive: true, force: true });
}
