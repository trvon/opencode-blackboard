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

  test("provides lifecycle hooks", async () => {
    const { $ } = createMockShell()

    const plugin = await YamsBlackboardPlugin({
      $,
      project: { path: "/test/project" } as any,
      directory: "/test/project",
    })

    expect(plugin["experimental.session.compacting"]).toBeDefined()
    expect(typeof plugin["experimental.session.compacting"]).toBe("function")

    expect(plugin["session.created"]).toBeDefined()
    expect(typeof plugin["session.created"]).toBe("function")

    expect(plugin["session.compacted"]).toBeDefined()
    expect(typeof plugin["session.compacted"]).toBe("function")
  })

  test("session.created does not output to console", async () => {
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

      await plugin["session.created"]!()

      // No console.log calls should have been made
      expect(logCalls.length).toBe(0)
    } finally {
      console.log = originalLog
    }
  })

  test("session.compacted does not output to console on error", async () => {
    // Create a shell that fails but still has .quiet() method
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
      await plugin["session.compacted"]!({} as any, output)

      // No console.error calls should have been made
      expect(errorCalls.length).toBe(0)
    } finally {
      console.error = originalError
    }
  })

  test("compaction hooks append context safely", async () => {
    const { $ } = createMockShell()

    const plugin = await YamsBlackboardPlugin({
      $,
      project: { path: "/test/project" } as any,
      directory: "/test/project",
    })

    const output = { context: [] as string[] }
    await plugin["experimental.session.compacting"]!({ summary: "s" } as any, output)
    await plugin["session.compacted"]!({ summary: "s" } as any, output)

    expect(output.context.length).toBeGreaterThanOrEqual(1)
    // Ensure no console output leaked during hook execution
    const originalLog = console.log
    const originalError = console.error
    const logCalls: any[] = []
    const errorCalls: any[] = []
    console.log = (...args: any[]) => logCalls.push(args)
    console.error = (...args: any[]) => errorCalls.push(args)
    try {
      const output2 = { context: [] as string[] }
      await plugin["experimental.session.compacting"]!({ summary: "s" } as any, output2)
      await plugin["session.compacted"]!({ summary: "s" } as any, output2)
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
