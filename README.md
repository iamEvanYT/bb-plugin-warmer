# Session Warmer

Keep selected BB threads warm by sending a short message after they have been idle. Every thread starts with warming off.

## Use

1. Open **Settings → Plugins → Session Warmer** to set the idle interval and message. Defaults are **55 minutes** and **Say 'ok' and nothing else.**
2. Open a thread's actions menu in its header or sidebar and choose **Turn on Session Warmer**.
3. While enabled, a **Warmer on** label appears in the thread header and a steaming-cup status icon appears on its sidebar row.
4. Use the same menu to turn it off. You can also add the action to your sidebar quick actions through BB's Customize actions menu.

Settings apply immediately to all opted-in threads. The interval accepts 1–10,080 minutes, including fractions. The message can contain up to 8,000 characters.

Thread opt-ins are held in memory. A BB restart, plugin reload, or plugin disable clears them. Archiving or deleting a thread clears its opt-in too. Closing a browser tab does not. Interval and message settings persist through BB's settings system.

## Behavior

The interval is measured from the latest completed response in the thread history. Enabling warming counts time the thread was already idle. If the interval has already elapsed, a warm message is sent on the next check.

Active work, queued messages, pending interactions, background agents, and unavailable runtimes block sending without resetting that response timestamp. A new completed response starts the next interval. Threads with no completed response are not warmed.

Warm messages use the thread's existing provider, model, and execution settings. They appear as ordinary messages in the conversation.

A single background service checks opted-in threads every five seconds. There are no persistent schedules or per-thread metadata writes. Missed checks, including machine sleep, produce at most one warm message on resumption. Failed delivery waits another full interval before retrying. If BB queues a warm message instead of sending it immediately, the plugin cancels that queued message. Provider cache retention depends on the provider; this plugin sends messages and does not configure provider caching.

## CLI

```sh
bb warmer on [thread-id]
bb warmer off [thread-id]
bb warmer status [thread-id]
bb plugin config warmer set intervalMinutes 55
bb plugin config warmer set message "Say 'ok' and nothing else."
```

Omitting the thread ID uses the invoking thread. The `warmer` commands return JSON.

## Development

```sh
npm ci
npm test
npm run typecheck
bb plugin build
bb plugin install . --yes
bb plugin dev
```

The SDK is pinned to the running BB contract. Run `bb plugin types --check` to check it, or `bb plugin types` to sync after upgrading BB. Tests use Node's built-in test runner with TypeScript stripping, requiring Node 22.18 or newer.

- `server.ts` registers settings, RPC, CLI, lifecycle events, and the background service.
- `warmer.ts` owns ephemeral opt-ins and idle/delivery rules.
- `contract.ts` shares validated settings and RPC contracts.
- `app.tsx` contributes the native thread action and subscribes to state changes.
