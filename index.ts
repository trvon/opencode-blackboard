/**
 * YAMS Blackboard Plugin for OpenCode
 *
 * Implements a blackboard architecture for agent-to-agent communication.
 * Agents post findings, claim tasks, and discover each other's work through YAMS.
 */

import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import { YamsBlackboard } from "./blackboard"
import {
  FindingTopic,
  FindingSeverity,
  FindingStatus,
  FindingScope,
  TaskType,
  TaskStatus,
  TaskPriority,
  ReferenceSchema,
} from "./types"

// Compaction hook types
interface CompactionInput {
  summary: string
}
interface CompactionOutput {
  context: string[]
}

// Named export for explicit imports
export const YamsBlackboardPlugin: Plugin = async ({ $, project, directory }) => {
  // Initialize blackboard (session will be started on session.created hook)
  // Cast $ to any to handle Bun shell type differences
  const blackboard = new YamsBlackboard($ as any, { defaultScope: "persistent" })
  let currentContextId: string | undefined

  const pushContextSummary = async (output?: CompactionOutput) => {
    if (!output || !Array.isArray(output.context)) {
      return
    }
    const contextId = currentContextId || "default"
    const summary = await blackboard.getContextSummary(contextId)
    output.context.push(summary)
  }

  return {
    // =========================================================================
    // LIFECYCLE HOOKS
    // =========================================================================

    "session.created": async () => {
      // Start a YAMS session scoped to this conversation
      await blackboard.startSession()
    },

    "experimental.session.compacting": async (input: CompactionInput, output: CompactionOutput) => {
      try {
        await pushContextSummary(output)
      } catch {
        // Silent failure - console output breaks OpenCode TUI
      }
    },

    "session.compacted": async (input: CompactionInput, output: CompactionOutput) => {
      // Generate summary of blackboard state for compaction context
      try {
        await pushContextSummary(output)
      } catch {
        // Don't fail compaction if summary generation fails
        // Note: Silent failure - console output breaks OpenCode TUI
      }
    },

    // =========================================================================
    // TOOLS
    // =========================================================================

    tool: {
      // -----------------------------------------------------------------------
      // Agent Management
      // -----------------------------------------------------------------------

      bb_register_agent: tool({
        description:
          "Register an agent's identity and capabilities on the blackboard. Call this when starting work to announce your presence.",
        args: {
          id: z.string().min(1).describe("Unique agent identifier (e.g., 'security-scanner')"),
          name: z.string().min(1).describe("Human-readable name"),
          capabilities: z
            .array(z.string())
            .min(1)
            .describe("List of capabilities (e.g., ['code-review', 'security-audit'])"),
        },
        async execute(args) {
          const agent = await blackboard.registerAgent({
            id: args.id,
            name: args.name,
            capabilities: args.capabilities,
            status: "active",
          })
          return `Agent registered: ${agent.id}\nCapabilities: ${agent.capabilities.join(", ")}\nRegistered at: ${agent.registered_at}`
        },
      }),

      bb_list_agents: tool({
        description: "List all registered agents and their capabilities",
        args: {},
        async execute() {
          const agents = await blackboard.listAgents()
          if (agents.length === 0) {
            return "No agents registered yet."
          }
          return agents
            .map(
              (a) =>
                `${a.id} (${a.status})\n  Name: ${a.name}\n  Capabilities: ${a.capabilities.join(", ")}`
            )
            .join("\n\n")
        },
      }),

      // -----------------------------------------------------------------------
      // Finding Management
      // -----------------------------------------------------------------------

      bb_post_finding: tool({
        description:
          "Post a finding to the shared blackboard for other agents to discover. Use this to share discoveries, observations, issues, or insights.",
        args: {
          agent_id: z.string().min(1).describe("Your agent identifier"),
          topic: FindingTopic.describe(
            "Category: security, performance, bug, architecture, refactor, test, doc, dependency, accessibility, other"
          ),
          title: z.string().min(1).max(200).describe("Brief summary of the finding"),
          content: z.string().min(1).describe("Full details in markdown"),
          confidence: z
            .number()
            .min(0)
            .max(1)
            .optional()
            .describe("Confidence level 0-1 (default: 0.8)"),
          severity: FindingSeverity.optional().describe(
            "Impact level: info, low, medium, high, critical"
          ),
          references: z
            .array(
              z.object({
                type: z.enum(["file", "url", "finding", "task", "symbol"]),
                target: z.string(),
                label: z.string().optional(),
                line_start: z.number().optional(),
                line_end: z.number().optional(),
              })
            )
            .optional()
            .describe("Related files, URLs, or other findings"),
          context_id: z.string().optional().describe("Group with related findings"),
          parent_id: z.string().optional().describe("Reply to another finding"),
          scope: FindingScope.optional().describe(
            "Persistence: 'persistent' (default) or 'session'"
          ),
          metadata: z.record(z.string(), z.string()).optional().describe("Additional key-value metadata"),
        },
        async execute(args) {
          const finding = await blackboard.postFinding({
            agent_id: args.agent_id,
            topic: args.topic,
            title: args.title,
            content: args.content,
            confidence: args.confidence ?? 0.8,
            severity: args.severity,
            references: args.references,
            context_id: args.context_id || currentContextId,
            parent_id: args.parent_id,
            scope: args.scope ?? "persistent",
            metadata: args.metadata,
          })

          return `Finding posted: ${finding.id}
Topic: ${finding.topic}
Title: ${finding.title}
Confidence: ${finding.confidence}
${finding.severity ? `Severity: ${finding.severity}` : ""}
${finding.context_id ? `Context: ${finding.context_id}` : ""}`
        },
      }),

      bb_query_findings: tool({
        description:
          "Query findings from the blackboard by topic, agent, severity, or context. Use to discover what other agents have found.",
        args: {
          topic: FindingTopic.optional().describe("Filter by topic"),
          agent_id: z.string().optional().describe("Filter by source agent"),
          context_id: z.string().optional().describe("Filter by context group"),
          status: FindingStatus.optional().describe("Filter by status"),
          severity: z.array(FindingSeverity).optional().describe("Filter by severity levels"),
          min_confidence: z.number().min(0).max(1).optional().describe("Minimum confidence threshold"),
          scope: FindingScope.optional().describe("Filter by persistence scope"),
          limit: z.number().int().positive().optional().describe("Max results (default: 20)"),
        },
        async execute(args) {
          const findings = await blackboard.queryFindings({
            ...args,
            context_id: args.context_id || currentContextId,
            limit: args.limit ?? 20,
            offset: 0,
          })

          if (findings.length === 0) {
            return "No findings match the query."
          }

          return findings
            .map(
              (f) =>
                `[${f.id}] ${f.topic.toUpperCase()} | ${f.title}
  Agent: ${f.agent_id} | Confidence: ${f.confidence.toFixed(2)}${f.severity ? ` | Severity: ${f.severity}` : ""}
  Status: ${f.status}${f.context_id ? ` | Context: ${f.context_id}` : ""}`
            )
            .join("\n\n")
        },
      }),

      bb_search_findings: tool({
        description:
          "Search findings using natural language. Uses semantic search to find relevant findings.",
        args: {
          query: z.string().min(1).describe("Natural language search query"),
          topic: FindingTopic.optional().describe("Limit to specific topic"),
          limit: z.number().int().positive().optional().describe("Max results (default: 10)"),
        },
        async execute(args) {
          const findings = await blackboard.searchFindings(args.query, {
            topic: args.topic,
            limit: args.limit ?? 10,
          })

          if (findings.length === 0) {
            return "No findings match the search."
          }

          return findings
            .map(
              (f) =>
                `[${f.id}] ${f.topic.toUpperCase()} | ${f.title}
  ${f.content.slice(0, 200)}${f.content.length > 200 ? "..." : ""}`
            )
            .join("\n\n")
        },
      }),

      bb_get_finding: tool({
        description: "Get full details of a specific finding by ID",
        args: {
          finding_id: z.string().min(1).describe("The finding ID"),
        },
        async execute(args) {
          const finding = await blackboard.getFinding(args.finding_id)
          if (!finding) {
            return `Finding not found: ${args.finding_id}`
          }

          return `# ${finding.title}

**ID:** ${finding.id}
**Agent:** ${finding.agent_id}
**Topic:** ${finding.topic}
**Status:** ${finding.status}
**Confidence:** ${finding.confidence}
${finding.severity ? `**Severity:** ${finding.severity}` : ""}
${finding.context_id ? `**Context:** ${finding.context_id}` : ""}
${finding.references?.length ? `**References:** ${finding.references.map((r) => `${r.type}:${r.target}`).join(", ")}` : ""}

## Content

${finding.content}`
        },
      }),

      bb_acknowledge_finding: tool({
        description: "Mark a finding as acknowledged (you've seen it)",
        args: {
          finding_id: z.string().min(1).describe("The finding ID to acknowledge"),
          agent_id: z.string().min(1).describe("Your agent ID"),
        },
        async execute(args) {
          await blackboard.acknowledgeFinding(args.finding_id, args.agent_id)
          return `Finding ${args.finding_id} acknowledged by ${args.agent_id}`
        },
      }),

      bb_resolve_finding: tool({
        description: "Mark a finding as resolved with an explanation",
        args: {
          finding_id: z.string().min(1).describe("The finding ID to resolve"),
          agent_id: z.string().min(1).describe("Your agent ID"),
          resolution: z.string().min(1).describe("How the finding was resolved"),
        },
        async execute(args) {
          await blackboard.resolveFinding(args.finding_id, args.agent_id, args.resolution)
          return `Finding ${args.finding_id} resolved by ${args.agent_id}: ${args.resolution}`
        },
      }),

      // -----------------------------------------------------------------------
      // Task Management
      // -----------------------------------------------------------------------

      bb_create_task: tool({
        description:
          "Create a new task on the blackboard for agents to claim and work on",
        args: {
          title: z.string().min(1).max(200).describe("What needs to be done"),
          description: z.string().optional().describe("Detailed requirements"),
          type: TaskType.describe(
            "Kind of task: analysis, fix, review, test, research, synthesis"
          ),
          priority: TaskPriority.optional().describe("0=critical, 1=high, 2=medium, 3=low, 4=backlog"),
          created_by: z.string().min(1).describe("Your agent ID"),
          depends_on: z.array(z.string()).optional().describe("Task IDs that must complete first"),
          context_id: z.string().optional().describe("Group with related tasks"),
        },
        async execute(args) {
          const task = await blackboard.createTask({
            title: args.title,
            description: args.description,
            type: args.type,
            priority: args.priority ?? 2,
            created_by: args.created_by,
            depends_on: args.depends_on,
            context_id: args.context_id || currentContextId,
          })

          return `Task created: ${task.id}
Title: ${task.title}
Type: ${task.type}
Priority: ${task.priority}
Status: ${task.status}
${task.depends_on?.length ? `Depends on: ${task.depends_on.join(", ")}` : ""}`
        },
      }),

      bb_get_ready_tasks: tool({
        description:
          "Get tasks that are ready to work on (pending, no unmet dependencies). Use this to find work.",
        args: {
          limit: z.number().int().positive().optional().describe("Max results"),
        },
        async execute(args) {
          const tasks = await blackboard.getReadyTasks()
          const limited = tasks.slice(0, args.limit || 10)

          if (limited.length === 0) {
            return "No tasks ready to work on."
          }

          return limited
            .map(
              (t) =>
                `[${t.id}] P${t.priority} ${t.type.toUpperCase()} | ${t.title}
  Created by: ${t.created_by}
  ${t.description ? `Description: ${t.description.slice(0, 100)}...` : ""}`
            )
            .join("\n\n")
        },
      }),

      bb_claim_task: tool({
        description: "Claim a pending task to work on it",
        args: {
          task_id: z.string().min(1).describe("The task ID to claim"),
          agent_id: z.string().min(1).describe("Your agent ID"),
        },
        async execute(args) {
          const task = await blackboard.claimTask(args.task_id, args.agent_id)
          if (!task) {
            return `Failed to claim task ${args.task_id}. It may not exist or is already claimed.`
          }
          return `Task claimed: ${task.id}
Title: ${task.title}
Assigned to: ${task.assigned_to}
Status: ${task.status}`
        },
      }),

      bb_update_task: tool({
        description: "Update the status of a task you're working on",
        args: {
          task_id: z.string().min(1).describe("The task ID"),
          status: TaskStatus.describe("New status: working, blocked, review"),
          error: z.string().optional().describe("Error message if blocked/failed"),
        },
        async execute(args) {
          const task = await blackboard.updateTask(args.task_id, {
            status: args.status,
            error: args.error,
          })
          if (!task) {
            return `Task not found: ${args.task_id}`
          }
          return `Task ${task.id} updated to status: ${task.status}`
        },
      }),

      bb_complete_task: tool({
        description: "Mark a task as completed, optionally with findings or artifacts",
        args: {
          task_id: z.string().min(1).describe("The task ID"),
          findings: z.array(z.string()).optional().describe("Finding IDs produced by this task"),
        },
        async execute(args) {
          const task = await blackboard.completeTask(args.task_id, {
            findings: args.findings,
          })
          if (!task) {
            return `Task not found: ${args.task_id}`
          }
          return `Task completed: ${task.id}
Title: ${task.title}
${args.findings?.length ? `Findings: ${args.findings.join(", ")}` : ""}`
        },
      }),

      bb_fail_task: tool({
        description: "Mark a task as failed with an error message",
        args: {
          task_id: z.string().min(1).describe("The task ID"),
          error: z.string().min(1).describe("What went wrong"),
        },
        async execute(args) {
          const task = await blackboard.failTask(args.task_id, args.error)
          if (!task) {
            return `Task not found: ${args.task_id}`
          }
          return `Task failed: ${task.id}
Error: ${args.error}`
        },
      }),

      bb_query_tasks: tool({
        description: "Query tasks by type, status, priority, or assignee",
        args: {
          type: TaskType.optional().describe("Filter by task type"),
          status: TaskStatus.optional().describe("Filter by status"),
          priority: TaskPriority.optional().describe("Filter by priority"),
          created_by: z.string().optional().describe("Filter by creator"),
          assigned_to: z.string().optional().describe("Filter by assignee"),
          context_id: z.string().optional().describe("Filter by context"),
          limit: z.number().int().positive().optional().describe("Max results"),
        },
        async execute(args) {
          const tasks = await blackboard.queryTasks({
            ...args,
            context_id: args.context_id || currentContextId,
            limit: args.limit ?? 20,
            offset: 0,
          })

          if (tasks.length === 0) {
            return "No tasks match the query."
          }

          return tasks
            .map(
              (t) =>
                `[${t.id}] P${t.priority} ${t.type} | ${t.title}
  Status: ${t.status} | Created: ${t.created_by}${t.assigned_to ? ` | Assigned: ${t.assigned_to}` : ""}`
            )
            .join("\n\n")
        },
      }),

      // -----------------------------------------------------------------------
      // Context Management
      // -----------------------------------------------------------------------

      bb_create_context: tool({
        description:
          "Create a new context to group related findings and tasks together",
        args: {
          id: z.string().min(1).describe("Context identifier (e.g., 'security-audit-2025')"),
          name: z.string().min(1).describe("Human-readable name"),
          description: z.string().optional().describe("What this context is about"),
          set_current: z.boolean().optional().describe("Set as current context (default: true)"),
        },
        async execute(args) {
          const context = await blackboard.createContext(
            args.id,
            args.name,
            args.description
          )

          if (args.set_current !== false) {
            currentContextId = context.id
          }

          return `Context created: ${context.id}
Name: ${context.name}
${context.description ? `Description: ${context.description}` : ""}
${args.set_current !== false ? "(Set as current context)" : ""}`
        },
      }),

      bb_get_context_summary: tool({
        description: "Get a summary of a context including findings, tasks, and agents",
        args: {
          context_id: z.string().optional().describe("Context ID (defaults to current)"),
        },
        async execute(args) {
          const contextId = args.context_id || currentContextId || "default"
          return await blackboard.getContextSummary(contextId)
        },
      }),

      bb_set_context: tool({
        description: "Set the current working context for findings and tasks",
        args: {
          context_id: z.string().min(1).describe("Context ID to set as current"),
        },
        async execute(args) {
          currentContextId = args.context_id
          return `Current context set to: ${args.context_id}`
        },
      }),

      // -----------------------------------------------------------------------
      // Utility
      // -----------------------------------------------------------------------

      bb_recent_activity: tool({
        description: "Get recent findings and task updates across all topics",
        args: {
          limit: z.number().int().positive().optional().describe("Max items (default: 10)"),
        },
        async execute(args) {
          const limit = args.limit || 10
          const findings = await blackboard.queryFindings({ limit, offset: 0 })
          const tasks = await blackboard.queryTasks({ limit, offset: 0 })

          const output: string[] = ["## Recent Activity\n"]

          if (findings.length > 0) {
            output.push("### Findings")
            output.push(
              findings
                .map((f) => `- [${f.topic}] ${f.title} (${f.agent_id})`)
                .join("\n")
            )
          }

          if (tasks.length > 0) {
            output.push("\n### Tasks")
            output.push(
              tasks
                .map((t) => `- [${t.status}] ${t.title} (${t.type})`)
                .join("\n")
            )
          }

          return output.join("\n")
        },
      }),

      bb_stats: tool({
        description: "Get statistics about the blackboard (agents, findings, tasks)",
        args: {},
        async execute() {
          const stats = await blackboard.getStats()

          return `## Blackboard Statistics

### Agents: ${stats.agents}

### Findings: ${stats.findings.total}
By Topic: ${Object.entries(stats.findings.by_topic).map(([k, v]) => `${k}:${v}`).join(", ") || "none"}
By Status: ${Object.entries(stats.findings.by_status).map(([k, v]) => `${k}:${v}`).join(", ") || "none"}
By Severity: ${Object.entries(stats.findings.by_severity).map(([k, v]) => `${k}:${v}`).join(", ") || "none"}

### Tasks: ${stats.tasks.total}
By Status: ${Object.entries(stats.tasks.by_status).map(([k, v]) => `${k}:${v}`).join(", ") || "none"}
By Type: ${Object.entries(stats.tasks.by_type).map(([k, v]) => `${k}:${v}`).join(", ") || "none"}`
        },
      }),

      bb_connections: tool({
        description:
          "Explore graph connections for a finding or document - see related code, findings, and concepts",
        args: {
          path: z.string().min(1).describe("Path to the entity (e.g., 'findings/security/f-xxx.md')"),
          depth: z.number().int().positive().optional().describe("Traversal depth (default: 2)"),
        },
        async execute(args) {
          const graph = await blackboard.getConnections(args.path, args.depth ?? 2)

          if (graph.nodes.length === 0) {
            return "No connections found."
          }

          return `## Connections for ${args.path}

Found ${graph.nodes.length} connected nodes:

${JSON.stringify(graph.nodes, null, 2)}`
        },
      }),
    },
  }
}

// Default export for OpenCode auto-discovery
export default YamsBlackboardPlugin
