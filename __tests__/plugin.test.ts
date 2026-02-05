/**
 * Plugin loading and tool registration tests
 *
 * Uses mocked shell ($) to verify plugin structure and tool definitions
 * without requiring a running YAMS daemon.
 */

import { describe, test, expect, mock } from "bun:test"
import { YamsBlackboardPlugin } from "../index"

// Helper to create a promise with .quiet() method attached (mimics Bun shell behavior)
function createQuietablePromise<T>(promise: Promise<T>): Promise<T> & { quiet(): Promise<T> } {
  const quietablePromise = promise as Promise<T> & { quiet(): Promise<T> }
  quietablePromise.quiet = () => quietablePromise
  return quietablePromise
}

// Mock shell function that captures commands
function createMockShell() {
  const calls: string[] = []
  const mockShell = mock((strings: TemplateStringsArray, ...values: any[]) => {
    const cmd = strings.reduce((acc, str, i) => acc + str + (values[i] ?? ""), "")
    calls.push(cmd)
    // Return empty success response with .quiet() method
    return createQuietablePromise(Promise.resolve({ stdout: Buffer.from("{}") }))
  })
  return { $: mockShell as any, calls }
}

describe("YamsBlackboardPlugin", () => {
  test("exports plugin as default and named export", async () => {
    const defaultExport = (await import("../index")).default
    const { YamsBlackboardPlugin: namedExport } = await import("../index")

    expect(defaultExport).toBeDefined()
    expect(namedExport).toBeDefined()
    expect(defaultExport).toBe(namedExport)
  })

  test("initializes without errors", async () => {
    const { $ } = createMockShell()

    const plugin = await YamsBlackboardPlugin({
      $,
      project: { path: "/test/project" } as any,
      directory: "/test/project",
    })

    expect(plugin).toBeDefined()
    expect(plugin.tool).toBeDefined()
  })

  test("registers all expected tools", async () => {
    const { $ } = createMockShell()

    const plugin = await YamsBlackboardPlugin({
      $,
      project: { path: "/test/project" } as any,
      directory: "/test/project",
    })

    const expectedTools = [
      // Agent management
      "bb_register_agent",
      "bb_list_agents",
      // Finding management
      "bb_post_finding",
      "bb_query_findings",
      "bb_search_findings",
      "bb_get_finding",
      "bb_acknowledge_finding",
      "bb_resolve_finding",
      // Task management
      "bb_create_task",
      "bb_get_ready_tasks",
      "bb_claim_task",
      "bb_update_task",
      "bb_complete_task",
      "bb_fail_task",
      "bb_query_tasks",
      // Context management
      "bb_create_context",
      "bb_get_context_summary",
      "bb_set_context",
      // Utility
      "bb_recent_activity",
      "bb_stats",
      "bb_connections",
    ]

    for (const toolName of expectedTools) {
      expect(plugin.tool[toolName]).toBeDefined()
      expect(plugin.tool[toolName].description).toBeTruthy()
      expect(plugin.tool[toolName].args).toBeDefined()
      expect(typeof plugin.tool[toolName].execute).toBe("function")
    }
  })

  describe("tool execute functions", () => {
    test("bb_register_agent.execute returns formatted agent info", async () => {
      const { $ } = createMockShell()
      const plugin = await YamsBlackboardPlugin({
        $, project: { path: "/test" } as any, directory: "/test",
      })

      const result = await plugin.tool.bb_register_agent.execute({
        id: "scanner-1", name: "Scanner", capabilities: ["security-audit"],
      })

      expect(result).toContain("scanner-1")
      expect(result).toContain("security-audit")
      expect(result).toContain("Registered at:")
    })

    test("bb_post_finding.execute returns finding ID and topic", async () => {
      const { $ } = createMockShell()
      const plugin = await YamsBlackboardPlugin({
        $, project: { path: "/test" } as any, directory: "/test",
      })

      const result = await plugin.tool.bb_post_finding.execute({
        agent_id: "scanner", topic: "security", title: "XSS Found",
        content: "Reflected XSS in /search", confidence: 0.9,
      })

      expect(result).toContain("Finding posted:")
      expect(result).toContain("f-")
      expect(result).toContain("security")
    })

    test("bb_list_agents.execute returns empty message when no agents", async () => {
      const { $ } = createMockShell({
        list: () => ({ stdout: Buffer.from(JSON.stringify({ documents: [] })) }),
      })
      const plugin = await YamsBlackboardPlugin({
        $, project: { path: "/test" } as any, directory: "/test",
      })

      const result = await plugin.tool.bb_list_agents.execute({})
      expect(result).toBe("No agents registered yet.")
    })

    test("bb_claim_task.execute returns failure when task already claimed", async () => {
      const claimedTask = { id: "t-1", title: "Task", type: "review", status: "claimed", priority: 2, created_by: "a", assigned_to: "other" }
      const { $ } = createMockShell({
        cat: () => ({ stdout: Buffer.from(JSON.stringify(claimedTask)) }),
      })
      const plugin = await YamsBlackboardPlugin({
        $, project: { path: "/test" } as any, directory: "/test",
      })

      const result = await plugin.tool.bb_claim_task.execute({ task_id: "t-1", agent_id: "me" })
      expect(result).toContain("Failed to claim")
    })

    test("bb_create_context.execute with set_current updates context for subsequent queries", async () => {
      const { $ } = createMockShell({
        list: () => ({ stdout: Buffer.from(JSON.stringify({ documents: [] })) }),
      })
      const plugin = await YamsBlackboardPlugin({
        $, project: { path: "/test" } as any, directory: "/test",
      })

      await plugin.tool.bb_create_context.execute({
        id: "ctx-1", name: "My Context", set_current: true,
      })

      // bb_get_context_summary should now use ctx-1 as default
      const summary = await plugin.tool.bb_get_context_summary.execute({})
      expect(summary).toContain("ctx-1")
    })

    test("bb_set_context.execute updates internal context", async () => {
      const { $ } = createMockShell({
        list: () => ({ stdout: Buffer.from(JSON.stringify({ documents: [] })) }),
      })
      const plugin = await YamsBlackboardPlugin({
        $, project: { path: "/test" } as any, directory: "/test",
      })

      await plugin.tool.bb_set_context.execute({ context_id: "new-ctx" })
      const summary = await plugin.tool.bb_get_context_summary.execute({})
      expect(summary).toContain("new-ctx")
    })
  })

  describe("compaction content validation", () => {
    test("experimental.session.compacting pushes Blackboard Summary string", async () => {
      const { $ } = createMockShell({
        list: () => ({ stdout: Buffer.from(JSON.stringify({ documents: [] })) }),
      })
      const plugin = await YamsBlackboardPlugin({
        $, project: { path: "/test" } as any, directory: "/test",
      })

      const output = { context: [] as string[] }
      await plugin["experimental.session.compacting"]!({ summary: "s" } as any, output)

      expect(output.context.length).toBeGreaterThanOrEqual(1)
      expect(output.context.some(s => s.includes("Blackboard Summary"))).toBe(true)
    })

    test("experimental.session.compacting includes manifest comment for recovery", async () => {
      const { $ } = createMockShell({
        list: () => ({ stdout: Buffer.from(JSON.stringify({ documents: [] })) }),
      })
      const plugin = await YamsBlackboardPlugin({
        $, project: { path: "/test" } as any, directory: "/test",
      })

      const output = { context: [] as string[] }
      await plugin["experimental.session.compacting"]!({ sessionID: "test-session" } as any, output)

      // Should have both markdown summary and manifest comment
      expect(output.context.length).toBeGreaterThanOrEqual(1)
      const content = output.context.join("\n")
      expect(content).toContain("Blackboard Summary")
      expect(content).toContain("BLACKBOARD_MANIFEST")
    })
  })

  test("provides lifecycle hooks", async () => {
    const { $ } = createMockShell()

    const plugin = await YamsBlackboardPlugin({
      $,
      project: { path: "/test/project" } as any,
      directory: "/test/project",
    })

    // Event hook handles session.created and other events
    expect(plugin.event).toBeDefined()
    expect(typeof plugin.event).toBe("function")

    // Direct compaction hook (experimental)
    expect(plugin["experimental.session.compacting"]).toBeDefined()
    expect(typeof plugin["experimental.session.compacting"]).toBe("function")
  })

  test("event hook handles session.created without console output", async () => {
    const { $ } = createMockShell()
    const originalLog = console.log
    const logCalls: any[] = []
    console.log = (...args: any[]) => logCalls.push(args)

    try {
      const plugin = await YamsBlackboardPlugin({
        $,
        project: { path: "/test/project" } as any,
        directory: "/test/project",
      })

      // Trigger session.created event via the event hook
      await plugin.event!({ event: { type: "session.created" } })

      // No console.log calls should have been made
      expect(logCalls.length).toBe(0)
    } finally {
      console.log = originalLog
    }
  })

  test("event hook handles session.compacted as notification (no output)", async () => {
    const { $ } = createMockShell()
    const originalLog = console.log
    const logCalls: any[] = []
    console.log = (...args: any[]) => logCalls.push(args)

    try {
      const plugin = await YamsBlackboardPlugin({
        $,
        project: { path: "/test/project" } as any,
        directory: "/test/project",
      })

      // session.compacted is now just a notification event - no output injection
      await plugin.event!({ event: { type: "session.compacted" } })

      // Should not throw and should not log
      expect(logCalls.length).toBe(0)
    } finally {
      console.log = originalLog
    }
  })

  test("compaction hook appends context safely without console output", async () => {
    const { $ } = createMockShell()

    const plugin = await YamsBlackboardPlugin({
      $,
      project: { path: "/test/project" } as any,
      directory: "/test/project",
    })

    // Ensure no console output leaked during hook execution
    const originalLog = console.log
    const originalError = console.error
    const logCalls: any[] = []
    const errorCalls: any[] = []
    console.log = (...args: any[]) => logCalls.push(args)
    console.error = (...args: any[]) => errorCalls.push(args)
    try {
      const output = { context: [] as string[] }
      await plugin["experimental.session.compacting"]!({ sessionID: "test" } as any, output)
      
      expect(output.context.length).toBeGreaterThanOrEqual(1)
      expect(logCalls.length).toBe(0)
      expect(errorCalls.length).toBe(0)
    } finally {
      console.log = originalLog
      console.error = originalError
    }
  })

  test("experimental.session.compacting does not output to console on error", async () => {
    const failingShell = mock(() => {
      return createQuietablePromise(Promise.reject(new Error("Mock failure")))
    })

    const originalError = console.error
    const errorCalls: any[] = []
    console.error = (...args: any[]) => errorCalls.push(args)

    try {
      const plugin = await YamsBlackboardPlugin({
        $: failingShell as any,
        project: { path: "/test/project" } as any,
        directory: "/test/project",
      })

      const output = { context: [] as string[] }
      await plugin["experimental.session.compacting"]!({} as any, output)

      expect(errorCalls.length).toBe(0)
    } finally {
      console.error = originalError
    }
  })
})
