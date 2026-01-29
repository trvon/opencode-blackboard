/**
 * Integration tests with real YAMS daemon
 *
 * These tests require a running YAMS daemon and are executed
 * via docker-compose.test.yml in CI.
 *
 * Run manually with: YAMS_INTEGRATION=1 bun test:integration
 */

import { describe, test, expect, beforeAll } from "bun:test"
import { $ } from "bun"
import { YamsBlackboard } from "../blackboard"

// Skip if not in integration test mode
const SKIP_INTEGRATION = !process.env.YAMS_INTEGRATION && !process.env.YAMS_HOST

// Helper to check if YAMS daemon is available
async function isYamsAvailable(): Promise<boolean> {
  try {
    // Prefer explicit socket if provided
    const socket = process.env.YAMS_DAEMON_SOCKET || process.env.YAMS_SOCKET
    if (socket) {
      const result = await $`yams status --daemon-socket ${socket}`.quiet()
      return result.exitCode === 0
    }
    const result = await $`yams status`.quiet()
    return result.exitCode === 0
  } catch {
    return false
  }
}

// Create a shell wrapper compatible with YamsBlackboard
function createBunShell() {
  return async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const cmd = strings.reduce((acc, str, i) => acc + str + (values[i] ?? ""), "")
    const result = await $`sh -c ${cmd}`.quiet()
    return { stdout: result.stdout }
  }
}

describe.skipIf(SKIP_INTEGRATION)("Integration Tests", () => {
  let yamsAvailable = false
  let shell: ReturnType<typeof createBunShell>

  beforeAll(async () => {
    yamsAvailable = await isYamsAvailable()
    if (!yamsAvailable) {
      console.warn("YAMS daemon not available, skipping integration tests")
    }
    shell = createBunShell()
  })

  describe.skipIf(!yamsAvailable)("YamsBlackboard with real daemon", () => {
    test("can start and stop session", async () => {
      const bb = new YamsBlackboard(shell as any)

      const sessionName = await bb.startSession(`integration-test-${Date.now()}`)
      expect(sessionName).toContain("integration-test")

      await bb.stopSession()
    })

    test("can register and list agents", async () => {
      const bb = new YamsBlackboard(shell as any)

      await bb.startSession(`agent-test-${Date.now()}`)

      const agent = await bb.registerAgent({
        id: `test-agent-${Date.now()}`,
        name: "Integration Test Agent",
        capabilities: ["testing"],
        status: "active",
      })

      expect(agent.id).toContain("test-agent")

      const agents = await bb.listAgents()
      expect(agents.some((a) => a.id === agent.id)).toBe(true)

      await bb.stopSession()
    })

    test("can post and query findings", async () => {
      const bb = new YamsBlackboard(shell as any)

      await bb.startSession(`finding-test-${Date.now()}`)

      const finding = await bb.postFinding({
        agent_id: "integration-test",
        topic: "test",
        title: "Integration Test Finding",
        content: "This finding was created during integration testing",
        confidence: 0.95,
        severity: "info",
        scope: "session",
      })

      expect(finding.id).toMatch(/^f-/)

      // Query the finding back
      const findings = await bb.queryFindings({
        topic: "test",
        limit: 10,
        offset: 0,
      })

      expect(findings.some((f) => f.id === finding.id)).toBe(true)

      await bb.stopSession()
    })

    test("can create, claim, and complete tasks", async () => {
      const bb = new YamsBlackboard(shell as any)

      await bb.startSession(`task-test-${Date.now()}`)

      // Create task
      const task = await bb.createTask({
        title: "Integration Test Task",
        description: "A task for integration testing",
        type: "test",
        priority: 2,
        created_by: "integration-test",
      })

      expect(task.status).toBe("pending")

      // Claim task
      const claimed = await bb.claimTask(task.id, "integration-agent")
      expect(claimed?.status).toBe("claimed")
      expect(claimed?.assigned_to).toBe("integration-agent")

      // Complete task
      const completed = await bb.completeTask(task.id)
      expect(completed?.status).toBe("completed")

      await bb.stopSession()
    })

    test("multi-agent shared blackboard coordination", async () => {
      const bb = new YamsBlackboard(shell as any)
      await bb.startSession(`multi-agent-${Date.now()}`)

      // Agent A and Agent B register
      const agentA = await bb.registerAgent({
        id: `agent-a-${Date.now()}`, name: "Agent A",
        capabilities: ["security-audit"], status: "active",
      })
      const agentB = await bb.registerAgent({
        id: `agent-b-${Date.now()}`, name: "Agent B",
        capabilities: ["code-review"], status: "active",
      })

      // Agent A posts a security finding
      const finding = await bb.postFinding({
        agent_id: agentA.id, topic: "security",
        title: "SQL Injection in login handler",
        content: "Unsanitized user input in SQL query",
        confidence: 0.95, severity: "high", scope: "persistent",
      })

      // Agent B discovers it by querying topic
      const discovered = await bb.queryFindings({ topic: "security", limit: 50, offset: 0 })
      expect(discovered.some(f => f.id === finding.id)).toBe(true)

      // Agent A creates a task
      const task = await bb.createTask({
        title: "Fix SQL injection", type: "fix",
        priority: 0, created_by: agentA.id,
      })

      // Agent B claims and completes the task
      const claimed = await bb.claimTask(task.id, agentB.id)
      expect(claimed?.assigned_to).toBe(agentB.id)

      const completed = await bb.completeTask(task.id, { findings: [finding.id] })
      expect(completed?.status).toBe("completed")

      await bb.stopSession()
    })

    test("context workflow: create, post with context_id, query by context", async () => {
      const bb = new YamsBlackboard(shell as any)
      await bb.startSession(`context-wf-${Date.now()}`)

      const ctx = await bb.createContext("audit-ctx", "Security Audit", "Full audit")
      expect(ctx.status).toBe("active")

      // Post findings with context_id
      await bb.postFinding({
        agent_id: "auditor", topic: "security",
        title: "Weak password policy",
        content: "No minimum length enforced",
        confidence: 0.85, scope: "persistent",
        context_id: "audit-ctx",
      })

      // Query by context
      const findings = await bb.queryFindings({ context_id: "audit-ctx", limit: 50, offset: 0 })
      expect(findings.length).toBeGreaterThanOrEqual(1)

      // Get summary
      const summary = await bb.getContextSummary("audit-ctx")
      expect(summary).toContain("Blackboard Summary")
      expect(summary).toContain("audit-ctx")

      await bb.stopSession()
    })

    test("can get blackboard statistics", async () => {
      const bb = new YamsBlackboard(shell as any)

      await bb.startSession(`stats-test-${Date.now()}`)

      const stats = await bb.getStats()

      expect(stats).toHaveProperty("agents")
      expect(stats).toHaveProperty("findings")
      expect(stats).toHaveProperty("tasks")
      expect(stats.findings).toHaveProperty("total")
      expect(stats.tasks).toHaveProperty("total")

      await bb.stopSession()
    })
  })
})
