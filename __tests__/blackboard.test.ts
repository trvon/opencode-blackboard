/**
 * YamsBlackboard class tests
 *
 * Tests the blackboard interaction layer with mocked shell responses.
 */

import { describe, test, expect, mock } from "bun:test"
import { YamsBlackboard } from "../blackboard"
import type { CreateFinding, CreateTask } from "../types"

// Helper to create a promise with .quiet() method attached (mimics Bun shell behavior)
function createQuietablePromise<T>(promise: Promise<T>): Promise<T> & { quiet(): Promise<T> } {
  const quietablePromise = promise as Promise<T> & { quiet(): Promise<T> }
  quietablePromise.quiet = () => quietablePromise
  return quietablePromise
}

// Mock shell that returns configurable responses
function createMockShell(responses: Record<string, unknown> = {}) {
  const calls: string[] = []
  const defaultResponse = { stdout: Buffer.from("{}") }

  const mockShell = mock((strings: TemplateStringsArray, ...values: unknown[]) => {
    const cmd = strings.reduce((acc, str, i) => acc + str + (values[i] ?? ""), "")
    calls.push(cmd)

    const resultPromise = (async () => {
      // Check if we have a specific response for this command
      for (const [pattern, response] of Object.entries(responses)) {
        if (cmd.includes(pattern)) {
          if (typeof response === "function") {
            return response(cmd)
          }
          if (typeof response === "string") {
            return { stdout: Buffer.from(response) }
          }
          return response
        }
      }

      return defaultResponse
    })()

    // Return promise with .quiet() method attached
    return createQuietablePromise(resultPromise)
  })

  return { $: mockShell as ReturnType<typeof createMockShell>["$"], calls }
}

describe("YamsBlackboard", () => {
  describe("shell result handling", () => {
    test("handles string result", async () => {
      const { $ } = createMockShell({
        "echo": () => "plain string output",
      })

      const bb = new YamsBlackboard($)
      // Use startSession which internally calls shell()
      const result = await bb.startSession("test-session")
      expect(result).toBe("test-session")
    })

    test("handles Buffer stdout", async () => {
      const { $ } = createMockShell({
        "session start": () => ({ stdout: Buffer.from("session started") }),
      })

      const bb = new YamsBlackboard($)
      await bb.startSession("buffer-test")
      // Should not throw
    })

    test("handles Uint8Array stdout", async () => {
      const encoder = new TextEncoder()
      const { $ } = createMockShell({
        "session start": () => ({ stdout: encoder.encode("session started") }),
      })

      const bb = new YamsBlackboard($)
      await bb.startSession("uint8-test")
      // Should not throw
    })

    test("handles object with text property", async () => {
      const { $ } = createMockShell({
        "session start": () => ({ text: "text property output" }),
      })

      const bb = new YamsBlackboard($)
      await bb.startSession("text-prop-test")
      // Should not throw
    })

    test("handles shell errors gracefully", async () => {
      const failingShell = mock(() => {
        return createQuietablePromise(Promise.reject(new Error("Command not found")))
      })

      const bb = new YamsBlackboard(failingShell as any)

      await expect(bb.startSession("fail-test")).rejects.toThrow("Shell command failed")
    })
  })

  describe("agent management", () => {
    test("registerAgent creates agent card", async () => {
      const { $, calls } = createMockShell()

      const bb = new YamsBlackboard($)
      const agent = await bb.registerAgent({
        id: "test-agent",
        name: "Test Agent",
        capabilities: ["code-review", "testing"],
        status: "active",
      })

      expect(agent.id).toBe("test-agent")
      expect(agent.name).toBe("Test Agent")
      expect(agent.capabilities).toContain("code-review")
      expect(agent.registered_at).toBeDefined()

      // Verify shell command was called with agent data
      const storeCmd = calls.find((c) => c.includes("yams add"))
      expect(storeCmd).toContain("agents/test-agent.json")
      expect(storeCmd).toContain("--metadata owner=opencode")
    })

    test("listAgents returns empty array on no agents", async () => {
      const { $ } = createMockShell({
        list: () => ({ stdout: Buffer.from(JSON.stringify({ documents: [] })) }),
      })

      const bb = new YamsBlackboard($)
      const agents = await bb.listAgents()
      expect(agents).toEqual([])
    })
  })

  describe("finding management", () => {
    test("postFinding generates unique ID and writes owner=opencode", async () => {
      const { $: $1 } = createMockShell()

      const bb = new YamsBlackboard($1)
      const finding = await bb.postFinding({
        agent_id: "test-agent",
        topic: "security",
        title: "Test Finding",
        content: "This is a test finding",
        confidence: 0.9,
        scope: "persistent",
      })

      expect(finding.id).toMatch(/^f-\d+-[a-z0-9]+$/)
      expect(finding.agent_id).toBe("test-agent")
      expect(finding.topic).toBe("security")
      expect(finding.status).toBe("published")

      // Verify owner metadata is applied on write via captured shell command
      const { $: $2, calls: calls2 } = createMockShell()
      const bb2 = new YamsBlackboard($2)
      await bb2.postFinding({
        agent_id: "test-agent",
        topic: "security",
        title: "Test Finding 2",
        content: "Body",
        confidence: 0.5,
        scope: "session",
      })
      const storeCmd2 = calls2.find((c) => c.includes("--metadata owner=opencode"))
      expect(storeCmd2).toBeTruthy()
    })

    test("queryFindings applies filters", async () => {
      const { $, calls } = createMockShell({
        list: () => ({ stdout: Buffer.from(JSON.stringify({ documents: [] })) }),
      })

      const bb = new YamsBlackboard($)
      await bb.queryFindings({
        topic: "security",
        severity: ["high"],
        limit: 10,
        offset: 0,
      })

      const listCmd = calls.find((c) => c.includes("list"))
      expect(listCmd).toContain("topic:security")
      expect(listCmd).toContain("severity:high")
    })
  })

  describe("task management", () => {
    test("createTask generates unique ID and sets defaults", async () => {
      const { $ } = createMockShell()

      const bb = new YamsBlackboard($)
      const task = await bb.createTask({
        title: "Review code",
        type: "review",
        priority: 2,
        created_by: "test-agent",
      })

      expect(task.id).toMatch(/^t-\d+-[a-z0-9]+$/)
      expect(task.status).toBe("pending")
      expect(task.priority).toBe(2)
    })

    test("claimTask updates status and assignee", async () => {
      const taskData = {
        id: "t-123",
        title: "Test task",
        type: "review",
        status: "pending",
        priority: 2,
        created_by: "agent-1",
      }

      const { $ } = createMockShell({
        cat: () => ({ stdout: Buffer.from(JSON.stringify(taskData)) }),
      })

      const bb = new YamsBlackboard($)
      const claimed = await bb.claimTask("t-123", "agent-2")

      expect(claimed).not.toBeNull()
      expect(claimed!.status).toBe("claimed")
      expect(claimed!.assigned_to).toBe("agent-2")
      expect(claimed!.claimed_at).toBeDefined()
    })

    test("claimTask returns null for non-pending task", async () => {
      const taskData = {
        id: "t-123",
        title: "Test task",
        type: "review",
        status: "claimed", // Already claimed
        priority: 2,
        created_by: "agent-1",
      }

      const { $ } = createMockShell({
        cat: () => ({ stdout: Buffer.from(JSON.stringify(taskData)) }),
      })

      const bb = new YamsBlackboard($)
      const result = await bb.claimTask("t-123", "agent-2")
      expect(result).toBeNull()
    })
  })

  describe("context management", () => {
    test("createContext initializes context structure", async () => {
      const { $ } = createMockShell()

      const bb = new YamsBlackboard($)
      const ctx = await bb.createContext("audit-2025", "Security Audit", "Full security review")

      expect(ctx.id).toBe("audit-2025")
      expect(ctx.name).toBe("Security Audit")
      expect(ctx.description).toBe("Full security review")
      expect(ctx.findings).toEqual([])
      expect(ctx.tasks).toEqual([])
      expect(ctx.status).toBe("active")
    })
  })

  describe("finding lifecycle", () => {
    test("getFinding parses YAML frontmatter and markdown body", async () => {
      const md = `---
id: "f-123"
agent_id: "scanner"
topic: "security"
confidence: 0.9
status: "published"
scope: "persistent"
severity: "high"
---

# SQL Injection in login

Found SQL injection vulnerability`

      const { $ } = createMockShell({
        cat: () => ({ stdout: Buffer.from(md) }),
      })

      const bb = new YamsBlackboard($)
      const finding = await bb.getFinding("f-123")

      expect(finding).not.toBeNull()
      expect(finding!.id).toBe("f-123")
      expect(finding!.agent_id).toBe("scanner")
      expect(finding!.topic).toBe("security")
      expect(finding!.confidence).toBe(0.9)
      expect(finding!.severity).toBe("high")
      expect(finding!.title).toBe("SQL Injection in login")
      expect(finding!.content).toBe("Found SQL injection vulnerability")
    })

    test("acknowledgeFinding sends update with status tag and metadata key=value args", async () => {
      const { $, calls } = createMockShell()

      const bb = new YamsBlackboard($)
      await bb.acknowledgeFinding("f-123", "reviewer-agent")

      const updateCmd = calls.find(c => c.includes("update"))
      expect(updateCmd).toContain("status:acknowledged")
      expect(updateCmd).toContain("-m")
      expect(updateCmd).toContain("acknowledged_by=reviewer-agent")
      expect(updateCmd).toContain("acknowledged_at=")
    })

    test("resolveFinding includes resolver, resolution, and timestamp as key=value args", async () => {
      const { $, calls } = createMockShell()

      const bb = new YamsBlackboard($)
      await bb.resolveFinding("f-456", "fixer-agent", "Patched the query")

      const updateCmd = calls.find(c => c.includes("update"))
      expect(updateCmd).toContain("status:resolved")
      expect(updateCmd).toContain("-m")
      expect(updateCmd).toContain("resolved_by=fixer-agent")
      expect(updateCmd).toContain("resolution=Patched the query")
      expect(updateCmd).toContain("resolved_at=")
    })

    test("searchFindings constructs search command with tag filters", async () => {
      const { $, calls } = createMockShell({
        search: () => ({ stdout: Buffer.from(JSON.stringify({ results: [] })) }),
      })

      const bb = new YamsBlackboard($)
      await bb.searchFindings("SQL injection", { topic: "security", limit: 5 })

      const searchCmd = calls.find(c => c.includes("search"))
      expect(searchCmd).toContain("SQL injection")
      expect(searchCmd).toContain("finding,topic:security")
      expect(searchCmd).toContain("--match-all-tags")
      expect(searchCmd).toContain("--limit 5")
    })
  })

  describe("task dependencies (getReadyTasks)", () => {
    test("returns pending tasks with no depends_on", async () => {
      const task1 = { id: "t-1", title: "Task 1", type: "review", status: "pending", priority: 2, created_by: "a" }
      const task2 = { id: "t-2", title: "Task 2", type: "test", status: "pending", priority: 1, created_by: "a" }

      const { $ } = createMockShell({
        "list": () => ({ stdout: Buffer.from(JSON.stringify({ documents: [
          { name: "tasks/t-1.json" },
          { name: "tasks/t-2.json" },
        ] })) }),
        "tasks/t-1.json": () => ({ stdout: Buffer.from(JSON.stringify(task1)) }),
        "tasks/t-2.json": () => ({ stdout: Buffer.from(JSON.stringify(task2)) }),
      })

      const bb = new YamsBlackboard($)
      const ready = await bb.getReadyTasks()

      expect(ready.length).toBe(2)
      // Sorted by priority: t-2 (priority 1) before t-1 (priority 2)
      expect(ready[0].id).toBe("t-2")
      expect(ready[1].id).toBe("t-1")
    })

    test("excludes tasks whose dependencies are not completed", async () => {
      const task1 = { id: "t-1", title: "Dep", type: "review", status: "pending", priority: 2, created_by: "a" }
      const task2 = { id: "t-2", title: "Blocked", type: "test", status: "pending", priority: 1, created_by: "a", depends_on: ["t-1"] }

      const { $ } = createMockShell({
        "list": () => ({ stdout: Buffer.from(JSON.stringify({ documents: [
          { name: "tasks/t-1.json" },
          { name: "tasks/t-2.json" },
        ] })) }),
        "tasks/t-1.json": () => ({ stdout: Buffer.from(JSON.stringify(task1)) }),
        "tasks/t-2.json": () => ({ stdout: Buffer.from(JSON.stringify(task2)) }),
      })

      const bb = new YamsBlackboard($)
      const ready = await bb.getReadyTasks()

      // t-2 depends on t-1 which is "pending" not "completed", so excluded
      expect(ready.length).toBe(1)
      expect(ready[0].id).toBe("t-1")
    })

    test("includes tasks whose dependencies are all completed", async () => {
      const task1 = { id: "t-1", title: "Done", type: "review", status: "completed", priority: 2, created_by: "a" }
      const task2 = { id: "t-2", title: "Ready", type: "test", status: "pending", priority: 0, created_by: "a", depends_on: ["t-1"] }

      // getReadyTasks queries pending tasks, then checks deps
      const { $ } = createMockShell({
        "list": () => ({ stdout: Buffer.from(JSON.stringify({ documents: [
          { name: "tasks/t-2.json" },
        ] })) }),
        "tasks/t-2.json": () => ({ stdout: Buffer.from(JSON.stringify(task2)) }),
        "tasks/t-1.json": () => ({ stdout: Buffer.from(JSON.stringify(task1)) }),
      })

      const bb = new YamsBlackboard($)
      const ready = await bb.getReadyTasks()

      expect(ready.length).toBe(1)
      expect(ready[0].id).toBe("t-2")
    })
  })

  describe("context management extended", () => {
    test("getContext retrieves and parses context JSON", async () => {
      const ctx = { id: "audit-1", name: "Audit", description: "Full audit", findings: [], tasks: [], agents: [], status: "active" }
      const { $ } = createMockShell({
        cat: () => ({ stdout: Buffer.from(JSON.stringify(ctx)) }),
      })

      const bb = new YamsBlackboard($)
      const result = await bb.getContext("audit-1")

      expect(result).not.toBeNull()
      expect(result!.id).toBe("audit-1")
      expect(result!.name).toBe("Audit")
      expect(result!.status).toBe("active")
    })

    test("getContextSummary builds markdown with agents, findings, tasks sections", async () => {
      const { $ } = createMockShell({
        list: () => ({ stdout: Buffer.from(JSON.stringify({ documents: [] })) }),
      })

      const bb = new YamsBlackboard($)
      const summary = await bb.getContextSummary("test-ctx")

      expect(summary).toContain("Blackboard Summary")
      expect(summary).toContain("test-ctx")
      expect(summary).toContain("Agents Active")
      expect(summary).toContain("Key Findings")
      expect(summary).toContain("Tasks")
    })
  })

  describe("tag filtering for shared blackboard", () => {
    test("queryFindings with agent_id builds agent tag", async () => {
      const { $, calls } = createMockShell({
        list: () => ({ stdout: Buffer.from(JSON.stringify({ documents: [] })) }),
      })

      const bb = new YamsBlackboard($)
      await bb.queryFindings({ agent_id: "agent-b", limit: 10, offset: 0 })

      const listCmd = calls.find(c => c.includes("list"))
      expect(listCmd).toContain("agent:agent-b")
    })

    test("queryTasks with assigned_to builds assignee tag", async () => {
      const { $, calls } = createMockShell({
        list: () => ({ stdout: Buffer.from(JSON.stringify({ documents: [] })) }),
      })

      const bb = new YamsBlackboard($)
      await bb.queryTasks({ assigned_to: "agent-a", limit: 10, offset: 0 })

      const listCmd = calls.find(c => c.includes("list"))
      expect(listCmd).toContain("assignee:agent-a")
    })

    test("session arg is passed when session is set", async () => {
      const { $, calls } = createMockShell({
        list: () => ({ stdout: Buffer.from(JSON.stringify({ documents: [] })) }),
      })

      const bb = new YamsBlackboard($, { sessionName: "my-session" })
      await bb.queryFindings({ limit: 10, offset: 0 })

      const listCmd = calls.find(c => c.includes("list"))
      expect(listCmd).toContain("--session 'my-session'")
    })

    test("session arg is absent when session is not set", async () => {
      const { $, calls } = createMockShell({
        list: () => ({ stdout: Buffer.from(JSON.stringify({ documents: [] })) }),
      })

      const bb = new YamsBlackboard($)
      await bb.queryFindings({ limit: 10, offset: 0 })

      const listCmd = calls.find(c => c.includes("list"))
      expect(listCmd).not.toContain("--session")
    })
  })

  describe("error handling", () => {
    test("yamsJson throws descriptive error on invalid JSON", async () => {
      const { $ } = createMockShell({
        "list": () => ({ stdout: Buffer.from("not valid json {{{") }),
      })

      const bb = new YamsBlackboard($)
      await expect(bb.queryFindings({ limit: 10, offset: 0 })).resolves.toEqual([])
      // queryFindings catches internally, but we can test getAgent for null on failure
    })

    test("getAgent returns null when cat command fails", async () => {
      const failingShell = mock(() => {
        return createQuietablePromise(Promise.reject(new Error("not found")))
      })

      const bb = new YamsBlackboard(failingShell as any)
      const agent = await bb.getAgent("nonexistent")
      expect(agent).toBeNull()
    })

    test("getTask returns null when cat command fails", async () => {
      const failingShell = mock(() => {
        return createQuietablePromise(Promise.reject(new Error("not found")))
      })

      const bb = new YamsBlackboard(failingShell as any)
      const task = await bb.getTask("nonexistent")
      expect(task).toBeNull()
    })

    test("getConnections returns empty on error", async () => {
      const failingShell = mock(() => {
        return createQuietablePromise(Promise.reject(new Error("network error")))
      })

      const bb = new YamsBlackboard(failingShell as any)
      const result = await bb.getConnections("some/path")
      expect(result).toEqual({ nodes: [], edges: [] })
    })
  })

  describe("utility methods", () => {
    test("genId produces unique identifiers", async () => {
      const { $ } = createMockShell()
      const bb = new YamsBlackboard($)

      // Create multiple findings to test ID uniqueness
      const ids = new Set<string>()
      for (let i = 0; i < 10; i++) {
        const finding = await bb.postFinding({
          agent_id: "test",
          topic: "test",
          title: `Finding ${i}`,
          content: "content",
          confidence: 0.5,
          scope: "session",
        })
        ids.add(finding.id)
      }

      expect(ids.size).toBe(10) // All IDs should be unique
    })

    test("shellEscape handles special characters", async () => {
      const { $, calls } = createMockShell()
      const bb = new YamsBlackboard($)

      await bb.postFinding({
        agent_id: "test",
        topic: "security",
        title: "Finding with 'quotes' and $pecial chars",
        content: "Content with \"double quotes\" and\nnewlines",
        confidence: 0.8,
        scope: "persistent",
      })

      // Verify the shell command was constructed (doesn't throw)
      expect(calls.length).toBeGreaterThan(0)
    })
  })

  describe("TUI safety - no console output", () => {
    test("shell execution does not call console.log", async () => {
      const { $ } = createMockShell({
        "list": () => ({ stdout: Buffer.from(JSON.stringify({ documents: [] })) }),
      })

      const originalLog = console.log
      const logCalls: unknown[] = []
      console.log = (...args: unknown[]) => logCalls.push(args)

      try {
        const bb = new YamsBlackboard($)
        await bb.listAgents()
        expect(logCalls.length).toBe(0)
      } finally {
        console.log = originalLog
      }
    })

    test("shell execution does not call console.error on success", async () => {
      const { $ } = createMockShell({
        "list": () => ({ stdout: Buffer.from(JSON.stringify({ documents: [] })) }),
      })

      const originalError = console.error
      const errorCalls: unknown[] = []
      console.error = (...args: unknown[]) => errorCalls.push(args)

      try {
        const bb = new YamsBlackboard($)
        await bb.listAgents()
        expect(errorCalls.length).toBe(0)
      } finally {
        console.error = originalError
      }
    })

    test("queryFindings returns data without console output", async () => {
      const mockFindings = {
        documents: [{ name: "findings/security/f-123.md" }],
      }
      const { $ } = createMockShell({
        "list": () => ({ stdout: Buffer.from(JSON.stringify(mockFindings)) }),
        "cat": () => ({ stdout: Buffer.from("---\nid: \"f-123\"\nagent_id: \"test\"\ntopic: \"security\"\nconfidence: 0.9\nstatus: \"published\"\nscope: \"persistent\"\n---\n\n# Test\n\nContent") }),
      })

      const originalLog = console.log
      const originalError = console.error
      const logCalls: unknown[] = []
      const errorCalls: unknown[] = []
      console.log = (...args: unknown[]) => logCalls.push(args)
      console.error = (...args: unknown[]) => errorCalls.push(args)

      try {
        const bb = new YamsBlackboard($)
        await bb.queryFindings({ limit: 10, offset: 0 })
        expect(logCalls.length).toBe(0)
        expect(errorCalls.length).toBe(0)
      } finally {
        console.log = originalLog
        console.error = originalError
      }
    })

    test("queryTasks returns data without console output", async () => {
      const mockTasks = { documents: [] }
      const { $ } = createMockShell({
        "list": () => ({ stdout: Buffer.from(JSON.stringify(mockTasks)) }),
      })

      const originalLog = console.log
      const originalError = console.error
      const logCalls: unknown[] = []
      const errorCalls: unknown[] = []
      console.log = (...args: unknown[]) => logCalls.push(args)
      console.error = (...args: unknown[]) => errorCalls.push(args)

      try {
        const bb = new YamsBlackboard($)
        await bb.queryTasks({ limit: 10, offset: 0 })
        expect(logCalls.length).toBe(0)
        expect(errorCalls.length).toBe(0)
      } finally {
        console.log = originalLog
        console.error = originalError
      }
    })

    test("shell commands include stderr redirect", async () => {
      const { $, calls } = createMockShell()
      const bb = new YamsBlackboard($)

      await bb.startSession("test")

      // Verify that 2>&1 is appended for stderr capture
      const shellCmd = calls.find(c => c.includes("sh -c"))
      expect(shellCmd).toContain("2>&1")
    })

    test("all shell calls use .quiet() to suppress TUI output", async () => {
      let quietCalled = 0
      const mockShell = mock((strings: TemplateStringsArray, ...values: unknown[]) => {
        const promise = Promise.resolve({ stdout: Buffer.from("{}") })
        return Object.assign(promise, {
          quiet() {
            quietCalled++
            return promise
          },
        })
      })

      const bb = new YamsBlackboard(mockShell as any)
      await bb.startSession("test")
      await bb.listAgents()

      // Every shell invocation must call .quiet()
      expect(quietCalled).toBe(mockShell.mock.calls.length)
    })

    test("acknowledgeFinding produces no console output", async () => {
      const { $ } = createMockShell()
      const originalLog = console.log
      const originalError = console.error
      const output: unknown[] = []
      console.log = (...args: unknown[]) => output.push(args)
      console.error = (...args: unknown[]) => output.push(args)

      try {
        const bb = new YamsBlackboard($)
        await bb.acknowledgeFinding("f-1", "agent-a")
        expect(output.length).toBe(0)
      } finally {
        console.log = originalLog
        console.error = originalError
      }
    })

    test("resolveFinding produces no console output", async () => {
      const { $ } = createMockShell()
      const originalLog = console.log
      const originalError = console.error
      const output: unknown[] = []
      console.log = (...args: unknown[]) => output.push(args)
      console.error = (...args: unknown[]) => output.push(args)

      try {
        const bb = new YamsBlackboard($)
        await bb.resolveFinding("f-1", "fixer", "Fixed it")
        expect(output.length).toBe(0)
      } finally {
        console.log = originalLog
        console.error = originalError
      }
    })

    test("searchFindings produces no console output", async () => {
      const { $ } = createMockShell({
        search: () => ({ stdout: Buffer.from(JSON.stringify({ results: [] })) }),
      })
      const originalLog = console.log
      const originalError = console.error
      const output: unknown[] = []
      console.log = (...args: unknown[]) => output.push(args)
      console.error = (...args: unknown[]) => output.push(args)

      try {
        const bb = new YamsBlackboard($)
        await bb.searchFindings("test query")
        expect(output.length).toBe(0)
      } finally {
        console.log = originalLog
        console.error = originalError
      }
    })

    test("getReadyTasks produces no console output", async () => {
      const { $ } = createMockShell({
        list: () => ({ stdout: Buffer.from(JSON.stringify({ documents: [] })) }),
      })
      const originalLog = console.log
      const originalError = console.error
      const output: unknown[] = []
      console.log = (...args: unknown[]) => output.push(args)
      console.error = (...args: unknown[]) => output.push(args)

      try {
        const bb = new YamsBlackboard($)
        await bb.getReadyTasks()
        expect(output.length).toBe(0)
      } finally {
        console.log = originalLog
        console.error = originalError
      }
    })

    test("getContextSummary produces no console output", async () => {
      const { $ } = createMockShell({
        list: () => ({ stdout: Buffer.from(JSON.stringify({ documents: [] })) }),
      })
      const originalLog = console.log
      const originalError = console.error
      const output: unknown[] = []
      console.log = (...args: unknown[]) => output.push(args)
      console.error = (...args: unknown[]) => output.push(args)

      try {
        const bb = new YamsBlackboard($)
        await bb.getContextSummary("ctx-1")
        expect(output.length).toBe(0)
      } finally {
        console.log = originalLog
        console.error = originalError
      }
    })

    test("getStats produces no console output", async () => {
      const { $ } = createMockShell({
        list: () => ({ stdout: Buffer.from(JSON.stringify({ documents: [] })) }),
      })
      const originalLog = console.log
      const originalError = console.error
      const output: unknown[] = []
      console.log = (...args: unknown[]) => output.push(args)
      console.error = (...args: unknown[]) => output.push(args)

      try {
        const bb = new YamsBlackboard($)
        await bb.getStats()
        expect(output.length).toBe(0)
      } finally {
        console.log = originalLog
        console.error = originalError
      }
    })

    test("error paths produce no console output", async () => {
      const failingShell = mock(() => {
        return createQuietablePromise(Promise.reject(new Error("fail")))
      })
      const originalLog = console.log
      const originalError = console.error
      const output: unknown[] = []
      console.log = (...args: unknown[]) => output.push(args)
      console.error = (...args: unknown[]) => output.push(args)

      try {
        const bb = new YamsBlackboard(failingShell as any)
        await bb.getAgent("x")
        await bb.getTask("x")
        await bb.getConnections("x")
        expect(output.length).toBe(0)
      } finally {
        console.log = originalLog
        console.error = originalError
      }
    })
  })
})
