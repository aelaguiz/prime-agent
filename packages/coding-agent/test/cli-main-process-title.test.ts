import { describe, expect, it } from "vitest";
import { processTitleForArgv0 } from "../src/cli-main.js";
import { APP_NAME } from "../src/config.js";
import {
	createProcessIdentityOwnerToken,
	PROCESS_IDENTITY_OWNER_TOKEN_ARGUMENT_PREFIX,
} from "../src/core/session-lease.js";

describe("CLI process title owner identity", () => {
	it("preserves only an exact parent-issued argv0 marker", () => {
		const marker = createProcessIdentityOwnerToken().argument;
		expect(processTitleForArgv0(marker)).toBe(`${APP_NAME} ${marker}`);
	});

	it.each([
		process.execPath,
		`node ${PROCESS_IDENTITY_OWNER_TOKEN_ARGUMENT_PREFIX}${"a".repeat(64)}`,
		`${PROCESS_IDENTITY_OWNER_TOKEN_ARGUMENT_PREFIX}${"a".repeat(63)}`,
		`${PROCESS_IDENTITY_OWNER_TOKEN_ARGUMENT_PREFIX}${"a".repeat(65)}`,
		`${PROCESS_IDENTITY_OWNER_TOKEN_ARGUMENT_PREFIX}${"A".repeat(64)}`,
		`${PROCESS_IDENTITY_OWNER_TOKEN_ARGUMENT_PREFIX}${"g".repeat(64)}`,
		`${PROCESS_IDENTITY_OWNER_TOKEN_ARGUMENT_PREFIX}${"a".repeat(64)} --mode daemon`,
	])("keeps the normal title for non-marker or hostile argv0 %j", (argv0) => {
		expect(processTitleForArgv0(argv0)).toBe(APP_NAME);
	});
});
