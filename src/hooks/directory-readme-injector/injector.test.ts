import { beforeEach, afterEach, describe, expect, it, mock, afterAll } from "bun:test"

const realNodeFs = await import("node:fs")
const realFinder = await import("./finder")
const realStorage = await import("./storage")

const originalReadFileSync = realNodeFs.readFileSync
const readFileSyncMock = mock((filePath: string, encoding?: string) => {
  if (String(filePath).endsWith("README.md")) {
    return "# README"
  }
  return originalReadFileSync(filePath as never, encoding as never)
})
const findReadmeMdUpMock = mock((_: { startDir: string; rootDir: string }) => [] as string[])
const resolveFilePathMock = mock((_: string, path: string) => path)
const loadInjectedPathsMock = mock((_: string) => new Set<string>())
const saveInjectedPathsMock = mock((_: string, __: Set<string>) => {})

afterAll(() => {
  mock.module("node:fs", () => ({ ...realNodeFs }))
  mock.module("./finder", () => ({ ...realFinder }))
  mock.module("./storage", () => ({ ...realStorage }))
})

let processFilePathForReadmeInjection: typeof import("./injector").processFilePathForReadmeInjection

describe("processFilePathForReadmeInjection", () => {
  beforeEach(async () => {
    readFileSyncMock.mockClear()
    findReadmeMdUpMock.mockClear()
    resolveFilePathMock.mockClear()
    loadInjectedPathsMock.mockClear()
    saveInjectedPathsMock.mockClear()

    mock.module("node:fs", () => ({
      ...realNodeFs,
      readFileSync: readFileSyncMock,
    }))

    mock.module("./finder", () => ({
      findReadmeMdUp: findReadmeMdUpMock,
      resolveFilePath: resolveFilePathMock,
    }))

    mock.module("./storage", () => ({
      loadInjectedPaths: loadInjectedPathsMock,
      saveInjectedPaths: saveInjectedPathsMock,
    }))

    ;({ processFilePathForReadmeInjection } = await import(`./injector?${Date.now()}`))
  })

  afterEach(() => {
    mock.module("node:fs", () => ({ ...realNodeFs }))
    mock.module("./finder", () => ({ ...realFinder }))
    mock.module("./storage", () => ({ ...realStorage }))
  })

  it("does not save when all discovered paths are already cached", async () => {
    //#given
    const sessionID = "session-1"
    const cachedDirectory = "/repo/src"
    loadInjectedPathsMock.mockReturnValueOnce(new Set([cachedDirectory]))
    findReadmeMdUpMock.mockReturnValueOnce(["/repo/src/README.md"])

    const truncator = {
      truncate: mock(async () => ({ result: "trimmed", truncated: false })),
    }

    //#when
    await processFilePathForReadmeInjection({
      ctx: { directory: "/repo" } as never,
      truncator: truncator as never,
      sessionCaches: new Map(),
      filePath: "/repo/src/file.ts",
      sessionID,
      output: { title: "Result", output: "", metadata: {} },
    })

    //#then
    expect(saveInjectedPathsMock).not.toHaveBeenCalled()
  })

  it("saves when a new path is injected", async () => {
    //#given
    const sessionID = "session-2"
    loadInjectedPathsMock.mockReturnValueOnce(new Set())
    findReadmeMdUpMock.mockReturnValueOnce(["/repo/src/README.md"])

    const truncator = {
      truncate: mock(async () => ({ result: "trimmed", truncated: false })),
    }

    //#when
    await processFilePathForReadmeInjection({
      ctx: { directory: "/repo" } as never,
      truncator: truncator as never,
      sessionCaches: new Map(),
      filePath: "/repo/src/file.ts",
      sessionID,
      output: { title: "Result", output: "", metadata: {} },
    })

    //#then
    expect(saveInjectedPathsMock).toHaveBeenCalledTimes(1)
    const saveCall = saveInjectedPathsMock.mock.calls[0]
    expect(saveCall[0]).toBe(sessionID)
    expect((saveCall[1] as Set<string>).has("/repo/src")).toBe(true)
  })

  it("saves once when cached and new paths are mixed", async () => {
    //#given
    const sessionID = "session-3"
    loadInjectedPathsMock.mockReturnValueOnce(new Set(["/repo/already-cached"]))
    findReadmeMdUpMock.mockReturnValueOnce([
      "/repo/already-cached/README.md",
      "/repo/new-dir/README.md",
    ])

    const truncator = {
      truncate: mock(async () => ({ result: "trimmed", truncated: false })),
    }

    //#when
    await processFilePathForReadmeInjection({
      ctx: { directory: "/repo" } as never,
      truncator: truncator as never,
      sessionCaches: new Map(),
      filePath: "/repo/new-dir/file.ts",
      sessionID,
      output: { title: "Result", output: "", metadata: {} },
    })

    //#then
    expect(saveInjectedPathsMock).toHaveBeenCalledTimes(1)
    const saveCall = saveInjectedPathsMock.mock.calls[0]
    expect((saveCall[1] as Set<string>).has("/repo/new-dir")).toBe(true)
  })
})
