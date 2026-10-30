import { cliCommand, type PluginCliCommand } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { ThreadHoldings } from "./guards.ts";
import { input, parseInput, print } from "./release/cli.ts";

const threadInput = z.object({ threadId: z.string().trim().min(1).max(128) }).strict();

export function threadCommands(guard: {
  holdings: (threadId: string) => Promise<ThreadHoldings>;
  archive: (threadId: string) => Promise<{ archivedThreadIds: string[] }>;
}): Record<string, PluginCliCommand> {
  return {
    "thread check": cliCommand({
      summary:
        "What archiving {threadId} would orphan: open tasks attached to it or its children, and open tasks of lanes they own. Blocked exits 1.",
      options: input,
      async run({ options }) {
        const { threadId } = threadInput.parse(parseInput(options.input));
        const holdings = await guard.holdings(threadId);
        return print({ kind: "thread_check", holdings }, holdings.blocked ? 1 : 0);
      },
    }),
    "thread archive": cliCommand({
      summary:
        "Archive {threadId} and its children only when none holds open tasks or owns a lane with open tasks; otherwise refuse with exit 1. Move, finish or detach the tasks first.",
      options: input,
      async run({ options }) {
        const { threadId } = threadInput.parse(parseInput(options.input));
        const holdings = await guard.holdings(threadId);
        if (holdings.blocked)
          return print({ kind: "thread_archive", outcome: "refused", holdings }, 1);
        const { archivedThreadIds } = await guard.archive(threadId);
        return print({ kind: "thread_archive", outcome: "archived", archivedThreadIds, holdings });
      },
    }),
  };
}
