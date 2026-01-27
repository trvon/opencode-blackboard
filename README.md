# YAMS Blackboard Plugin for OpenCode

> **EXPERIMENTAL SOFTWARE** - This plugin is under active development. APIs may change without notice. Use at your own risk.

A **blackboard architecture** plugin enabling agent-to-agent communication through [YAMS](https://github.com/trvon/yams) as shared memory.

## Overview

This plugin implements the classic [blackboard pattern](https://en.wikipedia.org/wiki/Blackboard_system) for multi-agent AI systems. Agents post findings, claim tasks, and discover each other's work through a shared knowledge store.

```
┌─────────────────────────────────────────────────────┐
│                   YAMS BLACKBOARD                   │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐ │
│  │  Findings   │  │   Tasks     │  │   Context   │ │
│  │  (tagged)   │  │  (status)   │  │   (graph)   │ │
│  └─────────────┘  └─────────────┘  └─────────────┘ │
└─────────────────────────────────────────────────────┘
        ▲ write            ▲ write           │ read
        │                  │                 ▼
   ┌────┴────┐        ┌────┴────┐       ┌────────┐
   │ Agent A │        │ Agent B │       │ Agent C │
   │ (scan)  │        │ (review)│       │(synthesize)│
   └─────────┘        └─────────┘       └────────┘
```

## Installation

### 1. Install YAMS

Install the YAMS daemon from [github.com/trvon/yams](https://github.com/trvon/yams):

```bash
# macOS
brew install trvon/tap/yams

# Or build from source (see YAMS repo for instructions)
```

Start the daemon:

```bash
yams daemon start
yams status  # Should show "running"
```

### 2. Add Plugin to OpenCode

Add to your `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["yams-blackboard"]
}
```

OpenCode automatically installs npm plugins at startup. No manual build or copy required.

## Tools

### Agent Management

| Tool | Description |
|------|-------------|
| `bb_register_agent` | Register agent identity and capabilities |
| `bb_list_agents` | List all registered agents |

### Findings

| Tool | Description |
|------|-------------|
| `bb_post_finding` | Post a finding to the blackboard |
| `bb_query_findings` | Query findings by topic, agent, severity |
| `bb_search_findings` | Semantic search across findings |
| `bb_get_finding` | Get full details of a finding |
| `bb_acknowledge_finding` | Mark a finding as acknowledged |
| `bb_resolve_finding` | Mark a finding as resolved |

### Tasks

| Tool | Description |
|------|-------------|
| `bb_create_task` | Create a new task |
| `bb_get_ready_tasks` | Get tasks ready to work (no blockers) |
| `bb_claim_task` | Claim a pending task |
| `bb_update_task` | Update task status |
| `bb_complete_task` | Mark task completed |
| `bb_fail_task` | Mark task as failed |
| `bb_query_tasks` | Query tasks by type, status, assignee |

### Context & Utility

| Tool | Description |
|------|-------------|
| `bb_create_context` | Create a context to group findings/tasks |
| `bb_get_context_summary` | Get summary of a context |
| `bb_set_context` | Set current working context |
| `bb_recent_activity` | Get recent findings and tasks |
| `bb_stats` | Get blackboard statistics |
| `bb_connections` | Explore graph connections |

## Example Workflow

```typescript
// Agent 1: Security scanner registers and posts finding
bb_register_agent({
  id: "scanner",
  name: "Security Scanner",
  capabilities: ["security", "code-review"]
})

bb_post_finding({
  agent_id: "scanner",
  topic: "security",
  title: "SQL Injection in auth.ts:42",
  severity: "high",
  confidence: 0.92,
  content: "Found unsanitized user input passed directly to SQL query...",
  references: [{ type: "file", target: "src/auth.ts", line_start: 42 }]
})

// Agent 2: Fixer discovers the finding
bb_search_findings({ query: "SQL injection" })

// Coordinator creates a task
bb_create_task({
  title: "Fix SQL injection vulnerability",
  type: "fix",
  created_by: "coordinator",
  priority: 1
})

// Fixer claims and works
bb_claim_task({ task_id: "t-xxx", agent_id: "fixer" })
bb_update_task({ task_id: "t-xxx", status: "working" })

// Fixer completes and resolves
bb_complete_task({ task_id: "t-xxx", findings: ["f-fix-001"] })
bb_resolve_finding({
  finding_id: "f-original",
  agent_id: "fixer",
  resolution: "Parameterized queries added in PR #123"
})
```

## Schemas

### Finding

```typescript
interface Finding {
  id: string
  agent_id: string
  topic: "security" | "performance" | "bug" | "architecture" | ...
  title: string
  content: string
  confidence: number        // 0.0 - 1.0
  severity?: "info" | "low" | "medium" | "high" | "critical"
  status: "draft" | "published" | "acknowledged" | "resolved" | "rejected"
  scope: "session" | "persistent"  // Default: persistent
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
  findings?: string[]
}
```

See [DESIGN.md](./DESIGN.md) for complete schema documentation.

## Lifecycle Hooks

The plugin integrates with OpenCode's lifecycle:

- **`session.created`**: Starts a YAMS session for the conversation
- **`session.compacted`**: Injects blackboard summary into compaction context

## Persistence

By default, findings are **persistent** (survive across sessions). Use `scope: "session"` for temporary scratch work:

```typescript
bb_post_finding({
  // ...
  scope: "session",
  ttl: 3600  // Optional: auto-delete after 1 hour
})
```

## Architecture

Based on research into multi-agent communication patterns:

- **Blackboard Pattern**: Shared memory over direct messaging for loose coupling
- **A2A Protocol Concepts**: Structured findings with lifecycle states
- **Task Coordination**: Claim-based work distribution with dependencies

## Development (Contributors Only)

This section is for contributors developing the plugin itself. Users should install via npm as described above.

```bash
bun install        # Install dependencies
bun run build      # Compile index.ts to index.js
bun run typecheck  # Type check
bun test           # Run tests
```

## Troubleshooting

### "YAMS daemon not running"

```bash
yams daemon start
yams status  # Should show "running"
```

### "Command 'yams' not found"

YAMS must be installed and in your PATH. See [Installation](#installation).

### Plugin not loading

1. Verify `opencode.json` has `"plugin": ["yams-blackboard"]`
2. Restart OpenCode to load the plugin
3. Check OpenCode logs for plugin errors

### Tools not appearing

Start a new session - tools are registered on `session.created`.

## License

This project is licensed under the GNU General Public License v3.0 - see [LICENSE](LICENSE) for details.
