# YAMS Blackboard Plugin - Schema Design

## Overview

This plugin implements a **blackboard architecture** for agent-to-agent communication using YAMS as the shared memory store. Agents post findings, claim tasks, and discover each other's work through structured queries.

## Core Entities

### 1. Agent Card

Agents self-register their identity and capabilities. This enables:
- Capability-based task routing
- Agent discovery for collaboration
- Audit trail of who contributed what

```typescript
interface AgentCard {
  id: string                    // Unique identifier, e.g., "security-scanner"
  name: string                  // Human-readable name
  capabilities: string[]        // What this agent can do
  version?: string              // Agent version
  registered_at: string         // ISO timestamp
  status: "active" | "idle" | "offline"
}
```

**Storage**: `agents/{agent_id}.json`
**Tags**: `agent, capability:{cap1}, capability:{cap2}`

---

### 2. Finding

The core unit of agent communication. Findings are discoveries, observations, or outputs that other agents may want to know about.

```typescript
interface Finding {
  // Identity
  id: string                    // Auto-generated: f-{timestamp}-{random}
  agent_id: string              // Who produced this

  // Classification
  topic: string                 // Category: security, performance, bug, architecture, refactor, test, doc
  title: string                 // Brief summary (< 100 chars)

  // Content
  content: string               // Full details (markdown)

  // Confidence & Priority
  confidence: number            // 0.0 - 1.0, how certain the agent is
  severity?: "info" | "low" | "medium" | "high" | "critical"

  // Context & Relationships
  context_id?: string           // Groups related findings (e.g., a task ID)
  references?: Reference[]      // Links to code, docs, other findings
  parent_id?: string            // For threaded/reply findings

  // Lifecycle
  status: "draft" | "published" | "acknowledged" | "resolved" | "rejected"
  created_at: string            // ISO timestamp
  updated_at?: string
  resolved_by?: string          // Agent that resolved this
  resolution?: string           // How it was resolved

  // Persistence
  scope: "session" | "persistent"  // Default: persistent
  ttl?: number                  // Optional TTL in seconds (for session-scoped)

  // Arbitrary metadata
  metadata?: Record<string, string>
}

interface Reference {
  type: "file" | "url" | "finding" | "task" | "symbol"
  target: string                // Path, URL, ID, or symbol name
  label?: string                // Human-readable label
  line_start?: number           // For file references
  line_end?: number
}
```

**Storage**: `findings/{topic}/{id}.md` (with YAML frontmatter)
**Tags**: `finding, agent:{id}, topic:{topic}, severity:{sev}, scope:{scope}, status:{status}`

---

### 3. Task

For coordinated workflows where agents need to claim work, track progress, and hand off results.

```typescript
interface Task {
  // Identity
  id: string                    // Auto-generated: t-{timestamp}-{random}

  // Description
  title: string                 // What needs to be done
  description?: string          // Detailed requirements

  // Classification
  type: "analysis" | "fix" | "review" | "test" | "research" | "synthesis"
  priority: 0 | 1 | 2 | 3 | 4   // 0 = critical, 4 = backlog

  // Lifecycle
  status: "pending" | "claimed" | "working" | "blocked" | "review" | "completed" | "failed" | "cancelled"

  // Assignment
  created_by: string            // Agent that created the task
  assigned_to?: string          // Agent currently working on it
  claimed_at?: string

  // Dependencies
  depends_on?: string[]         // Task IDs that must complete first
  blocks?: string[]             // Task IDs waiting on this

  // Results
  findings?: string[]           // Finding IDs produced by this task
  artifacts?: Artifact[]        // Output files/data

  // Context
  context_id?: string           // Groups related tasks
  parent_task?: string          // For subtasks

  // Timestamps
  created_at: string
  updated_at?: string
  completed_at?: string

  // Failure handling
  error?: string                // Error message if failed
  retry_count?: number
  max_retries?: number
}

interface Artifact {
  name: string
  type: "file" | "data" | "report"
  path?: string                 // YAMS path or local path
  hash?: string                 // YAMS content hash
  mime_type?: string
}
```

**Storage**: `tasks/{id}.json`
**Tags**: `task, type:{type}, status:{status}, priority:{p}, creator:{id}, assignee:{id}`

**State Machine**:
```
                    ┌──────────────────────────────────────┐
                    │                                      │
                    ▼                                      │
┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐  │
│ pending │───▶│ claimed │───▶│ working │───▶│ review  │──┤
└─────────┘    └─────────┘    └─────────┘    └─────────┘  │
     │              │              │              │        │
     │              │              ▼              │        │
     │              │         ┌─────────┐        │        │
     │              └────────▶│ blocked │────────┘        │
     │                        └─────────┘                 │
     │                                                    │
     │         ┌───────────┐    ┌─────────┐              │
     └────────▶│ cancelled │    │completed│◀─────────────┘
               └───────────┘    └─────────┘
                                     ▲
                                     │
                               ┌─────────┐
                               │ failed  │
                               └─────────┘
```

---

### 4. Context

Groups related findings and tasks into a coherent unit of work.

```typescript
interface Context {
  id: string                    // Auto-generated or user-provided
  name: string                  // Human-readable name
  description?: string

  // Aggregates
  findings: string[]            // Finding IDs in this context
  tasks: string[]               // Task IDs in this context
  agents: string[]              // Agents that contributed

  // Lifecycle
  status: "active" | "completed" | "archived"
  created_at: string
  updated_at?: string

  // Summary (for compaction)
  summary?: string              // AI-generated summary
  key_findings?: string[]       // Most important finding IDs
}
```

**Storage**: `contexts/{id}.json`
**Tags**: `context, status:{status}`

---

## Naming Conventions

### Tags

All entities use hierarchical tags for efficient filtering:

| Prefix | Purpose | Examples |
|--------|---------|----------|
| `agent:` | Source agent | `agent:security-scanner` |
| `topic:` | Finding category | `topic:security`, `topic:performance` |
| `severity:` | Finding severity | `severity:high`, `severity:critical` |
| `status:` | Lifecycle state | `status:published`, `status:completed` |
| `scope:` | Persistence | `scope:session`, `scope:persistent` |
| `type:` | Task type | `type:fix`, `type:review` |
| `priority:` | Task priority | `priority:0`, `priority:2` |
| `ctx:` | Context grouping | `ctx:audit-2025-01` |
| `capability:` | Agent capability | `capability:code-review` |

### Paths

```
agents/{agent_id}.json
findings/{topic}/{finding_id}.md
tasks/{task_id}.json
contexts/{context_id}.json
```

---

## Compaction Behavior

When OpenCode compacts a session, the plugin:

1. **Queries active context** - Gets all findings/tasks in current context
2. **Generates summary** - Uses structured template:

```markdown
## Blackboard Summary

### Agents Active
- security-scanner: code-review, vuln-detection
- performance-analyzer: profiling, optimization

### Key Findings ({count} total)
- [HIGH] SQL injection in auth module (security-scanner, 0.95 confidence)
- [MEDIUM] N+1 query in user list (performance-analyzer, 0.87 confidence)
- ...

### Tasks
- [COMPLETED] Audit authentication flow (2 findings)
- [WORKING] Fix SQL injection vulnerability (assigned: code-fixer)
- [PENDING] Review performance optimizations (blocked by: t-xxx)

### Unresolved Issues
- Finding f-xxx still unacknowledged
- Task t-yyy blocked for >1 hour
```

3. **Injects into context** - Adds summary to `output.context`

---

## Session vs Persistent Scope

| Aspect | Session-Scoped | Persistent |
|--------|----------------|------------|
| **Default** | No | Yes |
| **Survives restart** | No | Yes |
| **Use case** | Temporary scratch work | Long-term knowledge |
| **Cleanup** | Auto on session end | Manual or TTL |
| **Example** | Draft findings, WIP | Confirmed bugs, decisions |

To make a finding session-scoped:
```typescript
bb_post_finding({
  // ...
  scope: "session",
  ttl: 3600  // Optional: auto-delete after 1 hour
})
```

---

## Tool Summary

| Tool | Purpose |
|------|---------|
| `bb_register_agent` | Register agent identity and capabilities |
| `bb_post_finding` | Publish a finding to the blackboard |
| `bb_query_findings` | Filter findings by topic, agent, severity, etc. |
| `bb_search_findings` | Semantic search across findings |
| `bb_acknowledge_finding` | Mark a finding as seen/acknowledged |
| `bb_resolve_finding` | Mark a finding as resolved |
| `bb_create_task` | Create a new task |
| `bb_claim_task` | Claim a pending task |
| `bb_update_task` | Update task status/progress |
| `bb_complete_task` | Mark task completed with results |
| `bb_fail_task` | Mark task as failed |
| `bb_get_ready_tasks` | Get tasks ready to work (no blockers) |
| `bb_list_agents` | List registered agents |
| `bb_create_context` | Create a new context grouping |
| `bb_get_context_summary` | Get summary of a context |
| `bb_recent_activity` | Get recent findings and task updates |

---

## Example Workflow

```
1. Agents register on session start
   bb_register_agent({ id: "scanner", capabilities: ["security", "lint"] })
   bb_register_agent({ id: "fixer", capabilities: ["code-fix", "refactor"] })

2. Scanner posts findings
   bb_post_finding({
     agent_id: "scanner",
     topic: "security",
     title: "XSS in user profile",
     severity: "high",
     confidence: 0.91
   })

3. Coordinator creates task
   bb_create_task({
     title: "Fix XSS vulnerability",
     type: "fix",
     priority: 1,
     context_id: "security-audit"
   })

4. Fixer claims and works
   bb_claim_task({ task_id: "t-xxx", agent_id: "fixer" })
   bb_update_task({ task_id: "t-xxx", status: "working" })

5. Fixer completes with finding
   bb_post_finding({ ..., context_id: "security-audit", parent_id: "f-original" })
   bb_complete_task({ task_id: "t-xxx", findings: ["f-fix"] })

6. Original finding resolved
   bb_resolve_finding({ finding_id: "f-original", resolved_by: "fixer", resolution: "Fixed in PR #123" })
```
