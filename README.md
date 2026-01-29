# YAMS Blackboard Plugin for OpenCode

Shared blackboard for multi-agent coordination. Agents post findings, claim tasks, and discover each other's work through [YAMS](https://github.com/trvon/yams).

> [!WARNING]
> **Experimental Software**
>
> Under active development. APIs may change without notice. Requires YAMS v0.8.1+.

## Features
- [Blackboard pattern](https://en.wikipedia.org/wiki/Blackboard_system) for agent-to-agent communication via shared memory
- Findings with severity, confidence, topics, and lifecycle states (draft/published/acknowledged/resolved)
- Task coordination with claim-based assignment, dependencies, and priority
- Context grouping for related findings and tasks
- Automatic compaction hooks — blackboard state survives session compression
- All writes tagged `owner=opencode` for cross-agent discovery

```
┌─────────────────────────────────────────────────────┐
│                   YAMS BLACKBOARD                   │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  │
│  │  Findings   │  │   Tasks     │  │   Context   │  │
│  │  (tagged)   │  │  (status)   │  │   (graph)   │  │
│  └─────────────┘  └─────────────┘  └─────────────┘  │
└─────────────────────────────────────────────────────┘
        ▲ write            ▲ write           │ read
        │                  │                 ▼
   ┌────┴────┐        ┌────┴────┐       ┌────────────┐
   │ Agent A │        │ Agent B │       │   Agent C  │
   │ (scan)  │        │ (review)│       │(synthesize)│
   └─────────┘        └─────────┘       └────────────┘
```

## Install

### 1. YAMS daemon

```bash
brew install trvon/tap/yams
yams daemon start
yams status  # Should show "running"
```

### 2. OpenCode config

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["yams-blackboard"]
}
```

OpenCode installs npm plugins automatically at startup.

## Tools

### Agents
| Tool | Description |
|------|-------------|
| `bb_register_agent` | Register identity and capabilities |
| `bb_list_agents` | List registered agents |

### Findings
| Tool | Description |
|------|-------------|
| `bb_post_finding` | Post finding to blackboard |
| `bb_query_findings` | Query by topic, agent, severity, context |
| `bb_search_findings` | Semantic search across findings |
| `bb_get_finding` | Get full finding details |
| `bb_acknowledge_finding` | Mark as acknowledged |
| `bb_resolve_finding` | Mark as resolved with explanation |

### Tasks
| Tool | Description |
|------|-------------|
| `bb_create_task` | Create task for agents to claim |
| `bb_get_ready_tasks` | Get pending tasks with met dependencies |
| `bb_claim_task` | Claim a pending task |
| `bb_update_task` | Update task status |
| `bb_complete_task` | Mark completed with findings/artifacts |
| `bb_fail_task` | Mark failed with error |
| `bb_query_tasks` | Query by type, status, assignee |

### Context & Utility
| Tool | Description |
|------|-------------|
| `bb_create_context` | Group related findings/tasks |
| `bb_get_context_summary` | Summary of context state |
| `bb_set_context` | Set current working context |
| `bb_recent_activity` | Recent findings and task updates |
| `bb_stats` | Blackboard statistics |
| `bb_connections` | Explore graph connections |

## Quick Start

```typescript
// Scanner registers and posts finding
bb_register_agent({ id: "scanner", name: "Scanner", capabilities: ["security"] })

bb_post_finding({
  agent_id: "scanner", topic: "security",
  title: "SQL Injection in auth.ts:42", severity: "high", confidence: 0.92,
  content: "Unsanitized user input in SQL query...",
  references: [{ type: "file", target: "src/auth.ts", line_start: 42 }]
})

// Fixer discovers, claims task, resolves
bb_search_findings({ query: "SQL injection" })
bb_claim_task({ task_id: "t-xxx", agent_id: "fixer" })
bb_complete_task({ task_id: "t-xxx", findings: ["f-fix-001"] })
bb_resolve_finding({
  finding_id: "f-original", agent_id: "fixer",
  resolution: "Parameterized queries added in PR #123"
})
```

## Schemas

### Finding
```typescript
interface Finding {
  id: string
  agent_id: string
  topic: "security" | "performance" | "bug" | "architecture" | "refactor" | "test" | "doc" | "dependency" | "accessibility" | "other"
  title: string
  content: string           // markdown
  confidence: number        // 0.0–1.0
  severity?: "info" | "low" | "medium" | "high" | "critical"
  status: "draft" | "published" | "acknowledged" | "resolved" | "rejected"
  scope: "session" | "persistent"
  context_id?: string
  references?: Reference[]
}
```

### Task
```typescript
interface Task {
  id: string
  title: string
  type: "analysis" | "fix" | "review" | "test" | "research" | "synthesis"
  priority: 0 | 1 | 2 | 3 | 4  // 0=critical, 4=backlog
  status: "pending" | "claimed" | "working" | "blocked" | "review" | "completed" | "failed"
  created_by: string
  assigned_to?: string
  depends_on?: string[]
}
```

See [DESIGN.md](./DESIGN.md) for complete schema documentation.

## Lifecycle Hooks

- `session.created` — starts a YAMS session for the conversation
- `experimental.session.compacting` — injects blackboard summary before compaction prompt
- `session.compacted` — injects blackboard summary into compaction context

## Compaction

Blackboard state is automatically pushed into `output.context` during compaction. To manually retrieve shared context:

```bash
yams list --owner opencode --since 24h --limit 20 --format markdown
```

## Persistence

Findings are persistent by default (survive across sessions). Use `scope: "session"` for temporary data:

```typescript
bb_post_finding({ ..., scope: "session", ttl: 3600 })
```

## Development

```bash
bun install        # Install dependencies
bun run build      # Compile to index.js
bun run typecheck  # Type check
bun test           # Unit tests
bun run test:integration  # Integration tests (requires YAMS daemon)
```

## Troubleshooting

```bash
yams daemon start  # "YAMS daemon not running"
yams status        # Verify daemon is up
```

**Plugin not loading:** Check `opencode.json` has `"plugin": ["yams-blackboard"]`, restart OpenCode.

**Tools not appearing:** Start a new session — tools register on `session.created`.

## License

GPL-3.0-only — see [LICENSE](LICENSE).
