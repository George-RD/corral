import { describe, expect, it } from "bun:test";
import {
	codexCommand,
	sendDisposition,
	stateFromData,
	waitForCodexReady,
	waitForCompletion,
	type DispatchState,
	type RuntimeObservation,
} from "./corral";

function observation(status: string, overrides: Partial<RuntimeObservation> = {}): RuntimeObservation {
	return { status, agent: "codex", agentSessionId: "session-1", foregroundCodex: true, processInfoAvailable: true, ...overrides };
}

function scriptedObservation(values: RuntimeObservation[]): { read: () => Promise<RuntimeObservation>; calls: () => number } {
	let index = 0;
	return {
		read: async () => values[Math.min(index++, values.length - 1)],
		calls: () => index,
	};
}

function dispatch(phase: DispatchState["phase"] = "sent"): DispatchState {
	return { id: 7, kind: "task", phase };
}

const fastOptions = {
	timeoutMs: 40,
	startGraceMs: 8,
	pollIntervalMs: 2,
};

describe("codex launch readiness", () => {
	it("requires a new session, foreground codex, and stable idle", async () => {
		const observations = scriptedObservation([
			observation("idle", { agentSessionId: "old" }),
			observation("idle", { agentSessionId: "new", foregroundCodex: false }),
			observation("idle", { agentSessionId: "new" }),
			observation("idle", { agentSessionId: "new" }),
		]);
		const result = await waitForCodexReady(observations.read, {
			timeoutMs: 40,
			pollIntervalMs: 1,
			previousSessionId: "old",
		});

		expect(result?.agentSessionId).toBe("new");
		expect(observations.calls()).toBe(4);
	});

	it("does not accept a stale idle session", async () => {
		const observations = scriptedObservation([observation("idle", { agentSessionId: "old" })]);
		const result = await waitForCodexReady(observations.read, {
			timeoutMs: 5,
			pollIntervalMs: 1,
			previousSessionId: "old",
		});

		expect(result).toBeUndefined();
	});
});

describe("dispatch lifecycle", () => {
	it("does not call an untouched idle hand started or completed", async () => {
		const result = await waitForCompletion(async () => observation("idle"), { ...fastOptions });

		expect(result).toMatchObject({ status: "idle", timedOut: false, started: false, completed: false, launchState: "ready" });
		expect(result.dispatchId).toBeUndefined();
	});

	it("completes only after the same dispatch is observed working", async () => {
		const observations = scriptedObservation([observation("idle"), observation("working"), observation("done")]);
		const transitions: string[] = [];
		const result = await waitForCompletion(observations.read, {
			...fastOptions,
			dispatch: dispatch(),
			onDispatchChange: (next) => {
				transitions.push(next.phase);
			},
		});

		expect(result).toMatchObject({ dispatchId: 7, phase: "completed", started: true, completed: true });
		expect(transitions).toEqual(["working", "completed"]);
	});

	it("records an unobserved start instead of completing persistent idle", async () => {
		const transitions: string[] = [];
		const result = await waitForCompletion(async () => observation("idle"), {
			...fastOptions,
			dispatch: dispatch(),
			onDispatchChange: (next) => {
				transitions.push(next.phase);
			},
		});

		expect(result).toMatchObject({ phase: "start-unknown", timedOut: true, started: false, completed: false });
		expect(transitions).toEqual(["start-unknown"]);
	});

	it("preserves an unobserved-start result for explicit recovery", async () => {
		const result = await waitForCompletion(async () => observation("idle"), { ...fastOptions, dispatch: dispatch("start-unknown") });

		expect(result).toMatchObject({ phase: "start-unknown", timedOut: true, started: false, completed: false });
	});

	it("surfaces blocked dispatches as replyable", async () => {
		const result = await waitForCompletion(async () => observation("blocked"), { ...fastOptions, dispatch: dispatch() });

		expect(result).toMatchObject({ phase: "blocked", timedOut: false, started: true, blocked: true, completed: false });
	});

	it("detects codex exit instead of treating the shell as ready", async () => {
		const result = await waitForCompletion(
			async () => observation("unknown", { foregroundCodex: false }),
			{ ...fastOptions, dispatch: dispatch("working") },
		);

		expect(result).toMatchObject({ launchState: "exited", completed: false });
		expect(result.error).toContain("not running");
	});

	it("returns a completed dispatch by identity on repeated waits", async () => {
		const result = await waitForCompletion(async () => observation("idle"), { ...fastOptions, dispatch: dispatch("completed") });

		expect(result).toMatchObject({ dispatchId: 7, phase: "completed", started: true, completed: true });
	});
});

describe("state compatibility and model launch", () => {
	it("migrates a legacy pending dispatch conservatively", () => {
		const [hand] = stateFromData({
			hands: [{ name: "api", paneId: "w1:p2", worktree: "/tmp/api", branch: "corral/api", dispatchPending: true }],
		});

		expect(hand.dispatch).toEqual({ id: 1, kind: "task", phase: "start-unknown" });
		expect(hand.dispatchSequence).toBe(1);
	});

	it("does not invent a dispatch for legacy idle state", () => {
		const [hand] = stateFromData({ hands: [{ name: "api", paneId: "w1:p2", worktree: "/tmp/api", branch: "corral/api" }] });

		expect(hand.dispatch).toBeUndefined();
	});

	it("constructs bare and requested-model launches safely", () => {
		expect(codexCommand()).toBe("codex");
		expect(codexCommand("gpt-5.6-luna")).toBe("codex --model gpt-5.6-luna");
		expect(() => codexCommand("luna; touch /tmp/nope")).toThrow("unsupported characters");
	});
});

describe("send recovery safety", () => {
	it("never treats an exited Codex pane as sendable", () => {
		const exited = observation("unknown", { foregroundCodex: false });

		expect(sendDisposition(dispatch("working"), exited)).toMatchObject({ action: "reject" });
		expect(sendDisposition(dispatch("working"), exited, "restart")).toEqual({ action: "restart" });
	});

	it("requires an explicit retry for uncertain delivery", () => {
		const idle = observation("idle");

		expect(sendDisposition(dispatch("start-unknown"), idle)).toMatchObject({ action: "reject" });
		expect(sendDisposition(dispatch("start-unknown"), idle, "retry")).toEqual({ action: "retry" });
	});

	it("does not act when process inspection failed", () => {
		const unavailable = observation("idle", { foregroundCodex: false, processInfoAvailable: false });

		expect(sendDisposition(undefined, unavailable, "restart")).toMatchObject({ action: "reject" });
	});
});
