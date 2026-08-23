export async function resolve(specifier, context, nextResolve) {
	// Recent Node 22 + tsx releases rewrite source imports from .js to .ts
	// before downstream loader hooks run; support both forms deterministically.
	const isCliMain = specifier === "./cli-main.js" || specifier === "./cli-main.ts";
	if (isCliMain && context.parentURL?.endsWith("/src/cli.ts")) {
		throw new Error("prime-cli-main-import-failure-sentinel");
	}
	return nextResolve(specifier, context);
}
