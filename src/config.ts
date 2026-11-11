/** 从环境变量读取运行配置；不处理登录 / 多 provider，只认 .env。 */

export interface AppConfig {
	apiKey: string;
	baseUrl: string;
	model: string;
}

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
	const apiKey = readEnv(env, "OPENROUTER_API_KEY") ?? readEnv(env, "OPENAI_API_KEY");
	if (!apiKey) {
		throw new Error("缺少 OPENROUTER_API_KEY（或 OPENAI_API_KEY），请在项目根目录的 .env 中配置");
	}

	const rawModel = readEnv(env, "MODEL_NAME");
	if (!rawModel) {
		throw new Error("缺少 MODEL_NAME，请在项目根目录的 .env 中配置");
	}

	return {
		apiKey,
		// 兼容 pi 的 "openrouter/vendor/model" 写法，OpenRouter 只接受后半段。
		model: rawModel.replace(/^openrouter\//, ""),
		baseUrl: readEnv(env, "OPENAI_BASE_URL")?.replace(/\/+$/, "") || DEFAULT_BASE_URL,
	};
}

/** 读取非空环境变量。Node 的 --env-file 会自行处理合法引号。 */
function readEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
	const value = env[key]?.trim();
	return value ? value : undefined;
}
