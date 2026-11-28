import { createContext, useContext, useSyncExternalStore } from "react";
import { type IconName, iconInner } from "../../lib/icons.ts";
import type { AgentState, AgentStore } from "./store.ts";

/** The chat's store for its components, and the console's line icons drawn in React. */

export const StoreContext = createContext<AgentStore | null>(null);

export function useStore(): AgentStore {
  const store = useContext(StoreContext);
  if (!store) throw new Error("The Agent chat's store is missing.");
  return store;
}

/** A slice of the state; the component renders again only when that slice changes. */
export function useAgent<T>(selector: (state: AgentState) => T): T {
  const store = useStore();
  const read = () => selector(store.state);
  return useSyncExternalStore(store.subscribe, read, read);
}

export function Icon({
  name,
  label,
  size = 16,
}: {
  name: IconName;
  label?: string;
  size?: number;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={label ? undefined : "true"}
      role={label ? "img" : undefined}
      aria-label={label}
      focusable="false"
      // The icon set is the console's own fixed markup (lib/icons.ts), never text from outside.
      // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted, built-in SVG paths.
      dangerouslySetInnerHTML={{ __html: iconInner(name) }}
    />
  );
}

/** A path inside this workspace's console ("/acme/dashboard/settings/…"). */
export function workspacePath(workspace: string, path: string): string {
  if (path.startsWith(`/${workspace}/`)) return path;
  return `/${workspace}${path.startsWith("/") ? path : `/${path}`}`;
}
