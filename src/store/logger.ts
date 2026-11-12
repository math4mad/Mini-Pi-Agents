/** 控制台日志中间件：Safari 没有 Redux DevTools 扩展，用 redux-logger 在终端观察 action 与状态变更。 */

import type { Middleware } from "redux";
import type { ReduxLoggerOptions } from "redux-logger";
import reduxLogger from "redux-logger";
import type { AgentAction } from "./actions.ts";
import { AGENT_SUBMIT, AGENT_TEXT_DELTA } from "./actions.ts";
import type { AgentState } from "./reducer.ts";

/**
 * redux-logger 是 CJS 包：Node 的 ESM 默认导入拿到的是 module.exports 对象，
 * 而不是 createLogger 函数本身，这里显式解包并补上类型。
 */
const { createLogger } = reduxLogger as unknown as {
	createLogger: (options?: ReduxLoggerOptions) => Middleware;
};

/** data URL 只保留 MIME 前缀，避免整张 base64 图片刷满终端。 */
function truncateDataUrl(value: string): string {
	if (!value.startsWith("data:")) return value;
	const comma = value.indexOf(",");
	return comma === -1 ? value : `${value.slice(0, comma)},…(${value.length} chars)`;
}

export function createAgentLogger(): Middleware {
	return createLogger({
		collapsed: true,
		duration: true,
		diff: true,
		timestamp: true,
		// 流式 token 一个 delta 一条 action，全部打印会淹没终端。
		predicate: (_getState, action: { type?: string }) => action.type !== AGENT_TEXT_DELTA,
		actionTransformer: (action: AgentAction) =>
			action.type === AGENT_SUBMIT && action.payload.message.images
				? {
						...action,
						payload: {
							...action.payload,
							message: {
								...action.payload.message,
								images: action.payload.message.images.map(truncateDataUrl),
							},
						},
					}
				: action,
		stateTransformer: (state: AgentState) => ({
			...state,
			messages: state.messages.map((message) =>
				message.role === "user" && message.images
					? { ...message, images: message.images.map(truncateDataUrl) }
					: message,
			),
		}),
	});
}
