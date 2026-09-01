#!/usr/bin/env node
/**
 * Bundles the compiled CLI entry (dist/cli.js) into dist/bundle/ with esbuild.
 *
 * Why: the unbundled module graph is ~2,500 files; resolving and reading them
 * dominates startup (~1.5s on slow filesystems). The split bundle keeps the
 * startup and resident-memory profile low without invalidating live processes:
 * old content-hashed chunks remain available and the new entrypoint is
 * published atomically after its complete closure.
 *
 * Extension loading inside the bundle uses jiti virtualModules (same as the
 * compiled Bun binary), keyed off the __PI_BUNDLED__ define below, so extension
 * imports of pi packages share the bundle's module instances.
 */
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const testOutdir = process.env.NODE_ENV === "test" ? process.env.PRIME_AGENT_BUNDLE_OUTDIR : undefined;
const testEntrypoint = process.env.NODE_ENV === "test" ? process.env.PRIME_AGENT_BUNDLE_ENTRYPOINT : undefined;
const failBeforeEntrypoint =
	process.env.NODE_ENV === "test" && process.env.PRIME_AGENT_BUNDLE_FAIL_BEFORE_ENTRYPOINT === "1";
const outdir = testOutdir ? resolve(testOutdir) : join(packageDir, "dist", "bundle");
const sourceEntrypoint = testEntrypoint ? resolve(testEntrypoint) : join(packageDir, "dist", "cli.js");
const buildIdPlaceholder = "bundle-v1:0000000000000000000000000000000000000000000000000000000000000000";

async function createBundle(buildId) {
	return build({
		entryPoints: [sourceEntrypoint],
		outdir,
		write: false,
		bundle: true,
		splitting: true,
		format: "esm",
		platform: "node",
		// Native or interop-sensitive packages stay external; they resolve from
		// node_modules at runtime (and are loaded via createRequire/lazily anyway).
		external: ["koffi", "undici", "@silvia-odwyer/photon-node", "@mariozechner/clipboard"],
		define: { __PI_BUNDLED__: "true", __PI_BUILD_ID__: JSON.stringify(buildId) },
		banner: {
			js: `// prime-agent-bundle-build-id: ${buildId}\nimport { createRequire as __piBundleCreateRequire } from 'node:module'; const require = __piBundleCreateRequire(import.meta.url);`,
		},
		logLevel: "warning",
	});
}

function computeOutputBuildId(outputFiles) {
	const hash = createHash("sha256");
	hash.update("prime-agent-published-bundle-v1\0");
	for (const output of [...outputFiles].sort((left, right) => left.path.localeCompare(right.path))) {
		hash.update(relative(outdir, output.path).split(sep).join("/"));
		hash.update("\0");
		hash.update(output.contents);
		hash.update("\0");
	}
	return `bundle-v1:${hash.digest("hex")}`;
}

const provisional = await createBundle(buildIdPlaceholder);
const buildId = computeOutputBuildId(provisional.outputFiles);
const result = await createBundle(buildId);
const entrypoint = join(outdir, "cli.js");
const orderedOutputs = [...result.outputFiles].sort((left, right) => {
	if (left.path === entrypoint) return 1;
	if (right.path === entrypoint) return -1;
	return left.path.localeCompare(right.path);
});
if (!orderedOutputs.some((output) => output.path === entrypoint)) {
	throw new Error(`esbuild did not produce the expected CLI entrypoint: ${entrypoint}`);
}

mkdirSync(outdir, { recursive: true });
for (const output of orderedOutputs) {
	if (output.path === entrypoint && failBeforeEntrypoint) {
		throw new Error("test-only bundle publication failure before entrypoint");
	}
	mkdirSync(dirname(output.path), { recursive: true });
	const temporaryPath = join(dirname(output.path), `.${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
	try {
		writeFileSync(temporaryPath, output.contents, { mode: output.path === entrypoint ? 0o755 : 0o644 });
		if (output.path === entrypoint) chmodSync(temporaryPath, 0o755);
		renameSync(temporaryPath, output.path);
	} finally {
		rmSync(temporaryPath, { force: true });
	}
}

console.log(`bundled ${relative(packageDir, sourceEntrypoint)} -> ${outdir}/ (${buildId})`);
