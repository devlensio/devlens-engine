import fs from "fs";
import path from "path";
import { CONFIG_DIR } from "./paths.js";
import { DEFAULT_PROVIDERS } from "./providers.default.js";
// ─── Paths ───────────────────────────────────────────────────────────────────
const USER_CATALOG_FILE = path.join(CONFIG_DIR, "providers.json");
// ─── Atomic write helper ─────────────────────────────────────────────────────
// Matches the existing pattern in writer.ts and fileStorage.ts.
function atomicWrite(filePath, content) {
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, content, "utf-8");
    fs.renameSync(tmp, filePath);
}
// ─── Validation ──────────────────────────────────────────────────────────────
const VALID_PROTOCOLS = new Set(["openai", "anthropic"]);
const RESERVED_NAMES = new Set(["__custom__"]);
function validateProvider(entry) {
    const { name, label, protocol, baseUrl, requiresKey } = entry;
    if (typeof name !== "string" || !/^[a-z0-9-]+$/.test(name) || name.length === 0) {
        throw new Error(`Invalid provider name: "${name}". Must be non-empty, lowercase alphanumeric with hyphens.`);
    }
    if (RESERVED_NAMES.has(name)) {
        throw new Error(`"${name}" is a reserved name and cannot be used as a provider name.`);
    }
    if (typeof label !== "string" || label.trim().length === 0) {
        throw new Error("Provider label is required and must be non-empty.");
    }
    if (!VALID_PROTOCOLS.has(protocol)) {
        throw new Error(`Protocol must be "openai" or "anthropic", got "${protocol}".`);
    }
    if (typeof baseUrl !== "string" || baseUrl.length === 0) {
        throw new Error("baseUrl is required.");
    }
    try {
        const parsed = new URL(baseUrl);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            throw new Error();
        }
    }
    catch {
        throw new Error(`baseUrl must be a valid http(s) URL, got "${baseUrl}".`);
    }
    if (typeof requiresKey !== "boolean") {
        throw new Error("requiresKey must be a boolean.");
    }
}
// ─── Read user file (unmerged, warn on malformed) ────────────────────────────
function readUserFile() {
    if (!fs.existsSync(USER_CATALOG_FILE))
        return [];
    try {
        const raw = fs.readFileSync(USER_CATALOG_FILE, "utf-8");
        const parsed = JSON.parse(raw);
        return parsed.providers ?? [];
    }
    catch {
        console.warn(`DevLens: ~/.devlens/providers.json contains invalid JSON. ` +
            `Treating it as empty.`);
        return [];
    }
}
// ─── Ensure CONFIG_DIR exists ───────────────────────────────────────────────
function ensureConfigDir() {
    if (!fs.existsSync(CONFIG_DIR)) {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
}
// ─── Public read API ─────────────────────────────────────────────────────────
export function loadCatalog() {
    const defaults = DEFAULT_PROVIDERS;
    const userProviders = readUserFile();
    if (userProviders.length === 0)
        return defaults;
    const merged = new Map();
    for (const p of defaults)
        merged.set(p.name, p);
    for (const p of userProviders) {
        merged.set(p.name, { ...p });
    }
    return [...merged.values()];
}
export function findProvider(name) {
    return loadCatalog().find(p => p.name === name);
}
/** Returns only the user's overrides (not merged with defaults). */
export function listUserProviders() {
    return readUserFile();
}
// ─── Public write API ────────────────────────────────────────────────────────
/**
 * Upsert a provider entry in the user's providers.json.
 * Validates the entry before writing. Returns the entry as written.
 * The user file only stores the override layer — never the merged result.
 */
export function saveProvider(entry) {
    validateProvider(entry);
    const existing = readUserFile();
    const idx = existing.findIndex(p => p.name === entry.name);
    const clean = { name: entry.name, label: entry.label, protocol: entry.protocol, baseUrl: entry.baseUrl, requiresKey: entry.requiresKey };
    if (idx >= 0) {
        existing[idx] = clean;
    }
    else {
        existing.push(clean);
    }
    ensureConfigDir();
    atomicWrite(USER_CATALOG_FILE, JSON.stringify({ version: 2, providers: existing }, null, 2));
    return clean;
}
/**
 * Remove a user override entry by name.
 * Returns true if an entry was removed, false if it wasn't present.
 * Only removes entries from the user file — default providers cannot be removed.
 */
export function removeProvider(name) {
    const existing = readUserFile();
    const idx = existing.findIndex(p => p.name === name);
    if (idx === -1)
        return false;
    existing.splice(idx, 1);
    ensureConfigDir();
    atomicWrite(USER_CATALOG_FILE, JSON.stringify({ version: 2, providers: existing }, null, 2));
    return true;
}
/** Delete the entire user providers.json — catalog reverts to shipped defaults. */
export function resetUserCatalog() {
    if (fs.existsSync(USER_CATALOG_FILE)) {
        fs.unlinkSync(USER_CATALOG_FILE);
    }
}
