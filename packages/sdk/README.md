# @oh-my-openagent/sdk

Programmatic runner for starting or attaching to an OpenCode server, running oh-my-openagent sessions, and consuming normalized lifecycle events.

## `run()`

```ts
import { createOmoRunner } from "@oh-my-openagent/sdk"

const runner = createOmoRunner({ directory: process.cwd(), agent: "prometheus" })
const result = await runner.run("Plan the next release")
await runner.close()
```

## `stream()`

```ts
import { createOmoRunner } from "@oh-my-openagent/sdk"

const runner = createOmoRunner({ directory: process.cwd() })

for await (const event of runner.stream("Investigate the build failure")) {
  console.log(event.type)
}

await runner.close()
```
