import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const DEFAULT_INTERVAL = 55;
export const DEFAULT_MESSAGE = "Say 'ok' and nothing else.";
export const CHANGED = "warmer-changed";
export const intervalSchema = z.number().finite().min(1).max(10_080);
export const messageSchema = z.string().min(1).max(8_000)
  .refine((text) => text.trim().length > 0, "Enter a message");
export type WarmerSettings = { intervalMinutes: number; message: string };

export const rpcContract = defineRpcContract({
  list: {
    input: z.null(),
    output: z.object({ enabledThreadIds: z.array(z.string()) }),
  },
  setEnabled: {
    input: z.object({ threadId: z.string().min(1).max(200), enabled: z.boolean() }).strict(),
    output: z.object({ enabled: z.boolean() }),
  },
});
