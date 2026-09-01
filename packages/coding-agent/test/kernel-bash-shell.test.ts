import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	existsSync: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	// Module-load reads (config.ts) must see the real fs; tests override per case.
	mocks.existsSync.mockImplementation(actual.existsSync);
	return { ...actual, existsSync: mocks.existsSync };
});

import { getShellConfig, resolveKernelBashShell } from "../src/utils/shell.js";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

function stubWin32(): void {
	Object.defineProperty(process, "platform", { value: "win32" });
}

afterEach(() => {
	if (originalPlatform) {
		Object.defineProperty(process, "platform", originalPlatform);
	}
	mocks.existsSync.mockClear();
});

describe("bash shell resolution on win32", () => {
	it("returns undefined without consulting PATH when no Git Bash is installed", () => {
		stubWin32();
		mocks.existsSync.mockReturnValue(false);

		expect(resolveKernelBashShell()).toBeUndefined();
		expect(() => getShellConfig()).toThrow("No bash shell found");
		// A repo-controlled PATH/where.exe must never pick either host shell.
	});

	it("returns the canonical Git Bash install path when present", () => {
		stubWin32();
		const canonical = "C:\\Program Files\\Git\\bin\\bash.exe";
		mocks.existsSync.mockImplementation((path: string) => path === canonical);

		expect(resolveKernelBashShell()).toBe(canonical);
		expect(getShellConfig()).toEqual({ shell: canonical, args: ["-c"] });
	});

	it("returns an explicit shellPath as-is", () => {
		stubWin32();
		mocks.existsSync.mockReturnValue(false);

		expect(resolveKernelBashShell("D:\\tools\\bash.exe")).toBe("D:\\tools\\bash.exe");
		expect(mocks.existsSync).not.toHaveBeenCalled();
	});
});

describe.skipIf(process.platform === "win32")("bash shell resolution on POSIX", () => {
	it("resolves PATH bash as filesystem data without running hostile helpers or startup hooks", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-shell-resolution-"));
		const fakeBin = join(root, "bin");
		const whichMarker = join(root, "which-executed");
		const bashMarker = join(root, "bash-executed");
		const loaderMarker = join(root, "loader-executed");
		const loader = join(root, "loader.cjs");
		const previousPath = process.env.PATH;
		const previousNodeOptions = process.env.NODE_OPTIONS;
		try {
			mkdirSync(fakeBin);
			writeFileSync(
				join(fakeBin, "which"),
				`#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(whichMarker)}, "hostile");\nprocess.stdout.write(${JSON.stringify(`${join(fakeBin, "bash")}\n`)});\n`,
			);
			writeFileSync(join(fakeBin, "bash"), `#!/bin/sh\nprintf hostile > ${JSON.stringify(bashMarker)}\n`);
			writeFileSync(loader, `require("node:fs").writeFileSync(${JSON.stringify(loaderMarker)}, "hostile");\n`);
			chmodSync(join(fakeBin, "which"), 0o700);
			chmodSync(join(fakeBin, "bash"), 0o700);
			chmodSync(loader, 0o700);
			process.env.PATH = fakeBin;
			process.env.NODE_OPTIONS = `--require=${loader}`;
			mocks.existsSync.mockImplementation((path: string) => path !== "/bin/bash");

			expect(getShellConfig()).toEqual({ shell: join(fakeBin, "bash"), args: ["-c"] });
			expect(() => readFileSync(whichMarker)).toThrow();
			expect(() => readFileSync(bashMarker)).toThrow();
			expect(() => readFileSync(loaderMarker)).toThrow();
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
			if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
			else process.env.NODE_OPTIONS = previousNodeOptions;
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("uses an absolute sh fallback when neither bash location is executable", () => {
		const previousPath = process.env.PATH;
		try {
			process.env.PATH = join(tmpdir(), `prime-agent-no-bash-${process.pid}-${Date.now()}`);
			mocks.existsSync.mockReturnValue(false);

			expect(getShellConfig()).toEqual({ shell: "/bin/sh", args: ["-c"] });
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
		}
	});
});
