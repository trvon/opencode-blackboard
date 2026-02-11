// index.ts
import { tool } from "@opencode-ai/plugin";
import { z as z2 } from "zod";

// blackboard.ts
class YamsBlackboard {
  $;
  options;
  sessionName;
  sessionActive = false;
  instanceId;
  constructor($, options = {}) {
    this.$ = $;
    this.options = options;
    this.sessionName = options.sessionName;
    this.instanceId = options.instanceId || crypto.randomUUID();
  }
  instanceTag() {
    return `inst:${this.instanceId}`;
  }
  genId(prefix) {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
  nowISO() {
    return new Date().toISOString();
  }
  sessionArg() {
    return this.sessionName ? `--session ${this.shellEscape(this.sessionName)}` : "";
  }
  shellEscape(s) {
    return `'${s.replace(/'/g, "'\\''")}'`;
  }
  async shell(cmd) {
    try {
      const result = await this.$`sh -c ${cmd + " 2>&1"}`.quiet();
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
    const cmd = `echo ${escaped} | yams add - --name ${this.shellEscape(name)} --tags ${this.shellEscape(tags)} --metadata owner=opencode ${extraArgs}`;
    return this.shell(cmd);
  }
  async startSession(name) {
    this.sessionName = name || `opencode-${Date.now()}`;
    await this.yams(`session start ${this.shellEscape(this.sessionName)}`);
    await this.yams(`session use ${this.shellEscape(this.sessionName)}`);
    this.sessionActive = true;
    return this.sessionName;
  }
  async stopSession() {
    if (this.sessionName && this.sessionActive) {
      await this.reconcile();
      await this.yams(`session close`);
      this.sessionActive = false;
    }
  }
  async reconcile() {
    if (!this.sessionName)
      return;
    try {
      await this.yams(`session merge ${this.shellEscape(this.sessionName)}`);
    } catch {}
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
      this.instanceTag(),
      ...agent.capabilities.map((c) => `capability:${c}`)
    ].join(",");
    await this.yamsStore(content, `agents/${agent.id}.json`, tags, this.sessionArg());
    return full;
  }
  async getAgent(agentId) {
    try {
      const result = await this.yams(`cat ${this.shellEscape(`agents/${agentId}.json`)}`);
      return JSON.parse(result);
    } catch {
      return null;
    }
  }
  async listAgents(opts) {
    try {
      const tags = opts?.instance_id ? `agent,inst:${opts.instance_id}` : "agent";
      const matchAll = opts?.instance_id ? "--match-all-tags " : "";
      const result = await this.yamsJson(`list --tags ${this.shellEscape(tags)} ${matchAll}--limit 100`);
      const agents = [];
      for (const doc of result.documents || []) {
        try {
          const content = await this.yams(`cat ${this.shellEscape(doc.name)}`);
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
      await this.yamsStore(content, `agents/${agentId}.json`, `agent,${this.instanceTag()}`);
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
      this.instanceTag(),
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
    await this.reconcile();
    await this.triggerNotifications({
      event_type: "finding_created",
      source_id: id,
      source_type: "finding",
      source_agent_id: finding.agent_id,
      topic: finding.topic,
      severity: finding.severity,
      status: finding.status,
      context_id: finding.context_id,
      title: finding.title
    });
    return finding;
  }
  async getFinding(findingId) {
    try {
      const result = await this.yams(`cat ${this.shellEscape(`findings/**/${findingId}.md`)}`);
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
    if (query.instance_id)
      tags.push(`inst:${query.instance_id}`);
    if (query.topic)
      tags.push(`topic:${query.topic}`);
    if (query.agent_id)
      tags.push(`agent:${query.agent_id}`);
    if (query.severity)
      query.severity.forEach((s) => tags.push(`severity:${s}`));
    if (query.scope)
      tags.push(`scope:${query.scope}`);
    if (query.status)
      tags.push(`status:${query.status}`);
    try {
      const result = await this.yamsJson(`list --tags ${this.shellEscape(tags.join(","))} --match-all-tags --limit ${query.limit} --offset ${query.offset}`);
      const findings = [];
      for (const doc of result.documents || []) {
        const id = doc.name?.split("/").pop()?.replace(".md", "");
        if (!id)
          continue;
        const finding = await this.getFinding(id);
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
    const tagsParts = ["finding"];
    if (opts?.instance_id)
      tagsParts.push(`inst:${opts.instance_id}`);
    if (opts?.topic)
      tagsParts.push(`topic:${opts.topic}`);
    const tags = tagsParts.join(",");
    const limit = opts?.limit || 10;
    try {
      const result = await this.yamsJson(`search ${this.shellEscape(query)} --tags ${this.shellEscape(tags)} --match-all-tags --limit ${limit}`);
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
  buildMetadataArgs(meta) {
    return Object.entries(meta).map(([k, v]) => `-m ${this.shellEscape(`${k}=${v}`)}`).join(" ");
  }
  async acknowledgeFinding(findingId, agentId) {
    const metaArgs = this.buildMetadataArgs({
      acknowledged_by: agentId,
      acknowledged_at: this.nowISO()
    });
    await this.yams(`update --name ${this.shellEscape(`findings/**/${findingId}.md`)} --tags ${this.shellEscape("status:acknowledged")} ${metaArgs}`);
  }
  async resolveFinding(findingId, resolvedBy, resolution) {
    const finding = await this.getFinding(findingId);
    const metaArgs = this.buildMetadataArgs({
      resolved_by: resolvedBy,
      resolution,
      resolved_at: this.nowISO()
    });
    await this.yams(`update --name ${this.shellEscape(`findings/**/${findingId}.md`)} --tags ${this.shellEscape("status:resolved")} ${metaArgs}`);
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
        title: finding.title
      });
    }
  }
  buildTaskTags(task) {
    const tags = [
      "task",
      this.instanceTag(),
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
    await this.reconcile();
    await this.triggerNotifications({
      event_type: "task_created",
      source_id: id,
      source_type: "task",
      source_agent_id: task.created_by,
      status: task.status,
      context_id: task.context_id,
      title: task.title
    });
    return task;
  }
  async getTask(taskId) {
    try {
      const result = await this.yams(`cat ${this.shellEscape(`tasks/${taskId}.json`)}`);
      return JSON.parse(result);
    } catch {
      return null;
    }
  }
  async queryTasks(query) {
    const tags = ["task"];
    if (query.instance_id)
      tags.push(`inst:${query.instance_id}`);
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
      const result = await this.yamsJson(`list --tags ${this.shellEscape(tags.join(","))} --match-all-tags --limit ${query.limit} --offset ${query.offset}`);
      const tasks = [];
      for (const doc of result.documents || []) {
        const id = doc.name?.replace("tasks/", "").replace(".json", "");
        if (!id)
          continue;
        const task = await this.getTask(id);
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
    if (agentCapabilities?.length) {
      const capSet = new Set(agentCapabilities);
      return ready.filter((t) => capSet.has(t.type)).sort((a, b) => (a.priority ?? 2) - (b.priority ?? 2));
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
    await this.triggerNotifications({
      event_type: "task_claimed",
      source_id: taskId,
      source_type: "task",
      source_agent_id: agentId,
      status: task.status,
      context_id: task.context_id,
      title: task.title
    });
    return task;
  }
  async updateTask(taskId, updates) {
    const task = await this.getTask(taskId);
    if (!task)
      return null;
    const previousStatus = task.status;
    Object.assign(task, updates);
    const content = JSON.stringify(task, null, 2);
    const tags = this.buildTaskTags(task);
    await this.yamsStore(content, `tasks/${taskId}.json`, tags);
    if (updates.status && updates.status !== previousStatus) {
      const eventType = updates.status === "completed" ? "task_completed" : "task_updated";
      await this.triggerNotifications({
        event_type: eventType,
        source_id: taskId,
        source_type: "task",
        source_agent_id: task.assigned_to || task.created_by,
        status: task.status,
        context_id: task.context_id,
        title: task.title
      });
    }
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
    await this.yamsStore(content, `contexts/${id}.json`, `context,${this.instanceTag()},status:active`);
    return context;
  }
  async getContext(contextId) {
    try {
      const result = await this.yams(`cat ${this.shellEscape(`contexts/${contextId}.json`)}`);
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
    const recentFindings = [...highSeverity, ...unresolved.filter((f) => f.severity !== "high" && f.severity !== "critical")].slice(0, 10);
    const findingDetails = recentFindings.map((f) => {
      const truncated = f.content.length > 300 ? f.content.slice(0, 300) + "..." : f.content;
      return `#### [${f.severity?.toUpperCase() || "INFO"}] ${f.title}
- Agent: ${f.agent_id} | Confidence: ${f.confidence.toFixed(2)} | Status: ${f.status}
${truncated}`;
    }).join(`

`);
    const taskDetails = activeTasks.slice(0, 5).map((t) => {
      const desc = t.description ? t.description.length > 200 ? t.description.slice(0, 200) + "..." : t.description : "";
      return `- [${t.status.toUpperCase()}] ${t.title} (assigned: ${t.assigned_to || "unassigned"})${desc ? `
  ` + desc : ""}`;
    }).join(`
`);
    return `## Blackboard Summary (Context: ${contextId})

### Agents Active (${activeAgents.length})
${activeAgents.map((a) => `- ${a.id}: ${a.capabilities.join(", ")}`).join(`
`) || "- None"}

### Key Findings (${findings.length} total, ${unresolved.length} unresolved)
${findingDetails || "- None"}
${findings.length > 10 ? `
- ... and ${findings.length - 10} more findings` : ""}

### Tasks
${taskDetails || "- No active tasks"}
${blockedTasks.length ? `
**Blocked (${blockedTasks.length}):**
${blockedTasks.map((t) => `- ${t.title}`).join(`
`)}` : ""}

### Unresolved Issues
${unresolved.length ? `- ${unresolved.length} findings need resolution` : "- All findings resolved"}
${blockedTasks.length ? `- ${blockedTasks.length} tasks blocked` : ""}
`;
  }
  async getContextSummaryWithManifest(contextId) {
    const findings = await this.queryFindings({ context_id: contextId, limit: 100, offset: 0 });
    const tasks = await this.queryTasks({ context_id: contextId, limit: 100, offset: 0 });
    const agents = await this.listAgents();
    const activeAgents = agents.filter((a) => a.status === "active");
    const unresolved = findings.filter((f) => f.status !== "resolved");
    const activeTasks = tasks.filter((t) => t.status === "working" || t.status === "claimed");
    const blockedTasks = tasks.filter((t) => t.status === "blocked");
    const manifest = {
      contextId,
      timestamp: new Date().toISOString(),
      findingIds: findings.map((f) => ({
        id: f.id || "",
        topic: f.topic,
        severity: f.severity,
        status: f.status,
        confidence: f.confidence
      })),
      taskIds: tasks.map((t) => ({
        id: t.id || "",
        type: t.type,
        status: t.status,
        priority: t.priority ?? 2
      })),
      agentIds: activeAgents.map((a) => a.id),
      stats: {
        totalFindings: findings.length,
        unresolvedFindings: unresolved.length,
        activeTasks: activeTasks.length,
        blockedTasks: blockedTasks.length
      }
    };
    try {
      await this.yamsStore(JSON.stringify(manifest), `contexts/${contextId}/compaction-manifest.json`, `manifest,ctx:${contextId},scope:persistent`, "");
    } catch {}
    return {
      markdown: await this.getContextSummary(contextId),
      manifest
    };
  }
  async getCompactionManifest(contextId) {
    try {
      const result = await this.yams(`cat ${this.shellEscape(`contexts/${contextId}/compaction-manifest.json`)}`);
      return JSON.parse(result);
    } catch {
      return null;
    }
  }
  async hydrateFromManifest(manifest) {
    const findingPromises = manifest.findingIds.map((f) => this.getFinding(f.id).catch(() => null));
    const taskPromises = manifest.taskIds.map((t) => this.getTask(t.id).catch(() => null));
    const [findingResults, taskResults] = await Promise.all([
      Promise.all(findingPromises),
      Promise.all(taskPromises)
    ]);
    return {
      findings: findingResults.filter((f) => f !== null),
      tasks: taskResults.filter((t) => t !== null)
    };
  }
  async archiveSessionFindings(sessionName) {
    try {
      const sessionFindings = await this.queryFindings({
        scope: "session",
        limit: 1000,
        offset: 0
      });
      for (const finding of sessionFindings) {
        const archiveTags = [
          `archived:${sessionName}`,
          `archived_at:${new Date().toISOString().split("T")[0]}`
        ].join(",");
        try {
          await this.yams(`update --name ${this.shellEscape(`findings/**/${finding.id}.md`)} --tags ${this.shellEscape(archiveTags)} --remove-tags session`);
        } catch {}
      }
    } catch {}
  }
  async searchTasks(query, opts) {
    const tagsParts = ["task"];
    if (opts?.instance_id)
      tagsParts.push(`inst:${opts.instance_id}`);
    if (opts?.type)
      tagsParts.push(`type:${opts.type}`);
    const tags = tagsParts.join(",");
    const limit = opts?.limit || 10;
    try {
      const result = await this.yamsJson(`search ${this.shellEscape(query)} --tags ${this.shellEscape(tags)} --match-all-tags --limit ${limit}`);
      const tasks = [];
      for (const r of result.results || []) {
        const id = r.path?.replace("tasks/", "").replace(".json", "");
        if (id) {
          const task = await this.getTask(id);
          if (task)
            tasks.push(task);
        }
      }
      return tasks;
    } catch {
      return [];
    }
  }
  async search(query, opts) {
    const tags = opts?.instance_id ? `inst:${opts.instance_id}` : "";
    const limit = opts?.limit || 20;
    try {
      const tagArg = tags ? `--tags ${this.shellEscape(tags)} --match-all-tags ` : "";
      const result = await this.yamsJson(`search ${this.shellEscape(query)} ${tagArg}--limit ${limit}`);
      const findings = [];
      const tasks = [];
      for (const r of result.results || []) {
        const path = r.path || "";
        if (path.startsWith("findings/")) {
          const id = path.split("/").pop()?.replace(".md", "");
          if (id) {
            const finding = await this.getFinding(id);
            if (finding)
              findings.push(finding);
          }
        } else if (path.startsWith("tasks/")) {
          const id = path.replace("tasks/", "").replace(".json", "");
          if (id) {
            const task = await this.getTask(id);
            if (task)
              tasks.push(task);
          }
        }
      }
      return { findings, tasks };
    } catch {
      return { findings: [], tasks: [] };
    }
  }
  async grep(pattern, opts) {
    const tagsParts = [];
    if (opts?.entity)
      tagsParts.push(opts.entity);
    if (opts?.instance_id)
      tagsParts.push(`inst:${opts.instance_id}`);
    const tags = tagsParts.join(",");
    const limit = opts?.limit || 50;
    try {
      const tagArg = tags ? `--tags ${this.shellEscape(tags)} --match-all-tags ` : "";
      const result = await this.yams(`grep ${this.shellEscape(pattern)} ${tagArg}--limit ${limit} --json`);
      const parsed = JSON.parse(result);
      const entries = [];
      if (parsed.output) {
        const lines = parsed.output.split(`
`).filter((l) => l.trim());
        const byFile = new Map;
        for (const line of lines) {
          const sep = line.indexOf(":");
          if (sep > 0) {
            const file = line.slice(0, sep);
            const match = line.slice(sep + 1);
            if (!byFile.has(file))
              byFile.set(file, []);
            byFile.get(file).push(match);
          }
        }
        for (const [name, matches] of byFile) {
          entries.push({ name, matches });
        }
      }
      return entries;
    } catch {
      return [];
    }
  }
  async getConnections(entityPath, depth = 2) {
    try {
      const result = await this.yamsJson(`graph --name ${this.shellEscape(entityPath)} --depth ${depth}`);
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
    let contextCount = 0;
    try {
      const ctxResult = await this.yamsJson(`list --tags context --limit 1000`);
      contextCount = ctxResult.documents?.length || 0;
    } catch {}
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
      contexts: contextCount
    };
  }
  async createSubscription(input) {
    const id = this.genId("sub");
    const subscription = {
      id,
      subscriber_id: input.subscriber_id,
      pattern_type: input.pattern_type,
      pattern_value: input.pattern_value,
      filters: input.filters,
      created_at: this.nowISO(),
      expires_at: input.expires_at,
      status: "active"
    };
    const content = JSON.stringify(subscription, null, 2);
    const tags = [
      "subscription",
      this.instanceTag(),
      `subscriber:${subscription.subscriber_id}`,
      `pattern:${subscription.pattern_type}:${subscription.pattern_value}`,
      "status:active"
    ].join(",");
    await this.yamsStore(content, `subscriptions/${subscription.subscriber_id}/${id}.json`, tags, this.sessionArg());
    return subscription;
  }
  async getSubscription(subscriberId, subscriptionId) {
    try {
      const result = await this.yams(`cat ${this.shellEscape(`subscriptions/${subscriberId}/${subscriptionId}.json`)}`);
      return JSON.parse(result);
    } catch {
      return null;
    }
  }
  async listSubscriptions(subscriberId) {
    try {
      const result = await this.yamsJson(`list --tags ${this.shellEscape(`subscription,${this.instanceTag()},subscriber:${subscriberId}`)} --match-all-tags --limit 100`);
      const subscriptions = [];
      for (const doc of result.documents || []) {
        try {
          const content = await this.yams(`cat ${this.shellEscape(doc.name)}`);
          const sub = JSON.parse(content);
          if (sub.expires_at && new Date(sub.expires_at) < new Date) {
            continue;
          }
          if (sub.status === "active") {
            subscriptions.push(sub);
          }
        } catch {}
      }
      return subscriptions;
    } catch {
      return [];
    }
  }
  async cancelSubscription(subscriberId, subscriptionId) {
    try {
      const sub = await this.getSubscription(subscriberId, subscriptionId);
      if (!sub)
        return false;
      sub.status = "expired";
      const content = JSON.stringify(sub, null, 2);
      const tags = [
        "subscription",
        this.instanceTag(),
        `subscriber:${sub.subscriber_id}`,
        `pattern:${sub.pattern_type}:${sub.pattern_value}`,
        "status:expired"
      ].join(",");
      await this.yamsStore(content, `subscriptions/${subscriberId}/${subscriptionId}.json`, tags);
      return true;
    } catch {
      return false;
    }
  }
  async findMatchingSubscriptions(event) {
    const matching = [];
    try {
      const result = await this.yamsJson(`list --tags ${this.shellEscape(`subscription,${this.instanceTag()},status:active`)} --match-all-tags --limit 500`);
      for (const doc of result.documents || []) {
        try {
          const content = await this.yams(`cat ${this.shellEscape(doc.name)}`);
          const sub = JSON.parse(content);
          if (sub.expires_at && new Date(sub.expires_at) < new Date) {
            continue;
          }
          if (sub.filters?.exclude_self !== false && sub.subscriber_id === event.source_agent_id) {
            continue;
          }
          let matches = false;
          switch (sub.pattern_type) {
            case "topic":
              matches = event.topic === sub.pattern_value;
              break;
            case "agent":
              matches = event.source_agent_id === sub.pattern_value;
              break;
            case "status":
              matches = event.status === sub.pattern_value;
              break;
            case "context":
              matches = event.context_id === sub.pattern_value;
              break;
            case "entity":
              matches = event.source_type === sub.pattern_value;
              break;
          }
          if (!matches)
            continue;
          if (sub.filters?.severity?.length && event.severity) {
            if (!sub.filters.severity.includes(event.severity)) {
              continue;
            }
          }
          matching.push(sub);
        } catch {}
      }
    } catch {}
    return matching;
  }
  async createNotification(input) {
    const id = this.genId("notif");
    const notification = {
      id,
      subscription_id: input.subscription_id,
      event_type: input.event_type,
      source_id: input.source_id,
      source_type: input.source_type,
      source_agent_id: input.source_agent_id,
      summary: input.summary,
      recipient_id: input.recipient_id,
      created_at: this.nowISO(),
      status: "unread"
    };
    const content = JSON.stringify(notification, null, 2);
    const tags = [
      "notification",
      this.instanceTag(),
      `recipient:${notification.recipient_id}`,
      `event:${notification.event_type}`,
      "status:unread"
    ].join(",");
    await this.yamsStore(content, `notifications/${notification.recipient_id}/${id}.json`, tags, this.sessionArg());
    return notification;
  }
  async getUnreadNotifications(recipientId, limit = 20) {
    try {
      const result = await this.yamsJson(`list --tags ${this.shellEscape(`notification,${this.instanceTag()},recipient:${recipientId},status:unread`)} --match-all-tags --limit ${limit}`);
      const notifications = [];
      for (const doc of result.documents || []) {
        try {
          const content = await this.yams(`cat ${this.shellEscape(doc.name)}`);
          notifications.push(JSON.parse(content));
        } catch {}
      }
      return notifications.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    } catch {
      return [];
    }
  }
  async markNotificationRead(recipientId, notificationId) {
    try {
      const path = `notifications/${recipientId}/${notificationId}.json`;
      const content = await this.yams(`cat ${this.shellEscape(path)}`);
      const notification = JSON.parse(content);
      notification.status = "read";
      notification.read_at = this.nowISO();
      const tags = [
        "notification",
        this.instanceTag(),
        `recipient:${notification.recipient_id}`,
        `event:${notification.event_type}`,
        "status:read"
      ].join(",");
      await this.yamsStore(JSON.stringify(notification, null, 2), path, tags);
      return true;
    } catch {
      return false;
    }
  }
  async markAllNotificationsRead(recipientId) {
    const unread = await this.getUnreadNotifications(recipientId, 100);
    let count = 0;
    for (const notification of unread) {
      if (await this.markNotificationRead(recipientId, notification.id)) {
        count++;
      }
    }
    return count;
  }
  async dismissNotification(recipientId, notificationId) {
    try {
      const path = `notifications/${recipientId}/${notificationId}.json`;
      const content = await this.yams(`cat ${this.shellEscape(path)}`);
      const notification = JSON.parse(content);
      notification.status = "dismissed";
      const tags = [
        "notification",
        this.instanceTag(),
        `recipient:${notification.recipient_id}`,
        `event:${notification.event_type}`,
        "status:dismissed"
      ].join(",");
      await this.yamsStore(JSON.stringify(notification, null, 2), path, tags);
      return true;
    } catch {
      return false;
    }
  }
  async getNotificationCount(recipientId) {
    try {
      const unreadResult = await this.yamsJson(`list --tags ${this.shellEscape(`notification,${this.instanceTag()},recipient:${recipientId},status:unread`)} --match-all-tags --limit 1000`);
      const unread = unreadResult.documents?.length || 0;
      const totalResult = await this.yamsJson(`list --tags ${this.shellEscape(`notification,${this.instanceTag()},recipient:${recipientId}`)} --match-all-tags --limit 1000`);
      const total = totalResult.documents?.length || 0;
      return { unread, total };
    } catch {
      return { unread: 0, total: 0 };
    }
  }
  async triggerNotifications(event) {
    const matchingSubscriptions = await this.findMatchingSubscriptions(event);
    let created = 0;
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
            status: event.status
          },
          recipient_id: sub.subscriber_id
        });
        created++;
      } catch {}
    }
    return created;
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
  instance_id: z.string().optional().describe("Filter by instance ID for cross-instance queries"),
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
  instance_id: z.string().optional().describe("Filter by instance ID for cross-instance queries"),
  limit: z.number().int().positive().default(20),
  offset: z.number().int().nonnegative().default(0)
});
var SubscriptionPatternType = z.enum(["topic", "entity", "agent", "status", "context"]);
var SubscriptionStatus = z.enum(["active", "paused", "expired"]);
var SubscriptionFiltersSchema = z.object({
  severity: z.array(FindingSeverity).optional().describe("Only notify for these severities"),
  min_confidence: z.number().min(0).max(1).optional().describe("Minimum confidence threshold"),
  exclude_self: z.boolean().default(true).describe("Don't notify on own actions")
});
var SubscriptionSchema = z.object({
  id: z.string().min(1).describe("Unique subscription identifier"),
  subscriber_id: z.string().min(1).describe("Agent ID who created this subscription"),
  pattern_type: SubscriptionPatternType.describe("What to match: topic, entity, agent, status, context"),
  pattern_value: z.string().min(1).describe("Pattern to match (e.g., 'security' for topic, 'scanner' for agent)"),
  filters: SubscriptionFiltersSchema.optional(),
  created_at: z.string().datetime(),
  expires_at: z.string().datetime().optional().describe("Auto-expire after this time"),
  status: SubscriptionStatus.default("active")
});
var NotificationEventType = z.enum([
  "finding_created",
  "finding_updated",
  "finding_resolved",
  "task_created",
  "task_updated",
  "task_claimed",
  "task_completed"
]);
var NotificationSourceType = z.enum(["finding", "task"]);
var NotificationStatus = z.enum(["unread", "read", "dismissed"]);
var NotificationSummarySchema = z.object({
  title: z.string().min(1),
  topic: z.string().optional(),
  severity: FindingSeverity.optional(),
  status: z.string().optional()
});
var NotificationSchema = z.object({
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
  status: NotificationStatus.default("unread")
});

// index.ts
var YamsBlackboardPlugin = async ({ $, project, directory }) => {
  const blackboard = new YamsBlackboard($, { defaultScope: "persistent" });
  let currentContextId;
  return {
    event: async ({ event }) => {
      if (event.type === "session.created") {
        await blackboard.startSession();
      }
    },
    "experimental.session.compacting": async (input, output) => {
      try {
        await blackboard.archiveSessionFindings(input.sessionID);
        const contextId = currentContextId || "default";
        const { markdown, manifest } = await blackboard.getContextSummaryWithManifest(contextId);
        output.context.push(markdown);
        output.context.push(`
<!-- BLACKBOARD_MANIFEST:${JSON.stringify(manifest)} -->`);
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
        description: "List all registered agents and their capabilities. Lists agents across all instances by default.",
        args: {
          instance_id: z2.string().optional().describe("Filter by specific instance ID (omit to list agents across all instances)")
        },
        async execute(args) {
          const agents = await blackboard.listAgents({ instance_id: args.instance_id });
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
        description: "Query findings from the blackboard by topic, agent, severity, or context. Use to discover what other agents have found. By default, searches across all instances/sessions.",
        args: {
          topic: FindingTopic.optional().describe("Filter by topic"),
          agent_id: z2.string().optional().describe("Filter by source agent"),
          context_id: z2.string().optional().describe("Filter by context group"),
          status: FindingStatus.optional().describe("Filter by status"),
          severity: z2.array(FindingSeverity).optional().describe("Filter by severity levels"),
          min_confidence: z2.number().min(0).max(1).optional().describe("Minimum confidence threshold"),
          scope: FindingScope.optional().describe("Filter by persistence scope"),
          instance_id: z2.string().optional().describe("Filter by specific instance ID (omit to search across all instances)"),
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
        description: "Search findings using natural language. Uses semantic search to find relevant findings. Searches across all instances/sessions by default.",
        args: {
          query: z2.string().min(1).describe("Natural language search query"),
          topic: FindingTopic.optional().describe("Limit to specific topic"),
          instance_id: z2.string().optional().describe("Filter by specific instance ID (omit to search across all instances)"),
          limit: z2.number().int().positive().optional().describe("Max results (default: 10)")
        },
        async execute(args) {
          const findings = await blackboard.searchFindings(args.query, {
            topic: args.topic,
            instance_id: args.instance_id,
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
        description: "Update the status, findings, or artifacts of a task you're working on",
        args: {
          task_id: z2.string().min(1).describe("The task ID"),
          status: TaskStatus.optional().describe("New status: working, blocked, review, completed"),
          error: z2.string().optional().describe("Error message if blocked/failed"),
          findings: z2.array(z2.string()).optional().describe("Finding IDs to associate with this task"),
          artifacts: z2.array(ArtifactSchema).optional().describe("Artifacts produced by this task (files, data, reports)")
        },
        async execute(args) {
          const updates = {};
          if (args.status)
            updates.status = args.status;
          if (args.error)
            updates.error = args.error;
          if (args.findings)
            updates.findings = args.findings;
          if (args.artifacts)
            updates.artifacts = args.artifacts;
          const task = await blackboard.updateTask(args.task_id, updates);
          if (!task) {
            return `Task not found: ${args.task_id}`;
          }
          return `Task ${task.id} updated to status: ${task.status}${args.findings?.length ? `
Associated findings: ${args.findings.join(", ")}` : ""}${args.artifacts?.length ? `
Attached ${args.artifacts.length} artifact(s)` : ""}`;
        }
      }),
      bb_complete_task: tool({
        description: "Mark a task as completed, optionally with findings or artifacts",
        args: {
          task_id: z2.string().min(1).describe("The task ID"),
          findings: z2.array(z2.string()).optional().describe("Finding IDs produced by this task"),
          artifacts: z2.array(ArtifactSchema).optional().describe("Artifacts produced by this task (files, data, reports)")
        },
        async execute(args) {
          const task = await blackboard.completeTask(args.task_id, {
            findings: args.findings,
            artifacts: args.artifacts
          });
          if (!task) {
            return `Task not found: ${args.task_id}`;
          }
          return `Task completed: ${task.id}
Title: ${task.title}${args.findings?.length ? `
Findings: ${args.findings.join(", ")}` : ""}${args.artifacts?.length ? `
Artifacts: ${args.artifacts.map((a) => a.name).join(", ")}` : ""}`;
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
        description: "Query tasks by type, status, priority, or assignee. Searches across all instances/sessions by default.",
        args: {
          type: TaskType.optional().describe("Filter by task type"),
          status: TaskStatus.optional().describe("Filter by status"),
          priority: TaskPriority.optional().describe("Filter by priority"),
          created_by: z2.string().optional().describe("Filter by creator"),
          assigned_to: z2.string().optional().describe("Filter by assignee"),
          context_id: z2.string().optional().describe("Filter by context"),
          instance_id: z2.string().optional().describe("Filter by specific instance ID (omit to search across all instances)"),
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
      bb_search_tasks: tool({
        description: "Search tasks using natural language. Uses semantic search to find relevant tasks. Searches across all instances/sessions by default.",
        args: {
          query: z2.string().min(1).describe("Natural language search query"),
          type: TaskType.optional().describe("Limit to specific task type"),
          instance_id: z2.string().optional().describe("Filter by specific instance ID (omit to search across all instances)"),
          limit: z2.number().int().positive().optional().describe("Max results (default: 10)")
        },
        async execute(args) {
          const tasks = await blackboard.searchTasks(args.query, {
            type: args.type,
            instance_id: args.instance_id,
            limit: args.limit ?? 10
          });
          if (tasks.length === 0) {
            return "No tasks match the search.";
          }
          return tasks.map((t) => `[${t.id}] P${t.priority} ${t.type.toUpperCase()} | ${t.title}
  Status: ${t.status} | Created: ${t.created_by}${t.assigned_to ? ` | Assigned: ${t.assigned_to}` : ""}
  ${t.description ? t.description.slice(0, 200) + (t.description.length > 200 ? "..." : "") : ""}`).join(`

`);
        }
      }),
      bb_search: tool({
        description: "Unified semantic search across all blackboard entities (findings and tasks). Returns results classified by type. Searches across all instances/sessions by default.",
        args: {
          query: z2.string().min(1).describe("Natural language search query"),
          instance_id: z2.string().optional().describe("Filter by specific instance ID (omit to search across all instances)"),
          limit: z2.number().int().positive().optional().describe("Max results (default: 20)")
        },
        async execute(args) {
          const results = await blackboard.search(args.query, {
            instance_id: args.instance_id,
            limit: args.limit ?? 20
          });
          const output = [];
          if (results.findings.length > 0) {
            output.push("### Findings");
            output.push(results.findings.map((f) => `[${f.id}] ${f.topic.toUpperCase()} | ${f.title}
  ${f.content.slice(0, 150)}${f.content.length > 150 ? "..." : ""}`).join(`

`));
          }
          if (results.tasks.length > 0) {
            output.push(`
### Tasks`);
            output.push(results.tasks.map((t) => `[${t.id}] P${t.priority} ${t.type.toUpperCase()} | ${t.title}
  Status: ${t.status}`).join(`

`));
          }
          if (output.length === 0) {
            return "No results match the search.";
          }
          return output.join(`
`);
        }
      }),
      bb_grep: tool({
        description: "Search blackboard content using regex/pattern matching. Searches across finding and task content across all instances/sessions by default.",
        args: {
          pattern: z2.string().min(1).describe("Regex pattern to search for"),
          entity: z2.enum(["finding", "task"]).optional().describe("Limit to findings or tasks"),
          instance_id: z2.string().optional().describe("Filter by specific instance ID (omit to search across all instances)"),
          limit: z2.number().int().positive().optional().describe("Max results (default: 50)")
        },
        async execute(args) {
          const results = await blackboard.grep(args.pattern, {
            entity: args.entity,
            instance_id: args.instance_id,
            limit: args.limit ?? 50
          });
          if (results.length === 0) {
            return "No matches found.";
          }
          return results.map((r) => `**${r.name}**
${r.matches.slice(0, 5).map((m) => `  ${m}`).join(`
`)}${r.matches.length > 5 ? `
  ... and ${r.matches.length - 5} more matches` : ""}`).join(`

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
      }),
      bb_subscribe: tool({
        description: "Subscribe to blackboard events matching a pattern. Get notified when findings/tasks matching your criteria are created or updated. Call bb_check_notifications to see what's new.",
        args: {
          agent_id: z2.string().min(1).describe("Your agent identifier"),
          pattern_type: SubscriptionPatternType.describe("What to match: 'topic' (finding topic), 'agent' (source agent), 'status', 'context', 'entity' (finding/task)"),
          pattern_value: z2.string().min(1).describe("Value to match (e.g., 'security' for topic, 'scanner' for agent, 'finding' for entity)"),
          severity_filter: z2.array(FindingSeverity).optional().describe("Only notify for these severities (e.g., ['high', 'critical'])"),
          min_confidence: z2.number().min(0).max(1).optional().describe("Minimum confidence threshold"),
          exclude_self: z2.boolean().optional().describe("Don't notify on your own actions (default: true)"),
          expires_in_hours: z2.number().positive().optional().describe("Auto-expire subscription after N hours")
        },
        async execute(args) {
          const expiresAt = args.expires_in_hours ? new Date(Date.now() + args.expires_in_hours * 60 * 60 * 1000).toISOString() : undefined;
          const subscription = await blackboard.createSubscription({
            subscriber_id: args.agent_id,
            pattern_type: args.pattern_type,
            pattern_value: args.pattern_value,
            filters: {
              severity: args.severity_filter,
              min_confidence: args.min_confidence,
              exclude_self: args.exclude_self ?? true
            },
            expires_at: expiresAt
          });
          return `Subscription created: ${subscription.id}
Pattern: ${subscription.pattern_type}:${subscription.pattern_value}
${args.severity_filter?.length ? `Severity filter: ${args.severity_filter.join(", ")}` : ""}
${args.min_confidence ? `Min confidence: ${args.min_confidence}` : ""}
${expiresAt ? `Expires: ${expiresAt}` : "No expiration"}

Use bb_check_notifications to see matching events.`;
        }
      }),
      bb_unsubscribe: tool({
        description: "Cancel an active subscription",
        args: {
          agent_id: z2.string().min(1).describe("Your agent identifier"),
          subscription_id: z2.string().min(1).describe("The subscription ID to cancel")
        },
        async execute(args) {
          const success = await blackboard.cancelSubscription(args.agent_id, args.subscription_id);
          if (success) {
            return `Subscription ${args.subscription_id} cancelled.`;
          }
          return `Failed to cancel subscription ${args.subscription_id}. It may not exist or is already cancelled.`;
        }
      }),
      bb_list_subscriptions: tool({
        description: "List your active subscriptions",
        args: {
          agent_id: z2.string().min(1).describe("Your agent identifier")
        },
        async execute(args) {
          const subscriptions = await blackboard.listSubscriptions(args.agent_id);
          if (subscriptions.length === 0) {
            return "No active subscriptions.";
          }
          return subscriptions.map((s) => `[${s.id}] ${s.pattern_type}:${s.pattern_value}
  Created: ${s.created_at}${s.expires_at ? ` | Expires: ${s.expires_at}` : ""}
  ${s.filters?.severity?.length ? `Severity: ${s.filters.severity.join(", ")}` : ""}`).join(`

`);
        }
      }),
      bb_check_notifications: tool({
        description: "Check your notification mailbox for new events. Call this at the start of each turn to see what other agents have posted that matches your subscriptions.",
        args: {
          agent_id: z2.string().min(1).describe("Your agent identifier"),
          limit: z2.number().int().positive().optional().describe("Max notifications to return (default: 10)"),
          mark_as_read: z2.boolean().optional().describe("Mark returned notifications as read (default: false)")
        },
        async execute(args) {
          const notifications = await blackboard.getUnreadNotifications(args.agent_id, args.limit ?? 10);
          if (notifications.length === 0) {
            return "No new notifications.";
          }
          if (args.mark_as_read) {
            for (const n of notifications) {
              await blackboard.markNotificationRead(args.agent_id, n.id);
            }
          }
          const output = notifications.map((n) => {
            const severityStr = n.summary.severity ? ` (${n.summary.severity})` : "";
            return `[${n.id}] ${n.event_type}: ${n.summary.title}${severityStr}
  Source: ${n.source_type}/${n.source_id} by ${n.source_agent_id}
  ${n.summary.topic ? `Topic: ${n.summary.topic} | ` : ""}Time: ${n.created_at}`;
          });
          return `## ${notifications.length} New Notification${notifications.length > 1 ? "s" : ""}

${output.join(`

`)}${args.mark_as_read ? `

(Marked as read)` : ""}`;
        }
      }),
      bb_notification_count: tool({
        description: "Quick count of unread notifications without fetching details",
        args: {
          agent_id: z2.string().min(1).describe("Your agent identifier")
        },
        async execute(args) {
          const counts = await blackboard.getNotificationCount(args.agent_id);
          return `Unread: ${counts.unread} | Total: ${counts.total}`;
        }
      }),
      bb_mark_notification_read: tool({
        description: "Mark a specific notification as read",
        args: {
          agent_id: z2.string().min(1).describe("Your agent identifier"),
          notification_id: z2.string().min(1).describe("The notification ID to mark as read")
        },
        async execute(args) {
          const success = await blackboard.markNotificationRead(args.agent_id, args.notification_id);
          if (success) {
            return `Notification ${args.notification_id} marked as read.`;
          }
          return `Failed to mark notification ${args.notification_id} as read.`;
        }
      }),
      bb_mark_all_read: tool({
        description: "Mark all notifications as read",
        args: {
          agent_id: z2.string().min(1).describe("Your agent identifier")
        },
        async execute(args) {
          const count = await blackboard.markAllNotificationsRead(args.agent_id);
          return `Marked ${count} notification${count !== 1 ? "s" : ""} as read.`;
        }
      }),
      bb_dismiss_notification: tool({
        description: "Dismiss a notification permanently (won't show in future queries)",
        args: {
          agent_id: z2.string().min(1).describe("Your agent identifier"),
          notification_id: z2.string().min(1).describe("The notification ID to dismiss")
        },
        async execute(args) {
          const success = await blackboard.dismissNotification(args.agent_id, args.notification_id);
          if (success) {
            return `Notification ${args.notification_id} dismissed.`;
          }
          return `Failed to dismiss notification ${args.notification_id}.`;
        }
      })
    }
  };
};
var opencode_blackboard_default = YamsBlackboardPlugin;
export {
  opencode_blackboard_default as default,
  YamsBlackboardPlugin
};
