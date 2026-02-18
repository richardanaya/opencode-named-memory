// ~/.config/opencode/plugins/opencode-named-memory.ts
import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { createAgentMemory, type MemoryEntry } from "fastmemory";
import * as path from "path";
import * as os from "os";

export const OpencodeNamedMemoryPlugin: Plugin = async (ctx) => {
  const { client } = ctx;   // full ctx stays in scope for tools + hooks

  const pluginConfig = ((ctx as any).config?.["opencode-named-memory"] || {}) as any;
  const importanceThreshold = pluginConfig.importanceThreshold ?? 0.009;
  const noveltyThreshold = pluginConfig.noveltyThreshold ?? 0.87;
  const maxMemories = pluginConfig.maxMemories ?? 7;

  let activeMemory: Awaited<ReturnType<typeof createAgentMemory>> | null = null;
  let activeName: string | null = null;
  let activeShouldCreate: ((content: string) => Promise<boolean>) | null = null;
  let dbDir: string | null = null;

  // ── Official OpenCode config path (exact StatusPlugin pattern) ──
  async function getDbDir(): Promise<string> {
    if (dbDir) return dbDir;

    try {
      const result = await client.path.get();
      if (!result.data) {
        throw new Error("Failed to get config path from client");
      }
      dbDir = path.join(result.data.config, "named-memory");
    } catch (err) {
      console.warn("[opencode-named-memory] Could not get official config path, using fallback");
      dbDir = path.join(os.homedir(), ".config", "opencode", "named-memory");
    }
    return dbDir;
  }

  // Helper: sanitize name → safe filename
  function sanitizeName(raw: string): string {
    return raw
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "default";
  }

  // ── TOOL: Activate/switch named memory ──
  const namedMemoryUse = tool({
    description: "Activate (or switch to) a named memory store for the opencode-named-memory plugin. REQUIRED before any other memory tools work.",
    args: {
      name: tool.schema.string().describe("Memory name, e.g. 'richard', 'work', 'personal-project' (auto-lowercased)"),
    },
    async execute(args) {
      try {
        const dir = await getDbDir();
        await ctx.$`mkdir -p ${dir}`;   // ← now ctx is correctly in scope

        const name = sanitizeName(args.name);
        const dbPath = path.join(dir, `named-memory-${name}.db`);

        if (activeName === name && activeMemory) {
          return `✅ Already using named memory '${name}' (${dbPath}).`;
        }

        activeMemory = await createAgentMemory({ dbPath });
        activeShouldCreate = await activeMemory.shouldCreateMemory(importanceThreshold, noveltyThreshold);
        activeName = name;

        return `✅ Switched to named memory '${name}'.\nAll future memory tools now use: ${dbPath}`;
      } catch (err: any) {
        console.error("[opencode-named-memory] Activate failed:", err);
        return `Failed to activate memory: ${err.message || String(err)}`;
      }
    },
  });

  // ── AUTO-INGEST (only when active) ──
  const ingestUserMessage = async (msg: any) => {
    if (!activeMemory || !activeShouldCreate || !msg?.content || msg.role !== "user") return;

    const raw = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
    const insight = raw.length > 600 ? raw.slice(0, 550) + "..." : raw;

    if (await activeShouldCreate(insight)) {
      await activeMemory.add(insight, {
        type: "user_insight",
        source: "auto_user_message",
        name: activeName,
        sessionId: Date.now().toString(36),
      });
    }
  };

  // ── AUTO-PREPEND (only when active) ──
  const injectMemories = async (input: any, output: any) => {
    if (!activeMemory) return;

    try {
      const taskHint = input?.prompt || input?.messages?.[input.messages?.length - 1]?.content || "current coding task";
      const query = typeof taskHint === "string" ? taskHint : JSON.stringify(taskHint);

      let memories = await activeMemory.searchHybrid(query, maxMemories + 10);

      const now = Date.now();
      memories = memories
        .map((m: MemoryEntry) => {
          const ageHours = (now - new Date(m.createdAt).getTime()) / 3600000;
          const boost = Math.max(0.55, Math.exp(-ageHours / 72));
          return { ...m, finalScore: (m.score || 0) * boost };
        })
        .sort((a: any, b: any) => b.finalScore - a.finalScore)
        .slice(0, maxMemories);

      if (memories.length === 0) return;

      const block = memories
        .map((m: MemoryEntry, i: number) => 
          `Memory #${i + 1} (${new Date(m.createdAt).toISOString().split("T")[0]}):\n${m.content}`
        )
        .join("\n\n");

      if (!output.context) output.context = [];
      output.context.push(`<opencode-named-memory name="${activeName}">
These are your permanent memories for '${activeName}'. Respect them in every decision:

${block}
</opencode-named-memory>`);
    } catch (e) {
      console.error("[opencode-named-memory] Inject failed:", e);
    }
  };

  return {
    "message.updated": async ({ event }: any) => {
      if (event?.message?.role === "user") {
        ingestUserMessage(event.message).catch(console.error);
      }
    },

    "experimental.session.compacting": async (input, output) => {
      await injectMemories(input, output);
    },

    tool: {
      named_memory_use: namedMemoryUse,

      named_memory_search: tool({
        description: "Search the currently active named memory (opencode-named-memory plugin). Must call named_memory_use first.",
        args: {
          query: tool.schema.string().describe("Natural language search query"),
          limit: tool.schema.number().optional().default(6),
        },
        async execute(args) {
          if (!activeMemory) return "No active named memory. Call named_memory_use first.";
          try {
            const results = await activeMemory.searchHybrid(args.query, args.limit || 6);
            if (results.length === 0) return `No memories found for "${args.query}" in '${activeName}'.`;
            return results
              .map((m: MemoryEntry, i: number) => 
                `=== Memory #${i + 1} (relevance: ${(m.score || 0).toFixed(3)}) ===\n${m.content}\nCreated: ${new Date(m.createdAt).toLocaleDateString()}`
              )
              .join("\n\n---\n\n");
          } catch (err: any) {
            return `Search failed: ${err.message || String(err)}`;
          }
        },
      }),

      named_memory_add: tool({
        description: "Force-add to the currently active named memory (opencode-named-memory plugin). Must call named_memory_use first.",
        args: {
          content: tool.schema.string().describe("Exact text to remember"),
          type: tool.schema.string().optional().default("manual"),
        },
        async execute(args) {
          if (!activeMemory) return "No active named memory. Call named_memory_use first.";
          try {
            const id = await activeMemory.add(args.content, { type: args.type, name: activeName });
            return `✅ Added to '${activeName}' (ID: ${id})\n${args.content}`;
          } catch (err: any) {
            return `Add failed: ${err.message || String(err)}`;
          }
        },
      }),

      named_memory_stats: tool({
        description: "Show stats for the currently active named memory (opencode-named-memory plugin). Must call named_memory_use first.",
        args: {},
        async execute() {
          if (!activeMemory) return "No active named memory. Call named_memory_use first.";
          try {
            return `Named memory '${activeName}' contains ${activeMemory.getStats().total} entries.`;
          } catch (err: any) {
            return `Stats error: ${err.message || String(err)}`;
          }
        },
      }),
    },

    async destroy() {
      if (activeMemory) await activeMemory.close();
    },
  };
};

export default OpencodeNamedMemoryPlugin;