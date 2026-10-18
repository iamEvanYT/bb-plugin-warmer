import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { CHANGED, type WarmerSettings } from "./contract.ts";

type Thread = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["get"]>>;
type Entry = {
  idle: boolean;
  lastResponseAt: number | null;
  warmedResponseAt: number | null;
  retryAt: number;
  lastSentAt: number | null;
  error: string | null;
  revision: number;
};

function isIdle(thread: Thread) {
  return thread.status === "idle" && thread.runtime.displayStatus === "idle"
    && thread.queuedMessageCount === 0 && thread.activeBackgroundAgentCount === 0;
}

/** Opt-ins belong to this plugin generation, never persistent storage. */
export class SessionWarmer {
  private entries = new Map<string, Entry>();
  private disposed = false;
  private checking = false;

  private bb: BbPluginApi;
  private settings: WarmerSettings;

  constructor(bb: BbPluginApi, settings: WarmerSettings) {
    this.bb = bb;
    this.settings = settings;
  }

  updateSettings(settings: WarmerSettings) {
    this.settings = settings;
    for (const entry of this.entries.values()) entry.revision++;
    this.bb.realtime.publish(CHANGED, null);
  }

  enabledThreadIds() {
    return [...this.entries.keys()];
  }

  status(threadId: string) {
    const entry = this.entries.get(threadId);
    return {
      enabled: entry !== undefined,
      ...this.settings,
      nextWarmAt: entry?.idle
        && entry.lastResponseAt !== null
        && entry.lastResponseAt !== entry.warmedResponseAt
        ? Math.max(entry.lastResponseAt + this.settings.intervalMinutes * 60_000, entry.retryAt)
        : null,
      lastSentAt: entry?.lastSentAt ?? null,
      error: entry?.error ?? null,
    };
  }

  async setEnabled(threadId: string, enabled: boolean) {
    if (this.disposed) throw new Error("Session Warmer has stopped");
    if (!enabled) {
      this.remove(threadId);
      return { enabled: false };
    }
    if (this.entries.has(threadId)) return { enabled: true };
    const entry: Entry = {
      idle: false,
      lastResponseAt: null,
      warmedResponseAt: null,
      retryAt: 0,
      lastSentAt: null,
      error: null,
      revision: 0,
    };
    this.entries.set(threadId, entry);
    try {
      const thread = await this.bb.sdk.threads.get({ threadId });
      if (thread.archivedAt !== null || thread.deletedAt !== null) {
        throw new Error("Open an unarchived thread to use Session Warmer");
      }
      if (isIdle(thread)) {
        const lastResponseAt = await this.readLastResponseAt(threadId);
        if (this.entries.get(threadId) === entry && entry.revision === 0) {
          entry.lastResponseAt = lastResponseAt;
          entry.idle = true;
        }
      }
    } catch (cause) {
      if (this.entries.get(threadId) === entry) this.remove(threadId);
      throw cause;
    }
    if (this.disposed) return { enabled: false };
    this.changed(threadId);
    return { enabled: this.entries.has(threadId) };
  }

  observe(thread: Thread) {
    if (thread.archivedAt !== null || thread.deletedAt !== null) {
      this.remove(thread.id);
      return;
    }
    const entry = this.entries.get(thread.id);
    if (!entry) return;
    entry.revision++;
    this.setIdle(thread.id, entry, isIdle(thread));
  }

  interrupt(threadId: string) {
    const entry = this.entries.get(threadId);
    if (!entry) return;
    entry.revision++;
    this.setIdle(threadId, entry, false);
  }

  remove(threadId: string) {
    if (this.entries.delete(threadId)) this.changed(threadId);
  }

  dispose() {
    this.disposed = true;
    this.entries.clear();
  }

  private changed(threadId: string) {
    this.bb.realtime.publish(CHANGED, { threadId });
  }

  private setIdle(threadId: string, entry: Entry, idle: boolean) {
    if (idle === entry.idle) return;
    entry.idle = idle;
    this.changed(threadId);
  }

  private async readLastResponseAt(threadId: string) {
    const [response] = await this.bb.sdk.threads.events.list({
      threadId, types: ["turn/completed"], order: "desc", limit: "1",
    });
    return response?.type === "turn/completed" && response.data.status === "completed"
      ? response.createdAt : null;
  }

  /** Serialized polling also reconciles missed lifecycle events and stopped runtimes. */
  async tick() {
    if (this.disposed || this.checking) return;
    this.checking = true;
    try {
      for (const [threadId, entry] of this.entries) {
        const revision = entry.revision;
        const current = () => !this.disposed && this.entries.get(threadId) === entry
          && entry.revision === revision;
        try {
          const thread = await this.bb.sdk.threads.get({ threadId });
          if (!current()) continue;
          if (thread.archivedAt !== null || thread.deletedAt !== null) {
            this.remove(threadId);
            continue;
          }
          this.setIdle(threadId, entry, isIdle(thread));
          if (!entry.idle) continue;
          const lastResponseAt = await this.readLastResponseAt(threadId);
          if (!current()) continue;
          if (entry.lastResponseAt !== lastResponseAt) {
            entry.lastResponseAt = lastResponseAt;
            this.changed(threadId);
          }
          const dueAt = this.status(threadId).nextWarmAt;
          if (dueAt === null || Date.now() < dueAt) continue;
          const interactions = await this.bb.sdk.threads.interactions.list({ threadId });
          if (!current()) continue;
          if (interactions.length > 0) {
            this.setIdle(threadId, entry, false);
            continue;
          }
          // Keep delivery backoff separate from the actual response timestamp.
          entry.retryAt = Date.now() + this.settings.intervalMinutes * 60_000;
          this.setIdle(threadId, entry, false);
          const result = await this.bb.sdk.threads.send({
            threadId,
            mode: "start",
            input: [{ type: "text", text: this.settings.message, mentions: [] }],
          });
          // A keepalive is useful now, not as durable work queued for later.
          if (result.delivery === "queued") {
            await this.bb.sdk.threads.queuedMessages.delete({ threadId, queuedMessageId: result.queuedMessage.id });
          }
          if (this.disposed || this.entries.get(threadId) !== entry) continue;
          if (result.delivery === "sent") {
            entry.lastSentAt = Date.now();
            entry.warmedResponseAt = lastResponseAt;
            entry.retryAt = 0;
          }
          entry.error = result.delivery === "queued" ? "BB deferred the warm message; skipped this interval." : null;
          this.changed(threadId);
        } catch (cause) {
          if (!current()) continue;
          // Wait a full interval after failure, including uncertain delivery, to avoid duplicate sends.
          entry.retryAt = Date.now() + this.settings.intervalMinutes * 60_000;
          const error = cause instanceof Error ? cause.message : String(cause);
          if (error !== entry.error) this.bb.log.warn(`Session Warmer ${threadId}: ${error}`);
          entry.error = error;
          this.changed(threadId);
        }
      }
    } finally {
      this.checking = false;
    }
  }
}
