import { setTimeout } from "node:timers/promises";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { DEFAULT_INTERVAL, DEFAULT_MESSAGE, intervalSchema, messageSchema, rpcContract } from "./contract.ts";
import { SessionWarmer } from "./warmer.ts";

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    intervalMinutes: {
      type: "number",
      label: "Idle interval (minutes)",
      description: "Send a warm message after this much idle time. Between 1 minute and 7 days.",
      default: DEFAULT_INTERVAL,
      experimental_schema: intervalSchema,
    },
    message: {
      type: "string",
      label: "Warm message",
      description: "Sent to the thread using its current provider and model.",
      default: DEFAULT_MESSAGE,
      experimental_multiline: true,
      experimental_schema: messageSchema,
    },
  });
  const warmer = new SessionWarmer(bb, await settings.get());
  settings.onChange((next) => warmer.updateSettings(next));
  bb.rpc.register(rpcContract, {
    list: () => ({ enabledThreadIds: warmer.enabledThreadIds() }),
    setEnabled: ({ threadId, enabled }) => warmer.setEnabled(threadId, enabled),
  });
  for (const event of ["thread.active", "thread.idle", "thread.failed", "experimental_thread.events"] as const) {
    bb.events.on(event, ({ thread }) => warmer.observe(thread));
  }
  for (const event of ["thread.archived", "thread.deleted"] as const) {
    bb.events.on(event, ({ thread }) => warmer.remove(thread.id));
  }
  bb.events.on("interaction.pending", ({ thread }) => warmer.interrupt(thread.id));
  bb.events.on("message.queued", ({ entry }) => warmer.interrupt(entry.threadId));
  bb.onDispose(() => warmer.dispose());
  bb.background.service("idle-watch", {
    async start(signal) {
      try {
        while (!signal.aborted) {
          await setTimeout(5_000, undefined, { signal });
          if (!signal.aborted) await warmer.tick();
        }
      } catch (cause) {
        if (!signal.aborted) throw cause;
      }
    },
  });

  const usage = "bb warmer <on|off|status> [thread-id]";
  bb.cli.register({
    name: "warmer",
    summary: "Turn Session Warmer on or off for one thread, in memory only",
    commands: [
      { name: "on", summary: "Enable warming for this thread", usage: "bb warmer on [thread-id]" },
      { name: "off", summary: "Disable warming for this thread", usage: "bb warmer off [thread-id]" },
      { name: "status", summary: "Show warming state and current settings", usage: "bb warmer status [thread-id]" },
    ],
    async run(argv, context) {
      if (argv.length === 0 || argv[0] === "--help") return { exitCode: 0, stdout: usage };
      const [command, explicitId] = argv;
      const threadId = explicitId ?? context.threadId;
      if (!threadId || argv.length > 2 || !["on", "off", "status"].includes(command)) {
        return { exitCode: 1, stderr: usage };
      }
      try {
        if (command !== "status") await warmer.setEnabled(threadId, command === "on");
        return { exitCode: 0, stdout: JSON.stringify({ threadId, ...warmer.status(threadId) }, null, 2) };
      } catch (cause) {
        return { exitCode: 1, stderr: cause instanceof Error ? cause.message : String(cause) };
      }
    },
  });
}
