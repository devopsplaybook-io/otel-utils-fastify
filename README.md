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
  // Optional: record the http.server.request.duration histogram
  standardMeter: meter,
  // Optional: keep span-name cardinality bounded for unmatched routes (404s)
  // unmatchedRouteSpanName: "method",
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

| Hook             | Behavior                                                                                                                                                                                                                                                                                                                                              |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `onRequest`      | Extracts W3C trace context from incoming headers. Creates a `SpanKind.SERVER` span named after the route (`METHOD-<route template>`; path or method fallback when no route matched, see `unmatchedRouteSpanName`) and stores it plus its context in internal `WeakMap`s. Skips OPTIONS requests, paths outside `rootApiPath`, and ignored span names. |
| `onResponse`     | Ends the span: records `http.response.status_code` and sets the span status per the current OTel HTTP semantic conventions for server spans — **unset for 1xx–4xx, ERROR for 5xx** — then ends the span and removes it from the `WeakMap`s. A span on which `onError` already recorded an error keeps its ERROR status.                               |
| `onError`        | Sets span status to ERROR, records `error.type` and the exception, and logs the error via `ModuleLogger` with trace context: **`warn` (no stack) for client errors** (`statusCode < 500`, e.g. validation 400 or 403), `error` otherwise. Non-`Error` throws are normalized to an `Error` first.                                                      |
| `onRequestAbort` | Ends the span with ERROR status and `error.type = "client_abort"` when the client aborts the request.                                                                                                                                                                                                                                                 |
| `onTimeout`      | Ends the span with ERROR status and `error.type = "timeout"` when the connection times out.                                                                                                                                                                                                                                                           |

Registration is idempotent per Fastify instance: a second registration on the same instance is ignored with a warning. Hooks are registered globally and cannot be removed — register them **once**, at the root of the Fastify instance.

Tracing is **fail-open**: a fault in any hook (including a throwing tracer, span or logger) is caught, logged once at warn level through the `ModuleLogger`, and the request continues untraced — instrumentation never fails the request.

**Options:**

| Field                    | Type                  | Default  | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------ | --------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rootApiPath`            | `string?`             | `"/api"` | Only trace the path itself and paths under `"<rootApiPath>/"` (boundary check: `/apiary` is **not** traced, `/apiary/...` neither). `"/"` traces everything. Trailing slashes are ignored.                                                                                                                                                                                                                                                                                                                     |
| `ignoreList`             | `string[]?`           | —        | Exact span names to skip. Format: `"METHOD-/route"`, using the route template for parameterized routes (e.g. `"GET-/api/files/_id"`).                                                                                                                                                                                                                                                                                                                                                                          |
| `ignoreListPrefix`       | `string[]?`           | —        | Skip when span name **starts with** any of these (native `startsWith`).                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `ignoreListSuffix`       | `string[]?`           | —        | Skip when span name **ends with** any of these (native `endsWith`).                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `unmatchedRouteSpanName` | `"path" \| "method"?` | `"path"` | Span-name policy for requests that did not match a route (e.g. 404s). `"path"`: sanitized request path — today's behavior; note the unbounded cardinality from scanner/probe traffic and that attacker payloads end up as span names. `"method"`: method only (e.g. `GET`), keeping cardinality bounded (current semconv recommends a low-cardinality name when available); ignore lists then match `"GET"` for unmatched requests. The full path is always kept in `url.path`; matched routes are unaffected. |
| `standardMeter`          | `StandardMeter?`      | —        | When provided, records the `http.server.request.duration` histogram (seconds) for traced requests. See [Metrics](#metrics-http-server-requestduration) below.                                                                                                                                                                                                                                                                                                                                                  |

All three ignore lists are checked **in order** (exact → prefix → suffix) with **short-circuit evaluation** — as soon as one matches, the remaining checks are skipped for maximum performance.

### Span naming and attributes

Span names follow `METHOD-<route>`:

- Matched routes use the **route template**: `GET /api/files/:id` → span name `GET-/api/files/_id`.
- Unmatched routes (e.g. 404) fall back to the request path: `GET /api/unknown` → `GET-/api/unknown`, unless `unmatchedRouteSpanName: "method"` is set, in which case the span name is the method only (`GET`).
- The query string is never part of the span name.
- Span names are sanitized with the same regex used by `@devopsplaybook.io/otel-utils` (`[^a-zA-Z0-9-_/]` → `_`), so `ignoreList` entries match the exported span name.
- Spans are created with `SpanKind.SERVER` and the usual synthetic `StandardTracer` attributes (`http.request_method=BACKEND`, synthetic `http.route`) are **not** added — real HTTP attributes are set instead.

Attributes set on each HTTP span:

| Attribute                   | Value                                                                                                                                                                                                    |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `http.request.method`       | Request method (`GET`, `POST`, ...)                                                                                                                                                                      |
| `url.path`                  | Request path, **without** query string                                                                                                                                                                   |
| `http.route`                | Route template — only when the request matched a route                                                                                                                                                   |
| `http.response.status_code` | Response status code                                                                                                                                                                                     |
| `error.type`                | `error.name` when it is not the generic `Error`, otherwise `error.code` (e.g. `FST_ERR_VALIDATION` for Fastify errors), otherwise `Error` — or `client_abort` / `timeout` for aborted/timed out requests |

The query string is not recorded (`url.query` is not set).

### Metrics: `http.server.request.duration`

When a [`StandardMeter`](https://github.com/devopsplaybookio/otel-utils) is passed in `standardMeter`, the hooks record one histogram observation per traced request at span end:

- Name: `http.server.request.duration` (seconds). `StandardMeter` prefixes the service id, so it is exported as `<SERVICE_ID>.http.server.request.duration`.
- Attributes: `http.request.method`, `http.route` (only when a route matched) and `http.response.status_code` — or `error.type` (`client_abort` / `timeout`) instead of a status code for aborted/timed-out requests.
- The same `rootApiPath` / ignore-list filtering applies: only traced requests record, and the histogram counts are the traced request counts.

```typescript
const meter = new StandardMeter(config);
StandardTracerFastifyRegisterHooks(fastify, tracer, logger, {
  standardMeter: meter,
});
```

When the option is omitted (default), no metrics are recorded.

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

The span is also assigned to `req.tracerSpanApi` as a deprecated compatibility alias. **Deprecated in favor of `OTelRequestSpan(req)`**: it keeps working for the whole 1.x line and is **planned for removal in 2.0.0**, only after the known consumers (`common-utils`, `kubernetes-web-lightclient`) have migrated to `OTelRequestSpan(req)`. New code must use `OTelRequestSpan(req)`.

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

The span and context are stored in `WeakMap`s rather than as properties on the request object, avoiding type pollution and allowing natural garbage collection. The `tracerSpanApi` alias is set to `undefined` when the span ends (it is a plain property, so it must be cleaned up explicitly).

## Behavior changes in 1.4.0

- **Span status policy aligns with the current OTel HTTP semantic conventions** (consumer-visible): span status is left **unset for 1xx–4xx** responses (previously OK for ≤ 299 and ERROR for 4xx+) and stays ERROR for 5xx, exceptions, `client_abort` and `timeout`. Status-based dashboards will see fewer ERROR spans (routine 404/4xx traffic no longer counts as server errors) and no more OK statuses.
- **Client errors are logged at warn level**: `onError` logs errors with `statusCode < 500` via `logger.warn` (no stack), all others via `logger.error` as before — routine validation/auth failures no longer inflate error logs/alerts.
- **`error.type` is more specific**: `error.name` when not the generic `Error`, otherwise `error.code` (e.g. `FST_ERR_VALIDATION`), otherwise `Error`.
- **Tracing is fail-open**: a fault in a hook (throwing tracer/span/logger) is caught, logged once at warn level, and the request continues untraced instead of failing with a 500.
- **Absolute-form request targets** (`GET http://host/api/x HTTP/1.1`) are now traced with the parsed pathname (`url.path=/api/x`); previously they were silently not traced.
- New opt-in options (defaults preserve previous behavior): `unmatchedRouteSpanName` and `standardMeter`.
- A span on which `onError` recorded an error is never downgraded by a 2xx response produced by a custom error handler (regression fix).

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
