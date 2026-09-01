import { randomBytes } from "node:crypto";
import {
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type AcquireAuthorityMutationGuardOptions,
	AuthorityGuardContentionError,
	acquireAuthorityMutationGuard,
} from "../src/core/authority-mutation-guard.js";

const cleanupDirectories: string[] = [];

afterEach(() => {
	for (const directory of cleanupDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function createGuardFixture(token = "a".repeat(64)): {
	root: string;
	authorityPath: string;
	lockfilePath: string;
	record: Record<string, unknown>;
} {
	const root = mkdtempSync(join(tmpdir(), "authority-guard-test-"));
	cleanupDirectories.push(root);
	const authorityPath = resolve(root, "authority");
	const lockfilePath = join(authorityPath, ".guard");
	mkdirSync(authorityPath, { recursive: true });
	const record = {
		version: 1,
		type: "authority-mutation-guard",
		token,
		pid: 2_147_483_647,
		processStartId: "proc:123",
		authorityPath,
		createdAt: new Date(0).toISOString(),
	};
	writeFileSync(lockfilePath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
	return { root, authorityPath, lockfilePath, record };
}

function reclaimOptions(
	fixture: ReturnType<typeof createGuardFixture>,
	overrides: Partial<AcquireAuthorityMutationGuardOptions> = {},
): AcquireAuthorityMutationGuardOptions {
	return {
		authorityPath: fixture.authorityPath,
		lockfilePath: fixture.lockfilePath,
		attempts: 1,
		retryMs: 0,
		identity: { processStartId: `token:${"a".repeat(64)}` },
		classifyOwner: () => "exact-dead",
		failureMessage: "guard retained",
		...overrides,
	};
}

function readGuardToken(path: string): string {
	return (JSON.parse(readFileSync(path, "utf8")) as { token: string }).token;
}

describe("authority mutation guard reclamation", () => {
	it("elects only the successful deterministic claimant when two reclaimers interleave", () => {
		const fixture = createGuardFixture();
		const claimPath = `${fixture.lockfilePath}.reclaim-${fixture.record.token as string}`;
		let nestedError: unknown;
		let nestedClaimed = false;

		const held = acquireAuthorityMutationGuard(
			reclaimOptions(fixture, {
				attempts: 2,
				testHooks: {
					afterReclaimClaim: () => {
						expect(existsSync(claimPath)).toBe(true);
						try {
							acquireAuthorityMutationGuard(
								reclaimOptions(fixture, {
									testHooks: {
										afterReclaimClaim: () => {
											nestedClaimed = true;
										},
									},
								}),
							);
						} catch (error) {
							nestedError = error;
						}
						expect(nestedError).toBeInstanceOf(AuthorityGuardContentionError);
						expect(nestedClaimed).toBe(false);
						expect(readGuardToken(fixture.lockfilePath)).toBe(fixture.record.token);
					},
				},
			}),
		);

		expect(readGuardToken(fixture.lockfilePath)).not.toBe(fixture.record.token);
		expect(existsSync(claimPath)).toBe(false);
		held.release();
	});

	it("retains the canonical guard when a crashed deterministic claim already exists", () => {
		const fixture = createGuardFixture();
		const claimPath = `${fixture.lockfilePath}.reclaim-${fixture.record.token as string}`;
		linkSync(fixture.lockfilePath, claimPath);

		expect(() => acquireAuthorityMutationGuard(reclaimOptions(fixture))).toThrow(AuthorityGuardContentionError);
		expect(readGuardToken(fixture.lockfilePath)).toBe(fixture.record.token);
		expect(existsSync(claimPath)).toBe(true);
	});

	it("pins bigint inode identities and cannot unlink an overtaking replacement", () => {
		const fixture = createGuardFixture();
		const displacedPath = join(fixture.root, "displaced-owner");
		const replacementToken = randomBytes(32).toString("hex");
		let displacedInode: bigint | undefined;
		let replacementInode: bigint | undefined;

		expect(() =>
			acquireAuthorityMutationGuard(
				reclaimOptions(fixture, {
					testHooks: {
						beforeReclaimUnlink: () => {
							renameSync(fixture.lockfilePath, displacedPath);
							writeFileSync(
								fixture.lockfilePath,
								`${JSON.stringify({ ...fixture.record, token: replacementToken, createdAt: "replacement" })}\n`,
								{ mode: 0o600 },
							);
							displacedInode = lstatSync(displacedPath, { bigint: true }).ino;
							replacementInode = lstatSync(fixture.lockfilePath, { bigint: true }).ino;
						},
					},
				}),
			),
		).toThrow(AuthorityGuardContentionError);

		expect(typeof displacedInode).toBe("bigint");
		expect(typeof replacementInode).toBe("bigint");
		expect(displacedInode).not.toBe(replacementInode);
		expect(readGuardToken(fixture.lockfilePath)).toBe(replacementToken);
	});

	it("fails closed on a legacy empty-directory guard", () => {
		const root = mkdtempSync(join(tmpdir(), "authority-directory-guard-test-"));
		cleanupDirectories.push(root);
		const authorityPath = resolve(root, "authority");
		const lockfilePath = join(authorityPath, ".guard");
		mkdirSync(lockfilePath, { recursive: true });
		let classifications = 0;

		expect(() =>
			acquireAuthorityMutationGuard({
				authorityPath,
				lockfilePath,
				attempts: 1,
				retryMs: 0,
				identity: { processStartId: `token:${"a".repeat(64)}` },
				classifyOwner: () => {
					classifications++;
					return "exact-dead";
				},
				failureMessage: "directory guard retained",
			}),
		).toThrow(AuthorityGuardContentionError);
		expect(lstatSync(lockfilePath).isDirectory()).toBe(true);
		expect(readdirSync(lockfilePath)).toEqual([]);
		expect(classifications).toBe(0);
	});

	it.each([
		["conflicting start and hint", { processIdentityHint: "ps:lstart:canonical" }],
		["noncanonical arbitrary hint", { processStartId: undefined, processIdentityHint: "arbitrary" }],
	])("retains present-invalid %s bytes and inode", (_name, patch) => {
		const fixture = createGuardFixture();
		const invalid = { ...fixture.record, ...patch };
		writeFileSync(
			fixture.lockfilePath,
			`${JSON.stringify(invalid)}
`,
			{ mode: 0o600 },
		);
		const beforeBytes = readFileSync(fixture.lockfilePath);
		const before = lstatSync(fixture.lockfilePath, { bigint: true });

		expect(() => acquireAuthorityMutationGuard(reclaimOptions(fixture))).toThrow(AuthorityGuardContentionError);
		expect(readFileSync(fixture.lockfilePath)).toEqual(beforeBytes);
		const after = lstatSync(fixture.lockfilePath, { bigint: true });
		expect({ dev: after.dev, ino: after.ino }).toEqual({ dev: before.dev, ino: before.ino });
	});
});
