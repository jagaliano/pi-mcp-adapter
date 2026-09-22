import { createSecureKeyringStore } from "./secure-keyring.js";
/** The Jev decisions endpoint used when `SYSTEMONE_ENDPOINT` is not set. */
export const JEV_DEFAULT_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
/**
 * Environment variable naming the System One decisions endpoint. The name follows the wire surface every provider
 * exposes (`/v1/systemone`, `/zen/v1/systemone`, `/provider/v1/systemone`) so it stays provider-neutral; the module
 * itself keeps the `Jev` name used across the rest of the adapter.
 */
export const SYSTEMONE_ENDPOINT_ENV = "SYSTEMONE_ENDPOINT";
/** Environment variable holding the System One API key. */
export const SYSTEMONE_API_KEY_ENV = "SYSTEMONE_API_KEY";
/**
 * Pre-endpoint name for {@link SYSTEMONE_API_KEY_ENV}. Still read, and still wins over the keyring, so an existing
 * environment keeps working unchanged; `SYSTEMONE_API_KEY` takes precedence when both are set.
 */
export const LEGACY_TYPESAFE_API_KEY_ENV = "TYPESAFE_API_KEY";
/** @deprecated Kept because sibling modules import it. Use {@link JEV_DEFAULT_ENDPOINT}. */
export const TYPESAFE_API_ORIGIN = "https://api.typesafe.ai";
/** @deprecated Legacy credential account, still readable for the default endpoint. Accounts are now derived from the endpoint. */
export const JEV_KEYRING_ACCOUNT = "typesafe@sha256(https://api.typesafe.ai)";
export const JEV_KEYRING_SERVICE = "pi-mcp-adapter.service-key";
const MAX_ENDPOINT_LENGTH = 512;
/** The path `@typesafe-ai/sdk` appends to whatever base URL it is given. */
export const JEV_SDK_PATH = "/v1/systemone";
export class JevCredentialStoreError extends Error {
    operation;
    code = "JEV_CREDENTIAL_STORE_UNAVAILABLE";
    constructor(operation, cause) {
        super(`Jev API key secure credential store unavailable during ${operation}. Configure or unlock the OS credential store and retry.`, { cause });
        this.operation = operation;
        this.name = "JevCredentialStoreError";
    }
}
function validateApiKey(value) {
    if (typeof value !== "string" || value.trim().length === 0 || /[\u0000-\u001f\u007f]/.test(value)) {
        throw new Error("Jev API key must be a non-empty string without control characters");
    }
    return value;
}
/**
 * Validates a configured endpoint. The endpoint is operator-supplied, so it is constrained to a single absolute
 * HTTPS URL without credentials, query, or fragment: that keeps the pinned-fetch check below exact-match, and
 * stops a stray value from redirecting requests or smuggling a query string.
 */
function parseEndpoint(raw, label) {
    if (typeof raw !== "string" || raw.trim().length === 0)
        throw new Error(`${label} must be a non-empty URL`);
    if (raw.length > MAX_ENDPOINT_LENGTH)
        throw new Error(`${label} must be at most ${MAX_ENDPOINT_LENGTH} characters`);
    if (/[\u0000-\u001f\u007f\s]/.test(raw))
        throw new Error(`${label} must not contain whitespace or control characters`);
    let url;
    try {
        url = new URL(raw);
    }
    catch {
        throw new Error(`${label} must be an absolute URL`);
    }
    if (url.protocol !== "https:")
        throw new Error(`${label} must use https`);
    if (url.username !== "" || url.password !== "")
        throw new Error(`${label} must not embed credentials`);
    if (url.search !== "")
        throw new Error(`${label} must not include a query string`);
    if (url.hash !== "")
        throw new Error(`${label} must not include a fragment`);
    if (url.pathname === "" || url.pathname === "/")
        throw new Error(`${label} must include a path such as ${JEV_SDK_PATH}`);
    return { href: `${url.origin}${url.pathname}`, origin: url.origin, path: url.pathname };
}
/**
 * Resolves the Jev endpoint. An invalid `SYSTEMONE_ENDPOINT` resolves to `unavailable` instead of silently falling
 * back to the default: sending an operator's judgment payload to a provider they did not ask for would be a data leak.
 */
export function resolveJevEndpoint(env = process.env) {
    if (Object.hasOwn(env, SYSTEMONE_ENDPOINT_ENV)) {
        try {
            return { status: "resolved", source: "environment", endpoint: parseEndpoint(env[SYSTEMONE_ENDPOINT_ENV], SYSTEMONE_ENDPOINT_ENV) };
        }
        catch (error) {
            return { status: "unavailable", message: error instanceof Error ? error.message : `${SYSTEMONE_ENDPOINT_ENV} is invalid.` };
        }
    }
    return { status: "resolved", source: "default", endpoint: parseEndpoint(JEV_DEFAULT_ENDPOINT, "the default Jev endpoint") };
}
export function defaultJevEndpoint() {
    return parseEndpoint(JEV_DEFAULT_ENDPOINT, "the default Jev endpoint");
}
/** Keyring account for an endpoint, so keys for different providers coexist instead of overwriting each other. */
export function jevKeyringAccount(endpoint) {
    return `systemone@sha256(${typeof endpoint === "string" ? endpoint : endpoint.href})`;
}
function store() {
    return createSecureKeyringStore(JEV_KEYRING_SERVICE);
}
function requireEndpoint(endpoint, env) {
    if (endpoint)
        return endpoint;
    const resolution = resolveJevEndpoint(env);
    if (resolution.status === "unavailable")
        throw new Error(resolution.message);
    return resolution.endpoint;
}
/**
 * Reads one stored credential. Version 1 records were written before the endpoint was configurable, so they are
 * accepted only for the default endpoint and only from the legacy account.
 */
function parseStoredKey(payload, endpoint) {
    let value;
    try {
        value = JSON.parse(payload);
    }
    catch {
        throw new Error("invalid record");
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("invalid record");
    const record = value;
    const keys = Object.keys(record);
    if (record.version === 2) {
        if (keys.length !== 3 || !["version", "endpoint", "apiKey"].every(key => Object.hasOwn(record, key)))
            throw new Error("invalid record fields");
        if (record.endpoint !== endpoint.href)
            throw new Error("invalid or mismatched record");
        return validateApiKey(record.apiKey);
    }
    if (record.version === 1) {
        if (keys.length !== 4 || !["version", "provider", "origin", "apiKey"].every(key => Object.hasOwn(record, key)))
            throw new Error("invalid record fields");
        if (record.provider !== "typesafe" || record.origin !== TYPESAFE_API_ORIGIN)
            throw new Error("invalid or mismatched record");
        if (endpoint.href !== JEV_DEFAULT_ENDPOINT)
            throw new Error("invalid or mismatched record");
        return validateApiKey(record.apiKey);
    }
    throw new Error("invalid record version");
}
function readStoredKey(secretStore, endpoint) {
    try {
        let payload = secretStore.read(jevKeyringAccount(endpoint));
        if (payload === undefined && endpoint.href === JEV_DEFAULT_ENDPOINT)
            payload = secretStore.read(JEV_KEYRING_ACCOUNT);
        return payload === undefined ? undefined : parseStoredKey(payload, endpoint);
    }
    catch (error) {
        throw new JevCredentialStoreError("read", error);
    }
}
export function resolveJevCredential(env = process.env, endpoint, secretStore = store()) {
    let target;
    if (endpoint)
        target = endpoint;
    else {
        const resolution = resolveJevEndpoint(env);
        if (resolution.status === "unavailable")
            return { status: "unavailable", message: resolution.message };
        target = resolution.endpoint;
    }
    if (Object.hasOwn(env, SYSTEMONE_API_KEY_ENV)) {
        try {
            return { status: "present", source: "environment", apiKey: validateApiKey(env[SYSTEMONE_API_KEY_ENV]) };
        }
        catch {
            return { status: "unavailable", message: `${SYSTEMONE_API_KEY_ENV} is present but invalid.` };
        }
    }
    if (Object.hasOwn(env, LEGACY_TYPESAFE_API_KEY_ENV)) {
        // The legacy name carries a TypeSafe-issued credential, so it is never sent to another provider.
        if (target.href !== JEV_DEFAULT_ENDPOINT) {
            return {
                status: "unavailable",
                message: `${LEGACY_TYPESAFE_API_KEY_ENV} is a TypeSafe credential and is not sent to ${target.href}; set ${SYSTEMONE_API_KEY_ENV} for that endpoint.`,
            };
        }
        try {
            return { status: "present", source: "environment", apiKey: validateApiKey(env[LEGACY_TYPESAFE_API_KEY_ENV]) };
        }
        catch {
            return { status: "unavailable", message: `${LEGACY_TYPESAFE_API_KEY_ENV} is present but invalid.` };
        }
    }
    try {
        const apiKey = readStoredKey(secretStore, target);
        return apiKey === undefined ? { status: "missing" } : { status: "present", source: "keyring", apiKey };
    }
    catch (error) {
        if (!(error instanceof JevCredentialStoreError))
            throw error;
        return { status: "unavailable", message: error.message };
    }
}
export function saveJevApiKey(apiKey, endpoint, secretStore = store()) {
    const target = requireEndpoint(endpoint, process.env);
    const record = { version: 2, endpoint: target.href, apiKey: validateApiKey(apiKey) };
    try {
        secretStore.write(jevKeyringAccount(target), JSON.stringify(record));
    }
    catch (error) {
        throw new JevCredentialStoreError("write", error);
    }
}
export function removeJevApiKey(endpoint, secretStore = store()) {
    const target = requireEndpoint(endpoint, process.env);
    try {
        secretStore.remove(jevKeyringAccount(target));
        if (target.href === JEV_DEFAULT_ENDPOINT)
            secretStore.remove(JEV_KEYRING_ACCOUNT);
    }
    catch (error) {
        throw new JevCredentialStoreError("remove", error);
    }
}
//# sourceMappingURL=jev-key-store.js.map