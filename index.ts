// ~/.config/opencode/plugins/opencode-named-memory.ts
import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { createAgentMemory, type MemoryEntry } from "fastmemory";
import * as path from "path";
import * as os from "os";

export const OpencodeNamedMemoryPlugin: Plugin = async (ctx) => {
  const { client } = ctx;

  const importanceThreshold = 0.009;
  const noveltyThreshold = 0.87;
  const maxMemories = 7;

  let activeMemory: Awaited<ReturnType<typeof createAgentMemory>> | null = null;
  let activeName: string | null = null;
  let activeShouldCreate: ((content: string) => Promise<boolean>) | null = null;
  let dbDir: string | null = null;

  // ── Official OpenCode config path ──
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

  function sanitizeName(raw: string): string {
    return raw
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "default";
  }

  // Escape special characters for SQLite FTS5 queries
  // Single quotes must be doubled up, and we wrap in quotes to handle special chars
  function escapeFts5(query: string): string {
    // Escape single quotes by doubling them (SQLite standard)
    const escaped = query.replace(/'/g, "''");
    // Wrap in double quotes to handle other special FTS5 characters like - * " etc
    return `"${escaped}"`;
  }

  // ── TOOL: Activate/switch named memory ──
  const namedMemoryUse = tool({
    description: "Activate (or switch to) a named memory store (e.g 'richard', 'work', etc.). REQUIRED before any other memory tools work.",
    args: {
      name: tool.schema.string().describe("Memory name, e.g. 'richard', 'work', 'personal-project' (auto-lowercased)"),
    },
    async execute(args) {
      try {
        const dir = await getDbDir();
        await ctx.$`mkdir -p ${dir}`;

        const name = sanitizeName(args.name);
        const dbPath = path.join(dir, `named-memory-${name}.db`);
        const cacheDir = path.join(dir, "model_cache");
        await ctx.$`mkdir -p ${cacheDir}`;

        if (activeName === name && activeMemory) {
          return `✅ Already using named memory '${name}' (${dbPath}).`;
        }

        // Pass cacheDir to the new fastmemory version
        activeMemory = await createAgentMemory({ dbPath, cacheDir });
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

      let memories = await activeMemory.searchHybrid(escapeFts5(query), maxMemories + 10);

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
    "message.updated": async ({ event }) => {
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
        description: "Search the currently active named memory. Must call named_memory_use first. Use specific keywords and distinctive terms rather than vague descriptions (e.g. 'postgres uuid indexing' not 'database stuff').",
        args: {
          query: tool.schema.string().describe("Natural language search query"),
        },
        async execute(args) {
          if (!activeMemory) return "No active named memory. Call named_memory_use first.";
          try {
            const results = await activeMemory.searchHybrid(escapeFts5(args.query), 6);
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
        description: "Add a memory to the currently active named memory. Must call named_memory_use first.",
        args: {
          content: tool.schema.string().describe("Exact text to remember"),
        },
        async execute(args) {
          if (!activeMemory) return "No active named memory. Call named_memory_use first.";
          try {
            const id = await activeMemory.add(args.content, { type: "manual", name: activeName });
            return `✅ Added to '${activeName}' (ID: ${id})\n${args.content}`;
          } catch (err: any) {
            return `Add failed: ${err.message || String(err)}`;
          }
        },
      }),

      judge_if_memory_worth_saving: tool({
        description: "Evaluate whether content is worth saving as a permanent memory. Analyzes importance (preferences, facts, lessons) and novelty (not a duplicate). Always checks for duplicates when memory is active.",
        args: {
          content: tool.schema.string().describe("The content to evaluate for memory-worthiness"),
        },
        async execute(args) {
          const content = args.content;
          
          // Basic length check
          if (content.length < 20) {
            return `❌ NOT worth saving\nReason: Too short (${content.length} chars, minimum 20)\nContent: ${content}`;
          }
          if (content.length > 800) {
            return `❌ NOT worth saving\nReason: Too long (${content.length} chars, maximum 800)\nContent: ${content.slice(0, 100)}...`;
          }

          // Use the active memory's shouldCreate if available, otherwise we can't judge
          if (activeMemory && activeShouldCreate) {
            // First check for duplicates by searching for similar memories
            const similarMemories = await activeMemory.searchHybrid(escapeFts5(content), 3);
            const bestMatch = similarMemories[0];
            if (bestMatch && (bestMatch.score || 0) > 0.92) {
              return `❌ DUPLICATE - NOT SAVED\nReason: Too similar to existing memory (similarity: ${(bestMatch.score || 0).toFixed(3)})\nExisting: ${bestMatch.content.slice(0, 100)}${bestMatch.content.length > 100 ? "..." : ""}\n\nNew content: ${content}\n\nThis appears to be a duplicate of something already remembered.`;
            }
            
            const isWorthSaving = await activeShouldCreate(content);
            
            if (!isWorthSaving) {
              return `❌ NOT IMPORTANT ENOUGH\nReason: Content doesn't meet importance threshold for permanent storage\nContent: ${content}\n\nTip: Permanent memories should capture user preferences, facts, lessons learned, or project rules. Avoid ephemeral details like "currently fixing a bug" or "thanks for the help".`;
            }
            
            return `✅ WORTH SAVING\nContent: ${content}\n\nThis appears to be a permanent preference, fact, or lesson that should be remembered.`;
          }
          
          // No active memory to judge with - give manual guidance
          return `⚠️ Cannot auto-judge: No active memory. Call named_memory_use first to activate memory-based judgment.\n\nContent to evaluate: ${content}\n\nManual guidance:\n✅ SAVE if: User preferences, personal facts, lessons learned, project rules, or things explicitly requested to remember\n❌ SKIP if: Ephemeral events, casual chat, questions, status updates, opinions about external things, or emotional reactions`;
        },
      }),

    },

    async destroy() {
      if (activeMemory) await activeMemory.close();
    },
  };
};

export default OpencodeNamedMemoryPlugin;
