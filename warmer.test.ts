import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { DEFAULT_INTERVAL, DEFAULT_MESSAGE } from "./contract.ts";
import { SessionWarmer } from "./warmer.ts";

const minute = 60_000;
function setup(t: TestContext) {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  let thread = makeThreadResponse({ id: "t1", status: "idle", runtime: { displayStatus: "idle" } });
  let lastResponseAt: number | null = Date.now();
  let interactions: Awaited<ReturnType<typeof bb.sdk.threads.interactions.list>> = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "warmer",
    sdk: { threads: {
      get: async () => thread,
      events: { list: async () => lastResponseAt === null ? [] : [{
        type: "turn/completed", createdAt: lastResponseAt, data: { status: "completed" },
      }] },
      interactions: { list: async () => interactions },
      send: async () => ({ ok: true, delivery: "sent" }),
    } },
  });
  const warmer = new SessionWarmer(bb, { intervalMinutes: DEFAULT_INTERVAL, message: DEFAULT_MESSAGE });
  t.after(async () => { warmer.dispose(); await harness.lifecycle.dispose(); });
  return {
    bb, harness, warmer,
    advance: (minutes: number) => t.mock.timers.tick(minutes * minute),
    sent: () => harness.inspection.sdk.callsTo("threads.send"),
    setLastResponseAt: (at: number | null) => { lastResponseAt = at; },
    setThread: (overrides: Partial<typeof thread>) => {
      if (overrides.status === "idle" && thread.status !== "idle") lastResponseAt = Date.now();
      thread = { ...thread, ...overrides };
      warmer.observe(thread);
    },
    block: (blocked: boolean) => { interactions = blocked ? [{}] as typeof interactions : []; },
  };
}

test("opt-in, exact default interval/message, repeated idle turns, and thread isolation", async (t) => {
  const s = setup(t);
  await s.warmer.tick();
  assert.equal(s.harness.inspection.sdk.calls.length, 0);
  assert.equal(s.warmer.status("t2").enabled, false);
  await s.warmer.setEnabled("t1", true);
  s.advance(54.99);
  await s.warmer.tick();
  assert.equal(s.sent().length, 0);
  s.advance(0.01);
  await s.warmer.tick();
  assert.equal(s.sent().length, 1);
  assert.deepEqual(s.sent()[0], [{
    threadId: "t1", mode: "start",
    input: [{ type: "text", text: DEFAULT_MESSAGE, mentions: [] }],
  }]);
  s.setThread({ status: "active", runtime: { displayStatus: "active" } });
  s.advance(10);
  s.setThread({ status: "idle", runtime: { displayStatus: "idle" } });
  s.advance(54);
  await s.warmer.tick();
  assert.equal(s.sent().length, 1);
  s.advance(1);
  await s.warmer.tick();
  assert.equal(s.sent().length, 2);
});

test("a new completed response starts the next interval", async (t) => {
  const s = setup(t);
  await s.warmer.setEnabled("t1", true);
  s.advance(54);
  s.setThread({ status: "active", runtime: { displayStatus: "active" } });
  s.advance(60);
  await s.warmer.tick();
  assert.equal(s.sent().length, 0);
  s.setThread({ status: "idle", runtime: { displayStatus: "idle" } });
  s.advance(54);
  await s.warmer.tick();
  assert.equal(s.sent().length, 0);
  s.advance(1);
  await s.warmer.tick();
  assert.equal(s.sent().length, 1);
});

for (const [name, overrides] of Object.entries({
  pending: { status: "pending" as const },
  failed: { status: "error" as const },
  offline: { runtime: { displayStatus: "waiting-for-host" as const } },
  queued: { queuedMessageCount: 1 },
  background: { activeBackgroundAgentCount: 1 },
})) {
  test(`${name} threads do not receive warm messages`, async (t) => {
    const s = setup(t);
    await s.warmer.setEnabled("t1", true);
    s.advance(55);
    s.setThread(overrides);
    await s.warmer.tick();
    assert.equal(s.sent().length, 0);
    assert.equal(s.warmer.status("t1").nextWarmAt, null);
  });
}

test("resolving a pending interaction does not reset elapsed time since the response", async (t) => {
  const s = setup(t);
  await s.warmer.setEnabled("t1", true);
  s.block(true);
  s.advance(55);
  await s.warmer.tick();
  assert.equal(s.sent().length, 0);
  s.block(false);
  await s.warmer.tick();
  assert.equal(s.sent().length, 1);
});

test("settings update existing opt-ins without reloading or losing idle time", async (t) => {
  const s = setup(t);
  await s.warmer.setEnabled("t1", true);
  s.advance(30);
  s.warmer.updateSettings({ intervalMinutes: 31, message: "custom message" });
  await s.warmer.tick();
  assert.equal(s.sent().length, 0);
  s.advance(1);
  await s.warmer.tick();
  assert.equal(s.sent().length, 1);
  assert.equal((s.sent()[0][0] as { input: { text: string }[] }).input[0].text, "custom message");
});

test("failed delivery retries only after a full interval", async (t) => {
  const s = setup(t);
  s.harness.inspection.sdk.stub("threads.send", async () => { throw new Error("offline"); });
  await s.warmer.setEnabled("t1", true);
  s.advance(55);
  await s.warmer.tick();
  assert.equal(s.warmer.status("t1").error, "offline");
  s.advance(54);
  await s.warmer.tick();
  assert.equal(s.sent().length, 1);
  s.advance(1);
  await s.warmer.tick();
  assert.equal(s.sent().length, 2);
});

for (const action of ["off", "archive", "delete", "dispose"] as const) {
  test(`${action} clears the opt-in and prevents delivery`, async (t) => {
    const s = setup(t);
    await s.warmer.setEnabled("t1", true);
    s.advance(55);
    if (action === "off") await s.warmer.setEnabled("t1", false);
    if (action === "archive") s.setThread({ archivedAt: Date.now() });
    if (action === "delete") s.setThread({ deletedAt: Date.now() });
    if (action === "dispose") s.warmer.dispose();
    await s.warmer.tick();
    assert.deepEqual(s.warmer.enabledThreadIds(), []);
    assert.equal(s.sent().length, 0);
  });
}

test("disable or new activity during a due check prevents stale delivery", async (t) => {
  const s = setup(t);
  await s.warmer.setEnabled("t1", true);
  s.advance(55);
  let release!: (thread: ReturnType<typeof makeThreadResponse>) => void;
  s.harness.inspection.sdk.stub("threads.get", () => new Promise((resolve) => { release = resolve; }));
  const check = s.warmer.tick();
  s.warmer.interrupt("t1");
  release(makeThreadResponse({ id: "t1", status: "idle", runtime: { displayStatus: "idle" } }));
  await check;
  assert.equal(s.sent().length, 0);
  const next = s.warmer.tick();
  await s.warmer.setEnabled("t1", false);
  release(makeThreadResponse({ id: "t1", status: "idle", runtime: { displayStatus: "idle" } }));
  await next;
  assert.equal(s.sent().length, 0);
});

test("a deferred warm message is cancelled rather than left as persistent queued work", async (t) => {
  const s = setup(t);
  s.harness.inspection.sdk.stub("threads.send", async () => ({
    ok: true, delivery: "queued", queuedMessage: { id: "warm-queue" },
  }));
  s.harness.inspection.sdk.stub("threads.queuedMessages.delete", async () => ({ ok: true }));
  await s.warmer.setEnabled("t1", true);
  s.advance(55);
  await s.warmer.tick();
  assert.deepEqual(s.harness.inspection.sdk.callsTo("threads.queuedMessages.delete"), [[{
    threadId: "t1", queuedMessageId: "warm-queue",
  }]]);
  assert.equal(s.warmer.status("t1").lastSentAt, null);
});

test("settings changes during a due check prevent delivery on the old interval", async (t) => {
  const s = setup(t);
  await s.warmer.setEnabled("t1", true);
  s.advance(55);
  let release!: () => void;
  let entered!: () => void;
  const pending = new Promise<void>((resolve) => { entered = resolve; });
  s.harness.inspection.sdk.stub("threads.interactions.list", () => new Promise((resolve) => {
    release = () => resolve([]);
    entered();
  }));
  const check = s.warmer.tick();
  await pending;
  s.warmer.updateSettings({ intervalMinutes: 60, message: DEFAULT_MESSAGE });
  release();
  await check;
  assert.equal(s.sent().length, 0);
});

test("enabling after the interval elapsed warms on the next check, not another interval later", async (t) => {
  const s = setup(t);
  s.warmer.updateSettings({ intervalMinutes: 2, message: DEFAULT_MESSAGE });
  const responseAt = Date.now();
  s.advance(3);
  await s.warmer.setEnabled("t1", true);
  assert.equal(s.warmer.status("t1").nextWarmAt, responseAt + 2 * minute);
  await s.warmer.tick();
  assert.equal(s.sent().length, 1);
  // Until a new response arrives, do not warm the same response twice.
  s.advance(3);
  await s.warmer.tick();
  assert.equal(s.sent().length, 1);
  s.setLastResponseAt(Date.now());
  await s.warmer.tick();
  s.advance(2);
  await s.warmer.tick();
  assert.equal(s.sent().length, 2);
});

test("enabling partway through an idle interval retains elapsed response time", async (t) => {
  const s = setup(t);
  s.warmer.updateSettings({ intervalMinutes: 2, message: DEFAULT_MESSAGE });
  s.advance(1.5);
  await s.warmer.setEnabled("t1", true);
  await s.warmer.tick();
  assert.equal(s.sent().length, 0);
  s.advance(0.5);
  await s.warmer.tick();
  assert.equal(s.sent().length, 1);
});

test("a delayed idle notification uses response history rather than notification time", async (t) => {
  const s = setup(t);
  s.warmer.updateSettings({ intervalMinutes: 2, message: DEFAULT_MESSAGE });
  await s.warmer.setEnabled("t1", true);
  s.setThread({ status: "active", runtime: { displayStatus: "active" } });
  s.advance(1);
  const responseAt = Date.now();
  s.advance(1.5);
  s.setThread({ status: "idle", runtime: { displayStatus: "idle" } });
  s.setLastResponseAt(responseAt);
  await s.warmer.tick();
  assert.equal(s.warmer.status("t1").nextWarmAt, responseAt + 2 * minute);
  assert.equal(s.sent().length, 0);
  s.advance(0.5);
  await s.warmer.tick();
  assert.equal(s.sent().length, 1);
});

test("thread metadata updates do not postpone the response deadline", async (t) => {
  const s = setup(t);
  s.warmer.updateSettings({ intervalMinutes: 2, message: DEFAULT_MESSAGE });
  await s.warmer.setEnabled("t1", true);
  s.advance(1.5);
  s.setThread({ title: "Renamed", updatedAt: Date.now() });
  s.advance(0.5);
  await s.warmer.tick();
  assert.equal(s.sent().length, 1);
});

test("threads without a completed response are not warmed", async (t) => {
  const s = setup(t);
  s.setLastResponseAt(null);
  await s.warmer.setEnabled("t1", true);
  s.advance(100);
  await s.warmer.tick();
  assert.equal(s.warmer.status("t1").nextWarmAt, null);
  assert.equal(s.sent().length, 0);
});
