# otel-utils-fastify

Fastify integration for `@devopsplaybook.io/otel-utils`. Automatically creates and manages OpenTelemetry spans for HTTP requests via Fastify lifecycle hooks.

## Installation

```bash
npm install @devopsplaybook.io/otel-utils-fastify
```

Peer dependencies that must be installed and configured in the consuming project:

| Peer dependency                 | Version  |
| ------------------------------- | -------- |
| `@devopsplaybook.io/otel-utils` | `^1.3.0` |
| `fastify`                       | `^5.0.0` |

Requires Node.js >= 22.

## Usage

```typescript
import {
  StandardLogger,
  StandardMeter,
  StandardTracer,
} from "@devopsplaybook.io/otel-utils";
import {
  OTelRequestContext,
  OTelRequestSpan,
  StandardTracerFastifyRegisterHooks,
} from "@devopsplaybook.io/otel-utils-fastify";
import { context } from "@opentelemetry/api";
import Fastify from "fastify";

const config = {/* ... ConfigOTelInterface ... */};

const tracer = new StandardTracer(config);
const meter = new StandardMeter(config);
const logger = new StandardLogger();
logger.initOTel(config);

const fastify = Fastify();

// Register hooks once at startup, at the root of the Fastify instance
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

// Or run handler work inside the request context so everything created
// within it automatically becomes a child of the HTTP span:
fastify.get("/api/files", async (req, res) => {
  const ctx = OTelRequestContext(req);
  if (!ctx) {
    return res.send({ files: [] });
  }
  return context.with(ctx, async () => {
    const childSpan = tracer.startSpan("load-files");
    // ... do work ...
    childSpan.end();
  });
});
```

## Exported API

### `StandardTracerFastifyRegisterHooks(fastify, standardTracer, standardLogger, options?)`

Registers five Fastify hooks:

| Hook             | Behavior                                                                                                                                                                                                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `onRequest`      | Extracts W3C trace context from incoming headers. Creates a `SpanKind.SERVER` span named after the route (`METHOD-<route template>`, path fallback when no route matched) and stores it plus its context in internal `WeakMap`s. Skips OPTIONS requests, paths outside `rootApiPath`, and ignored span names. |
| `onResponse`     | Sets span status (OK for status <= 299, ERROR otherwise), records `http.response.status_code`, ends the span, and removes it from the `WeakMap`s.                                                                                                                                                             |
| `onError`        | Sets span status to ERROR, records `error.type` and the exception, and logs the error via `ModuleLogger` with trace context. Non-`Error` throws are normalized to an `Error` first.                                                                                                                           |
| `onRequestAbort` | Ends the span with ERROR status and `error.type = "client_abort"` when the client aborts the request.                                                                                                                                                                                                         |
| `onTimeout`      | Ends the span with ERROR status and `error.type = "timeout"` when the connection times out.                                                                                                                                                                                                                   |

Registration is idempotent per Fastify instance: a second registration on the same instance is ignored with a warning. Hooks are registered globally and cannot be removed — register them **once**, at the root of the Fastify instance.

**Options:**

| Field              | Type        | Default  | Description                                                                                                                                                                                |
| ------------------ | ----------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `rootApiPath`      | `string?`   | `"/api"` | Only trace the path itself and paths under `"<rootApiPath>/"` (boundary check: `/apiary` is **not** traced, `/apiary/...` neither). `"/"` traces everything. Trailing slashes are ignored. |
| `ignoreList`       | `string[]?` | —        | Exact span names to skip. Format: `"METHOD-/route"`, using the route template for parameterized routes (e.g. `"GET-/api/files/_id"`).                                                      |
| `ignoreListPrefix` | `string[]?` | —        | Skip when span name **starts with** any of these (native `startsWith`).                                                                                                                    |
| `ignoreListSuffix` | `string[]?` | —        | Skip when span name **ends with** any of these (native `endsWith`).                                                                                                                        |

All three ignore lists are checked **in order** (exact → prefix → suffix) with **short-circuit evaluation** — as soon as one matches, the remaining checks are skipped for maximum performance.

### Span naming and attributes

Span names follow `METHOD-<route>`:

- Matched routes use the **route template**: `GET /api/files/:id` → span name `GET-/api/files/_id`.
- Unmatched routes (e.g. 404) fall back to the request path: `GET /api/unknown` → `GET-/api/unknown`.
- The query string is never part of the span name.
- Span names are sanitized with the same regex used by `@devopsplaybook.io/otel-utils` (`[^a-zA-Z0-9-_/]` → `_`), so `ignoreList` entries match the exported span name.
- Spans are created with `SpanKind.SERVER` and the usual synthetic `StandardTracer` attributes (`http.request_method=BACKEND`, synthetic `http.route`) are **not** added — real HTTP attributes are set instead.

Attributes set on each HTTP span:

| Attribute                   | Value                                                                    |
| --------------------------- | ------------------------------------------------------------------------ |
| `http.request.method`       | Request method (`GET`, `POST`, ...)                                      |
| `url.path`                  | Request path, **without** query string                                   |
| `http.route`                | Route template — only when the request matched a route                   |
| `http.response.status_code` | Response status code                                                     |
| `error.type`                | Error name, or `client_abort` / `timeout` for aborted/timed out requests |

The query string is not recorded (`url.query` is not set).

### `OTelRequestSpan(req)`

Retrieves the active span for a Fastify request from the internal `WeakMap`.

|               |                                                                                        |
| ------------- | -------------------------------------------------------------------------------------- |
| **Parameter** | `req: FastifyRequest`                                                                  |
| **Returns**   | `Span \| undefined` — `undefined` when the request was skipped or after the span ended |

Use it to parent spans created in route handlers:

```typescript
const childSpan = tracer.startSpan("my-work", OTelRequestSpan(req));
```

### `OTelRequestContext(req)`

Retrieves the OpenTelemetry `Context` for a Fastify request: the incoming W3C trace context with the HTTP span set as active span.

|               |                                                                                           |
| ------------- | ----------------------------------------------------------------------------------------- |
| **Parameter** | `req: FastifyRequest`                                                                     |
| **Returns**   | `Context \| undefined` — `undefined` when the request was skipped or after the span ended |

Because Fastify runs hooks and handlers in separate async contexts, the span cannot be active automatically after the `onRequest` hook returns. Wrapping handler work in `context.with(OTelRequestContext(req), ...)` makes any span created inside it a child of the HTTP span:

```typescript
fastify.get("/api/files/:id", async (req, res) => {
  const ctx = OTelRequestContext(req);
  if (!ctx) {
    return res.send({});
  }
  return context.with(ctx, async () => {
    const childSpan = tracer.startSpan("load-file"); // child of the HTTP span
    // ...
    childSpan.end();
  });
});
```

### Deprecated: `req.tracerSpanApi`

The span is also assigned to `req.tracerSpanApi` as a deprecated compatibility alias. Use `OTelRequestSpan(req)` instead.

## Architecture

```
Incoming Request
  │
  ▼
onRequest hook
  ├── propagator.extract(headers)  ← W3C trace context from caller
  ├── context.with(ctx, () => { ... })
  │     └── standardTracer.startSpan(spanName, undefined, { kind: SERVER })
  │           └── WeakMap<req, span> + WeakMap<req, context>
  └── Route handler
        └── OTelRequestSpan(req)
              or context.with(OTelRequestContext(req), () => ...)
onResponse / onError / onRequestAbort / onTimeout
  └── WeakMap.get(req) → span
        ├── span.setStatus({ code })
        ├── span.setAttribute(...)
        ├── span.end() / span.recordException(error)
        └── WeakMap.delete(req)
```

The span and context are stored in `WeakMap`s rather than as properties on the request object, avoiding type pollution and allowing natural garbage collection. The `tracerSpanApi` alias is deleted when the span ends (it is a plain property, so it must be removed explicitly).

## Behavior changes in 1.3.0

- Span names now use the **route template** for matched routes and the path fallback otherwise (previously the raw path, including dynamic segments), and are sanitized like `StandardTracer` span names. Update `ignoreList` entries accordingly (e.g. `"GET-/api/files/_id"`).
- `url.path` is now recorded **without** the query string.
- Spans are `SpanKind.SERVER`; synthetic `BACKEND` attributes from `StandardTracer` are no longer added.
- Client aborts and connection timeouts end the span with ERROR status and `error.type`.
- `rootApiPath` uses a segment boundary check (`/apiary` is no longer traced).
- Requires `@devopsplaybook.io/otel-utils` `^1.3.0` (uses `StandardTracer.startSpan(name, parentSpan?, options?)`).

## Dependencies

| Package                               | Type       | Purpose                                     |
| ------------------------------------- | ---------- | ------------------------------------------- |
| `@devopsplaybook.io/otel-utils`       | peer       | StandardTracer and StandardLogger instances |
| `fastify`                             | peer       | Fastify web framework (v5)                  |
| `@opentelemetry/api`                  | dependency | Context management, span status codes       |
| `@opentelemetry/core`                 | dependency | W3C trace context propagator                |
| `@opentelemetry/sdk-trace-base`       | dependency | Span type                                   |
| `@opentelemetry/semantic-conventions` | dependency | HTTP semantic attribute constants           |

## Build, lint, test

```bash
npm run build    # tsc → dist/, then type-checks the spec files (tsc --noEmit)
npm run lint     # oxlint index.ts src && prettier --check .
npm run format   # prettier --write .
npm test         # jest --coverage (coverage thresholds enforced)
```
