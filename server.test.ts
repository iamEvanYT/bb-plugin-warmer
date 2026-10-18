import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakePluginHost, makeThreadResponse, experimental_scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.ts";

const thread = makeThreadResponse({ id: "t1", status: "idle", runtime: { displayStatus: "idle" } });

test("settings, RPC, CLI, events and reload preserve only the global settings", async (t) => {
  const responseAt = Date.now();
  const { bb, harness } = createFakePluginHost({
    pluginId: "warmer",
    sdk: { threads: {
      get: async () => thread,
      events: { list: async () => [{
        type: "turn/completed", createdAt: responseAt, data: { status: "completed" },
      }] },
    } },
  });
  t.after(() => harness.lifecycle.dispose());
  await plugin(bb);
  assert.deepEqual(await harness.behavior.callRpc("list", null), { enabledThreadIds: [] });
  await assert.rejects(harness.behavior.callRpc("setEnabled", { threadId: "t1", enabled: "yes" }));
  await assert.rejects(harness.behavior.setSettings({ intervalMinutes: 0 }));
  await assert.rejects(harness.behavior.setSettings({ intervalMinutes: Infinity }));
  await assert.rejects(harness.behavior.setSettings({ message: "   " }));
  await harness.behavior.setSettings({ intervalMinutes: 10, message: "test" });
  await harness.behavior.callRpc("setEnabled", { threadId: "t1", enabled: true });
  let result = await harness.behavior.runCli(["status", "t1"]);
  assert.deepEqual(JSON.parse(result.stdout!), {
    threadId: "t1", enabled: true, intervalMinutes: 10, message: "test",
    nextWarmAt: JSON.parse(result.stdout!).nextWarmAt, lastSentAt: null, error: null,
  });
  assert.equal((await harness.behavior.runCli(["unknown", "t1"])).exitCode, 1);
  await harness.behavior.emitThreadEvent("thread.archived", { thread: { ...thread, archivedAt: Date.now() } });
  assert.deepEqual(await harness.behavior.callRpc("list", null), { enabledThreadIds: [] });
  await harness.behavior.runCli(["on", "t1"]);
  await harness.lifecycle.reload(plugin);
  assert.deepEqual(await harness.behavior.callRpc("list", null), { enabledThreadIds: [] });
  result = await harness.behavior.runCli(["status", "t1"]);
  assert.equal(JSON.parse(result.stdout!).intervalMinutes, 10);
  assert.equal(JSON.parse(result.stdout!).enabled, false);
  const service = harness.behavior.runService("idle-watch");
  service.controller.abort();
  await service.done;
});

test("only public SDK imports", () => {
  const scan = experimental_scanPublicSdkOnly(import.meta.dirname, { allow: [/^react$/, /^sonner$/] });
  assert.deepEqual(scan.violations, []);
  assert.deepEqual(scan.privateDependencies, []);
});
