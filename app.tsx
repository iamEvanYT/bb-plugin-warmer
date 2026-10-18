import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  definePluginApp,
  experimental_THREAD_ACTION_GROUPS,
  experimental_Icon as Icon,
  type PluginContentScriptContext,
  type PluginThreadHeaderActionProps,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./contract.ts";

// Bound by the content-script lifecycle before the host mounts our slots.
let setThreadRowStatus: PluginContentScriptContext["experimental_setThreadRowStatus"];
function useWarmer() {
  const rpc = useRpc<typeof rpcContract>();
  const connection = useRealtimeConnectionState();
  const [enabled, setEnabled] = useState<Set<string> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(new Set<string>());
  const generation = useRef(0);
  const refetch = useCallback(() => {
    const request = ++generation.current;
    rpc.call("list").then((result) => {
      if (request !== generation.current) return;
      setEnabled(new Set(result.enabledThreadIds));
      setError(null);
    }, (cause: unknown) => {
      if (request !== generation.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  }, [rpc]);
  useEffect(() => {
    refetch();
    return () => { generation.current++; };
  }, [refetch, connection]);
  useRealtime("warmer-changed", refetch);

  return {
    enabled, error,
    toggle: async (threadId: string, next: boolean) => {
      if (pending.current.has(threadId)) return;
      pending.current.add(threadId);
      try {
        await rpc.call("setEnabled", { threadId, enabled: next });
        refetch();
      } catch (cause) {
        toast.error(cause instanceof Error ? cause.message : String(cause));
      } finally {
        pending.current.delete(threadId);
      }
    },
  };
}

// The host mounts this once for the menu registration, not once per sidebar row.
function useWarmerMenu() {
  const data = useWarmer();
  useEffect(() => {
    const setStatus = setThreadRowStatus;
    if (!setStatus || !data.enabled) return;
    const ids = data.enabled;
    for (const id of ids) setStatus(id, { icon: "Coffee", label: "Session Warmer is on" });
    return () => {
      for (const id of ids) setStatus(id, null);
    };
  }, [data.enabled]);
  return data;
}

function WarmerIndicator({ threadId, isCompactViewport }: PluginThreadHeaderActionProps) {
  const { enabled, error } = useWarmer();
  if (error || !enabled?.has(threadId)) return null;
  return (
    <span
      role="status"
      aria-label="Session Warmer is on"
      title="Session Warmer is on"
      className="inline-flex h-7 items-center gap-1.5 rounded-md bg-muted px-2 text-xs text-muted-foreground"
    >
      <Icon name="Coffee" className="size-3.5" aria-hidden="true" />
      <span className={isCompactViewport ? "sr-only" : undefined}>Warmer on</span>
    </span>
  );
}

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "warmer-row-status",
    mount({ experimental_setThreadRowStatus }) {
      setThreadRowStatus = experimental_setThreadRowStatus;
      // BB also clears this generation's row statuses on deactivation.
      return () => { setThreadRowStatus = undefined; };
    },
  });
  app.slots.experimental_threadHeaderAction({
    id: "warmer-indicator",
    title: "Session Warmer",
    component: WarmerIndicator,
  });
  app.slots.experimental_threadAction({
    id: "session-warmer",
    title: "Session Warmer",
    icon: "Coffee",
    group: experimental_THREAD_ACTION_GROUPS.state,
    order: 50,
    useData: useWarmerMenu,
    item: ({ thread, data }) => {
      if (thread.archivedAt !== null) return null;
      const enabled = data.enabled?.has(thread.id) ?? false;
      return {
        label: enabled ? "Turn off Session Warmer" : "Turn on Session Warmer",
        icon: "Coffee",
        disabled: data.enabled === null || data.error !== null,
        run: () => data.toggle(thread.id, !enabled),
      };
    },
  });
});
