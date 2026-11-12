/** Session 适配器单元测试：用假 Session 验证桥接、重放与注册表。 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { attachSession, SessionRegistry, type SessionAdapter } from "./adapter.ts";
import type { AgentAction } from "../store/actions.ts";

interface FakeSession {
	sessionId: string;
	sessionFile: string | undefined;
	messages: any[];
	listeners: Array<(event: AgentSessionEvent) => void>;
	subscribe(listener: (event: AgentSessionEvent) => void): () => void;
	emit(event: Record<string, unknown>): void;
	unsubscribed: boolean;
}

function fakeSession(messages: any[] = []): FakeSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const session: FakeSession = {
		sessionId: "session-1",
		sessionFile: "/tmp/session-1.jsonl",
		messages,
		listeners,
		unsubscribed: false,
		subscribe(listener) {
			listeners.push(listener);
			return () => {
				session.unsubscribed = true;
				listeners.length = 0;
			};
		},
		emit(event) {
			for (const listener of listeners) listener(event as unknown as AgentSessionEvent);
		},
	};
	return session;
}

function fakeAdapter(taskId: string, sessionId: string): SessionAdapter & { disposed: boolean } {
	const adapter = {
		taskId,
		sessionId,
		sessionFile: undefined,
		disposed: false,
		async prompt() {
			return { text: "", stopReason: "stop" as const };
		},
		async abort() {},
		dispose() {
			adapter.disposed = true;
		},
	};
	return adapter;
}

describe("attachSession", () => {
	test("hydrate 先打开 Session 再整体重放历史", () => {
		const actions: AgentAction[] = [];
		const session = fakeSession([
			{ role: "system", content: "rules", timestamp: 0 },
			{ role: "user", content: "hi", timestamp: 1 },
			{ role: "assistant", content: [{ type: "text", text: "你好" }], stopReason: "stop", timestamp: 2 },
		]);

		const { hydrate } = attachSession(session, "task-1", (action) => actions.push(action));
		hydrate();

		assert.strictEqual(actions.length, 2);
		assert.deepStrictEqual(actions[0], {
			type: "session/opened",
			payload: { taskId: "task-1", sessionId: "session-1", sessionFile: "/tmp/session-1.jsonl" },
		});
		assert.deepStrictEqual(actions[1], {
			type: "session/restored",
			payload: {
				messages: [
					{ role: "user", content: "hi", timestamp: 1 },
					{ role: "assistant", content: [{ type: "text", text: "你好" }], stopReason: "stop", timestamp: 2 },
				],
			},
		});
	});

	test("Session 事件实时投影，取消订阅后静默", () => {
		const actions: AgentAction[] = [];
		const session = fakeSession();
		const { unsubscribe } = attachSession(session, "task-1", (action) => actions.push(action));

		session.emit({ type: "turn_start" });
		session.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "好" } });

		assert.deepStrictEqual(actions, [
			{ type: "agent/turnStarted" },
			{ type: "agent/textDelta", payload: { text: "好" } },
		]);

		unsubscribe();
		session.emit({ type: "turn_start" });
		assert.strictEqual(actions.length, 2);
		assert.strictEqual(session.unsubscribed, true);
	});
});

describe("SessionRegistry", () => {
	test("taskId ↔ sessionId 双向查找，dispose 会清理并释放适配器", () => {
		const registry = new SessionRegistry();
		const first = fakeAdapter("task-1", "session-1");
		const second = fakeAdapter("task-2", "session-2");
		registry.register(first);
		registry.register(second);

		assert.strictEqual(registry.get("task-1"), first);
		assert.strictEqual(registry.taskIdOf("session-2"), "task-2");

		registry.dispose("task-1");
		assert.strictEqual(registry.get("task-1"), undefined);
		assert.strictEqual(registry.taskIdOf("session-1"), undefined);
		assert.strictEqual(first.disposed, true);

		registry.disposeAll();
		assert.strictEqual(second.disposed, true);
		assert.strictEqual(registry.get("task-2"), undefined);
	});
});
