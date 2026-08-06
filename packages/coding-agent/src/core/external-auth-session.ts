import {
	AUTH_STORAGE_GET_EXTERNAL_DESCRIPTOR_SNAPSHOT,
	AUTH_STORAGE_RESET_EXTERNAL_RUNTIME,
	AUTH_STORAGE_SET_EXTERNAL_DESCRIPTOR_SNAPSHOT,
	AUTH_STORAGE_SET_EXTERNAL_INSPECTION_BINDINGS,
	AUTH_STORAGE_START_EXTERNAL_SESSION,
	type AuthStorage,
} from "./auth-storage.js";
import type { CredentialBinding, ExternalCredentialDescriptor } from "./external-credential-client.js";
import type { SessionManager } from "./session-manager.js";

const activeExternalOwners = new WeakMap<AuthStorage, string>();

function assertRootScopedOwner(authStorage: AuthStorage, sessionManager: SessionManager): void {
	const owner = activeExternalOwners.get(authStorage);
	if (owner && owner !== sessionManager.getSessionId()) {
		throw new Error("AIM-managed AuthStorage cannot be shared across root session runtimes");
	}
}

/** Enable helper resolution for one active worker and persist its exact non-secret bindings. */
export function initializeExternalCredentialSession(
	authStorage: AuthStorage,
	sessionManager: SessionManager,
	onBindingResolved?: (binding: CredentialBinding) => void,
): void {
	assertRootScopedOwner(authStorage, sessionManager);
	authStorage[AUTH_STORAGE_RESET_EXTERNAL_RUNTIME]();
	authStorage.reload();
	const reloadErrors = authStorage.drainErrors();
	if (reloadErrors.length > 0) throw reloadErrors[0];
	assertRootScopedOwner(authStorage, sessionManager);
	authStorage[AUTH_STORAGE_START_EXTERNAL_SESSION](sessionManager.getCredentialBindings().values(), (binding) => {
		sessionManager.appendCredentialBinding(binding);
		onBindingResolved?.(binding);
	});
	if (authStorage.list().some((provider) => authStorage.isExternalAuthManaged(provider))) {
		activeExternalOwners.set(authStorage, sessionManager.getSessionId());
	}
}

/** Seed UI/client status from session metadata without granting helper execution. */
export function inspectExternalCredentialSession(authStorage: AuthStorage, sessionManager: SessionManager): void {
	authStorage[AUTH_STORAGE_SET_EXTERNAL_INSPECTION_BINDINGS](sessionManager.getCredentialBindings().values());
}

/** Capture immutable root descriptor mechanics for a same-process descendant. */
export function snapshotExternalCredentialDescriptors(
	authStorage: AuthStorage,
): ReadonlyMap<string, ExternalCredentialDescriptor> {
	return authStorage[AUTH_STORAGE_GET_EXTERNAL_DESCRIPTOR_SNAPSHOT]();
}

/** Stage a root-owned descriptor snapshot for the descendant's internal initialization. */
export function stageExternalCredentialDescriptors(
	authStorage: AuthStorage,
	snapshot: ReadonlyMap<string, ExternalCredentialDescriptor>,
): void {
	authStorage[AUTH_STORAGE_SET_EXTERNAL_DESCRIPTOR_SNAPSHOT](snapshot);
}
