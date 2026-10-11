// Release-owned presentation wrapper around the original, verified adapter.
// No adapter sources, host internals or execution paths are replaced here.
import { readOsAdapterConfig } from "./shared/os-adapter-config.ts";
import { decorateCctTool } from "./shared/os-cct-send-renderer.ts";

export function wrapOsAdapterApi<T extends object>(pi: T): T {
  return new Proxy(pi, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key === "registerTool" && typeof value === "function") {
        return (tool: Parameters<typeof decorateCctTool>[0], ...rest: unknown[]) =>
          Reflect.apply(value, target, [decorateCctTool(tool), ...rest]);
      }
      // Methods must keep the real API receiver (including extracted methods).
      // Nonfunction objects, notably the shared event bus, retain identity.
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export default async function osMcpExtension(pi: object): Promise<void> {
  const { adapterPath } = readOsAdapterConfig();
  // Keep this ordinary dynamic import inside the extension: the host's Jiti
  // loader rewrites it using its pi/typebox aliases, also for adapter children.
  // Native import indirection/new loaders would bypass that host module graph.
  const adapter = await import(adapterPath);
  if (typeof adapter.default !== "function") throw new Error("CCT os adapter has no default factory");
  // Public API limitation: registrations have this wrapper's sourceInfo.
  // There is no public API to impersonate the original adapter's provenance.
  await adapter.default(wrapOsAdapterApi(pi));
}
