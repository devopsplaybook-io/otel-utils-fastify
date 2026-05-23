# otel-utils-fastify

Fastify integration for `@devopsplaybook.io/otel-utils`. Automatically creates and manages OpenTelemetry spans for HTTP requests via Fastify lifecycle hooks.

## Installation

```bash
npm install @devopsplaybook.io/otel-utils-fastify
```

Requires `@devopsplaybook.io/otel-utils` as a peer dependency — it must be installed and configured in the consuming project.

## Usage

```typescript
import {
  StandardLogger,
  StandardMeter,
  StandardTracer,
} from "@devopsplaybook.io/otel-utils";
import { StandardTracerFastifyRegisterHooks } from "@devopsplaybook.io/otel-utils-fastify";
import Fastify from "fastify";

const config = {
  /* ... ConfigOTelInterface ... */
};

const tracer = new StandardTracer(config);
const meter = new StandardMeter(config);
const logger = new StandardLogger();
logger.initOTel(config);

const fastify = Fastify();

// Register hooks once at startup
StandardTracerFastifyRegisterHooks(fastify, tracer, logger, {
  rootApiPath: "/api",
  ignoreList: ["GET-/api/health"],
  ignoreListPrefix: ["GET-/api/public/"],
  ignoreListSuffix: ["/metrics", "/health"],
});

// In route handlers, retrieve the current span for manual instrumentation
fastify.get("/api/files/:id", async (req, res) => {
  const span = OTelRequestSpan(req);
  // span is `Span | undefined` — guard or pass along
  if (span) {
    span.setAttribute("custom.attr", "value");
  }
  // ...
});
```

## Exported API

### `StandardTracerFastifyRegisterHooks(fastify, standardTracer, standardLogger, options?)`

Registers three Fastify hooks:

| Hook         | Behavior                                                                                                                                                                                                                                                   |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `onRequest`  | Extracts W3C trace context from incoming headers. Creates a span named `METHOD-/path` and stores it in a `WeakMap<FastifyRequest, Span>`. Skips OPTIONS requests and paths outside `rootApiPath`. Supports an `ignoreList` to exclude specific span names. |
| `onResponse` | Sets span status (OK/ERROR based on status code), records `http.response.status_code`, ends the span, and removes it from the WeakMap.                                                                                                                     |
| `onError`    | Sets span status to ERROR, records the exception, and logs the error via `ModuleLogger` with trace context.                                                                                                                                                |

**Options:**

| Field              | Type        | Default  | Description                                                            |
| ------------------ | ----------- | -------- | ---------------------------------------------------------------------- |
| `rootApiPath`      | `string?`   | `"/api"` | Only trace requests under this path prefix                             |
| `ignoreList`       | `string[]?` | —        | Exact span names to skip. Format: `"METHOD-/path"`                     |
| `ignoreListPrefix` | `string[]?` | —        | Skip when span name **starts with** any of these (native `startsWith`) |
| `ignoreListSuffix` | `string[]?` | —        | Skip when span name **ends with** any of these (native `endsWith`)     |

All three ignore lists are checked **in order** (exact → prefix → suffix) with **short-circuit evaluation** — as soon as one matches, the remaining checks are skipped for maximum performance.

### `OTelRequestSpan(req)`

Retrieves the active span for a Fastify request from the internal WeakMap.

|               |                                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------------- |
| **Parameter** | `req: FastifyRequest`                                                                                               |
| **Returns**   | `Span \| undefined` — `undefined` when the request was skipped (OPTIONS, outside `rootApiPath`, or in `ignoreList`) |

Used in route handlers to access the current span for custom attributes or sub-spans.

## Architecture

```
Incoming Request
  │
  ▼
  onRequest hook
    ├── propagator.extract(headers)  ← W3C trace context from caller
    ├── context.with(ctx, () => { ... })
    │     └── standardTracer.startSpan("METHOD-/path")
    │           └── WeakMap<req, span>
    └── Route handler
          └── OTelRequestSpan(req) → span
  onResponse / onError
    └── WeakMap.get(req) → span
          ├── span.setStatus({ code })
          ├── span.setAttribute(...)
          ├── span.end() / span.recordException(error)
          └── WeakMap.delete(req)
```

The span is stored in a `WeakMap` rather than as a property on the request object, avoiding type pollution and allowing natural garbage collection.

## Dependencies

| Package                               | Purpose                                     |
| ------------------------------------- | ------------------------------------------- |
| `@devopsplaybook.io/otel-utils`       | StandardTracer and StandardLogger instances |
| `@opentelemetry/api`                  | Context management, span status codes       |
| `@opentelemetry/core`                 | W3C trace context propagator                |
| `@opentelemetry/sdk-trace-base`       | Span type                                   |
| `@opentelemetry/semantic-conventions` | HTTP semantic attribute constants           |
| `fastify`                             | Fastify web framework                       |

## Build

```bash
npm run build   # tsc → dist/
```
