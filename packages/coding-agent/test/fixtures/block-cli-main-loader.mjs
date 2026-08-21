export async function resolve(specifier, context, nextResolve) {
	if (specifier === "./cli-main.js" && context.parentURL?.endsWith("/src/cli.ts")) {
		throw new Error("prime-cli-main-import-failure-sentinel");
	}
	return nextResolve(specifier, context);
}
