/** Provider 连通性探测：用一次最小 chat/completions 请求验证 key、baseUrl 与模型名是否可用。 */

import type { AppConfig } from "../config.ts";

export interface ProviderPing {
	ok: boolean;
	ms: number;
	/** 成功时为 HTTP 状态行，失败时尽量带上 provider 返回的错误片段。 */
	detail: string;
}

const PING_TIMEOUT_MS = 15_000;

export async function pingProvider(config: Pick<AppConfig, "apiKey" | "baseUrl" | "model">): Promise<ProviderPing> {
	const started = Date.now();

	try {
		const response = await fetch(`${config.baseUrl}/chat/completions`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${config.apiKey}`,
			},
			body: JSON.stringify({
				model: config.model,
				messages: [{ role: "user", content: "ping" }],
				max_tokens: 1,
				temperature: 0,
			}),
			signal: AbortSignal.timeout(PING_TIMEOUT_MS),
		});

		const ms = Date.now() - started;
		if (!response.ok) {
			const body = await response.text().catch(() => "");
			return {
				ok: false,
				ms,
				detail: `HTTP ${response.status}${body ? ` · ${body.slice(0, 200)}` : ""}`,
			};
		}

		// 不解析响应体：能返回 2xx 就说明鉴权、模型名与网络链路都通了。
		await response.body?.cancel();
		return { ok: true, ms, detail: `HTTP ${response.status}` };
	} catch (error) {
		const ms = Date.now() - started;
		const detail = error instanceof Error ? error.message : String(error);
		return { ok: false, ms, detail: detail.includes("timed out") ? `超时（${PING_TIMEOUT_MS}ms）` : detail };
	}
}
