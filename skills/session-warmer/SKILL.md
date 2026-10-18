---
name: session-warmer
description: Turn Session Warmer on or off for a BB thread, inspect its state, or adjust its global interval and warm message.
---

# Session Warmer

Only enable warming when the user explicitly asks. Never enable it automatically for a new, forked, or child thread.

The thread actions menu contains **Turn on Session Warmer** or **Turn off Session Warmer**. The same action is available from the thread header and sidebar.

```sh
bb warmer on [thread-id]
bb warmer off [thread-id]
bb warmer status [thread-id]
```

An omitted thread id uses the invoking thread. These commands return JSON. `status` reports whether warming is enabled, the current settings, next due time when idle, last sent time, and any delivery error.

Interval and message are global plugin settings in Settings → Plugins → Session Warmer. They apply immediately to every opted-in thread. CLI equivalents:

```sh
bb plugin config warmer set intervalMinutes 55
bb plugin config warmer set message "Say 'ok' and nothing else."
```

The interval accepts 1–10,080 minutes, including fractions. The default is 55 minutes. Messages must contain non-whitespace text and be at most 8,000 characters.

Opt-ins are in memory only. Reloading, disabling, or restarting the plugin or BB clears them. Archiving or deleting a thread also clears its opt-in. Global settings persist. Warming uses the thread's current provider/model and sends an ordinary message when the interval since the latest completed response has elapsed. Idle time before enabling counts; an overdue idle thread is warmed on the next five-second check. Busy threads, pending interactions, queued work, and background agents block sending without resetting the response timestamp. Threads with no completed response are not warmed.
