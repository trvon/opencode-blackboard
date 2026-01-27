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
        "session_start": () => ({ stdout: Buffer.from("session started") }),
      })

      const bb = new YamsBlackboard($)
      await bb.startSession("buffer-test")
      // Should not throw
    })

    test("handles Uint8Array stdout", async () => {
      const encoder = new TextEncoder()
      const { $ } = createMockShell({
        "session_start": () => ({ stdout: encoder.encode("session started") }),
      })

      const bb = new YamsBlackboard($)
      await bb.startSession("uint8-test")
      // Should not throw
    })

    test("handles object with text property", async () => {
      const { $ } = createMockShell({
        "session_start": () => ({ text: "text property output" }),
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
    test("postFinding generates unique ID", async () => {
      const { $ } = createMockShell()

      const bb = new YamsBlackboard($)
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
  })
})
