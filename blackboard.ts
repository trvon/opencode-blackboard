/**
 * YAMS Blackboard - Interaction Layer
 *
 * Handles all communication with YAMS daemon via CLI.
 * Future: Could be replaced with direct socket connection for better performance.
 */

import type {
  AgentCard,
  Finding,
  CreateFinding,
  FindingQuery,
  Task,
  CreateTask,
  TaskQuery,
  Context,
  CompactionSummary,
  BlackboardStats,
} from "./types"

// Shell type from OpenCode plugin context
type Shell = {
  (strings: TemplateStringsArray, ...values: any[]): { text(): Promise<string> }
}

export class YamsBlackboard {
  private sessionName?: string
  private sessionActive = false

  constructor(
    private $: Shell,
    private options: {
      sessionName?: string
      defaultScope?: "session" | "persistent"
    } = {}
  ) {
    this.sessionName = options.sessionName
  }

  // ===========================================================================
  // Utility Methods
  // ===========================================================================

  private genId(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  }

  private nowISO(): string {
    return new Date().toISOString()
  }

  private sessionArg(): string {
    return this.sessionName ? `--session ${this.sessionName}` : ""
  }

  // Shell escape a string for safe inclusion in shell commands
  private shellEscape(s: string): string {
    return `'${s.replace(/'/g, "'\\''")}'`
  }

  // Execute a shell command string
  private async shell(cmd: string): Promise<string> {
    try {
      const result = await this.$`sh -c ${cmd}`.text()
      return result.trim()
    } catch (e: any) {
      throw new Error(`Shell command failed: ${e.message}`)
    }
  }

  // Execute a yams command
  private async yams(cmd: string): Promise<string> {
    return this.shell(`yams ${cmd}`)
  }

  // Execute yams and parse JSON response
  private async yamsJson<T>(cmd: string): Promise<T> {
    const result = await this.yams(`${cmd} --json`)
    try {
      return JSON.parse(result)
    } catch {
      throw new Error(`Failed to parse YAMS JSON response: ${result}`)
    }
  }

  // Store content via yams add with piping
  private async yamsStore(content: string, name: string, tags: string, extraArgs: string = ""): Promise<string> {
    const escaped = this.shellEscape(content)
    const cmd = `echo ${escaped} | yams add - --name ${this.shellEscape(name)} --tags ${this.shellEscape(tags)} ${extraArgs}`
    return this.shell(cmd)
  }

  // ===========================================================================
  // Session Management
  // ===========================================================================

  async startSession(name?: string): Promise<string> {
    this.sessionName = name || `opencode-${Date.now()}`
    await this.yams(`session_start --name "${this.sessionName}"`)
    this.sessionActive = true
    return this.sessionName
  }

  async stopSession(): Promise<void> {
    if (this.sessionName && this.sessionActive) {
      await this.yams(`session_stop --name "${this.sessionName}"`)
      this.sessionActive = false
    }
  }

  getSessionName(): string | undefined {
    return this.sessionName
  }

  // ===========================================================================
  // Agent Management
  // ===========================================================================

  async registerAgent(agent: Omit<AgentCard, "registered_at">): Promise<AgentCard> {
    const full: AgentCard = {
      ...agent,
      registered_at: this.nowISO(),
      status: agent.status || "active",
    }

    const content = JSON.stringify(full, null, 2)
    const tags = [
      "agent",
      ...agent.capabilities.map(c => `capability:${c}`),
    ].join(",")

    await this.yamsStore(content, `agents/${agent.id}.json`, tags, this.sessionArg())

    return full
  }

  async getAgent(agentId: string): Promise<AgentCard | null> {
    try {
      const result = await this.yamsJson<{ content: string }>(`cat --name "agents/${agentId}.json"`)
      return JSON.parse(result.content)
    } catch {
      return null
    }
  }

  async listAgents(): Promise<AgentCard[]> {
    try {
      const result = await this.yamsJson<{ documents: any[] }>(`list --tags "agent" --limit 100`)
      const agents: AgentCard[] = []
      for (const doc of result.documents || []) {
        try {
          const content = await this.yams(`cat --name "${doc.name}"`)
          agents.push(JSON.parse(content))
        } catch { /* skip malformed */ }
      }
      return agents
    } catch {
      return []
    }
  }

  async updateAgentStatus(agentId: string, status: AgentCard["status"]): Promise<void> {
    const agent = await this.getAgent(agentId)
    if (agent) {
      agent.status = status
      const content = JSON.stringify(agent, null, 2)
      await this.yamsStore(content, `agents/${agentId}.json`, "agent")
    }
  }

  // ===========================================================================
  // Finding Management
  // ===========================================================================

  private findingToMarkdown(finding: Finding): string {
    const frontmatter: Record<string, any> = {
      id: finding.id,
      agent_id: finding.agent_id,
      topic: finding.topic,
      confidence: finding.confidence,
      status: finding.status,
      scope: finding.scope,
      created_at: this.nowISO(),
    }

    if (finding.severity) frontmatter.severity = finding.severity
    if (finding.context_id) frontmatter.context_id = finding.context_id
    if (finding.parent_id) frontmatter.parent_id = finding.parent_id
    if (finding.references?.length) frontmatter.references = finding.references
    if (finding.ttl) frontmatter.ttl = finding.ttl
    if (finding.metadata) frontmatter.metadata = finding.metadata

    const fm = Object.entries(frontmatter)
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join("\n")

    return `---
${fm}
---

# ${finding.title}

${finding.content}
`
  }

  private buildFindingTags(finding: Finding | CreateFinding): string {
    const tags = [
      "finding",
      `agent:${finding.agent_id}`,
      `topic:${finding.topic}`,
      `scope:${finding.scope || "persistent"}`,
      `status:${finding.status || "published"}`,
    ]
    if (finding.severity) tags.push(`severity:${finding.severity}`)
    if (finding.context_id) tags.push(`ctx:${finding.context_id}`)
    return tags.join(",")
  }

  async postFinding(input: CreateFinding): Promise<Finding> {
    const id = this.genId("f")
    const finding: Finding = {
      ...input,
      id,
      status: input.status || "published",
      scope: input.scope || this.options.defaultScope || "persistent",
    }

    const md = this.findingToMarkdown(finding)
    const tags = this.buildFindingTags(finding)
    const name = `findings/${finding.topic}/${id}.md`

    await this.yamsStore(md, name, tags, this.sessionArg())

    return finding
  }

  async getFinding(findingId: string): Promise<Finding | null> {
    try {
      // Search by ID in the findings directory
      const result = await this.yams(`cat --name "findings/**/${findingId}.md"`)
      // Parse frontmatter
      const match = result.match(/^---\n([\s\S]*?)\n---\n\n# (.*?)\n\n([\s\S]*)$/)
      if (!match) return null

      const frontmatter: Record<string, any> = {}
      match[1].split("\n").forEach(line => {
        const [key, ...rest] = line.split(": ")
        if (key && rest.length) {
          try {
            frontmatter[key] = JSON.parse(rest.join(": "))
          } catch {
            frontmatter[key] = rest.join(": ")
          }
        }
      })

      return {
        ...frontmatter,
        title: match[2],
        content: match[3].trim(),
      } as Finding
    } catch {
      return null
    }
  }

  async queryFindings(query: FindingQuery): Promise<Finding[]> {
    const tags = ["finding"]
    if (query.topic) tags.push(`topic:${query.topic}`)
    if (query.agent_id) tags.push(`agent:${query.agent_id}`)
    if (query.context_id) tags.push(`ctx:${query.context_id}`)
    if (query.status) tags.push(`status:${query.status}`)
    if (query.scope) tags.push(`scope:${query.scope}`)
    if (query.severity?.length) {
      // For multiple severities, we'd need to query each
      tags.push(`severity:${query.severity[0]}`)
    }

    try {
      const result = await this.yamsJson<{ documents: any[] }>(
        `list --tags "${tags.join(",")}" --limit ${query.limit} --offset ${query.offset} ${this.sessionArg()}`
      )

      const findings: Finding[] = []
      for (const doc of result.documents || []) {
        const finding = await this.getFinding(doc.name?.split("/").pop()?.replace(".md", "") || "")
        if (finding) {
          // Apply confidence filter
          if (query.min_confidence && finding.confidence < query.min_confidence) continue
          findings.push(finding)
        }
      }
      return findings
    } catch {
      return []
    }
  }

  async searchFindings(query: string, opts?: { topic?: string; limit?: number }): Promise<Finding[]> {
    const tags = opts?.topic ? `finding,topic:${opts.topic}` : "finding"
    const limit = opts?.limit || 10

    try {
      const result = await this.yamsJson<{ results: any[] }>(
        `search "${query}" --tags "${tags}" --limit ${limit} ${this.sessionArg()}`
      )

      const findings: Finding[] = []
      for (const r of result.results || []) {
        const id = r.path?.split("/").pop()?.replace(".md", "")
        if (id) {
          const finding = await this.getFinding(id)
          if (finding) findings.push(finding)
        }
      }
      return findings
    } catch {
      return []
    }
  }

  async acknowledgeFinding(findingId: string, agentId: string): Promise<void> {
    await this.yams(
      `update --name "findings/**/${findingId}.md" --tags "status:acknowledged" --metadata '{"acknowledged_by":"${agentId}","acknowledged_at":"${this.nowISO()}"}'`
    )
  }

  async resolveFinding(
    findingId: string,
    resolvedBy: string,
    resolution: string
  ): Promise<void> {
    await this.yams(
      `update --name "findings/**/${findingId}.md" --tags "status:resolved" --metadata '{"resolved_by":"${resolvedBy}","resolution":"${resolution}","resolved_at":"${this.nowISO()}"}'`
    )
  }

  // ===========================================================================
  // Task Management
  // ===========================================================================

  private buildTaskTags(task: Task | CreateTask): string {
    const tags = [
      "task",
      `type:${task.type}`,
      `status:${(task as Task).status || "pending"}`,
      `priority:${task.priority}`,
      `creator:${task.created_by}`,
    ]
    if ((task as Task).assigned_to) tags.push(`assignee:${(task as Task).assigned_to}`)
    if (task.context_id) tags.push(`ctx:${task.context_id}`)
    return tags.join(",")
  }

  async createTask(input: CreateTask): Promise<Task> {
    const id = this.genId("t")
    const task: Task = {
      ...input,
      id,
      status: "pending",
      priority: input.priority ?? 2,
    }

    const content = JSON.stringify(task, null, 2)
    const tags = this.buildTaskTags(task)

    await this.yamsStore(content, `tasks/${id}.json`, tags, this.sessionArg())

    return task
  }

  async getTask(taskId: string): Promise<Task | null> {
    try {
      const result = await this.yams(`cat --name "tasks/${taskId}.json"`)
      return JSON.parse(result)
    } catch {
      return null
    }
  }

  async queryTasks(query: TaskQuery): Promise<Task[]> {
    const tags = ["task"]
    if (query.type) tags.push(`type:${query.type}`)
    if (query.status) tags.push(`status:${query.status}`)
    if (query.priority !== undefined) tags.push(`priority:${query.priority}`)
    if (query.created_by) tags.push(`creator:${query.created_by}`)
    if (query.assigned_to) tags.push(`assignee:${query.assigned_to}`)
    if (query.context_id) tags.push(`ctx:${query.context_id}`)

    try {
      const result = await this.yamsJson<{ documents: any[] }>(
        `list --tags "${tags.join(",")}" --limit ${query.limit} --offset ${query.offset} ${this.sessionArg()}`
      )

      const tasks: Task[] = []
      for (const doc of result.documents || []) {
        const task = await this.getTask(doc.name?.replace("tasks/", "").replace(".json", "") || "")
        if (task) tasks.push(task)
      }
      return tasks
    } catch {
      return []
    }
  }

  async getReadyTasks(agentCapabilities?: string[]): Promise<Task[]> {
    const pending = await this.queryTasks({ status: "pending", limit: 100 })

    // Filter out tasks with unmet dependencies
    const ready: Task[] = []
    for (const task of pending) {
      if (task.depends_on?.length) {
        const deps = await Promise.all(task.depends_on.map(id => this.getTask(id)))
        const allComplete = deps.every(d => d?.status === "completed")
        if (!allComplete) continue
      }
      ready.push(task)
    }

    // TODO: Filter by agent capabilities if provided

    return ready.sort((a, b) => (a.priority ?? 2) - (b.priority ?? 2))
  }

  async claimTask(taskId: string, agentId: string): Promise<Task | null> {
    const task = await this.getTask(taskId)
    if (!task || task.status !== "pending") return null

    task.status = "claimed"
    task.assigned_to = agentId
    task.claimed_at = this.nowISO()

    const content = JSON.stringify(task, null, 2)
    const tags = this.buildTaskTags(task)

    await this.yamsStore(content, `tasks/${taskId}.json`, tags)

    return task
  }

  async updateTask(
    taskId: string,
    updates: Partial<Pick<Task, "status" | "error" | "findings" | "artifacts">>
  ): Promise<Task | null> {
    const task = await this.getTask(taskId)
    if (!task) return null

    Object.assign(task, updates)

    const content = JSON.stringify(task, null, 2)
    const tags = this.buildTaskTags(task)

    await this.yamsStore(content, `tasks/${taskId}.json`, tags)

    return task
  }

  async completeTask(
    taskId: string,
    results?: { findings?: string[]; artifacts?: Task["artifacts"] }
  ): Promise<Task | null> {
    return this.updateTask(taskId, {
      status: "completed",
      findings: results?.findings,
      artifacts: results?.artifacts,
    })
  }

  async failTask(taskId: string, error: string): Promise<Task | null> {
    return this.updateTask(taskId, { status: "failed", error })
  }

  // ===========================================================================
  // Context Management
  // ===========================================================================

  async createContext(
    id: string,
    name: string,
    description?: string
  ): Promise<Context> {
    const context: Context = {
      id,
      name,
      description,
      findings: [],
      tasks: [],
      agents: [],
      status: "active",
    }

    const content = JSON.stringify(context, null, 2)
    await this.yamsStore(content, `contexts/${id}.json`, "context,status:active")

    return context
  }

  async getContext(contextId: string): Promise<Context | null> {
    try {
      const result = await this.yams(`cat --name "contexts/${contextId}.json"`)
      return JSON.parse(result)
    } catch {
      return null
    }
  }

  async getContextSummary(contextId: string): Promise<string> {
    const findings = await this.queryFindings({ context_id: contextId, limit: 100 })
    const tasks = await this.queryTasks({ context_id: contextId, limit: 100 })
    const agents = await this.listAgents()

    const activeAgents = agents.filter(a => a.status === "active")
    const highSeverity = findings.filter(f => f.severity === "high" || f.severity === "critical")
    const unresolved = findings.filter(f => f.status !== "resolved")
    const activeTasks = tasks.filter(t => t.status === "working" || t.status === "claimed")
    const blockedTasks = tasks.filter(t => t.status === "blocked")

    return `## Blackboard Summary (Context: ${contextId})

### Agents Active (${activeAgents.length})
${activeAgents.map(a => `- ${a.id}: ${a.capabilities.join(", ")}`).join("\n") || "- None"}

### Key Findings (${findings.length} total, ${unresolved.length} unresolved)
${highSeverity.slice(0, 5).map(f =>
  `- [${f.severity?.toUpperCase()}] ${f.title} (${f.agent_id}, ${f.confidence.toFixed(2)} confidence)`
).join("\n") || "- None"}
${findings.length > 5 ? `- ... and ${findings.length - 5} more` : ""}

### Tasks
${activeTasks.map(t => `- [${t.status.toUpperCase()}] ${t.title} (assigned: ${t.assigned_to || "unassigned"})`).join("\n") || "- No active tasks"}
${blockedTasks.length ? `\n**Blocked (${blockedTasks.length}):**\n${blockedTasks.map(t => `- ${t.title}`).join("\n")}` : ""}

### Unresolved Issues
${unresolved.length ? `- ${unresolved.length} findings need resolution` : "- All findings resolved"}
${blockedTasks.length ? `- ${blockedTasks.length} tasks blocked` : ""}
`
  }

  // ===========================================================================
  // Graph Exploration
  // ===========================================================================

  async getConnections(
    entityPath: string,
    depth = 2
  ): Promise<{ nodes: any[]; edges: any[] }> {
    try {
      const result = await this.yamsJson<any>(
        `graph --name "${entityPath}" --depth ${depth}`
      )
      return {
        nodes: result.connected_nodes || [],
        edges: [], // YAMS graph format TBD
      }
    } catch {
      return { nodes: [], edges: [] }
    }
  }

  // ===========================================================================
  // Stats & Health
  // ===========================================================================

  async getStats(): Promise<BlackboardStats> {
    const agents = await this.listAgents()
    const findings = await this.queryFindings({ limit: 1000 })
    const tasks = await this.queryTasks({ limit: 1000 })

    const findingsByTopic: Record<string, number> = {}
    const findingsByStatus: Record<string, number> = {}
    const findingsBySeverity: Record<string, number> = {}

    for (const f of findings) {
      findingsByTopic[f.topic] = (findingsByTopic[f.topic] || 0) + 1
      findingsByStatus[f.status] = (findingsByStatus[f.status] || 0) + 1
      if (f.severity) findingsBySeverity[f.severity] = (findingsBySeverity[f.severity] || 0) + 1
    }

    const tasksByStatus: Record<string, number> = {}
    const tasksByType: Record<string, number> = {}

    for (const t of tasks) {
      tasksByStatus[t.status] = (tasksByStatus[t.status] || 0) + 1
      tasksByType[t.type] = (tasksByType[t.type] || 0) + 1
    }

    return {
      agents: agents.length,
      findings: {
        total: findings.length,
        by_topic: findingsByTopic,
        by_status: findingsByStatus,
        by_severity: findingsBySeverity,
      },
      tasks: {
        total: tasks.length,
        by_status: tasksByStatus,
        by_type: tasksByType,
      },
      contexts: 0, // TODO: count contexts
    }
  }
}
