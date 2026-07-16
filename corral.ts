import type { ExtensionAPI, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { $ } from "bun";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

type HandState = {
	name: string;
	paneId: string;
	workspaceId?: string;
	worktree: string;
	branch: string;
	task?: string;
};

type CommandResult = { exitCode: number; stdout: string; stderr: string };
type PaneInfo = { pane?: { agent_status?: string; [key: string]: unknown }; [key: string]: unknown };

const STATE_TYPE = "corral-state";
const DEFAULT_TIMEOUT_MS = 60_000;

const hands = new Map<string, HandState>();
let sessionCwd = process.cwd();

function textResult(text: string, details?: unknown, isError = false) {
	return {
		content: [{ type: "text" as const, text }],
		details,
		...(isError ? { isError: true } : {}),
	};
}

function errorResult(message: string) {
	return textResult(`corral: ${message}`, undefined, true);
}
function parseJson(stdout: string): unknown {
	try {
		return JSON.parse(stdout) as unknown;
	} catch {
		return undefined;
	}
}
function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (value && typeof value === "object") return value as Record<string, unknown>;
	return undefined;
}

async function runCommand(command: string, args: string[], cwd?: string): Promise<CommandResult> {
	try {
		const result = await $`${command} ${args}`.quiet().nothrow().cwd(cwd ?? sessionCwd);
		return {
			exitCode: result.exitCode,
			stdout: result.stdout.toString(),
			stderr: result.stderr.toString(),
		};
	} catch (error) {
		return { exitCode: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
	}
}

async function runHerdr(args: string[], cwd?: string): Promise<CommandResult> {
	return runCommand("herdr", args, cwd);
}

function commandError(result: CommandResult, fallback: string): string {
	return result.stderr.trim() || result.stdout.trim() || fallback;
}

async function prerequisites(cwd: string, needCodex = true): Promise<string | undefined> {
	if (process.env.HERDR_ENV !== "1") return "HERDR_ENV=1 is required; corral must run inside herdr";
	if (!Bun.which("herdr")) return "herdr is not available in PATH";
	if (needCodex && !Bun.which("codex")) return "codex is not available in PATH";
	if (!Bun.which("git")) return "git is not available in PATH";
	const repo = await runCommand("git", ["rev-parse", "--show-toplevel"], cwd);
	if (repo.exitCode !== 0) return "the current directory is not inside a git repository";
	return undefined;
}

function safeName(input: string): string {
	const normalized = input.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	return normalized || `hand-${Date.now().toString(36)}`;
}

function snapshot(): HandState[] {
	return [...hands.values()].map((hand) => ({ ...hand }));
}

function persist(pi: ExtensionAPI) {
	pi.appendEntry(STATE_TYPE, { hands: snapshot() });
}

async function paneInfo(paneId: string): Promise<PaneInfo | undefined> {
	const result = await runHerdr(["pane", "get", paneId]);
	if (result.exitCode !== 0) return undefined;
	const parsed = asRecord(parseJson(result.stdout));
	return asRecord(parsed?.result) as PaneInfo | undefined;
}

async function waitForIdle(paneId: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<CommandResult> {
	return runHerdr(["wait", "agent-status", paneId, "--status", "idle", "--timeout", String(timeoutMs)]);
}

async function waitForCompletion(paneId: string, timeoutMs: number): Promise<{ status?: string; timedOut: boolean }> {
	const initial = await paneInfo(paneId);
	const initialStatus = initial?.pane?.agent_status;
	if (initialStatus === "idle" || initialStatus === "done") return { status: initialStatus, timedOut: false };
	const waited = await runHerdr(["wait", "agent-status", paneId, "--status", "done", "--timeout", String(Math.max(0, timeoutMs))]);
	const finalInfo = await paneInfo(paneId);
	const status = finalInfo?.pane?.agent_status;
	if (status === "idle" || status === "done") return { status, timedOut: false };
	return { status, timedOut: waited.exitCode !== 0 || status !== "idle" };
}

async function readPane(paneId: string, lines: number): Promise<string> {
	const result = await runHerdr(["pane", "read", paneId, "--source", "recent-unwrapped", "--lines", String(lines)]);
	if (result.exitCode !== 0) throw new Error(commandError(result, "unable to read pane"));
	const parsed = asRecord(parseJson(result.stdout));
	const data = asRecord(parsed?.result);
	let output = typeof data?.text === "string" ? data.text : typeof data?.content === "string" ? data.content : `${result.stdout}${result.stderr}`.trim();
	if (!output) {
		const visible = await runHerdr(["pane", "read", paneId, "--source", "visible", "--lines", String(lines)], sessionCwd);
		if (visible.exitCode === 0) output = `${visible.stdout}${visible.stderr}`.trim();
	}
	return output;
}

function stateFromData(data: unknown): HandState[] {
	if (!data || typeof data !== "object") return [];
	const value = data as { hands?: unknown };
	if (!Array.isArray(value.hands)) return [];
	return value.hands.filter((hand): hand is HandState => {
		if (!hand || typeof hand !== "object") return false;
		const item = hand as Partial<HandState>;
		return typeof item.name === "string" && typeof item.paneId === "string" && typeof item.worktree === "string" && typeof item.branch === "string";
	});
}
async function repositoryRoot(cwd: string): Promise<string | undefined> {
	const result = await runCommand("git", ["rev-parse", "--show-toplevel"], cwd);
	if (result.exitCode !== 0) return undefined;
	const root = result.stdout.trim();
	return root.length > 0 ? root : undefined;
}

async function cleanupCreatedPane(paneId: string, workspaceId: string | undefined, worktree: string, cwd: string): Promise<void> {
	if (workspaceId) {
		await runHerdr(["worktree", "remove", "--workspace", workspaceId, "--force", "--json"], cwd);
		return;
	}
	await runHerdr(["pane", "close", paneId], cwd);
	await runCommand("git", ["worktree", "remove", "--force", worktree], cwd);
}

export default function corralExtension(pi: ExtensionAPI) {
	pi.setLabel("Corral");

	const spawnSchema = pi.zod.z.object({
		name: pi.zod.z.string().optional(),
		task: pi.zod.z.string().min(1),
		base_branch: pi.zod.z.string().optional(),
	});
	const sendSchema = pi.zod.z.object({ name: pi.zod.z.string(), message: pi.zod.z.string().min(1) });
	const waitSchema = pi.zod.z.object({ name: pi.zod.z.string().optional(), timeout_s: pi.zod.z.number().int().positive().optional() });
	const readSchema = pi.zod.z.object({ name: pi.zod.z.string(), lines: pi.zod.z.number().int().positive().optional() });
	const listSchema = pi.zod.z.object({});
	const killSchema = pi.zod.z.object({ name: pi.zod.z.string(), remove_worktree: pi.zod.z.boolean().optional() });
	pi.on("session_start", async (_event, ctx) => {
		sessionCwd = ctx.cwd;
		hands.clear();
		let latest: HandState[] = [];
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === STATE_TYPE) latest = stateFromData(entry.data);
		}
		for (const hand of latest) {
			const info = await paneInfo(hand.paneId);
			if (info?.pane) hands.set(hand.name, hand);
		}
		if (latest.length !== hands.size) persist(pi);
	});

	const spawnTool = {
		name: "corral_spawn",
		label: "Corral Spawn",
		description: "Create a visible Codex hand in an isolated git worktree and give it a task.",
		parameters: spawnSchema,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const guard = await prerequisites(ctx.cwd);
			if (guard) return errorResult(guard);
			const repoRoot = await repositoryRoot(ctx.cwd);
			if (!repoRoot) return errorResult("could not determine the git repository root");
			sessionCwd = repoRoot;
			const name = safeName(params.name ?? params.task.slice(0, 32));
			if (hands.has(name)) return errorResult(`a hand named ${name} already exists`);
			const branch = `corral/${name}`;
			const worktree = resolve(repoRoot, ".corral", "worktrees", name);
			if (existsSync(worktree)) return errorResult(`worktree path already exists: ${worktree}`);
			const args = ["worktree", "create", "--cwd", repoRoot, "--branch", branch, "--path", worktree];
			if (params.base_branch) args.push("--base", params.base_branch);
			args.push("--label", `corral:${name}`, "--no-focus", "--json");
			const created = await runHerdr(args, repoRoot);
			if (created.exitCode !== 0) return errorResult(`could not create worktree: ${commandError(created, "herdr worktree create failed")}`);
			const createdData = asRecord(parseJson(created.stdout));
			const payload = asRecord(createdData?.result);
			const rootPane = asRecord(payload?.root_pane);
			const workspaceData = asRecord(payload?.workspace);
			const paneId = rootPane?.pane_id;
			const workspaceId = rootPane?.workspace_id ?? workspaceData?.workspace_id;
			if (typeof paneId !== "string") {
				await runCommand("git", ["worktree", "remove", "--force", worktree], repoRoot);
				return errorResult("herdr created a worktree but returned no pane id");
			}
			const normalizedWorkspaceId = typeof workspaceId === "string" ? workspaceId : undefined;
			const hand: HandState = { name, paneId, workspaceId: normalizedWorkspaceId, worktree, branch, task: params.task };
			const launched = await runHerdr(["pane", "run", paneId, "codex"], worktree);
			if (launched.exitCode !== 0) {
				await cleanupCreatedPane(paneId, normalizedWorkspaceId, worktree, repoRoot);
				return errorResult(`could not launch codex: ${commandError(launched, "herdr pane run failed")}`);
			}
			const ready = await waitForIdle(paneId);
			if (ready.exitCode !== 0) {
				await cleanupCreatedPane(paneId, normalizedWorkspaceId, worktree, repoRoot);
				return errorResult(`codex pane did not become idle: ${commandError(ready, "timed out waiting for codex")}`);
			}
			const sent = await runHerdr(["pane", "run", paneId, params.task], worktree);
			if (sent.exitCode !== 0) {
				await cleanupCreatedPane(paneId, normalizedWorkspaceId, worktree, repoRoot);
				return errorResult(`could not send task: ${commandError(sent, "herdr pane run failed")}`);
			}
			hands.set(name, hand);
			persist(pi);
			return textResult(JSON.stringify({ name, pane_id: paneId, branch, worktree }, null, 2), { name, pane_id: paneId, branch, worktree });
		},
	} satisfies ToolDefinition<typeof spawnSchema, unknown>;
	pi.registerTool<typeof spawnSchema, unknown>(spawnTool);

	const sendTool = {
		name: "corral_send",
		label: "Corral Send",
		description: "Wait for a corral hand to be ready, then send it another instruction.",
		parameters: sendSchema,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const guard = await prerequisites(ctx.cwd);
			if (guard) return errorResult(guard);
			const hand = hands.get(params.name);
			if (!hand) return errorResult(`unknown hand: ${params.name}`);
			const ready = await waitForCompletion(hand.paneId, DEFAULT_TIMEOUT_MS);
			if (ready.timedOut) return errorResult(`hand ${hand.name} did not become idle or done (status: ${ready.status ?? "unknown"})`);
			const sent = await runHerdr(["pane", "run", hand.paneId, params.message], hand.worktree);
			if (sent.exitCode !== 0) return errorResult(`could not send message: ${commandError(sent, "herdr pane run failed")}`);
			return textResult(`Sent to ${hand.name}.`, { name: hand.name, pane_id: hand.paneId });
		},
	} satisfies ToolDefinition<typeof sendSchema, unknown>;
	pi.registerTool<typeof sendSchema, unknown>(sendTool);

	const waitTool = {
		name: "corral_wait",
		label: "Corral Wait",
		description: "Wait for one hand, or all hands, to become idle or done.",
		parameters: waitSchema,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const guard = await prerequisites(ctx.cwd, false);
			if (guard) return errorResult(guard);
			const selected = params.name ? [hands.get(params.name)] : [...hands.values()];
			if (params.name && !selected[0]) return errorResult(`unknown hand: ${params.name}`);
			const timeoutMs = (params.timeout_s ?? 60) * 1000;
			const results = await Promise.all(selected.map(async (hand) => ({ name: hand!.name, ...(await waitForCompletion(hand!.paneId, timeoutMs)) })));
			return textResult(JSON.stringify(results, null, 2), results);
		},
	} satisfies ToolDefinition<typeof waitSchema, unknown>;
	pi.registerTool<typeof waitSchema, unknown>(waitTool);

	const readTool = {
		name: "corral_read",
		label: "Corral Read",
		description: "Read recent visible terminal output from a corral hand.",
		parameters: readSchema,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const guard = await prerequisites(ctx.cwd, false);
			if (guard) return errorResult(guard);
			const hand = hands.get(params.name);
			if (!hand) return errorResult(`unknown hand: ${params.name}`);
			try {
				const output = await readPane(hand.paneId, params.lines ?? 40);
				return textResult(output, { name: hand.name, pane_id: hand.paneId, lines: params.lines ?? 40 });
			} catch (error) {
				return errorResult(error instanceof Error ? error.message : String(error));
			}
		},
	} satisfies ToolDefinition<typeof readSchema, unknown>;
	pi.registerTool<typeof readSchema, unknown>(readTool);

	const listTool = {
		name: "corral_list",
		label: "Corral List",
		description: "List corral hands and their current herdr agent status.",
		parameters: listSchema,
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const guard = await prerequisites(ctx.cwd, false);
			if (guard) return errorResult(guard);
			const roster = await Promise.all([...hands.values()].map(async (hand) => {
				const info = await paneInfo(hand.paneId);
				return { ...hand, agent_status: info?.pane?.agent_status ?? "unknown" };
			}));
			return textResult(JSON.stringify(roster, null, 2), roster);
		},
	} satisfies ToolDefinition<typeof listSchema, unknown>;
	pi.registerTool<typeof listSchema, unknown>(listTool);

	const killTool = {
		name: "corral_kill",
		label: "Corral Kill",
		description: "Close a corral hand pane and optionally remove its git worktree, preserving the branch.",
		parameters: killSchema,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const guard = await prerequisites(ctx.cwd, false);
			if (guard) return errorResult(guard);
			const hand = hands.get(params.name);
			if (!hand) return errorResult(`unknown hand: ${params.name}`);
			let result: CommandResult;
			if (params.remove_worktree && hand.workspaceId) {
				result = await runHerdr(["worktree", "remove", "--workspace", hand.workspaceId, "--force", "--json"], ctx.cwd);
			} else {
				result = await runHerdr(["pane", "close", hand.paneId], ctx.cwd);
				if (params.remove_worktree && result.exitCode === 0) {
					const removed = await runCommand("git", ["worktree", "remove", "--force", hand.worktree], ctx.cwd);
					if (removed.exitCode !== 0) return errorResult(`pane closed but worktree removal failed: ${commandError(removed, "git worktree remove failed")}`);
				}
			}
			if (result.exitCode !== 0) return errorResult(`could not kill ${hand.name}: ${commandError(result, "herdr cleanup failed")}`);
			hands.delete(hand.name);
			persist(pi);
			return textResult(`Killed ${hand.name}; branch ${hand.branch} was preserved.`, { ...hand, removed_worktree: Boolean(params.remove_worktree) });
		},
	} satisfies ToolDefinition<typeof killSchema, unknown>;
	pi.registerTool<typeof killSchema, unknown>(killTool);

	pi.registerCommand("corral", {
		description: "Show corral hand roster and herdr pane ids",
		handler: async (_args, ctx) => {
			const lines = await Promise.all([...hands.values()].map(async (hand) => {
				const info = await paneInfo(hand.paneId);
				return `${hand.name}: ${info?.pane?.agent_status ?? "unknown"} (${hand.branch})`;
			}));
			ctx.ui.notify(lines.length ? lines.join("\n") : "No corral hands.", "info");
		},
	});
}
