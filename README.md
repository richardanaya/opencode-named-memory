# opencode-named-memory

A persistent named memory plugin for OpenCode. Gives each agent, project, or person their own long-term memory store backed by a local SQLite database with hybrid semantic + keyword search.

## Features

- **Named memory stores** - separate isolated memory per name (e.g. `richard`, `work`, `my-project`)
- **Auto-ingest** - automatically captures important user messages into the active memory
- **Auto-inject** - relevant memories are prepended to the context during session compaction
- **Hybrid search** - combines semantic (vector) and keyword (BM25) search via [fastmemory](https://github.com/richardanaya/fastmemory)
- **Importance filtering** - only stores genuinely novel/important content, not every message
- **Age decay** - recent memories are weighted higher during injection

## Installation

```bash
npm install opencode-named-memory
```

## Usage

Add to your OpenCode configuration:

```json
{
  "plugins": ["opencode-named-memory"]
}
```

Then tell the agent which memory to use at the start of a session:

```
Use named memory 'richard' for this session.
```

This calls the `named_memory_use` tool, activating that store. All subsequent memory operations use it automatically.

## Configuration

Optional config in your OpenCode config file:

```json
{
  "plugins": ["opencode-named-memory"],
  "opencode-named-memory": {
    "importanceThreshold": 0.009,
    "noveltyThreshold": 0.87,
    "maxMemories": 7
  }
}
```

| Option | Default | Description |
|---|---|---|
| `importanceThreshold` | `0.009` | Minimum importance score for auto-ingesting a message |
| `noveltyThreshold` | `0.87` | Minimum novelty score (avoids storing duplicate information) |
| `maxMemories` | `7` | Maximum number of memories injected per session compaction |

## Storage

Memory databases are stored in your OpenCode config directory:

```
~/.config/opencode/named-memory/named-memory-<name>.db
```

Each name gets its own SQLite file, so memories are fully isolated.

## Tools

All tools require calling `named_memory_use` first to activate a store.

### `named_memory_use`

Activate (or switch to) a named memory store.

```
named_memory_use({ name: "richard" })
```

Names are auto-lowercased and sanitized. You can switch stores mid-session by calling this again with a different name.

### `named_memory_search`

Search the active memory with a natural language query.

```
named_memory_search({ query: "preferred coding style", limit: 5 })
```

### `named_memory_add`

Force-add a specific piece of information to the active memory.

```
named_memory_add({ content: "Prefers TypeScript with strict mode off", type: "preference" })
```

### `named_memory_stats`

Show how many entries are in the active memory store.

```
named_memory_stats()
```

## License

MIT
