// index.ts
import { tool } from "@opencode-ai/plugin";
import { z as z2 } from "zod";

// blackboard.ts
class YamsBlackboard {
  $;
  options;
  sessionName;
  sessionActive = false;
  constructor($, options = {}) {
    this.$ = $;
    this.options = options;
    this.sessionName = options.sessionName;
  }
  genId(prefix) {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
  nowISO() {
    return new Date().toISOString();
  }
  sessionArg() {
    return this.sessionName ? `--session ${this.sessionName}` : "";
  }
  shellEscape(s) {
    return `'${s.replace(/'/g, "'\\''")}'`;
  }
  isBufferLike(value) {
    return value !== null && typeof value === "object" && typeof value.toString === "function" && value.constructor?.name === "Buffer";
  }
  async shell(cmd) {
    try {
      const result = await this.$`sh -c ${cmd + " 2>&1"}`;
      if (typeof result === "string") {
        return result.trim();
      }
      if (result && typeof result === "object") {
        let raw = result.stdout ?? result.output ?? result.text;
        if (raw instanceof Uint8Array || Buffer.isBuffer(raw)) {
          return new TextDecoder().decode(raw).trim();
        }
        if (typeof raw === "string") {
          return raw.trim();
        }
        if (typeof raw === "function") {
          const text = await raw();
          return typeof text === "string" ? text.trim() : String(text).trim();
        }
      }
      return String(result ?? "").trim();
    } catch (e) {
      throw new Error(`Shell command failed: ${e.message}`);
    }
  }
  async yams(cmd) {
    return this.shell(`yams ${cmd}`);
  }
  async yamsJson(cmd) {
    const result = await this.yams(`${cmd} --json`);
    try {
      return JSON.parse(result);
    } catch {
      throw new Error(`Failed to parse YAMS JSON response: ${result}`);
    }
  }
  async yamsStore(content, name, tags, extraArgs = "") {
    const escaped = this.shellEscape(content);
    const cmd = `echo ${escaped} | yams add - --name ${this.shellEscape(name)} --tags ${this.shellEscape(tags)} ${extraArgs}`;
    return this.shell(cmd);
  }
  async startSession(name) {
    this.sessionName = name || `opencode-${Date.now()}`;
    await this.yams(`session_start --name "${this.sessionName}"`);
    this.sessionActive = true;
    return this.sessionName;
  }
  async stopSession() {
    if (this.sessionName && this.sessionActive) {
      await this.yams(`session_stop --name "${this.sessionName}"`);
      this.sessionActive = false;
    }
  }
  getSessionName() {
    return this.sessionName;
  }
  async registerAgent(agent) {
    const full = {
      ...agent,
      registered_at: this.nowISO(),
      status: agent.status || "active"
    };
    const content = JSON.stringify(full, null, 2);
    const tags = [
      "agent",
      ...agent.capabilities.map((c) => `capability:${c}`)
    ].join(",");
    await this.yamsStore(content, `agents/${agent.id}.json`, tags, this.sessionArg());
    return full;
  }
  async getAgent(agentId) {
    try {
      const result = await this.yamsJson(`cat --name "agents/${agentId}.json"`);
      return JSON.parse(result.content);
    } catch {
      return null;
    }
  }
  async listAgents() {
    try {
      const result = await this.yamsJson(`list --tags "agent" --limit 100`);
      const agents = [];
      for (const doc of result.documents || []) {
        try {
          const content = await this.yams(`cat --name "${doc.name}"`);
          agents.push(JSON.parse(content));
        } catch {}
      }
      return agents;
    } catch {
      return [];
    }
  }
  async updateAgentStatus(agentId, status) {
    const agent = await this.getAgent(agentId);
    if (agent) {
      agent.status = status;
      const content = JSON.stringify(agent, null, 2);
      await this.yamsStore(content, `agents/${agentId}.json`, "agent");
    }
  }
  findingToMarkdown(finding) {
    const frontmatter = {
      id: finding.id,
      agent_id: finding.agent_id,
      topic: finding.topic,
      confidence: finding.confidence,
      status: finding.status,
      scope: finding.scope,
      created_at: this.nowISO()
    };
    if (finding.severity)
      frontmatter.severity = finding.severity;
    if (finding.context_id)
      frontmatter.context_id = finding.context_id;
    if (finding.parent_id)
      frontmatter.parent_id = finding.parent_id;
    if (finding.references?.length)
      frontmatter.references = finding.references;
    if (finding.ttl)
      frontmatter.ttl = finding.ttl;
    if (finding.metadata)
      frontmatter.metadata = finding.metadata;
    const fm = Object.entries(frontmatter).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(`
`);
    return `---
${fm}
---

# ${finding.title}

${finding.content}
`;
  }
  buildFindingTags(finding) {
    const tags = [
      "finding",
      `agent:${finding.agent_id}`,
      `topic:${finding.topic}`,
      `scope:${finding.scope || "persistent"}`,
      `status:${finding.status || "published"}`
    ];
    if (finding.severity)
      tags.push(`severity:${finding.severity}`);
    if (finding.context_id)
      tags.push(`ctx:${finding.context_id}`);
    return tags.join(",");
  }
  async postFinding(input) {
    const id = this.genId("f");
    const finding = {
      ...input,
      id,
      status: input.status || "published",
      scope: input.scope || this.options.defaultScope || "persistent"
    };
    const md = this.findingToMarkdown(finding);
    const tags = this.buildFindingTags(finding);
    const name = `findings/${finding.topic}/${id}.md`;
    await this.yamsStore(md, name, tags, this.sessionArg());
    return finding;
  }
  async getFinding(findingId) {
    try {
      const result = await this.yams(`cat --name "findings/**/${findingId}.md"`);
      const match = result.match(/^---\n([\s\S]*?)\n---\n\n# (.*?)\n\n([\s\S]*)$/);
      if (!match)
        return null;
      const frontmatter = {};
      match[1].split(`
`).forEach((line) => {
        const [key, ...rest] = line.split(": ");
        if (key && rest.length) {
          try {
            frontmatter[key] = JSON.parse(rest.join(": "));
          } catch {
            frontmatter[key] = rest.join(": ");
          }
        }
      });
      return {
        ...frontmatter,
        title: match[2],
        content: match[3].trim()
      };
    } catch {
      return null;
    }
  }
  async queryFindings(query) {
    const tags = ["finding"];
    if (query.topic)
      tags.push(`topic:${query.topic}`);
    if (query.agent_id)
      tags.push(`agent:${query.agent_id}`);
    if (query.context_id)
      tags.push(`ctx:${query.context_id}`);
    if (query.status)
      tags.push(`status:${query.status}`);
    if (query.scope)
      tags.push(`scope:${query.scope}`);
    if (query.severity?.length) {
      tags.push(`severity:${query.severity[0]}`);
    }
    try {
      const result = await this.yamsJson(`list --tags "${tags.join(",")}" --limit ${query.limit} --offset ${query.offset} ${this.sessionArg()}`);
      const findings = [];
      for (const doc of result.documents || []) {
        const finding = await this.getFinding(doc.name?.split("/").pop()?.replace(".md", "") || "");
        if (finding) {
          if (query.min_confidence && finding.confidence < query.min_confidence)
            continue;
          findings.push(finding);
        }
      }
      return findings;
    } catch {
      return [];
    }
  }
  async searchFindings(query, opts) {
    const tags = opts?.topic ? `finding,topic:${opts.topic}` : "finding";
    const limit = opts?.limit || 10;
    try {
      const result = await this.yamsJson(`search "${query}" --tags "${tags}" --limit ${limit} ${this.sessionArg()}`);
      const findings = [];
      for (const r of result.results || []) {
        const id = r.path?.split("/").pop()?.replace(".md", "");
        if (id) {
          const finding = await this.getFinding(id);
          if (finding)
            findings.push(finding);
        }
      }
      return findings;
    } catch {
      return [];
    }
  }
  async acknowledgeFinding(findingId, agentId) {
    await this.yams(`update --name "findings/**/${findingId}.md" --tags "status:acknowledged" --metadata '{"acknowledged_by":"${agentId}","acknowledged_at":"${this.nowISO()}"}'`);
  }
  async resolveFinding(findingId, resolvedBy, resolution) {
    await this.yams(`update --name "findings/**/${findingId}.md" --tags "status:resolved" --metadata '{"resolved_by":"${resolvedBy}","resolution":"${resolution}","resolved_at":"${this.nowISO()}"}'`);
  }
  buildTaskTags(task) {
    const tags = [
      "task",
      `type:${task.type}`,
      `status:${task.status || "pending"}`,
      `priority:${task.priority}`,
      `creator:${task.created_by}`
    ];
    if (task.assigned_to)
      tags.push(`assignee:${task.assigned_to}`);
    if (task.context_id)
      tags.push(`ctx:${task.context_id}`);
    return tags.join(",");
  }
  async createTask(input) {
    const id = this.genId("t");
    const task = {
      ...input,
      id,
      status: "pending",
      priority: input.priority ?? 2
    };
    const content = JSON.stringify(task, null, 2);
    const tags = this.buildTaskTags(task);
    await this.yamsStore(content, `tasks/${id}.json`, tags, this.sessionArg());
    return task;
  }
  async getTask(taskId) {
    try {
      const result = await this.yams(`cat --name "tasks/${taskId}.json"`);
      return JSON.parse(result);
    } catch {
      return null;
    }
  }
  async queryTasks(query) {
    const tags = ["task"];
    if (query.type)
      tags.push(`type:${query.type}`);
    if (query.status)
      tags.push(`status:${query.status}`);
    if (query.priority !== undefined)
      tags.push(`priority:${query.priority}`);
    if (query.created_by)
      tags.push(`creator:${query.created_by}`);
    if (query.assigned_to)
      tags.push(`assignee:${query.assigned_to}`);
    if (query.context_id)
      tags.push(`ctx:${query.context_id}`);
    try {
      const result = await this.yamsJson(`list --tags "${tags.join(",")}" --limit ${query.limit} --offset ${query.offset} ${this.sessionArg()}`);
      const tasks = [];
      for (const doc of result.documents || []) {
        const task = await this.getTask(doc.name?.replace("tasks/", "").replace(".json", "") || "");
        if (task)
          tasks.push(task);
      }
      return tasks;
    } catch {
      return [];
    }
  }
  async getReadyTasks(agentCapabilities) {
    const pending = await this.queryTasks({ status: "pending", limit: 100, offset: 0 });
    const ready = [];
    for (const task of pending) {
      if (task.depends_on?.length) {
        const deps = await Promise.all(task.depends_on.map((id) => this.getTask(id)));
        const allComplete = deps.every((d) => d?.status === "completed");
        if (!allComplete)
          continue;
      }
      ready.push(task);
    }
    return ready.sort((a, b) => (a.priority ?? 2) - (b.priority ?? 2));
  }
  async claimTask(taskId, agentId) {
    const task = await this.getTask(taskId);
    if (!task || task.status !== "pending")
      return null;
    task.status = "claimed";
    task.assigned_to = agentId;
    task.claimed_at = this.nowISO();
    const content = JSON.stringify(task, null, 2);
    const tags = this.buildTaskTags(task);
    await this.yamsStore(content, `tasks/${taskId}.json`, tags);
    return task;
  }
  async updateTask(taskId, updates) {
    const task = await this.getTask(taskId);
    if (!task)
      return null;
    Object.assign(task, updates);
    const content = JSON.stringify(task, null, 2);
    const tags = this.buildTaskTags(task);
    await this.yamsStore(content, `tasks/${taskId}.json`, tags);
    return task;
  }
  async completeTask(taskId, results) {
    return this.updateTask(taskId, {
      status: "completed",
      findings: results?.findings,
      artifacts: results?.artifacts
    });
  }
  async failTask(taskId, error) {
    return this.updateTask(taskId, { status: "failed", error });
  }
  async createContext(id, name, description) {
    const context = {
      id,
      name,
      description,
      findings: [],
      tasks: [],
      agents: [],
      status: "active"
    };
    const content = JSON.stringify(context, null, 2);
    await this.yamsStore(content, `contexts/${id}.json`, "context,status:active");
    return context;
  }
  async getContext(contextId) {
    try {
      const result = await this.yams(`cat --name "contexts/${contextId}.json"`);
      return JSON.parse(result);
    } catch {
      return null;
    }
  }
  async getContextSummary(contextId) {
    const findings = await this.queryFindings({ context_id: contextId, limit: 100, offset: 0 });
    const tasks = await this.queryTasks({ context_id: contextId, limit: 100, offset: 0 });
    const agents = await this.listAgents();
    const activeAgents = agents.filter((a) => a.status === "active");
    const highSeverity = findings.filter((f) => f.severity === "high" || f.severity === "critical");
    const unresolved = findings.filter((f) => f.status !== "resolved");
    const activeTasks = tasks.filter((t) => t.status === "working" || t.status === "claimed");
    const blockedTasks = tasks.filter((t) => t.status === "blocked");
    return `## Blackboard Summary (Context: ${contextId})

### Agents Active (${activeAgents.length})
${activeAgents.map((a) => `- ${a.id}: ${a.capabilities.join(", ")}`).join(`
`) || "- None"}

### Key Findings (${findings.length} total, ${unresolved.length} unresolved)
${highSeverity.slice(0, 5).map((f) => `- [${f.severity?.toUpperCase()}] ${f.title} (${f.agent_id}, ${f.confidence.toFixed(2)} confidence)`).join(`
`) || "- None"}
${findings.length > 5 ? `- ... and ${findings.length - 5} more` : ""}

### Tasks
${activeTasks.map((t) => `- [${t.status.toUpperCase()}] ${t.title} (assigned: ${t.assigned_to || "unassigned"})`).join(`
`) || "- No active tasks"}
${blockedTasks.length ? `
**Blocked (${blockedTasks.length}):**
${blockedTasks.map((t) => `- ${t.title}`).join(`
`)}` : ""}

### Unresolved Issues
${unresolved.length ? `- ${unresolved.length} findings need resolution` : "- All findings resolved"}
${blockedTasks.length ? `- ${blockedTasks.length} tasks blocked` : ""}
`;
  }
  async getConnections(entityPath, depth = 2) {
    try {
      const result = await this.yamsJson(`graph --name "${entityPath}" --depth ${depth}`);
      return {
        nodes: result.connected_nodes || [],
        edges: []
      };
    } catch {
      return { nodes: [], edges: [] };
    }
  }
  async getStats() {
    const agents = await this.listAgents();
    const findings = await this.queryFindings({ limit: 1000, offset: 0 });
    const tasks = await this.queryTasks({ limit: 1000, offset: 0 });
    const findingsByTopic = {};
    const findingsByStatus = {};
    const findingsBySeverity = {};
    for (const f of findings) {
      findingsByTopic[f.topic] = (findingsByTopic[f.topic] || 0) + 1;
      findingsByStatus[f.status] = (findingsByStatus[f.status] || 0) + 1;
      if (f.severity)
        findingsBySeverity[f.severity] = (findingsBySeverity[f.severity] || 0) + 1;
    }
    const tasksByStatus = {};
    const tasksByType = {};
    for (const t of tasks) {
      tasksByStatus[t.status] = (tasksByStatus[t.status] || 0) + 1;
      tasksByType[t.type] = (tasksByType[t.type] || 0) + 1;
    }
    return {
      agents: agents.length,
      findings: {
        total: findings.length,
        by_topic: findingsByTopic,
        by_status: findingsByStatus,
        by_severity: findingsBySeverity
      },
      tasks: {
        total: tasks.length,
        by_status: tasksByStatus,
        by_type: tasksByType
      },
      contexts: 0
    };
  }
}

// types.ts
import { z } from "zod";
var AgentCardSchema = z.object({
  id: z.string().min(1).describe("Unique agent identifier"),
  name: z.string().min(1).describe("Human-readable name"),
  capabilities: z.array(z.string()).min(1).describe("What this agent can do"),
  version: z.string().optional(),
  registered_at: z.string().datetime().optional(),
  status: z.enum(["active", "idle", "offline"]).default("active")
});
var ReferenceSchema = z.object({
  type: z.enum(["file", "url", "finding", "task", "symbol"]),
  target: z.string().min(1).describe("Path, URL, ID, or symbol name"),
  label: z.string().optional().describe("Human-readable label"),
  line_start: z.number().int().positive().optional(),
  line_end: z.number().int().positive().optional()
});
var FindingSeverity = z.enum(["info", "low", "medium", "high", "critical"]);
var FindingStatus = z.enum(["draft", "published", "acknowledged", "resolved", "rejected"]);
var FindingScope = z.enum(["session", "persistent"]);
var FindingTopic = z.enum([
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
]);
var FindingSchema = z.object({
  id: z.string().optional().describe("Auto-generated if not provided"),
  agent_id: z.string().min(1).describe("Agent that produced this finding"),
  topic: FindingTopic.describe("Category of the finding"),
  title: z.string().min(1).max(200).describe("Brief summary"),
  content: z.string().min(1).describe("Full details in markdown"),
  confidence: z.number().min(0).max(1).default(0.8).describe("How certain the agent is"),
  severity: FindingSeverity.optional().describe("Impact level"),
  context_id: z.string().optional().describe("Groups related findings"),
  references: z.array(ReferenceSchema).optional().describe("Links to code, docs, other findings"),
  parent_id: z.string().optional().describe("For threaded/reply findings"),
  status: FindingStatus.default("published"),
  resolved_by: z.string().optional().describe("Agent that resolved this"),
  resolution: z.string().optional().describe("How it was resolved"),
  scope: FindingScope.default("persistent"),
  ttl: z.number().int().positive().optional().describe("TTL in seconds for session-scoped"),
  metadata: z.record(z.string(), z.string()).optional()
});
var CreateFindingSchema = FindingSchema.omit({
  id: true,
  status: true,
  resolved_by: true,
  resolution: true
}).extend({
  status: FindingStatus.optional()
});
var TaskType = z.enum(["analysis", "fix", "review", "test", "research", "synthesis"]);
var TaskStatus = z.enum([
  "pending",
  "claimed",
  "working",
  "blocked",
  "review",
  "completed",
  "failed",
  "cancelled"
]);
var TaskPriority = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4)
]);
var ArtifactSchema = z.object({
  name: z.string().min(1),
  type: z.enum(["file", "data", "report"]),
  path: z.string().optional().describe("YAMS path or local path"),
  hash: z.string().optional().describe("YAMS content hash"),
  mime_type: z.string().optional()
});
var TaskSchema = z.object({
  id: z.string().optional().describe("Auto-generated if not provided"),
  title: z.string().min(1).max(200).describe("What needs to be done"),
  description: z.string().optional().describe("Detailed requirements"),
  type: TaskType.describe("Kind of task"),
  priority: TaskPriority.default(2).describe("0=critical, 4=backlog"),
  status: TaskStatus.default("pending"),
  created_by: z.string().min(1).describe("Agent that created the task"),
  assigned_to: z.string().optional().describe("Agent currently working on it"),
  claimed_at: z.string().datetime().optional(),
  depends_on: z.array(z.string()).optional().describe("Task IDs that must complete first"),
  blocks: z.array(z.string()).optional().describe("Task IDs waiting on this"),
  findings: z.array(z.string()).optional().describe("Finding IDs produced"),
  artifacts: z.array(ArtifactSchema).optional().describe("Output files/data"),
  context_id: z.string().optional().describe("Groups related tasks"),
  parent_task: z.string().optional().describe("For subtasks"),
  error: z.string().optional().describe("Error message if failed"),
  retry_count: z.number().int().nonnegative().optional(),
  max_retries: z.number().int().nonnegative().optional(),
  metadata: z.record(z.string(), z.string()).optional()
});
var CreateTaskSchema = TaskSchema.omit({
  id: true,
  status: true,
  assigned_to: true,
  claimed_at: true,
  findings: true,
  artifacts: true,
  error: true,
  retry_count: true
});
var ContextStatus = z.enum(["active", "completed", "archived"]);
var ContextSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).describe("Human-readable name"),
  description: z.string().optional(),
  findings: z.array(z.string()).default([]),
  tasks: z.array(z.string()).default([]),
  agents: z.array(z.string()).default([]),
  status: ContextStatus.default("active"),
  summary: z.string().optional().describe("AI-generated summary"),
  key_findings: z.array(z.string()).optional().describe("Most important finding IDs")
});
var FindingQuerySchema = z.object({
  topic: FindingTopic.optional(),
  agent_id: z.string().optional(),
  context_id: z.string().optional(),
  status: FindingStatus.optional(),
  severity: z.array(FindingSeverity).optional(),
  min_confidence: z.number().min(0).max(1).optional(),
  scope: FindingScope.optional(),
  limit: z.number().int().positive().default(20),
  offset: z.number().int().nonnegative().default(0)
});
var TaskQuerySchema = z.object({
  type: TaskType.optional(),
  status: TaskStatus.optional(),
  priority: TaskPriority.optional(),
  created_by: z.string().optional(),
  assigned_to: z.string().optional(),
  context_id: z.string().optional(),
  limit: z.number().int().positive().default(20),
  offset: z.number().int().nonnegative().default(0)
});

// index.ts
var YamsBlackboardPlugin = async ({ $, project, directory }) => {
  const blackboard = new YamsBlackboard($, { defaultScope: "persistent" });
  let currentContextId;
  return {
    "session.created": async () => {
      await blackboard.startSession();
    },
    "session.compacted": async (input, output) => {
      try {
        const contextId = currentContextId || "default";
        const summary = await blackboard.getContextSummary(contextId);
        output.context.push(summary);
      } catch {}
    },
    tool: {
      bb_register_agent: tool({
        description: "Register an agent's identity and capabilities on the blackboard. Call this when starting work to announce your presence.",
        args: {
          id: z2.string().min(1).describe("Unique agent identifier (e.g., 'security-scanner')"),
          name: z2.string().min(1).describe("Human-readable name"),
          capabilities: z2.array(z2.string()).min(1).describe("List of capabilities (e.g., ['code-review', 'security-audit'])")
        },
        async execute(args) {
          const agent = await blackboard.registerAgent({
            id: args.id,
            name: args.name,
            capabilities: args.capabilities,
            status: "active"
          });
          return `Agent registered: ${agent.id}
Capabilities: ${agent.capabilities.join(", ")}
Registered at: ${agent.registered_at}`;
        }
      }),
      bb_list_agents: tool({
        description: "List all registered agents and their capabilities",
        args: {},
        async execute() {
          const agents = await blackboard.listAgents();
          if (agents.length === 0) {
            return "No agents registered yet.";
          }
          return agents.map((a) => `${a.id} (${a.status})
  Name: ${a.name}
  Capabilities: ${a.capabilities.join(", ")}`).join(`

`);
        }
      }),
      bb_post_finding: tool({
        description: "Post a finding to the shared blackboard for other agents to discover. Use this to share discoveries, observations, issues, or insights.",
        args: {
          agent_id: z2.string().min(1).describe("Your agent identifier"),
          topic: FindingTopic.describe("Category: security, performance, bug, architecture, refactor, test, doc, dependency, accessibility, other"),
          title: z2.string().min(1).max(200).describe("Brief summary of the finding"),
          content: z2.string().min(1).describe("Full details in markdown"),
          confidence: z2.number().min(0).max(1).optional().describe("Confidence level 0-1 (default: 0.8)"),
          severity: FindingSeverity.optional().describe("Impact level: info, low, medium, high, critical"),
          references: z2.array(z2.object({
            type: z2.enum(["file", "url", "finding", "task", "symbol"]),
            target: z2.string(),
            label: z2.string().optional(),
            line_start: z2.number().optional(),
            line_end: z2.number().optional()
          })).optional().describe("Related files, URLs, or other findings"),
          context_id: z2.string().optional().describe("Group with related findings"),
          parent_id: z2.string().optional().describe("Reply to another finding"),
          scope: FindingScope.optional().describe("Persistence: 'persistent' (default) or 'session'"),
          metadata: z2.record(z2.string(), z2.string()).optional().describe("Additional key-value metadata")
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
            metadata: args.metadata
          });
          return `Finding posted: ${finding.id}
Topic: ${finding.topic}
Title: ${finding.title}
Confidence: ${finding.confidence}
${finding.severity ? `Severity: ${finding.severity}` : ""}
${finding.context_id ? `Context: ${finding.context_id}` : ""}`;
        }
      }),
      bb_query_findings: tool({
        description: "Query findings from the blackboard by topic, agent, severity, or context. Use to discover what other agents have found.",
        args: {
          topic: FindingTopic.optional().describe("Filter by topic"),
          agent_id: z2.string().optional().describe("Filter by source agent"),
          context_id: z2.string().optional().describe("Filter by context group"),
          status: FindingStatus.optional().describe("Filter by status"),
          severity: z2.array(FindingSeverity).optional().describe("Filter by severity levels"),
          min_confidence: z2.number().min(0).max(1).optional().describe("Minimum confidence threshold"),
          scope: FindingScope.optional().describe("Filter by persistence scope"),
          limit: z2.number().int().positive().optional().describe("Max results (default: 20)")
        },
        async execute(args) {
          const findings = await blackboard.queryFindings({
            ...args,
            context_id: args.context_id || currentContextId,
            limit: args.limit ?? 20,
            offset: 0
          });
          if (findings.length === 0) {
            return "No findings match the query.";
          }
          return findings.map((f) => `[${f.id}] ${f.topic.toUpperCase()} | ${f.title}
  Agent: ${f.agent_id} | Confidence: ${f.confidence.toFixed(2)}${f.severity ? ` | Severity: ${f.severity}` : ""}
  Status: ${f.status}${f.context_id ? ` | Context: ${f.context_id}` : ""}`).join(`

`);
        }
      }),
      bb_search_findings: tool({
        description: "Search findings using natural language. Uses semantic search to find relevant findings.",
        args: {
          query: z2.string().min(1).describe("Natural language search query"),
          topic: FindingTopic.optional().describe("Limit to specific topic"),
          limit: z2.number().int().positive().optional().describe("Max results (default: 10)")
        },
        async execute(args) {
          const findings = await blackboard.searchFindings(args.query, {
            topic: args.topic,
            limit: args.limit ?? 10
          });
          if (findings.length === 0) {
            return "No findings match the search.";
          }
          return findings.map((f) => `[${f.id}] ${f.topic.toUpperCase()} | ${f.title}
  ${f.content.slice(0, 200)}${f.content.length > 200 ? "..." : ""}`).join(`

`);
        }
      }),
      bb_get_finding: tool({
        description: "Get full details of a specific finding by ID",
        args: {
          finding_id: z2.string().min(1).describe("The finding ID")
        },
        async execute(args) {
          const finding = await blackboard.getFinding(args.finding_id);
          if (!finding) {
            return `Finding not found: ${args.finding_id}`;
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

${finding.content}`;
        }
      }),
      bb_acknowledge_finding: tool({
        description: "Mark a finding as acknowledged (you've seen it)",
        args: {
          finding_id: z2.string().min(1).describe("The finding ID to acknowledge"),
          agent_id: z2.string().min(1).describe("Your agent ID")
        },
        async execute(args) {
          await blackboard.acknowledgeFinding(args.finding_id, args.agent_id);
          return `Finding ${args.finding_id} acknowledged by ${args.agent_id}`;
        }
      }),
      bb_resolve_finding: tool({
        description: "Mark a finding as resolved with an explanation",
        args: {
          finding_id: z2.string().min(1).describe("The finding ID to resolve"),
          agent_id: z2.string().min(1).describe("Your agent ID"),
          resolution: z2.string().min(1).describe("How the finding was resolved")
        },
        async execute(args) {
          await blackboard.resolveFinding(args.finding_id, args.agent_id, args.resolution);
          return `Finding ${args.finding_id} resolved by ${args.agent_id}: ${args.resolution}`;
        }
      }),
      bb_create_task: tool({
        description: "Create a new task on the blackboard for agents to claim and work on",
        args: {
          title: z2.string().min(1).max(200).describe("What needs to be done"),
          description: z2.string().optional().describe("Detailed requirements"),
          type: TaskType.describe("Kind of task: analysis, fix, review, test, research, synthesis"),
          priority: TaskPriority.optional().describe("0=critical, 1=high, 2=medium, 3=low, 4=backlog"),
          created_by: z2.string().min(1).describe("Your agent ID"),
          depends_on: z2.array(z2.string()).optional().describe("Task IDs that must complete first"),
          context_id: z2.string().optional().describe("Group with related tasks")
        },
        async execute(args) {
          const task = await blackboard.createTask({
            title: args.title,
            description: args.description,
            type: args.type,
            priority: args.priority ?? 2,
            created_by: args.created_by,
            depends_on: args.depends_on,
            context_id: args.context_id || currentContextId
          });
          return `Task created: ${task.id}
Title: ${task.title}
Type: ${task.type}
Priority: ${task.priority}
Status: ${task.status}
${task.depends_on?.length ? `Depends on: ${task.depends_on.join(", ")}` : ""}`;
        }
      }),
      bb_get_ready_tasks: tool({
        description: "Get tasks that are ready to work on (pending, no unmet dependencies). Use this to find work.",
        args: {
          limit: z2.number().int().positive().optional().describe("Max results")
        },
        async execute(args) {
          const tasks = await blackboard.getReadyTasks();
          const limited = tasks.slice(0, args.limit || 10);
          if (limited.length === 0) {
            return "No tasks ready to work on.";
          }
          return limited.map((t) => `[${t.id}] P${t.priority} ${t.type.toUpperCase()} | ${t.title}
  Created by: ${t.created_by}
  ${t.description ? `Description: ${t.description.slice(0, 100)}...` : ""}`).join(`

`);
        }
      }),
      bb_claim_task: tool({
        description: "Claim a pending task to work on it",
        args: {
          task_id: z2.string().min(1).describe("The task ID to claim"),
          agent_id: z2.string().min(1).describe("Your agent ID")
        },
        async execute(args) {
          const task = await blackboard.claimTask(args.task_id, args.agent_id);
          if (!task) {
            return `Failed to claim task ${args.task_id}. It may not exist or is already claimed.`;
          }
          return `Task claimed: ${task.id}
Title: ${task.title}
Assigned to: ${task.assigned_to}
Status: ${task.status}`;
        }
      }),
      bb_update_task: tool({
        description: "Update the status of a task you're working on",
        args: {
          task_id: z2.string().min(1).describe("The task ID"),
          status: TaskStatus.describe("New status: working, blocked, review"),
          error: z2.string().optional().describe("Error message if blocked/failed")
        },
        async execute(args) {
          const task = await blackboard.updateTask(args.task_id, {
            status: args.status,
            error: args.error
          });
          if (!task) {
            return `Task not found: ${args.task_id}`;
          }
          return `Task ${task.id} updated to status: ${task.status}`;
        }
      }),
      bb_complete_task: tool({
        description: "Mark a task as completed, optionally with findings or artifacts",
        args: {
          task_id: z2.string().min(1).describe("The task ID"),
          findings: z2.array(z2.string()).optional().describe("Finding IDs produced by this task")
        },
        async execute(args) {
          const task = await blackboard.completeTask(args.task_id, {
            findings: args.findings
          });
          if (!task) {
            return `Task not found: ${args.task_id}`;
          }
          return `Task completed: ${task.id}
Title: ${task.title}
${args.findings?.length ? `Findings: ${args.findings.join(", ")}` : ""}`;
        }
      }),
      bb_fail_task: tool({
        description: "Mark a task as failed with an error message",
        args: {
          task_id: z2.string().min(1).describe("The task ID"),
          error: z2.string().min(1).describe("What went wrong")
        },
        async execute(args) {
          const task = await blackboard.failTask(args.task_id, args.error);
          if (!task) {
            return `Task not found: ${args.task_id}`;
          }
          return `Task failed: ${task.id}
Error: ${args.error}`;
        }
      }),
      bb_query_tasks: tool({
        description: "Query tasks by type, status, priority, or assignee",
        args: {
          type: TaskType.optional().describe("Filter by task type"),
          status: TaskStatus.optional().describe("Filter by status"),
          priority: TaskPriority.optional().describe("Filter by priority"),
          created_by: z2.string().optional().describe("Filter by creator"),
          assigned_to: z2.string().optional().describe("Filter by assignee"),
          context_id: z2.string().optional().describe("Filter by context"),
          limit: z2.number().int().positive().optional().describe("Max results")
        },
        async execute(args) {
          const tasks = await blackboard.queryTasks({
            ...args,
            context_id: args.context_id || currentContextId,
            limit: args.limit ?? 20,
            offset: 0
          });
          if (tasks.length === 0) {
            return "No tasks match the query.";
          }
          return tasks.map((t) => `[${t.id}] P${t.priority} ${t.type} | ${t.title}
  Status: ${t.status} | Created: ${t.created_by}${t.assigned_to ? ` | Assigned: ${t.assigned_to}` : ""}`).join(`

`);
        }
      }),
      bb_create_context: tool({
        description: "Create a new context to group related findings and tasks together",
        args: {
          id: z2.string().min(1).describe("Context identifier (e.g., 'security-audit-2025')"),
          name: z2.string().min(1).describe("Human-readable name"),
          description: z2.string().optional().describe("What this context is about"),
          set_current: z2.boolean().optional().describe("Set as current context (default: true)")
        },
        async execute(args) {
          const context = await blackboard.createContext(args.id, args.name, args.description);
          if (args.set_current !== false) {
            currentContextId = context.id;
          }
          return `Context created: ${context.id}
Name: ${context.name}
${context.description ? `Description: ${context.description}` : ""}
${args.set_current !== false ? "(Set as current context)" : ""}`;
        }
      }),
      bb_get_context_summary: tool({
        description: "Get a summary of a context including findings, tasks, and agents",
        args: {
          context_id: z2.string().optional().describe("Context ID (defaults to current)")
        },
        async execute(args) {
          const contextId = args.context_id || currentContextId || "default";
          return await blackboard.getContextSummary(contextId);
        }
      }),
      bb_set_context: tool({
        description: "Set the current working context for findings and tasks",
        args: {
          context_id: z2.string().min(1).describe("Context ID to set as current")
        },
        async execute(args) {
          currentContextId = args.context_id;
          return `Current context set to: ${args.context_id}`;
        }
      }),
      bb_recent_activity: tool({
        description: "Get recent findings and task updates across all topics",
        args: {
          limit: z2.number().int().positive().optional().describe("Max items (default: 10)")
        },
        async execute(args) {
          const limit = args.limit || 10;
          const findings = await blackboard.queryFindings({ limit, offset: 0 });
          const tasks = await blackboard.queryTasks({ limit, offset: 0 });
          const output = [`## Recent Activity
`];
          if (findings.length > 0) {
            output.push("### Findings");
            output.push(findings.map((f) => `- [${f.topic}] ${f.title} (${f.agent_id})`).join(`
`));
          }
          if (tasks.length > 0) {
            output.push(`
### Tasks`);
            output.push(tasks.map((t) => `- [${t.status}] ${t.title} (${t.type})`).join(`
`));
          }
          return output.join(`
`);
        }
      }),
      bb_stats: tool({
        description: "Get statistics about the blackboard (agents, findings, tasks)",
        args: {},
        async execute() {
          const stats = await blackboard.getStats();
          return `## Blackboard Statistics

### Agents: ${stats.agents}

### Findings: ${stats.findings.total}
By Topic: ${Object.entries(stats.findings.by_topic).map(([k, v]) => `${k}:${v}`).join(", ") || "none"}
By Status: ${Object.entries(stats.findings.by_status).map(([k, v]) => `${k}:${v}`).join(", ") || "none"}
By Severity: ${Object.entries(stats.findings.by_severity).map(([k, v]) => `${k}:${v}`).join(", ") || "none"}

### Tasks: ${stats.tasks.total}
By Status: ${Object.entries(stats.tasks.by_status).map(([k, v]) => `${k}:${v}`).join(", ") || "none"}
By Type: ${Object.entries(stats.tasks.by_type).map(([k, v]) => `${k}:${v}`).join(", ") || "none"}`;
        }
      }),
      bb_connections: tool({
        description: "Explore graph connections for a finding or document - see related code, findings, and concepts",
        args: {
          path: z2.string().min(1).describe("Path to the entity (e.g., 'findings/security/f-xxx.md')"),
          depth: z2.number().int().positive().optional().describe("Traversal depth (default: 2)")
        },
        async execute(args) {
          const graph = await blackboard.getConnections(args.path, args.depth ?? 2);
          if (graph.nodes.length === 0) {
            return "No connections found.";
          }
          return `## Connections for ${args.path}

Found ${graph.nodes.length} connected nodes:

${JSON.stringify(graph.nodes, null, 2)}`;
        }
      })
    }
  };
};
var open_code_blackboard_default = YamsBlackboardPlugin;
export {
  open_code_blackboard_default as default,
  YamsBlackboardPlugin
};
