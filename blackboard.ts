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
  CompactionManifest,
  Subscription,
  SubscriptionFilters,
  Notification,
  BlackboardEvent,
  NotificationEventType,
  FindingSeverity,
} from "./types"

// Shell type from OpenCode plugin context
// The actual return type varies by OpenCode version
type ShellResult = string | {
  stdout?: string | { toString(encoding?: string): string }
  stderr?: string | { toString(encoding?: string): string }
  output?: string
  text?: string | (() => Promise<string>)
  exitCode?: number
  toString?(encoding?: string): string
}

type Shell = {
  (strings: TemplateStringsArray, ...values: any[]): Promise<ShellResult> & { quiet(): Promise<ShellResult> }
}

export class YamsBlackboard {
  private sessionName?: string
  private sessionActive = false
  readonly instanceId: string

  constructor(
    private $: Shell,
    private options: {
      sessionName?: string
      instanceId?: string
      defaultScope?: "session" | "persistent"
    } = {}
  ) {
    this.sessionName = options.sessionName
    this.instanceId = options.instanceId || crypto.randomUUID()
  }

  private instanceTag(): string {
    return `inst:${this.instanceId}`
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
    return this.sessionName ? `--session ${this.shellEscape(this.sessionName)}` : ""
  }

  // Shell escape a string for safe inclusion in shell commands
  private shellEscape(s: string): string {
    return `'${s.replace(/'/g, "'\\''")}'`
  }

  // Execute a shell command string
  // Redirects stderr to stdout and captures all output to avoid TUI pollution
  private async shell(cmd: string): Promise<string> {
    try {
      // Redirect stderr to stdout and use .quiet() to suppress TUI output
      const result = await this.$`sh -c ${cmd + ' 2>&1'}`.quiet()

      // Handle different return types from Bun shell
      if (typeof result === 'string') {
        return result.trim()
      }

      if (result && typeof result === 'object') {
        // Get raw output - could be stdout, output, or text property
        let raw = (result as any).stdout ?? (result as any).output ?? (result as any).text

        // Handle Buffer/Uint8Array - use TextDecoder for reliable decoding
        if (raw instanceof Uint8Array || Buffer.isBuffer(raw)) {
          return new TextDecoder().decode(raw).trim()
        }

        // Handle string
        if (typeof raw === 'string') {
          return raw.trim()
        }

        // Handle function (Response-like .text())
        if (typeof raw === 'function') {
          const text = await raw()
          return typeof text === 'string' ? text.trim() : String(text).trim()
        }
      }

      // Fallback: stringify
      return String(result ?? '').trim()
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
    const cmd = `echo ${escaped} | yams add - --name ${this.shellEscape(name)} --tags ${this.shellEscape(tags)} --metadata owner=opencode ${extraArgs}`
    return this.shell(cmd)
  }

  // ===========================================================================
  // Session Management
  // ===========================================================================

  async startSession(name?: string): Promise<string> {
    this.sessionName = name || `opencode-${Date.now()}`
    await this.yams(`session start ${this.shellEscape(this.sessionName)}`)
    await this.yams(`session use ${this.shellEscape(this.sessionName)}`)
    this.sessionActive = true
    return this.sessionName
  }

  async stopSession(): Promise<void> {
    if (this.sessionName && this.sessionActive) {
      // Reconcile session to global before closing
      await this.reconcile()
      await this.yams(`session close`)
      this.sessionActive = false
    }
  }

  /**
   * Reconcile session documents to global corpus.
   * This makes findings/tasks discoverable across sessions.
   */
  async reconcile(): Promise<void> {
    if (!this.sessionName) return
    try {
      await this.yams(`session merge ${this.shellEscape(this.sessionName)}`)
    } catch {
      // Silent failure - don't break workflow if merge fails
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
      this.instanceTag(),
      ...agent.capabilities.map(c => `capability:${c}`),
    ].join(",")

    await this.yamsStore(content, `agents/${agent.id}.json`, tags, this.sessionArg())

    return full
  }

  async getAgent(agentId: string): Promise<AgentCard | null> {
    try {
      const result = await this.yams(`cat ${this.shellEscape(`agents/${agentId}.json`)}`)
      return JSON.parse(result)
    } catch {
      return null
    }
  }

  async listAgents(opts?: { instance_id?: string }): Promise<AgentCard[]> {
    try {
      const tags = opts?.instance_id ? `agent,inst:${opts.instance_id}` : "agent"
      const matchAll = opts?.instance_id ? "--match-all-tags " : ""
      const result = await this.yamsJson<{ documents: any[] }>(`list --tags ${this.shellEscape(tags)} ${matchAll}--limit 100`)
      const agents: AgentCard[] = []
      for (const doc of result.documents || []) {
        try {
          const content = await this.yams(`cat ${this.shellEscape(doc.name)}`)
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
      await this.yamsStore(content, `agents/${agentId}.json`, `agent,${this.instanceTag()}`)
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
      this.instanceTag(),
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

    // Auto-reconcile to global corpus for cross-session discovery
    await this.reconcile()

    // Trigger notifications for subscribers
    await this.triggerNotifications({
      event_type: "finding_created",
      source_id: id,
      source_type: "finding",
      source_agent_id: finding.agent_id,
      topic: finding.topic,
      severity: finding.severity,
      status: finding.status,
      context_id: finding.context_id,
      title: finding.title,
    })

    return finding
  }

  async getFinding(findingId: string): Promise<Finding | null> {
    try {
      // Search by ID in the findings directory
      const result = await this.yams(`cat ${this.shellEscape(`findings/**/${findingId}.md`)}`)
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
    // Only filter by instance if explicitly requested
    if (query.instance_id) tags.push(`inst:${query.instance_id}`)
    if (query.topic) tags.push(`topic:${query.topic}`)
    if (query.agent_id) tags.push(`agent:${query.agent_id}`)
    if (query.severity) query.severity.forEach(s => tags.push(`severity:${s}`))
    if (query.scope) tags.push(`scope:${query.scope}`)
    if (query.status) tags.push(`status:${query.status}`)

    try {
      const result = await this.yamsJson<{ documents: any[] }>(
        `list --tags ${this.shellEscape(tags.join(","))} --match-all-tags --limit ${query.limit} --offset ${query.offset}`
      )

      const findings: Finding[] = []
      for (const doc of result.documents || []) {
        const id = doc.name?.split("/").pop()?.replace(".md", "")
        if (!id) continue
        const finding = await this.getFinding(id)
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

  async searchFindings(query: string, opts?: { topic?: string; limit?: number; instance_id?: string }): Promise<Finding[]> {
    const tagsParts = ["finding"]
    if (opts?.instance_id) tagsParts.push(`inst:${opts.instance_id}`)
    if (opts?.topic) tagsParts.push(`topic:${opts.topic}`)
    const tags = tagsParts.join(",")
    const limit = opts?.limit || 10

    try {
      const result = await this.yamsJson<{ results: any[] }>(
        `search ${this.shellEscape(query)} --tags ${this.shellEscape(tags)} --match-all-tags --limit ${limit}`
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

  private buildMetadataArgs(meta: Record<string, string>): string {
    return Object.entries(meta)
      .map(([k, v]) => `-m ${this.shellEscape(`${k}=${v}`)}`)
      .join(" ")
  }

  async acknowledgeFinding(findingId: string, agentId: string): Promise<void> {
    const metaArgs = this.buildMetadataArgs({
      acknowledged_by: agentId,
      acknowledged_at: this.nowISO(),
    })
    await this.yams(
      `update --name ${this.shellEscape(`findings/**/${findingId}.md`)} --tags ${this.shellEscape("status:acknowledged")} ${metaArgs}`
    )
  }

  async resolveFinding(
    findingId: string,
    resolvedBy: string,
    resolution: string
  ): Promise<void> {
    const finding = await this.getFinding(findingId)
    const metaArgs = this.buildMetadataArgs({
      resolved_by: resolvedBy,
      resolution,
      resolved_at: this.nowISO(),
    })
    await this.yams(
      `update --name ${this.shellEscape(`findings/**/${findingId}.md`)} --tags ${this.shellEscape("status:resolved")} ${metaArgs}`
    )

    // Trigger notifications for resolution
    if (finding) {
      await this.triggerNotifications({
        event_type: "finding_resolved",
        source_id: findingId,
        source_type: "finding",
        source_agent_id: resolvedBy,
        topic: finding.topic,
        severity: finding.severity,
        status: "resolved",
        context_id: finding.context_id,
        title: finding.title,
      })
    }
  }

  // ===========================================================================
  // Task Management
  // ===========================================================================

  private buildTaskTags(task: Task | CreateTask): string {
    const tags = [
      "task",
      this.instanceTag(),
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

    // Auto-reconcile to global corpus for cross-session discovery
    await this.reconcile()

    // Trigger notifications for task creation
    await this.triggerNotifications({
      event_type: "task_created",
      source_id: id,
      source_type: "task",
      source_agent_id: task.created_by,
      status: task.status,
      context_id: task.context_id,
      title: task.title,
    })

    return task
  }

  async getTask(taskId: string): Promise<Task | null> {
    try {
      const result = await this.yams(`cat ${this.shellEscape(`tasks/${taskId}.json`)}`)
      return JSON.parse(result)
    } catch {
      return null
    }
  }

  async queryTasks(query: TaskQuery): Promise<Task[]> {
    const tags = ["task"]
    if (query.instance_id) tags.push(`inst:${query.instance_id}`)
    if (query.type) tags.push(`type:${query.type}`)
    if (query.status) tags.push(`status:${query.status}`)
    if (query.priority !== undefined) tags.push(`priority:${query.priority}`)
    if (query.created_by) tags.push(`creator:${query.created_by}`)
    if (query.assigned_to) tags.push(`assignee:${query.assigned_to}`)
    if (query.context_id) tags.push(`ctx:${query.context_id}`)

    try {
      const result = await this.yamsJson<{ documents: any[] }>(
        `list --tags ${this.shellEscape(tags.join(","))} --match-all-tags --limit ${query.limit} --offset ${query.offset}`
      )

      const tasks: Task[] = []
      for (const doc of result.documents || []) {
        const id = doc.name?.replace("tasks/", "").replace(".json", "")
        if (!id) continue
        const task = await this.getTask(id)
        if (task) tasks.push(task)
      }
      return tasks
    } catch {
      return []
    }
  }

  async getReadyTasks(agentCapabilities?: string[]): Promise<Task[]> {
    const pending = await this.queryTasks({ status: "pending", limit: 100, offset: 0 })

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

    // Filter by agent capabilities if provided
    if (agentCapabilities?.length) {
      const capSet = new Set(agentCapabilities)
      return ready
        .filter(t => capSet.has(t.type))
        .sort((a, b) => (a.priority ?? 2) - (b.priority ?? 2))
    }

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

    // Trigger notifications for task claim
    await this.triggerNotifications({
      event_type: "task_claimed",
      source_id: taskId,
      source_type: "task",
      source_agent_id: agentId,
      status: task.status,
      context_id: task.context_id,
      title: task.title,
    })

    return task
  }

  async updateTask(
    taskId: string,
    updates: Partial<Pick<Task, "status" | "error" | "findings" | "artifacts">>
  ): Promise<Task | null> {
    const task = await this.getTask(taskId)
    if (!task) return null

    const previousStatus = task.status
    Object.assign(task, updates)

    const content = JSON.stringify(task, null, 2)
    const tags = this.buildTaskTags(task)

    await this.yamsStore(content, `tasks/${taskId}.json`, tags)

    // Trigger notifications if status changed
    if (updates.status && updates.status !== previousStatus) {
      const eventType: NotificationEventType =
        updates.status === "completed" ? "task_completed" : "task_updated"

      await this.triggerNotifications({
        event_type: eventType,
        source_id: taskId,
        source_type: "task",
        source_agent_id: task.assigned_to || task.created_by,
        status: task.status,
        context_id: task.context_id,
        title: task.title,
      })
    }

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
    await this.yamsStore(content, `contexts/${id}.json`, `context,${this.instanceTag()},status:active`)

    return context
  }

  async getContext(contextId: string): Promise<Context | null> {
    try {
      const result = await this.yams(`cat ${this.shellEscape(`contexts/${contextId}.json`)}`)
      return JSON.parse(result)
    } catch {
      return null
    }
  }

  async getContextSummary(contextId: string): Promise<string> {
    const findings = await this.queryFindings({ context_id: contextId, limit: 100, offset: 0 })
    const tasks = await this.queryTasks({ context_id: contextId, limit: 100, offset: 0 })
    const agents = await this.listAgents()

    const activeAgents = agents.filter(a => a.status === "active")
    const highSeverity = findings.filter(f => f.severity === "high" || f.severity === "critical")
    const unresolved = findings.filter(f => f.status !== "resolved")
    const activeTasks = tasks.filter(t => t.status === "working" || t.status === "claimed")
    const blockedTasks = tasks.filter(t => t.status === "blocked")

    // Include actual content for recent high-priority findings
    const recentFindings = [...highSeverity, ...unresolved.filter(f => f.severity !== "high" && f.severity !== "critical")]
      .slice(0, 10)

    const findingDetails = recentFindings.map(f => {
      const truncated = f.content.length > 300 ? f.content.slice(0, 300) + "..." : f.content
      return `#### [${f.severity?.toUpperCase() || "INFO"}] ${f.title}
- Agent: ${f.agent_id} | Confidence: ${f.confidence.toFixed(2)} | Status: ${f.status}
${truncated}`
    }).join("\n\n")

    const taskDetails = activeTasks.slice(0, 5).map(t => {
      const desc = t.description ? (t.description.length > 200 ? t.description.slice(0, 200) + "..." : t.description) : ""
      return `- [${t.status.toUpperCase()}] ${t.title} (assigned: ${t.assigned_to || "unassigned"})${desc ? "\n  " + desc : ""}`
    }).join("\n")

    return `## Blackboard Summary (Context: ${contextId})

### Agents Active (${activeAgents.length})
${activeAgents.map(a => `- ${a.id}: ${a.capabilities.join(", ")}`).join("\n") || "- None"}

### Key Findings (${findings.length} total, ${unresolved.length} unresolved)
${findingDetails || "- None"}
${findings.length > 10 ? `\n- ... and ${findings.length - 10} more findings` : ""}

### Tasks
${taskDetails || "- No active tasks"}
${blockedTasks.length ? `\n**Blocked (${blockedTasks.length}):**\n${blockedTasks.map(t => `- ${t.title}`).join("\n")}` : ""}

### Unresolved Issues
${unresolved.length ? `- ${unresolved.length} findings need resolution` : "- All findings resolved"}
${blockedTasks.length ? `- ${blockedTasks.length} tasks blocked` : ""}
`
  }

  /**
   * Generate both human-readable markdown and machine-parseable manifest
   * for post-compression context recovery.
   */
  async getContextSummaryWithManifest(contextId: string): Promise<{
    markdown: string;
    manifest: CompactionManifest;
  }> {
    const findings = await this.queryFindings({ context_id: contextId, limit: 100, offset: 0 })
    const tasks = await this.queryTasks({ context_id: contextId, limit: 100, offset: 0 })
    const agents = await this.listAgents()

    const activeAgents = agents.filter(a => a.status === "active")
    const unresolved = findings.filter(f => f.status !== "resolved")
    const activeTasks = tasks.filter(t => t.status === "working" || t.status === "claimed")
    const blockedTasks = tasks.filter(t => t.status === "blocked")

    // Build JSON manifest for machine consumption
    const manifest: CompactionManifest = {
      contextId,
      timestamp: new Date().toISOString(),
      findingIds: findings.map(f => ({
        id: f.id || "",
        topic: f.topic,
        severity: f.severity,
        status: f.status,
        confidence: f.confidence,
      })),
      taskIds: tasks.map(t => ({
        id: t.id || "",
        type: t.type,
        status: t.status,
        priority: t.priority ?? 2,
      })),
      agentIds: activeAgents.map(a => a.id),
      stats: {
        totalFindings: findings.length,
        unresolvedFindings: unresolved.length,
        activeTasks: activeTasks.length,
        blockedTasks: blockedTasks.length,
      }
    }

    // Store manifest to YAMS for later recovery
    try {
      await this.yamsStore(
        JSON.stringify(manifest),
        `contexts/${contextId}/compaction-manifest.json`,
        `manifest,ctx:${contextId},scope:persistent`,
        ""
      )
    } catch {
      // Silent failure - don't break compaction if storage fails
    }

    return {
      markdown: await this.getContextSummary(contextId),
      manifest
    }
  }

  /**
   * Retrieve a previously stored compaction manifest for context recovery.
   */
  async getCompactionManifest(contextId: string): Promise<CompactionManifest | null> {
    try {
      const result = await this.yams(`cat ${this.shellEscape(`contexts/${contextId}/compaction-manifest.json`)}`)
      return JSON.parse(result)
    } catch {
      return null
    }
  }

  /**
   * Hydrate full findings and tasks from a manifest's IDs.
   * Used for recovering full context after compression.
   */
  async hydrateFromManifest(manifest: CompactionManifest): Promise<{
    findings: Finding[];
    tasks: Task[];
  }> {
    const findingPromises = manifest.findingIds.map(f =>
      this.getFinding(f.id).catch(() => null)
    )
    const taskPromises = manifest.taskIds.map(t =>
      this.getTask(t.id).catch(() => null)
    )

    const [findingResults, taskResults] = await Promise.all([
      Promise.all(findingPromises),
      Promise.all(taskPromises)
    ])

    return {
      findings: findingResults.filter((f): f is Finding => f !== null),
      tasks: taskResults.filter((t): t is Task => t !== null),
    }
  }

  /**
   * Archive session-scoped findings before session cleanup.
   * Re-tags findings as archived instead of deleting them.
   */
  async archiveSessionFindings(sessionName: string): Promise<void> {
    try {
      // Query session-scoped findings
      const sessionFindings = await this.queryFindings({
        scope: "session",
        limit: 1000,
        offset: 0
      })

      for (const finding of sessionFindings) {
        // Re-tag as archived instead of deleting
        const archiveTags = [
          `archived:${sessionName}`,
          `archived_at:${new Date().toISOString().split("T")[0]}`,
        ].join(",")

        try {
          await this.yams(
            `update --name ${this.shellEscape(`findings/**/${finding.id}.md`)} --tags ${this.shellEscape(archiveTags)} --remove-tags session`
          )
        } catch {
          // Skip individual failures
        }
      }
    } catch {
      // Silent failure - don't break session cleanup
    }
  }

  // ===========================================================================
  // Search Methods
  // ===========================================================================

  async searchTasks(query: string, opts?: { type?: string; limit?: number; instance_id?: string }): Promise<Task[]> {
    const tagsParts = ["task"]
    if (opts?.instance_id) tagsParts.push(`inst:${opts.instance_id}`)
    if (opts?.type) tagsParts.push(`type:${opts.type}`)
    const tags = tagsParts.join(",")
    const limit = opts?.limit || 10

    try {
      const result = await this.yamsJson<{ results: any[] }>(
        `search ${this.shellEscape(query)} --tags ${this.shellEscape(tags)} --match-all-tags --limit ${limit}`
      )

      const tasks: Task[] = []
      for (const r of result.results || []) {
        const id = r.path?.replace("tasks/", "").replace(".json", "")
        if (id) {
          const task = await this.getTask(id)
          if (task) tasks.push(task)
        }
      }
      return tasks
    } catch {
      return []
    }
  }

  async search(query: string, opts?: { limit?: number; instance_id?: string }): Promise<{ findings: Finding[]; tasks: Task[] }> {
    const tags = opts?.instance_id ? `inst:${opts.instance_id}` : ""
    const limit = opts?.limit || 20

    try {
      const tagArg = tags ? `--tags ${this.shellEscape(tags)} --match-all-tags ` : ""
      const result = await this.yamsJson<{ results: any[] }>(
        `search ${this.shellEscape(query)} ${tagArg}--limit ${limit}`
      )

      const findings: Finding[] = []
      const tasks: Task[] = []

      for (const r of result.results || []) {
        const path = r.path || ""
        if (path.startsWith("findings/")) {
          const id = path.split("/").pop()?.replace(".md", "")
          if (id) {
            const finding = await this.getFinding(id)
            if (finding) findings.push(finding)
          }
        } else if (path.startsWith("tasks/")) {
          const id = path.replace("tasks/", "").replace(".json", "")
          if (id) {
            const task = await this.getTask(id)
            if (task) tasks.push(task)
          }
        }
      }

      return { findings, tasks }
    } catch {
      return { findings: [], tasks: [] }
    }
  }

  async grep(pattern: string, opts?: { entity?: "finding" | "task"; limit?: number; instance_id?: string }): Promise<Array<{ name: string; matches: string[] }>> {
    const tagsParts: string[] = []
    if (opts?.entity) tagsParts.push(opts.entity)
    if (opts?.instance_id) tagsParts.push(`inst:${opts.instance_id}`)
    const tags = tagsParts.join(",")
    const limit = opts?.limit || 50

    try {
      const tagArg = tags ? `--tags ${this.shellEscape(tags)} --match-all-tags ` : ""
      const result = await this.yams(
        `grep ${this.shellEscape(pattern)} ${tagArg}--limit ${limit} --json`
      )
      const parsed = JSON.parse(result)

      // Parse grep output into structured results
      const entries: Array<{ name: string; matches: string[] }> = []
      if (parsed.output) {
        const lines = parsed.output.split("\n").filter((l: string) => l.trim())
        const byFile = new Map<string, string[]>()
        for (const line of lines) {
          const sep = line.indexOf(":")
          if (sep > 0) {
            const file = line.slice(0, sep)
            const match = line.slice(sep + 1)
            if (!byFile.has(file)) byFile.set(file, [])
            byFile.get(file)!.push(match)
          }
        }
        for (const [name, matches] of byFile) {
          entries.push({ name, matches })
        }
      }
      return entries
    } catch {
      return []
    }
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
        `graph --name ${this.shellEscape(entityPath)} --depth ${depth}`
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
    const findings = await this.queryFindings({ limit: 1000, offset: 0 })
    const tasks = await this.queryTasks({ limit: 1000, offset: 0 })

    let contextCount = 0
    try {
      const ctxResult = await this.yamsJson<{ documents: any[] }>(`list --tags context --limit 1000`)
      contextCount = ctxResult.documents?.length || 0
    } catch { /* contexts unavailable */ }

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
      contexts: contextCount,
    }
  }

  // ===========================================================================
  // Subscription Management
  // ===========================================================================

  async createSubscription(input: {
    subscriber_id: string
    pattern_type: "topic" | "entity" | "agent" | "status" | "context"
    pattern_value: string
    filters?: SubscriptionFilters
    expires_at?: string
  }): Promise<Subscription> {
    const id = this.genId("sub")
    const subscription: Subscription = {
      id,
      subscriber_id: input.subscriber_id,
      pattern_type: input.pattern_type,
      pattern_value: input.pattern_value,
      filters: input.filters,
      created_at: this.nowISO(),
      expires_at: input.expires_at,
      status: "active",
    }

    const content = JSON.stringify(subscription, null, 2)
    const tags = [
      "subscription",
      this.instanceTag(),
      `subscriber:${subscription.subscriber_id}`,
      `pattern:${subscription.pattern_type}:${subscription.pattern_value}`,
      "status:active",
    ].join(",")

    await this.yamsStore(
      content,
      `subscriptions/${subscription.subscriber_id}/${id}.json`,
      tags,
      this.sessionArg()
    )

    return subscription
  }

  async getSubscription(subscriberId: string, subscriptionId: string): Promise<Subscription | null> {
    try {
      const result = await this.yams(
        `cat ${this.shellEscape(`subscriptions/${subscriberId}/${subscriptionId}.json`)}`
      )
      return JSON.parse(result)
    } catch {
      return null
    }
  }

  async listSubscriptions(subscriberId: string): Promise<Subscription[]> {
    try {
      const result = await this.yamsJson<{ documents: any[] }>(
        `list --tags ${this.shellEscape(`subscription,${this.instanceTag()},subscriber:${subscriberId}`)} --match-all-tags --limit 100`
      )

      const subscriptions: Subscription[] = []
      for (const doc of result.documents || []) {
        try {
          const content = await this.yams(`cat ${this.shellEscape(doc.name)}`)
          const sub = JSON.parse(content)
          // Filter out expired subscriptions
          if (sub.expires_at && new Date(sub.expires_at) < new Date()) {
            continue
          }
          if (sub.status === "active") {
            subscriptions.push(sub)
          }
        } catch { /* skip malformed */ }
      }
      return subscriptions
    } catch {
      return []
    }
  }

  async cancelSubscription(subscriberId: string, subscriptionId: string): Promise<boolean> {
    try {
      const sub = await this.getSubscription(subscriberId, subscriptionId)
      if (!sub) return false

      sub.status = "expired"
      const content = JSON.stringify(sub, null, 2)
      const tags = [
        "subscription",
        this.instanceTag(),
        `subscriber:${sub.subscriber_id}`,
        `pattern:${sub.pattern_type}:${sub.pattern_value}`,
        "status:expired",
      ].join(",")

      await this.yamsStore(
        content,
        `subscriptions/${subscriberId}/${subscriptionId}.json`,
        tags
      )
      return true
    } catch {
      return false
    }
  }

  async findMatchingSubscriptions(event: BlackboardEvent): Promise<Subscription[]> {
    const matching: Subscription[] = []

    // Query active subscriptions
    try {
      const result = await this.yamsJson<{ documents: any[] }>(
        `list --tags ${this.shellEscape(`subscription,${this.instanceTag()},status:active`)} --match-all-tags --limit 500`
      )

      for (const doc of result.documents || []) {
        try {
          const content = await this.yams(`cat ${this.shellEscape(doc.name)}`)
          const sub: Subscription = JSON.parse(content)

          // Check expiration
          if (sub.expires_at && new Date(sub.expires_at) < new Date()) {
            continue
          }

          // Check exclude_self filter
          if (sub.filters?.exclude_self !== false && sub.subscriber_id === event.source_agent_id) {
            continue
          }

          // Match based on pattern type
          let matches = false
          switch (sub.pattern_type) {
            case "topic":
              matches = event.topic === sub.pattern_value
              break
            case "agent":
              matches = event.source_agent_id === sub.pattern_value
              break
            case "status":
              matches = event.status === sub.pattern_value
              break
            case "context":
              matches = event.context_id === sub.pattern_value
              break
            case "entity":
              // Entity type matches (finding or task)
              matches = event.source_type === sub.pattern_value
              break
          }

          if (!matches) continue

          // Apply additional filters
          if (sub.filters?.severity?.length && event.severity) {
            if (!sub.filters.severity.includes(event.severity)) {
              continue
            }
          }

          matching.push(sub)
        } catch { /* skip malformed */ }
      }
    } catch { /* no subscriptions */ }

    return matching
  }

  // ===========================================================================
  // Notification Management
  // ===========================================================================

  async createNotification(input: {
    subscription_id: string
    event_type: NotificationEventType
    source_id: string
    source_type: "finding" | "task"
    source_agent_id: string
    summary: { title: string; topic?: string; severity?: FindingSeverity; status?: string }
    recipient_id: string
  }): Promise<Notification> {
    const id = this.genId("notif")
    const notification: Notification = {
      id,
      subscription_id: input.subscription_id,
      event_type: input.event_type,
      source_id: input.source_id,
      source_type: input.source_type,
      source_agent_id: input.source_agent_id,
      summary: input.summary,
      recipient_id: input.recipient_id,
      created_at: this.nowISO(),
      status: "unread",
    }

    const content = JSON.stringify(notification, null, 2)
    const tags = [
      "notification",
      this.instanceTag(),
      `recipient:${notification.recipient_id}`,
      `event:${notification.event_type}`,
      "status:unread",
    ].join(",")

    await this.yamsStore(
      content,
      `notifications/${notification.recipient_id}/${id}.json`,
      tags,
      this.sessionArg()
    )

    return notification
  }

  async getUnreadNotifications(recipientId: string, limit = 20): Promise<Notification[]> {
    try {
      const result = await this.yamsJson<{ documents: any[] }>(
        `list --tags ${this.shellEscape(`notification,${this.instanceTag()},recipient:${recipientId},status:unread`)} --match-all-tags --limit ${limit}`
      )

      const notifications: Notification[] = []
      for (const doc of result.documents || []) {
        try {
          const content = await this.yams(`cat ${this.shellEscape(doc.name)}`)
          notifications.push(JSON.parse(content))
        } catch { /* skip malformed */ }
      }

      // Sort by created_at descending (newest first)
      return notifications.sort((a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      )
    } catch {
      return []
    }
  }

  async markNotificationRead(recipientId: string, notificationId: string): Promise<boolean> {
    try {
      const path = `notifications/${recipientId}/${notificationId}.json`
      const content = await this.yams(`cat ${this.shellEscape(path)}`)
      const notification: Notification = JSON.parse(content)

      notification.status = "read"
      notification.read_at = this.nowISO()

      const tags = [
        "notification",
        this.instanceTag(),
        `recipient:${notification.recipient_id}`,
        `event:${notification.event_type}`,
        "status:read",
      ].join(",")

      await this.yamsStore(JSON.stringify(notification, null, 2), path, tags)
      return true
    } catch {
      return false
    }
  }

  async markAllNotificationsRead(recipientId: string): Promise<number> {
    const unread = await this.getUnreadNotifications(recipientId, 100)
    let count = 0

    for (const notification of unread) {
      if (await this.markNotificationRead(recipientId, notification.id)) {
        count++
      }
    }

    return count
  }

  async dismissNotification(recipientId: string, notificationId: string): Promise<boolean> {
    try {
      const path = `notifications/${recipientId}/${notificationId}.json`
      const content = await this.yams(`cat ${this.shellEscape(path)}`)
      const notification: Notification = JSON.parse(content)

      notification.status = "dismissed"

      const tags = [
        "notification",
        this.instanceTag(),
        `recipient:${notification.recipient_id}`,
        `event:${notification.event_type}`,
        "status:dismissed",
      ].join(",")

      await this.yamsStore(JSON.stringify(notification, null, 2), path, tags)
      return true
    } catch {
      return false
    }
  }

  async getNotificationCount(recipientId: string): Promise<{ unread: number; total: number }> {
    try {
      // Count unread
      const unreadResult = await this.yamsJson<{ documents: any[] }>(
        `list --tags ${this.shellEscape(`notification,${this.instanceTag()},recipient:${recipientId},status:unread`)} --match-all-tags --limit 1000`
      )
      const unread = unreadResult.documents?.length || 0

      // Count total (all statuses)
      const totalResult = await this.yamsJson<{ documents: any[] }>(
        `list --tags ${this.shellEscape(`notification,${this.instanceTag()},recipient:${recipientId}`)} --match-all-tags --limit 1000`
      )
      const total = totalResult.documents?.length || 0

      return { unread, total }
    } catch {
      return { unread: 0, total: 0 }
    }
  }

  // ===========================================================================
  // Trigger Integration
  // ===========================================================================

  async triggerNotifications(event: BlackboardEvent): Promise<number> {
    const matchingSubscriptions = await this.findMatchingSubscriptions(event)
    let created = 0

    for (const sub of matchingSubscriptions) {
      try {
        await this.createNotification({
          subscription_id: sub.id,
          event_type: event.event_type,
          source_id: event.source_id,
          source_type: event.source_type,
          source_agent_id: event.source_agent_id,
          summary: {
            title: event.title,
            topic: event.topic,
            severity: event.severity,
            status: event.status,
          },
          recipient_id: sub.subscriber_id,
        })
        created++
      } catch { /* skip failed notifications */ }
    }

    return created
  }
}
