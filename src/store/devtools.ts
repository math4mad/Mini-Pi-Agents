/** Redux DevTools（远程模式）接入：只有显式启用时才加载依赖，正常终端启动零负担。 */

import type { StoreEnhancer } from "redux";

export interface DevtoolsConfig {
	enabled: boolean;
	name?: string;
	hostname?: string;
	port?: number;
}

export async function loadDevtoolsEnhancer(config: DevtoolsConfig): Promise<StoreEnhancer | undefined> {
	if (!config.enabled) return undefined;

	const { devToolsEnhancer } = await import("@redux-devtools/remote");

	return devToolsEnhancer({
		name: config.name ?? "Mini Pi Agents",
		realtime: true,
		hostname: config.hostname ?? "localhost",
		port: config.port ?? 8000,
		// 没启动 devtools server 时不刷屏报错，方便先开着 flag 调试。
		suppressConnectErrors: true,
	});
}
