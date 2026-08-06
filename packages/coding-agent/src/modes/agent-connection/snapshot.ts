import { createHash } from "node:crypto";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentSession } from "../../core/agent-session.js";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.js";
import type { SessionTreeFlatNode, SessionTreeNode } from "../../core/session-manager.js";
import type {
	AgentConnectionArtifactReference,
	AgentConnectionArtifactType,
	AgentConnectionModel,
	AgentConnectionResourceSnapshot,
	AgentConnectionSessionTreeFlatNode,
	AgentConnectionSessionTreeNode,
	AgentConnectionSlashCommand,
	AgentConnectionSnapshot,
	AgentConnectionState,
} from "./types.js";

function persistedRecap(sessionManager: {
	getLatestAgentStatus?: () => { summary: string } | undefined;
}): string | undefined {
	return sessionManager.getLatestAgentStatus?.()?.summary;
}

export function createAgentConnectionState(
	runtime: AgentSessionRuntime,
	activeSessionId?: string,
): AgentConnectionState {
	const session = runtime.session;
	const sessionManager = session.sessionManager;
	return {
		activeSessionId,
		cwd: sessionManager.getCwd(),
		model: toConnectionModel(session.model),
		thinkingLevel: session.thinkingLevel,
		serviceTier: session.serviceTier,
		availableThinkingLevels: session.getAvailableThinkingLevels(),
		isStreaming: session.isStreaming,
		isCompacting: session.isCompacting,
		isBashRunning: session.isBashRunning,
		retryAttempt: session.retryAttempt,
		steeringMode: session.steeringMode,
		followUpMode: session.followUpMode,
		sessionFile: session.sessionFile,
		sessionId: session.sessionId,
		sessionName: session.sessionName,
		sessionDir: sessionManager.getSessionDir(),
		leafId: sanitizeAgentConnectionSessionTreeLeafId(
			sessionManager.getLeafId(),
			typeof sessionManager.getFlatTree === "function" ? sessionManager.getFlatTree() : [],
		),
		autoCompactionEnabled: session.autoCompactionEnabled,
		messageCount: session.messages.length,
		sessionActions: session.getSessionActionSnapshot(),
		compactionCount: sessionManager.getEntries().filter((entry) => entry.type === "compaction").length,
		goal: session.goalState,
		scopedModels: session.scopedModels.map((scoped) => ({
			model: toConnectionModel(scoped.model),
			thinkingLevel: scoped.thinkingLevel,
		})),
		activeToolNames: session.getActiveToolNames(),
		contextUsage: session.getContextUsage(),
		credentialBindings: [...sessionManager.getCredentialBindings().values()]
			.map(({ provider, source, binding }) => ({ provider, source, binding }))
			.sort((left, right) => left.provider.localeCompare(right.provider)),
		// Baseline recap; the daemon overlays the live summary on attach.
		recap: persistedRecap(sessionManager),
	};
}

function publicParentId(parentId: string | null, byId: ReadonlyMap<string, SessionTreeFlatNode>): string | null {
	const seen = new Set<string>();
	let current = parentId;
	while (current !== null) {
		if (seen.has(current)) return null;
		seen.add(current);
		const parent = byId.get(current);
		if (!parent || parent.entry.type !== "credential_binding") return current;
		current = parent.entry.parentId;
	}
	return null;
}

/** Canonical worker-metadata sanitizer used by snapshots and old/new daemon paths. */
export function sanitizeAgentConnectionSessionTreeFlatNodes(
	nodes: readonly SessionTreeFlatNode[],
): AgentConnectionSessionTreeFlatNode[] {
	const byId = new Map(nodes.map((node) => [node.entry.id, node]));
	return nodes.flatMap((node) => {
		if (node.entry.type === "credential_binding") return [];
		return [
			{
				...node,
				entry: { ...node.entry, parentId: publicParentId(node.entry.parentId, byId) },
			} as AgentConnectionSessionTreeFlatNode,
		];
	});
}

export function sanitizeAgentConnectionSessionTreeLeafId(
	leafId: string | null,
	nodes: readonly SessionTreeFlatNode[],
): string | null {
	if (leafId === null) return null;
	const byId = new Map(nodes.map((node) => [node.entry.id, node]));
	const leaf = byId.get(leafId);
	return leaf?.entry.type === "credential_binding" ? publicParentId(leaf.entry.parentId, byId) : leafId;
}

export function buildSanitizedAgentConnectionSessionTree(
	nodes: readonly SessionTreeFlatNode[],
): AgentConnectionSessionTreeNode[] {
	const flatNodes = sanitizeAgentConnectionSessionTreeFlatNodes(nodes);
	const byId = new Map<string, AgentConnectionSessionTreeNode>();
	const roots: AgentConnectionSessionTreeNode[] = [];
	for (const node of flatNodes) byId.set(node.entry.id, { ...node, children: [] });
	for (const node of flatNodes) {
		const treeNode = byId.get(node.entry.id)!;
		const parent = node.entry.parentId === null ? undefined : byId.get(node.entry.parentId);
		if (parent) parent.children.push(treeNode);
		else roots.push(treeNode);
	}
	return roots;
}

/** Keep worker-only credential metadata out of the existing daemon/client tree shape. */
export function createAgentConnectionSessionTree(nodes: SessionTreeNode[]): AgentConnectionSessionTreeNode[] {
	const flat: SessionTreeFlatNode[] = [];
	const visit = (node: SessionTreeNode) => {
		flat.push({
			entry: node.entry,
			...(node.label ? { label: node.label } : {}),
			...(node.labelTimestamp ? { labelTimestamp: node.labelTimestamp } : {}),
		});
		for (const child of node.children) visit(child);
	};
	for (const node of nodes) visit(node);
	return buildSanitizedAgentConnectionSessionTree(flat);
}

export function createAgentConnectionSnapshot(
	runtime: AgentSessionRuntime,
	activeSessionId?: string,
): AgentConnectionSnapshot {
	const session = runtime.session;
	const sessionManager = session.sessionManager;
	return {
		state: createAgentConnectionState(runtime, activeSessionId),
		messages: [...session.messages],
		...(session.state?.streamingMessage ? { streamingMessage: session.state.streamingMessage } : {}),
		sessionContext: session.buildSessionContext(),
		sessionTree: {
			tree: createAgentConnectionSessionTree(sessionManager.getTree()),
			leafId: sanitizeAgentConnectionSessionTreeLeafId(
				sessionManager.getLeafId(),
				typeof sessionManager.getFlatTree === "function" ? sessionManager.getFlatTree() : [],
			),
		},
	};
}

export function createAgentConnectionCommands(session: AgentSession): AgentConnectionSlashCommand[] {
	return [
		...session.extensionRunner.getRegisteredCommands().map((entry) => ({
			name: entry.invocationName,
			registeredName: entry.name,
			description: entry.description,
			source: "extension" as const,
			sourceInfo: entry.sourceInfo,
		})),
		...session.promptTemplates.map((entry) => ({
			name: entry.name,
			description: entry.description,
			argumentHint: entry.argumentHint,
			source: "prompt" as const,
			sourceInfo: entry.sourceInfo,
		})),
		...session.resourceLoader.getSkills().skills.map((entry) => ({
			name: `skill:${entry.name}`,
			description: entry.description,
			source: "skill" as const,
			sourceInfo: entry.sourceInfo,
		})),
	];
}

export function createAgentConnectionResourceSnapshot(session: AgentSession): AgentConnectionResourceSnapshot {
	const skillsResult = session.resourceLoader.getSkills();
	const promptsResult = session.resourceLoader.getPrompts();
	const themesResult = session.resourceLoader.getThemes();
	const extensionsResult = session.resourceLoader.getExtensions();

	return {
		contextFiles: session.resourceLoader.getAgentsFiles().agentsFiles.map((entry) => ({
			path: entry.path,
			artifact: createArtifactReference(session, "context_file", entry.path),
		})),
		skills: skillsResult.skills.map((skill) => ({
			name: skill.name,
			description: skill.description,
			filePath: skill.filePath,
			sourceInfo: skill.sourceInfo,
			artifact: createArtifactReference(session, "skill", skill.filePath),
		})),
		prompts: promptsResult.prompts.map((prompt) => ({
			name: prompt.name,
			description: prompt.description,
			argumentHint: prompt.argumentHint,
			filePath: prompt.filePath,
			sourceInfo: prompt.sourceInfo,
			artifact: createArtifactReference(session, "prompt", prompt.filePath),
		})),
		extensions: extensionsResult.extensions.map((extension) => ({
			path: extension.path,
			sourceInfo: extension.sourceInfo,
			artifact: createArtifactReference(session, "extension", extension.path),
		})),
		themes: themesResult.themes.map((loadedTheme) => ({
			name: loadedTheme.name,
			sourcePath: loadedTheme.sourcePath,
			sourceInfo: loadedTheme.sourceInfo,
			artifact: createArtifactReference(session, "theme", loadedTheme.sourcePath),
		})),
		diagnostics: {
			skills: skillsResult.diagnostics,
			prompts: promptsResult.diagnostics,
			extensions: extensionsResult.errors.map((error) => ({
				type: "error",
				message: error.error,
				path: error.path,
			})),
			themes: themesResult.diagnostics,
		},
	};
}

export function toConnectionModel(model: Model<Api>): AgentConnectionModel;
export function toConnectionModel(model: Model<Api> | undefined): AgentConnectionModel | undefined;
export function toConnectionModel(model: Model<Api> | undefined): AgentConnectionModel | undefined {
	return model;
}

function createArtifactReference(
	session: AgentSession,
	type: AgentConnectionArtifactType,
	filePath: string | undefined,
): AgentConnectionArtifactReference | undefined {
	if (!filePath) {
		return undefined;
	}
	const { logicalPath, relativePath } = createArtifactPathInfo(filePath, session.sessionManager.getCwd());
	const idHash = createHash("sha256").update(`${session.sessionId}\0${type}\0${filePath}`).digest("hex").slice(0, 16);
	return {
		id: `artifact_${idHash}`,
		sessionId: session.sessionId,
		type,
		logicalPath,
		...(relativePath ? { relativePath } : {}),
	};
}

function createArtifactPathInfo(filePath: string, cwd: string): { logicalPath: string; relativePath?: string } {
	if (filePath.startsWith("<") && filePath.endsWith(">")) {
		return { logicalPath: filePath };
	}

	const resolvedCwd = resolve(cwd);
	const resolvedPath = resolve(filePath);
	const cwdRelativePath = toPosixPath(relative(resolvedCwd, resolvedPath));
	if (cwdRelativePath && !cwdRelativePath.startsWith("..") && !isAbsolute(cwdRelativePath)) {
		return { logicalPath: cwdRelativePath, relativePath: cwdRelativePath };
	}

	return { logicalPath: basename(filePath) || "artifact" };
}

function toPosixPath(path: string): string {
	return sep === "/" ? path : path.split(sep).join("/");
}
