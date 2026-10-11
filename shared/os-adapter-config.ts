import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface OsAdapterConfig {
  version: 1;
  /** The exact global settings entry to restore, not a normalized replacement. */
  adapterEntry: string;
  /** Verified, canonical original factory; never CCT's wrapper. */
  adapterPath: string;
}

const CCT_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const OWN_ENTRIES = ["os-mcp-extension.ts", "os-extension.ts", "os-inbox-extension.ts"]
  .map((name) => join(CCT_DIR, name));
const ADAPTER_NAME = "pi-mcp-adapter";
const ADAPTER_VERSION = "2.33.0";

/** Match os getAgentDir(), including per-profile tilde and file URL paths. */
export function resolveOsAgentDir(): string {
  const configured = process.env.OS_CODING_AGENT_DIR;
  if (!configured) return join(homedir(), ".os", "agent");
  return resolveOsExtensionPath(configured, process.cwd());
}

/** Deliberately outside extensions/: this JSON is state, not an extension. */
export function osAdapterConfigPath(): string {
  return join(resolveOsAgentDir(), "cct-adapter.json");
}

export function resolveOsExtensionPath(entry: string, baseDir = resolveOsAgentDir()): string {
  if (entry === "~") return homedir();
  if (entry.startsWith("~/")) return resolve(homedir(), entry.slice(2));
  if (entry.startsWith("file://")) return fileURLToPath(entry);
  return resolve(baseDir, entry);
}

export function isOwnedOsExtension(entry: unknown, ownedPath: string, baseDir = resolveOsAgentDir()): boolean {
  if (typeof entry !== "string") return false;
  try {
    const candidate = resolveOsExtensionPath(entry, baseDir);
    if (candidate === ownedPath) return true;
    return realpathSync(candidate) === realpathSync(ownedPath);
  } catch {
    return false;
  }
}

/** Identify known unsupported activations too, without claiming arbitrary index.ts files. */
export function isKnownOsAdapterEntry(entry: string, baseDir = resolveOsAgentDir()): boolean {
  if (/(?:^|[/:\\])pi-mcp-adapter(?:@[^/\\]*|-\d[^/\\]*)?(?:[/\\]|$)/.test(entry)) return true;
  try {
    let path = realpathSync(resolveOsExtensionPath(entry, baseDir));
    if (!statSync(path).isDirectory()) path = dirname(path);
    for (;;) {
      try {
        const pkg = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
        // The nearest package owns this entry; a dependency is not its parent.
        return pkg?.name === ADAPTER_NAME;
      } catch (error: any) {
        if (error.code !== "ENOENT") return false;
      }
      const parent = dirname(path);
      if (parent === path) return false;
      path = parent;
    }
  } catch {
    return false;
  }
}

/** Verify the supported package's original index.ts; no imports or third-party writes. */
export function verifyOsAdapterEntry(entry: string, baseDir = resolveOsAgentDir()): string {
  if (typeof entry !== "string" || !entry.trim()) throw new Error("Expected a non-empty adapter entry string");
  if (OWN_ENTRIES.some((owned) => isOwnedOsExtension(entry, owned, baseDir))) {
    throw new Error("Adapter original cannot be a CCT extension or wrapper (self-loop)");
  }
  const original = realpathSync(resolveOsExtensionPath(entry, baseDir));
  const directory = statSync(original).isDirectory();
  const factory = realpathSync(directory ? join(original, "index.ts") : original);
  if (OWN_ENTRIES.some((owned) => isOwnedOsExtension(factory, owned, baseDir))) {
    throw new Error("Adapter original cannot be a CCT extension or wrapper (self-loop)");
  }
  if (!statSync(factory).isFile() || basename(factory) !== "index.ts" || (directory && dirname(factory) !== original)) {
    throw new Error("Adapter must be the original package index.ts or its directory");
  }
  const pkg = JSON.parse(readFileSync(join(dirname(factory), "package.json"), "utf8"));
  if (pkg?.name !== ADAPTER_NAME || pkg?.version !== ADAPTER_VERSION) {
    throw new Error(`Only ${ADAPTER_NAME}@${ADAPTER_VERSION} original index.ts is supported`);
  }
  // A directory manifest loading other factories cannot be replaced by this one.
  const entries = pkg.pi?.extensions;
  if (directory && Array.isArray(entries) && entries.length
      && (entries.length !== 1 || typeof entries[0] !== "string"
          || realpathSync(resolve(original, entries[0])) !== factory)) {
    throw new Error("Adapter directory must resolve only its original index.ts factory");
  }
  return factory;
}

export function validateOsAdapterConfig(value: unknown): OsAdapterConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an adapter config object");
  const config = value as Partial<OsAdapterConfig>;
  if (config.version !== 1 || typeof config.adapterEntry !== "string" || !config.adapterEntry.trim()
      || typeof config.adapterPath !== "string" || !config.adapterPath.trim() || !isAbsolute(config.adapterPath)) {
    throw new Error("Expected version: 1 and non-empty adapterEntry/absolute adapterPath strings");
  }
  const adapterPath = verifyOsAdapterEntry(config.adapterEntry);
  if (config.adapterPath !== adapterPath || verifyOsAdapterEntry(config.adapterPath) !== adapterPath) {
    throw new Error("Saved adapterPath must match the original factory's canonical realpath");
  }
  return { version: 1, adapterEntry: config.adapterEntry, adapterPath };
}

/** Fail closed: a missing, malformed, stale or recursive factory cannot be activated. */
export function readOsAdapterConfig(): OsAdapterConfig {
  const path = osAdapterConfigPath();
  try {
    return validateOsAdapterConfig(JSON.parse(readFileSync(path, "utf8")));
  } catch (error: any) {
    throw new Error(`Invalid CCT adapter state ${path}: ${error.message}`);
  }
}
