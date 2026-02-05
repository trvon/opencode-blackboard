/**
 * YAMS Blackboard Plugin - Type Definitions
 *
 * Zod schemas for agent cards, findings, tasks, and contexts.
 */

import { z } from "zod"

// =============================================================================
// Agent Card
// =============================================================================

export const AgentCardSchema = z.object({
  id: z.string().min(1).describe("Unique agent identifier"),
  name: z.string().min(1).describe("Human-readable name"),
  capabilities: z.array(z.string()).min(1).describe("What this agent can do"),
  version: z.string().optional(),
  registered_at: z.string().datetime().optional(),
  status: z.enum(["active", "idle", "offline"]).default("active"),
})

export type AgentCard = z.infer<typeof AgentCardSchema>

// =============================================================================
// Reference - Links between entities
// =============================================================================

export const ReferenceSchema = z.object({
  type: z.enum(["file", "url", "finding", "task", "symbol"]),
  target: z.string().min(1).describe("Path, URL, ID, or symbol name"),
  label: z.string().optional().describe("Human-readable label"),
  line_start: z.number().int().positive().optional(),
  line_end: z.number().int().positive().optional(),
})

export type Reference = z.infer<typeof ReferenceSchema>

// =============================================================================
// Finding - Core unit of agent communication
// =============================================================================

export const FindingSeverity = z.enum(["info", "low", "medium", "high", "critical"])
export type FindingSeverity = z.infer<typeof FindingSeverity>

export const FindingStatus = z.enum(["draft", "published", "acknowledged", "resolved", "rejected"])
export type FindingStatus = z.infer<typeof FindingStatus>

export const FindingScope = z.enum(["session", "persistent"])
export type FindingScope = z.infer<typeof FindingScope>

export const FindingTopic = z.enum([
  "security",
  "performance",
  "bug",
  "architecture",
  "refactor",
  "test",
  "doc",
  "dependency",
  "accessibility",
  "other"
])
export type FindingTopic = z.infer<typeof FindingTopic>

export const FindingSchema = z.object({
  // Identity
  id: z.string().optional().describe("Auto-generated if not provided"),
  agent_id: z.string().min(1).describe("Agent that produced this finding"),

  // Classification
  topic: FindingTopic.describe("Category of the finding"),
  title: z.string().min(1).max(200).describe("Brief summary"),

  // Content
  content: z.string().min(1).describe("Full details in markdown"),

  // Confidence & Priority
  confidence: z.number().min(0).max(1).default(0.8).describe("How certain the agent is"),
  severity: FindingSeverity.optional().describe("Impact level"),

  // Context & Relationships
  context_id: z.string().optional().describe("Groups related findings"),
  references: z.array(ReferenceSchema).optional().describe("Links to code, docs, other findings"),
  parent_id: z.string().optional().describe("For threaded/reply findings"),

  // Lifecycle
  status: FindingStatus.default("published"),
  resolved_by: z.string().optional().describe("Agent that resolved this"),
  resolution: z.string().optional().describe("How it was resolved"),

  // Persistence
  scope: FindingScope.default("persistent"),
  ttl: z.number().int().positive().optional().describe("TTL in seconds for session-scoped"),

  // Metadata
  metadata: z.record(z.string(), z.string()).optional(),
})

export type Finding = z.infer<typeof FindingSchema>

// Input schema for creating findings (fewer required fields)
export const CreateFindingSchema = FindingSchema.omit({
  id: true,
  status: true,
  resolved_by: true,
  resolution: true,
}).extend({
  status: FindingStatus.optional(),
})

export type CreateFinding = z.infer<typeof CreateFindingSchema>

// =============================================================================
// Task - For coordinated workflows
// =============================================================================

export const TaskType = z.enum(["analysis", "fix", "review", "test", "research", "synthesis"])
export type TaskType = z.infer<typeof TaskType>

export const TaskStatus = z.enum([
  "pending",    // Created, waiting to be claimed
  "claimed",    // Agent has claimed it
  "working",    // Actively being worked on
  "blocked",    // Waiting on dependencies
  "review",     // Work done, needs review
  "completed",  // Successfully finished
  "failed",     // Execution failed
  "cancelled",  // Manually cancelled
])
export type TaskStatus = z.infer<typeof TaskStatus>

export const TaskPriority = z.union([
  z.literal(0), // Critical
  z.literal(1), // High
  z.literal(2), // Medium
  z.literal(3), // Low
  z.literal(4), // Backlog
])
export type TaskPriority = z.infer<typeof TaskPriority>

export const ArtifactSchema = z.object({
  name: z.string().min(1),
  type: z.enum(["file", "data", "report"]),
  path: z.string().optional().describe("YAMS path or local path"),
  hash: z.string().optional().describe("YAMS content hash"),
  mime_type: z.string().optional(),
})

export type Artifact = z.infer<typeof ArtifactSchema>

export const TaskSchema = z.object({
  // Identity
  id: z.string().optional().describe("Auto-generated if not provided"),

  // Description
  title: z.string().min(1).max(200).describe("What needs to be done"),
  description: z.string().optional().describe("Detailed requirements"),

  // Classification
  type: TaskType.describe("Kind of task"),
  priority: TaskPriority.default(2).describe("0=critical, 4=backlog"),

  // Lifecycle
  status: TaskStatus.default("pending"),

  // Assignment
  created_by: z.string().min(1).describe("Agent that created the task"),
  assigned_to: z.string().optional().describe("Agent currently working on it"),
  claimed_at: z.string().datetime().optional(),

  // Dependencies
  depends_on: z.array(z.string()).optional().describe("Task IDs that must complete first"),
  blocks: z.array(z.string()).optional().describe("Task IDs waiting on this"),

  // Results
  findings: z.array(z.string()).optional().describe("Finding IDs produced"),
  artifacts: z.array(ArtifactSchema).optional().describe("Output files/data"),

  // Context
  context_id: z.string().optional().describe("Groups related tasks"),
  parent_task: z.string().optional().describe("For subtasks"),

  // Failure handling
  error: z.string().optional().describe("Error message if failed"),
  retry_count: z.number().int().nonnegative().optional(),
  max_retries: z.number().int().nonnegative().optional(),

  // Metadata
  metadata: z.record(z.string(), z.string()).optional(),
})

export type Task = z.infer<typeof TaskSchema>

// Input schema for creating tasks
export const CreateTaskSchema = TaskSchema.omit({
  id: true,
  status: true,
  assigned_to: true,
  claimed_at: true,
  findings: true,
  artifacts: true,
  error: true,
  retry_count: true,
})

export type CreateTask = z.infer<typeof CreateTaskSchema>

// =============================================================================
// Context - Groups related findings and tasks
// =============================================================================

export const ContextStatus = z.enum(["active", "completed", "archived"])
export type ContextStatus = z.infer<typeof ContextStatus>

export const ContextSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).describe("Human-readable name"),
  description: z.string().optional(),

  // Aggregates (auto-populated)
  findings: z.array(z.string()).default([]),
  tasks: z.array(z.string()).default([]),
  agents: z.array(z.string()).default([]),

  // Lifecycle
  status: ContextStatus.default("active"),

  // Summary (for compaction)
  summary: z.string().optional().describe("AI-generated summary"),
  key_findings: z.array(z.string()).optional().describe("Most important finding IDs"),
})

export type Context = z.infer<typeof ContextSchema>

// =============================================================================
// Query Types
// =============================================================================

export const FindingQuerySchema = z.object({
  topic: FindingTopic.optional(),
  agent_id: z.string().optional(),
  context_id: z.string().optional(),
  instance_id: z.string().optional().describe("Filter by instance ID for cross-instance queries"),
  status: FindingStatus.optional(),
  severity: z.array(FindingSeverity).optional(),
  min_confidence: z.number().min(0).max(1).optional(),
  scope: FindingScope.optional(),
  limit: z.number().int().positive().default(20),
  offset: z.number().int().nonnegative().default(0),
})

export type FindingQuery = z.infer<typeof FindingQuerySchema>

export const TaskQuerySchema = z.object({
  type: TaskType.optional(),
  status: TaskStatus.optional(),
  priority: TaskPriority.optional(),
  created_by: z.string().optional(),
  assigned_to: z.string().optional(),
  context_id: z.string().optional(),
  instance_id: z.string().optional().describe("Filter by instance ID for cross-instance queries"),
  limit: z.number().int().positive().default(20),
  offset: z.number().int().nonnegative().default(0),
})

export type TaskQuery = z.infer<typeof TaskQuerySchema>

// =============================================================================
// Utility Types
// =============================================================================

export interface BlackboardStats {
  agents: number
  findings: {
    total: number
    by_topic: Record<string, number>
    by_status: Record<string, number>
    by_severity: Record<string, number>
  }
  tasks: {
    total: number
    by_status: Record<string, number>
    by_type: Record<string, number>
  }
  contexts: number
}

export interface CompactionSummary {
  agents: AgentCard[]
  key_findings: Finding[]
  active_tasks: Task[]
  blocked_tasks: Task[]
  unresolved_count: number
  summary_text: string
}

// =============================================================================
// Compaction Manifest - Machine-readable summary for post-compression recovery
// =============================================================================

export interface CompactionManifestFinding {
  id: string
  topic: string
  severity?: string
  status: string
  confidence: number
}

export interface CompactionManifestTask {
  id: string
  type: string
  status: string
  priority: number
}

export interface CompactionManifest {
  contextId: string
  timestamp: string
  findingIds: CompactionManifestFinding[]
  taskIds: CompactionManifestTask[]
  agentIds: string[]
  stats: {
    totalFindings: number
    unresolvedFindings: number
    activeTasks: number
    blockedTasks: number
  }
}

// =============================================================================
// Subscription & Notification System
// =============================================================================

export const SubscriptionPatternType = z.enum(["topic", "entity", "agent", "status", "context"])
export type SubscriptionPatternType = z.infer<typeof SubscriptionPatternType>

export const SubscriptionStatus = z.enum(["active", "paused", "expired"])
export type SubscriptionStatus = z.infer<typeof SubscriptionStatus>

export const SubscriptionFiltersSchema = z.object({
  severity: z.array(FindingSeverity).optional().describe("Only notify for these severities"),
  min_confidence: z.number().min(0).max(1).optional().describe("Minimum confidence threshold"),
  exclude_self: z.boolean().default(true).describe("Don't notify on own actions"),
})

export type SubscriptionFilters = z.infer<typeof SubscriptionFiltersSchema>

export const SubscriptionSchema = z.object({
  id: z.string().min(1).describe("Unique subscription identifier"),
  subscriber_id: z.string().min(1).describe("Agent ID who created this subscription"),
  pattern_type: SubscriptionPatternType.describe("What to match: topic, entity, agent, status, context"),
  pattern_value: z.string().min(1).describe("Pattern to match (e.g., 'security' for topic, 'scanner' for agent)"),
  filters: SubscriptionFiltersSchema.optional(),
  created_at: z.string().datetime(),
  expires_at: z.string().datetime().optional().describe("Auto-expire after this time"),
  status: SubscriptionStatus.default("active"),
})

export type Subscription = z.infer<typeof SubscriptionSchema>

export const NotificationEventType = z.enum([
  "finding_created",
  "finding_updated",
  "finding_resolved",
  "task_created",
  "task_updated",
  "task_claimed",
  "task_completed",
])
export type NotificationEventType = z.infer<typeof NotificationEventType>

export const NotificationSourceType = z.enum(["finding", "task"])
export type NotificationSourceType = z.infer<typeof NotificationSourceType>

export const NotificationStatus = z.enum(["unread", "read", "dismissed"])
export type NotificationStatus = z.infer<typeof NotificationStatus>

export const NotificationSummarySchema = z.object({
  title: z.string().min(1),
  topic: z.string().optional(),
  severity: FindingSeverity.optional(),
  status: z.string().optional(),
})

export type NotificationSummary = z.infer<typeof NotificationSummarySchema>

export const NotificationSchema = z.object({
  id: z.string().min(1).describe("Unique notification identifier"),
  subscription_id: z.string().min(1).describe("Subscription that triggered this"),
  event_type: NotificationEventType.describe("What happened"),
  source_id: z.string().min(1).describe("ID of the finding/task that triggered this"),
  source_type: NotificationSourceType.describe("Whether source is finding or task"),
  source_agent_id: z.string().min(1).describe("Agent that performed the action"),
  summary: NotificationSummarySchema.describe("Quick overview without fetching full source"),
  recipient_id: z.string().min(1).describe("Agent who should receive this"),
  created_at: z.string().datetime(),
  read_at: z.string().datetime().optional(),
  status: NotificationStatus.default("unread"),
})

export type Notification = z.infer<typeof NotificationSchema>

// Event passed to triggerNotifications
export interface BlackboardEvent {
  event_type: NotificationEventType
  source_id: string
  source_type: "finding" | "task"
  source_agent_id: string
  // Event-specific data for matching
  topic?: string
  severity?: FindingSeverity
  status?: string
  context_id?: string
  title: string
}
