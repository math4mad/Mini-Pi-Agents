/** 配置加载测试：.env 自动读取，且不覆盖已存在的环境变量。 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadDotEnv } from "./config.ts";

test("loadDotEnv 读取 .env 且保留已存在的环境变量", () => {
	const dir = mkdtempSync(join(tmpdir(), "mini-pi-env-"));
	writeFileSync(join(dir, ".env"), "MINI_PI_TEST_A=from-file\nMINI_PI_TEST_B=from-file\n");
	process.env.MINI_PI_TEST_B = "from-env";

	try {
		loadDotEnv(dir);
		assert.equal(process.env.MINI_PI_TEST_A, "from-file");
		assert.equal(process.env.MINI_PI_TEST_B, "from-env");
	} finally {
		delete process.env.MINI_PI_TEST_A;
		delete process.env.MINI_PI_TEST_B;
	}
});

test("loadDotEnv 在没有 .env 时静默跳过", () => {
	const dir = mkdtempSync(join(tmpdir(), "mini-pi-no-env-"));
	assert.doesNotThrow(() => loadDotEnv(dir));
});
