import { describe, expect, it } from "bun:test";
import { canDispatch, waitForCompletion, type CompletionResult } from "./corral";

function completion(overrides: Partial<CompletionResult>): CompletionResult {
	return { timedOut: false, started: true, completed: false, blocked: false, ...overrides };
}


function scriptedStatus(statuses: string[]): { read: () => Promise<string | undefined>; calls: () => number } {
	let index = 0;
	return {
		read: async () => statuses[Math.min(index++, statuses.length - 1)],
		calls: () => index,
	};
}

const fastOptions = {
	timeoutMs: 40,
	startGraceMs: 8,
	pollIntervalMs: 2,
};

describe("dispatch-aware completion waiting", () => {
	it("does not complete idle until working has been observed", async () => {
		const statuses = scriptedStatus(["idle", "idle", "working", "done"]);
		const transitions: boolean[] = [];
		const result = await waitForCompletion(statuses.read, {
			...fastOptions,
			dispatchPending: true,
			onDispatchPendingChange: (pending) => {
				transitions.push(pending);
			},
		});

		expect(result).toMatchObject({ status: "done", timedOut: false, started: true, completed: true });
		expect(transitions).toEqual([false]);
		expect(statuses.calls()).toBe(4);
	});

	it("times out as never started when idle persists", async () => {
		const statuses = scriptedStatus(["idle"]);
		const result = await waitForCompletion(statuses.read, { ...fastOptions, dispatchPending: true });

		expect(result).toMatchObject({ status: "idle", timedOut: true, started: false, completed: false });
		expect(result.error).toContain("never observably started");
	});

	it("treats stale done as pending until working is observed", async () => {
		const statuses = scriptedStatus(["done"]);
		const result = await waitForCompletion(statuses.read, { ...fastOptions, dispatchPending: true });

		expect(result).toMatchObject({ status: "done", timedOut: true, started: false, completed: false });
	});

	it("accepts done after a pending dispatch starts", async () => {
		const statuses = scriptedStatus(["done", "working", "done"]);
		const result = await waitForCompletion(statuses.read, { ...fastOptions, dispatchPending: true });

		expect(result).toMatchObject({ status: "done", timedOut: false, started: true, completed: true });
	});

	it("preserves immediate idle completion without a pending dispatch", async () => {
		const statuses = scriptedStatus(["idle"]);
		const result = await waitForCompletion(statuses.read, { ...fastOptions, dispatchPending: false });

		expect(result).toMatchObject({ status: "idle", timedOut: false, started: true, completed: true });
		expect(statuses.calls()).toBe(1);
	});

	it("allows a blocked hand to receive its input reply", async () => {
		const statuses = scriptedStatus(["blocked"]);
		const result = await waitForCompletion(statuses.read, { ...fastOptions, dispatchPending: true });

		expect(result).toMatchObject({ status: "blocked", timedOut: false, started: true, blocked: true, completed: false });
		expect(result.error).toContain("blocked");
		expect(canDispatch(result)).toEqual({ ok: true });
	});

	it("allows a completed hand to receive another instruction", () => {
		expect(canDispatch(completion({ status: "done", completed: true }))).toEqual({ ok: true });
	});

	it("rejects a never-started dispatch with its reason", () => {
		const result = completion({
			status: "idle",
			timedOut: true,
			started: false,
			error: "hand never observably started",
		});

		expect(canDispatch(result)).toEqual({ ok: false, reason: "hand never observably started" });
	});

	it("rejects a result marked never-started even without timeout", () => {
		const result = completion({ started: false, error: "hand never started" });

		expect(canDispatch(result)).toEqual({ ok: false, reason: "hand never started" });
	});

	it("rejects a plain timeout with its reason", () => {
		const result = completion({ status: "working", timedOut: true, error: "timed out waiting for hand completion" });

		expect(canDispatch(result)).toEqual({ ok: false, reason: "timed out waiting for hand completion" });
	});
});
