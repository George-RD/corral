import type { ExtensionAPI, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { $ } from "bun";
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";

export type LaunchState = "starting" | "ready" | "exited";
export type DispatchPhase = "sent" | "working" | "blocked" | "completed" | "start-unknown";
export type DispatchState = {
	id: number;
	kind: "task" | "message";
	phase: DispatchPhase;
};

type BootstrapCheck = { check: string; ok: boolean; detail: string };

export type HandState = {
	name: string;
	paneId: string;
	workspaceId?: string;
	worktree: string;
	branch: string;
	task?: string;
	model?: string;
	launchState?: LaunchState;
	agentSessionId?: string;
	dispatch?: DispatchState;
	dispatchSequence?: number;
	bootstrap?: BootstrapCheck[];
};

type CommandResult = { exitCode: number; stdout: string; stderr: string };
type PaneInfo = {
	pane?: {
		agent?: string;
		agent_status?: string;
		agent_session?: { value?: string; [key: string]: unknown };
		[key: string]: unknown;
	};
	[key: string]: unknown;
};

export type RuntimeObservation = {
	status?: string;
	agent?: string;
	agentSessionId?: string;
	foregroundCodex: boolean;
	processInfoAvailable: boolean;
};

export type CompletionResult = {
	status?: string;
	timedOut: boolean;
	started: boolean;
	completed: boolean;
	blocked: boolean;
	dispatchId?: number;
	phase?: DispatchPhase;
	launchState?: LaunchState;
	error?: string;
};

export type CompletionWaitOptions = {
	timeoutMs: number;
	dispatch?: DispatchState;
	pollIntervalMs?: number;
	startGraceMs?: number;
	onDispatchChange?: (dispatch: DispatchState) => void | Promise<void>;
};

type ObservationReader = () => Promise<RuntimeObservation>;

export type ReadyWaitOptions = {
	timeoutMs: number;
	previousSessionId?: string;
	pollIntervalMs?: number;
	stableSamples?: number;
};

export type SendDisposition = { action: "send" | "wait" | "retry" | "restart" | "reject"; reason?: string };

const STATE_TYPE = "corral-state";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_START_GRACE_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

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

async function runtimeObservation(paneId: string): Promise<RuntimeObservation> {
	const [info, processResult] = await Promise.all([
		paneInfo(paneId),
		runHerdr(["pane", "process-info", "--pane", paneId]),
	]);
	const processJson = asRecord(parseJson(processResult.stdout));
	const processPayload = asRecord(processJson?.result);
	const processInfo = asRecord(processPayload?.process_info);
	const foreground = Array.isArray(processInfo?.foreground_processes) ? processInfo.foreground_processes : [];
	const foregroundCodex = foreground.some((value) => {
		const process = asRecord(value);
		const name = typeof process?.name === "string" ? process.name : "";
		const argv0 = typeof process?.argv0 === "string" ? basename(process.argv0) : "";
		return name === "codex" || argv0 === "codex";
	});
	return {
		status: info?.pane?.agent_status,
		agent: info?.pane?.agent,
		agentSessionId: info?.pane?.agent_session?.value,
		foregroundCodex,
		processInfoAvailable: processResult.exitCode === 0 && Boolean(processInfo),
	};
}

function completionOutcome(
	observation: RuntimeObservation,
	timedOut: boolean,
	started: boolean,
	completed: boolean,
	blocked = false,
	dispatch?: DispatchState,
	error?: string,
): CompletionResult {
	return {
		status: observation.status,
		timedOut,
		started,
		completed,
		blocked,
		launchState: observation.foregroundCodex ? "ready" : "exited",
		...(dispatch ? { dispatchId: dispatch.id, phase: dispatch.phase } : {}),
		...(error ? { error } : {}),
	};
}

function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

export async function waitForCodexReady(readObservation: ObservationReader, options: ReadyWaitOptions): Promise<RuntimeObservation | undefined> {
	const timeoutMs = Math.max(0, options.timeoutMs);
	const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
	const stableSamples = Math.max(1, options.stableSamples ?? 2);
	const startedAt = Date.now();
	let consecutiveReady = 0;
	while (true) {
		const observation = await readObservation();
		const isNewSession = Boolean(observation.agentSessionId) && observation.agentSessionId !== options.previousSessionId;
		if (isNewSession && observation.agent === "codex" && observation.foregroundCodex && observation.status === "idle") {
			consecutiveReady += 1;
			if (consecutiveReady >= stableSamples) return observation;
		} else {
			consecutiveReady = 0;
		}
		const elapsed = Date.now() - startedAt;
		if (elapsed >= timeoutMs) return undefined;
		await sleep(Math.min(pollIntervalMs, timeoutMs - elapsed));
	}
}

export async function waitForCompletion(readObservation: ObservationReader, options: CompletionWaitOptions): Promise<CompletionResult> {
	let dispatch = options.dispatch ? { ...options.dispatch } : undefined;
	const timeoutMs = Math.max(0, options.timeoutMs);
	const startGraceMs = Math.min(Math.max(0, options.startGraceMs ?? DEFAULT_START_GRACE_MS), timeoutMs);
	const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
	const startedAt = Date.now();
	const transition = async (phase: DispatchPhase) => {
		if (!dispatch || dispatch.phase === phase) return;
		dispatch = { ...dispatch, phase };
		await options.onDispatchChange?.(dispatch);
	};

	while (true) {
		const observation = await readObservation();
		const status = observation.status;
		const elapsed = Date.now() - startedAt;

		if (!observation.processInfoAvailable) {
			return completionOutcome(observation, false, false, false, false, dispatch, "unable to inspect the hand foreground process");
		}
		if (!observation.foregroundCodex) {
			return completionOutcome(observation, false, Boolean(dispatch && dispatch.phase !== "sent" && dispatch.phase !== "start-unknown"), false, false, dispatch, "codex is not running in the hand pane");
		}
		if (!dispatch) {
			return completionOutcome(observation, false, false, false);
		}
		if (dispatch.phase === "completed") return completionOutcome(observation, false, true, true, false, dispatch);
		if (dispatch.phase === "blocked") return completionOutcome(observation, false, true, false, true, dispatch, "hand is blocked and needs input");
		if (dispatch.phase === "start-unknown") {
			return completionOutcome(observation, true, false, false, false, dispatch, "hand startup was not observably detected; inspect the pane and retry explicitly if safe");
		}
		if (status === "blocked") {
			await transition("blocked");
			return completionOutcome(observation, false, true, false, true, dispatch, "hand is blocked and needs input");
		}
		if (dispatch.phase === "sent" && status === "working") await transition("working");
		if (dispatch.phase === "working" && (status === "idle" || status === "done")) {
			await transition("completed");
			return completionOutcome(observation, false, true, true, false, dispatch);
		}
		if (dispatch.phase === "sent" && elapsed >= startGraceMs) {
			await transition("start-unknown");
			return completionOutcome(observation, true, false, false, false, dispatch, "hand never observably started; inspect the pane and retry explicitly if safe");
		}
		if (elapsed >= timeoutMs) {
			return completionOutcome(observation, true, dispatch.phase !== "sent", false, false, dispatch, "timed out waiting for hand completion");
		}
		await sleep(Math.min(pollIntervalMs, timeoutMs - elapsed));
	}
}
function waitForHand(hand: HandState, timeoutMs: number, pi: ExtensionAPI): Promise<CompletionResult> {
	return waitForCompletion(
		() => runtimeObservation(hand.paneId),
		{
			timeoutMs,
			dispatch: hand.dispatch,
			onDispatchChange: (dispatch) => {
				hand.dispatch = dispatch;
				persist(pi);
			},
		},
	);
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

export function stateFromData(data: unknown): HandState[] {
	if (!data || typeof data !== "object") return [];
	const value = data as { hands?: unknown };
	if (!Array.isArray(value.hands)) return [];
	return value.hands
		.filter((hand): hand is HandState => {
			if (!hand || typeof hand !== "object") return false;
			const item = hand as Partial<HandState>;
			return typeof item.name === "string" && typeof item.paneId === "string" && typeof item.worktree === "string" && typeof item.branch === "string";
		})
		.map((hand) => {
			const legacy = hand as HandState & { dispatchPending?: boolean };
			const dispatch = legacy.dispatch ?? (legacy.dispatchPending === true ? { id: 1, kind: "task" as const, phase: "start-unknown" as const } : undefined);
			const { dispatchPending: _dispatchPending, ...current } = legacy;
			return {
				...current,
				launchState: current.launchState ?? "ready",
				dispatchSequence: Math.max(current.dispatchSequence ?? 0, dispatch?.id ?? 0),
				...(dispatch ? { dispatch } : {}),
			};
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

function nextDispatch(hand: HandState, kind: DispatchState["kind"]): DispatchState {
	hand.dispatchSequence = Math.max(hand.dispatchSequence ?? 0, hand.dispatch?.id ?? 0) + 1;
	return { id: hand.dispatchSequence, kind, phase: "sent" };
}

export function sendDisposition(
	dispatch: DispatchState | undefined,
	observation: RuntimeObservation,
	recovery?: "retry" | "restart",
): SendDisposition {
	if (!observation.processInfoAvailable) return { action: "reject", reason: "unable to inspect the foreground process; no recovery action was taken" };
	if (!observation.foregroundCodex) {
		return recovery === "restart"
			? { action: "restart" }
			: { action: "reject", reason: "codex has exited; resend with recovery: \"restart\" to relaunch explicitly" };
	}
	if (recovery === "restart") return { action: "reject", reason: "codex is still running; recovery: \"restart\" is only valid after exit" };
	const unconfirmed = dispatch?.phase === "start-unknown" || (dispatch?.phase === "sent" && (observation.status === "idle" || observation.status === "done"));
	if (unconfirmed) {
		return recovery === "retry"
			? { action: "retry" }
			: { action: "reject", reason: "the previous dispatch is unconfirmed; inspect it and resend with recovery: \"retry\" only if duplication is safe" };
	}
	if (dispatch?.phase === "sent" || dispatch?.phase === "working") return { action: "wait" };
	if (!dispatch && observation.status === "working") return { action: "reject", reason: "codex is working outside a tracked corral dispatch" };
	return { action: "send" };
}

export function codexCommand(model?: string): string {
	if (model && !SAFE_MODEL.test(model)) throw new Error("model contains unsupported characters");
	return model ? `codex --model ${model}` : "codex";
}

async function launchCodex(hand: HandState, pi: ExtensionAPI, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string | undefined> {
	const before = await runtimeObservation(hand.paneId);
	hand.launchState = "starting";
	persist(pi);
	let command: string;
	try {
		command = codexCommand(hand.model);
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	const launched = await runHerdr(["pane", "run", hand.paneId, command], hand.worktree);
	if (launched.exitCode !== 0) return commandError(launched, "herdr pane run failed");
	const ready = await waitForCodexReady(() => runtimeObservation(hand.paneId), {
		timeoutMs,
		previousSessionId: before.agentSessionId,
	});
	if (!ready) {
		hand.launchState = "exited";
		persist(pi);
		return "codex did not establish a new ready session";
	}
	hand.launchState = "ready";
	hand.agentSessionId = ready.agentSessionId;
	persist(pi);
	return undefined;
}

type BootstrapConfig = {
	codex_auth?: boolean;
	git_auth?: "remote" | "github";
	tools?: string[];
};

async function runBootstrap(config: BootstrapConfig | undefined, cwd: string): Promise<BootstrapCheck[]> {
	if (!config) return [];
	const checks: BootstrapCheck[] = [];
	if (config.codex_auth) {
		const result = await runCommand("codex", ["login", "status"], cwd);
		checks.push({ check: "codex_auth", ok: result.exitCode === 0, detail: result.exitCode === 0 ? "Codex authentication is configured" : commandError(result, "Codex authentication check failed") });
	}
	if (config.git_auth === "github") {
		const result = await runCommand("gh", ["auth", "status"], cwd);
		checks.push({ check: "git_auth:github", ok: result.exitCode === 0, detail: result.exitCode === 0 ? "GitHub authentication is configured" : commandError(result, "GitHub authentication check failed") });
	} else if (config.git_auth === "remote") {
		const result = await runCommand("env", ["GIT_TERMINAL_PROMPT=0", "git", "ls-remote", "--exit-code", "origin", "HEAD"], cwd);
		checks.push({ check: "git_auth:remote", ok: result.exitCode === 0, detail: result.exitCode === 0 ? "origin is reachable non-interactively" : commandError(result, "origin authentication check failed") });
	}
	for (const tool of config.tools ?? []) {
		const path = Bun.which(tool);
		checks.push({ check: `tool:${tool}`, ok: Boolean(path), detail: path ? `available at ${path}` : "not available in PATH" });
	}
	return checks;
}

export default function corralExtension(pi: ExtensionAPI) {
	pi.setLabel("Corral");

	const spawnSchema = pi.zod.z.object({
		name: pi.zod.z.string().optional(),
		task: pi.zod.z.string().min(1).optional(),
		base_branch: pi.zod.z.string().optional(),
		model: pi.zod.z.string().regex(SAFE_MODEL, "model contains unsupported characters").optional(),
		bootstrap: pi.zod.z.object({
			codex_auth: pi.zod.z.boolean().optional(),
			git_auth: pi.zod.z.enum(["remote", "github"]).optional(),
			tools: pi.zod.z.array(pi.zod.z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/, "tool name contains unsupported characters")).optional(),
		}).optional(),
	});
	const sendSchema = pi.zod.z.object({
		name: pi.zod.z.string(),
		message: pi.zod.z.string().min(1),
		recovery: pi.zod.z.enum(["retry", "restart"]).optional(),
	});
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
		description: "Create a visible Codex hand in an isolated git worktree, optionally verify bootstrap readiness, and optionally give it a task.",
		parameters: spawnSchema,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const guard = await prerequisites(ctx.cwd);
			if (guard) return errorResult(guard);
			const repoRoot = await repositoryRoot(ctx.cwd);
			if (!repoRoot) return errorResult("could not determine the git repository root");
			sessionCwd = repoRoot;
			const name = safeName(params.name ?? params.task?.slice(0, 32) ?? "warm-hand");
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
			const hand: HandState = {
				name,
				paneId,
				workspaceId: normalizedWorkspaceId,
				worktree,
				branch,
				task: params.task,
				model: params.model,
				launchState: "starting",
			};
			const bootstrap = await runBootstrap(params.bootstrap, worktree);
			hand.bootstrap = bootstrap;
			const failedChecks = bootstrap.filter((check) => !check.ok);
			if (failedChecks.length > 0) {
				await cleanupCreatedPane(paneId, normalizedWorkspaceId, worktree, repoRoot);
				return errorResult(`bootstrap failed: ${failedChecks.map((check) => `${check.check}: ${check.detail}`).join("; ")}`);
			}
			hands.set(name, hand);
			persist(pi);
			const launchError = await launchCodex(hand, pi);
			if (launchError) {
				hands.delete(name);
				await cleanupCreatedPane(paneId, normalizedWorkspaceId, worktree, repoRoot);
				persist(pi);
				return errorResult(`could not launch codex: ${launchError}`);
			}
			if (params.task) {
				const sent = await runHerdr(["pane", "run", paneId, params.task], worktree);
				if (sent.exitCode !== 0) {
					hands.delete(name);
					await cleanupCreatedPane(paneId, normalizedWorkspaceId, worktree, repoRoot);
					persist(pi);
					return errorResult(`could not send task: ${commandError(sent, "herdr pane run failed")}`);
				}
				hand.dispatch = nextDispatch(hand, "task");
			}
			persist(pi);
			const details = { name, pane_id: paneId, branch, worktree, launch_state: hand.launchState, dispatch: hand.dispatch, bootstrap };
			return textResult(JSON.stringify(details, null, 2), details);
		},
	} satisfies ToolDefinition<typeof spawnSchema, unknown>;
	pi.registerTool<typeof spawnSchema, unknown>(spawnTool);

	const sendTool = {
		name: "corral_send",
		label: "Corral Send",
		description: "Wait for a corral hand to be ready, then send an instruction; uncertain or exited hands require explicit recovery.",
		parameters: sendSchema,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const guard = await prerequisites(ctx.cwd);
			if (guard) return errorResult(guard);
			const hand = hands.get(params.name);
			if (!hand) return errorResult(`unknown hand: ${params.name}`);
			let observation = await runtimeObservation(hand.paneId);
			let disposition = sendDisposition(hand.dispatch, observation, params.recovery);
			if (disposition.action === "reject") return errorResult(`hand ${hand.name}: ${disposition.reason ?? "hand is not ready"}`);
			if (disposition.action === "restart") {
				hand.launchState = "exited";
				persist(pi);
				const launchError = await launchCodex(hand, pi);
				if (launchError) return errorResult(`hand ${hand.name}: could not restart codex: ${launchError}`);
				hand.dispatch = undefined;
				persist(pi);
				observation = await runtimeObservation(hand.paneId);
				disposition = sendDisposition(hand.dispatch, observation);
				if (disposition.action !== "send") return errorResult(`hand ${hand.name}: ${disposition.reason ?? "restarted codex is not ready for dispatch"}`);
			}

			if (disposition.action === "wait") {
				const ready = await waitForHand(hand, DEFAULT_TIMEOUT_MS, pi);
				if (!ready.completed && !ready.blocked) return errorResult(`hand ${hand.name}: ${ready.error ?? "hand is not ready for dispatch"} (status: ${ready.status ?? "unknown"})`);
			}

			const sent = await runHerdr(["pane", "run", hand.paneId, params.message], hand.worktree);
			if (sent.exitCode !== 0) return errorResult(`could not send message: ${commandError(sent, "herdr pane run failed")}`);
			hand.dispatch = nextDispatch(hand, "message");
			hand.agentSessionId = observation.agentSessionId;
			persist(pi);
			return textResult(`Sent to ${hand.name}.`, { name: hand.name, pane_id: hand.paneId });
		},
	} satisfies ToolDefinition<typeof sendSchema, unknown>;
	pi.registerTool<typeof sendSchema, unknown>(sendTool);

	const waitTool = {
		name: "corral_wait",
		label: "Corral Wait",
		description: "Wait for one hand, or all hands, to finish their tracked dispatch without treating an untouched idle prompt as completed.",
		parameters: waitSchema,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const guard = await prerequisites(ctx.cwd, false);
			if (guard) return errorResult(guard);
			const selected = params.name ? [hands.get(params.name)] : [...hands.values()];
			if (params.name && !selected[0]) return errorResult(`unknown hand: ${params.name}`);
			const timeoutMs = (params.timeout_s ?? 60) * 1000;
			const results = await Promise.all(selected.map(async (hand) => ({ name: hand!.name, ...(await waitForHand(hand!, timeoutMs, pi)) })));
			const failed = results.filter((result) => result.timedOut || result.blocked || Boolean(result.error));
			if (failed.length > 0) {
				const summary = failed.map((result) => `${result.name}: ${result.error ?? `status ${result.status ?? "unknown"}`}`).join("; ");
				return textResult(`corral: ${summary}`, results, true);
			}
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
				const observation = await runtimeObservation(hand.paneId);
				return { ...hand, agent_status: observation.status ?? "unknown", codex_running: observation.foregroundCodex };
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
