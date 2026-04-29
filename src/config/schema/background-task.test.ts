import { describe, expect, test } from "bun:test"
import { ZodError } from "zod/v4"
import { BackgroundTaskConfigSchema } from "./background-task"

describe("BackgroundTaskConfigSchema", () => {
  describe("maxDepth", () => {
    describe("#given valid maxDepth (3)", () => {
      test("#when parsed #then returns correct value", () => {
        const result = BackgroundTaskConfigSchema.parse({ maxDepth: 3 })

        expect(result.maxDepth).toBe(3)
      })
    })

    describe("#given maxDepth below minimum (0)", () => {
      test("#when parsed #then throws ZodError", () => {
        let thrownError: unknown

        try {
          BackgroundTaskConfigSchema.parse({ maxDepth: 0 })
        } catch (error) {
          thrownError = error
        }

        expect(thrownError).toBeInstanceOf(ZodError)
      })
    })
  })

  describe("maxDescendants", () => {
    describe("#given valid maxDescendants (50)", () => {
      test("#when parsed #then returns correct value", () => {
        const result = BackgroundTaskConfigSchema.parse({ maxDescendants: 50 })

        expect(result.maxDescendants).toBe(50)
      })
    })

    describe("#given maxDescendants below minimum (0)", () => {
      test("#when parsed #then throws ZodError", () => {
        let thrownError: unknown

        try {
          BackgroundTaskConfigSchema.parse({ maxDescendants: 0 })
        } catch (error) {
          thrownError = error
        }

        expect(thrownError).toBeInstanceOf(ZodError)
      })
    })
  })

  describe("maxIdenticalTasksPerParent", () => {
    describe("#given valid maxIdenticalTasksPerParent (1)", () => {
      test("#when parsed #then returns correct value", () => {
        const result = BackgroundTaskConfigSchema.parse({ maxIdenticalTasksPerParent: 1 })

        expect(result.maxIdenticalTasksPerParent).toBe(1)
      })
    })

    describe("#given maxIdenticalTasksPerParent below minimum (0)", () => {
      test("#when parsed #then throws ZodError", () => {
        let thrownError: unknown

        try {
          BackgroundTaskConfigSchema.parse({ maxIdenticalTasksPerParent: 0 })
        } catch (error) {
          thrownError = error
        }

        expect(thrownError).toBeInstanceOf(ZodError)
      })
    })
  })

  describe("syncPollTimeoutMs", () => {
    describe("#given valid syncPollTimeoutMs (120000)", () => {
      test("#when parsed #then returns correct value", () => {
        const result = BackgroundTaskConfigSchema.parse({ syncPollTimeoutMs: 120000 })

        expect(result.syncPollTimeoutMs).toBe(120000)
      })
    })

    describe("#given syncPollTimeoutMs below minimum (59999)", () => {
      test("#when parsed #then throws ZodError", () => {
        let thrownError: unknown

        try {
          BackgroundTaskConfigSchema.parse({ syncPollTimeoutMs: 59999 })
        } catch (error) {
          thrownError = error
        }

        expect(thrownError).toBeInstanceOf(ZodError)
      })
    })

    describe("#given syncPollTimeoutMs not provided", () => {
      test("#when parsed #then field is undefined", () => {
        const result = BackgroundTaskConfigSchema.parse({})

        expect(result.syncPollTimeoutMs).toBeUndefined()
      })
    })

    describe('#given syncPollTimeoutMs is non-number ("abc")', () => {
      test("#when parsed #then throws ZodError", () => {
        let thrownError: unknown

        try {
          BackgroundTaskConfigSchema.parse({ syncPollTimeoutMs: "abc" })
        } catch (error) {
          thrownError = error
        }

        expect(thrownError).toBeInstanceOf(ZodError)
      })
    })
  })
})

describe('BackgroundTaskConfigSchema processBudget', () => {
  test('#given no processBudget #then parses without error', () => {
    const result = BackgroundTaskConfigSchema.parse({})
    expect(result.processBudget).toBeUndefined()
  })

  test('#given valid processBudget #then returns correct values', () => {
    const result = BackgroundTaskConfigSchema.parse({
      processBudget: { maxTrackedRoots: 20, maxMcpRoots: 6, maxRuntimeFallbackRoots: 6 },
    })
    expect(result.processBudget?.maxTrackedRoots).toBe(20)
    expect(result.processBudget?.maxMcpRoots).toBe(6)
    expect(result.processBudget?.maxRuntimeFallbackRoots).toBe(6)
  })

  test('#given maxTrackedRoots of 0 #then throws ZodError', () => {
    let thrownError: unknown
    try {
      BackgroundTaskConfigSchema.parse({ processBudget: { maxTrackedRoots: 0 } })
    } catch (error) {
      thrownError = error
    }
    expect(thrownError).toBeInstanceOf(ZodError)
  })

  test('#given maxMcpRoots of 0 #then throws ZodError', () => {
    let thrownError: unknown
    try {
      BackgroundTaskConfigSchema.parse({ processBudget: { maxMcpRoots: 0 } })
    } catch (error) {
      thrownError = error
    }
    expect(thrownError).toBeInstanceOf(ZodError)
  })

  test('#given maxRuntimeFallbackRoots of -1 #then throws ZodError', () => {
    let thrownError: unknown
    try {
      BackgroundTaskConfigSchema.parse({ processBudget: { maxRuntimeFallbackRoots: -1 } })
    } catch (error) {
      thrownError = error
    }
    expect(thrownError).toBeInstanceOf(ZodError)
  })
})
