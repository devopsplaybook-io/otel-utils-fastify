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
  // Recommended: keep span-name cardinality bounded for unmatched routes (404s)
  // from scanner/probe traffic. "path" remains the default for compatibility.
  unmatchedRouteSpanName: "method",
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

> **Production tip:** set `unmatchedRouteSpanName: "method"` to keep span-name cardinality bounded when scanners and probes hit unmatched routes (404s) with arbitrary paths; `"path"` remains the default for backward compatibility. The full request path is always kept in `url.path`.

## Exported API

### `StandardTracerFastifyRegisterHooks(fastify, standardTracer, standardLogger, options?)`

Registers five Fastify hooks:

| Hook             | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `onRequest`      | Extracts W3C trace context from incoming headers. Creates a `SpanKind.SERVER` span named after the route (`METHOD-<route template>`; path or method fallback when no route matched, see `unmatchedRouteSpanName`; unknown methods use `_OTHER`) and stores it plus its context in internal `WeakMap`s. Skips OPTIONS requests, paths outside `rootApiPath`, and ignored span names.                                                                  |
| `onResponse`     | Ends the span: records `http.response.status_code` and sets the span status per the current OTel HTTP semantic conventions for server spans — **unset for 1xx–4xx, ERROR for 5xx** — then ends the span and removes it from the `WeakMap`s. A span on which `onError` already recorded an error keeps its ERROR status. Returned 5xx responses without a recorded exception also get `error.type` set to the status code as a string (e.g. `"500"`). |
| `onError`        | Sets span status to ERROR, records `error.type` and the exception, and logs the error via `ModuleLogger` with trace context: **`warn` (no stack) for client errors** (`statusCode < 500`, e.g. validation 400 or 403), `error` otherwise. Non-`Error` throws are normalized to an `Error` first.                                                                                                                                                     |
| `onRequestAbort` | Ends the span with ERROR status and `error.type = "client_abort"` when the client aborts the request.                                                                                                                                                                                                                                                                                                                                                |
| `onTimeout`      | Ends the span with ERROR status and `error.type = "timeout"` when the connection times out.                                                                                                                                                                                                                                                                                                                                                          |

Registration is idempotent across the instance tree: a second registration on the same instance **or on an encapsulated child of an already-registered instance** is ignored with a warning. The internal `otelUtilsFastifyHooksRegistered` decorator marks a registered instance and is inherited by encapsulated children; a child registered before its root cannot be detected at registration time and is additionally neutralized per request, so a request is never instrumented twice. Hooks are registered globally and cannot be removed — register them **once**, at the root of the Fastify instance.

Tracing is **fail-open**: a fault in any hook (including a throwing tracer, span or logger) is caught, logged once at warn level through the `ModuleLogger`, and the request continues untraced — instrumentation never fails the request. If `onRequest` fails after the span was created, the span is ended (best effort) before the request continues untraced, so it is not leaked.

**Options:**

| Field                    | Type                  | Default  | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------ | --------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rootApiPath`            | `string?`             | `"/api"` | Only trace the path itself and paths under `"<rootApiPath>/"` (boundary check: `/apiary` is **not** traced, `/apiary/...` neither). `"/"` traces everything. Trailing slashes are ignored.                                                                                                                                                                                                                                                                                                                                                                      |
| `ignoreList`             | `string[]?`           | —        | Exact span names to skip. Format: `"METHOD-/route"`, using the route template for parameterized routes (e.g. `"GET-/api/files/_id"`).                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `ignoreListPrefix`       | `string[]?`           | —        | Skip when span name **starts with** any of these (native `startsWith`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `ignoreListSuffix`       | `string[]?`           | —        | Skip when span name **ends with** any of these (native `endsWith`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `unmatchedRouteSpanName` | `"path" \| "method"?` | `"path"` | Span-name policy for requests that did not match a route (e.g. 404s). `"path"`: sanitized request path — today's behavior; note the unbounded cardinality from scanner/probe traffic and that attacker payloads end up as span names. `"method"`: method only (e.g. `GET`), keeping cardinality bounded (current semconv recommends a low-cardinality name when available); ignore lists then match `"GET"` for unmatched requests. Unknown methods use `_OTHER` with either policy. The full path is always kept in `url.path`; matched routes are unaffected. |
| `standardMeter`          | `StandardMeter?`      | —        | When provided, records the `http.server.request.duration` histogram (seconds) for traced requests. See [Metrics](#metrics-http-server-requestduration) below.                                                                                                                                                                                                                                                                                                                                                                                                   |

All three ignore lists are checked **in order** (exact → prefix → suffix) with **short-circuit evaluation** — as soon as one matches, the remaining checks are skipped for maximum performance.

### Span naming and attributes

Span names follow `METHOD-<route>`:

- Matched routes use the **route template**: `GET /api/files/:id` → span name `GET-/api/files/_id`.
- Unmatched routes (e.g. 404) fall back to the request path: `GET /api/unknown` → `GET-/api/unknown`, unless `unmatchedRouteSpanName: "method"` is set, in which case the span name is the method only (`GET`).
- Unknown HTTP methods (anything outside the IANA set `CONNECT`, `DELETE`, `GET`, `HEAD`, `OPTIONS`, `PATCH`, `POST`, `PUT`, `TRACE`) are normalized to `_OTHER`: `PROPFIND /api/x` → `_OTHER-/api/x` (or `_OTHER` with `unmatchedRouteSpanName: "method"`). `ignoreList`/`ignoreListPrefix`/`ignoreListSuffix` must use `_OTHER` for such requests.
- The query string is never part of the span name.
- Span names are sanitized with the same regex used by `@devopsplaybook.io/otel-utils` (`[^a-zA-Z0-9-_/]` → `_`), so `ignoreList` entries match the exported span name.
- Spans are created with `SpanKind.SERVER` and the usual synthetic `StandardTracer` attributes (`http.request_method=BACKEND`, synthetic `http.route`) are **not** added — real HTTP attributes are set instead.

Attributes set on each HTTP span:

| Attribute                      | Value                                                                                                                                                                                                                                                                                                    |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `http.request.method`          | Request method (`GET`, `POST`, ...); unknown methods are recorded as `_OTHER`                                                                                                                                                                                                                            |
| `http.request.method_original` | Verbatim request method — only when `http.request.method` is `_OTHER`                                                                                                                                                                                                                                    |
| `url.path`                     | Request path, **without** query string                                                                                                                                                                                                                                                                   |
| `url.scheme`                   | `http` or `https` from `req.protocol` (honours Fastify `trustProxy`)                                                                                                                                                                                                                                     |
| `server.address`               | `req.hostname` — omitted when empty (e.g. HTTP/1.0 request without `Host`)                                                                                                                                                                                                                               |
| `server.port`                  | `req.port` — omitted when absent                                                                                                                                                                                                                                                                         |
| `network.protocol.version`     | `req.raw.httpVersion` (e.g. `1.1`, `1.0`)                                                                                                                                                                                                                                                                |
| `http.route`                   | Route template — only when the request matched a route                                                                                                                                                                                                                                                   |
| `http.response.status_code`    | Response status code                                                                                                                                                                                                                                                                                     |
| `error.type`                   | `error.name` when it is not the generic `Error`, otherwise `error.code` (e.g. `FST_ERR_VALIDATION` for Fastify errors), otherwise `Error`; `client_abort` / `timeout` for aborted/timed out requests; the status code as a string (e.g. `"500"`) for returned 5xx responses without a recorded exception |

The query string is not recorded (`url.query` is not set).

`server.address` and `server.port` are derived from the client-controlled `Host` header — or from `X-Forwarded-Host` when Fastify `trustProxy` is enabled and the connecting peer is trusted — so they are only as trustworthy as the deployment's proxy configuration. Arbitrary `Host` values also become attribute values: if inbound host names are not constrained by a proxy or load balancer, that introduces cardinality. 1.5.0 has no configured server-address override.

### Span status: returned vs thrown 4xx

Span status follows the OTel HTTP semantic conventions for **returned** responses: **unset for 1xx–4xx** and **ERROR for 5xx**. **Thrown** errors are intentionally different: `onError` always sets ERROR and records `error.type` and the exception, even when Fastify turns the thrown error into a 4xx response (for example a validation error producing a 400). An exception is treated as an error regardless of the status code it produces, whereas a deliberately returned 4xx response is not a server error. This asymmetry is intentional; do not report it as a bug.

### Metrics: `http.server.request.duration`

When a [`StandardMeter`](https://github.com/devopsplaybook-io/otel-utils) is passed in `standardMeter`, the hooks record one histogram observation per traced request at span end:

- Name: `http.server.request.duration` (values in **seconds**), with two deliberate deviations from the OTel semantic conventions: `StandardMeter` prefixes the service id, so the metric is exported as `<SERVICE_ID>.http.server.request.duration` instead of `http.server.request.duration`, and the histogram is created without a unit, so backends do not see the semconv unit `s`. Both are kept unchanged for compatibility (renaming or adding a unit is a behaviour change). The future opt-in is `createHistogram(name, { unprefixed: true })`, available in the otel-utils 1.5.x line (verified with the locked 1.5.3), which would export the exact semconv name; forwarding a unit (`{ unit: "s" }`) requires otel-utils >= 1.7.0, which adds `MetricOptions` support. Neither option is used by this package today.
- Attributes: `http.request.method` (normalized to `_OTHER` for unknown methods), the required `url.scheme`, the recommended `network.protocol.version`, `http.route` (only when a route matched) and `http.response.status_code` — or `error.type` (`client_abort` / `timeout`) instead of a status code for aborted/timed-out requests.
- Returned 5xx responses also carry `error.type`: the status code as a string (e.g. `"500"`), or the specific value recorded by `onError` (`FST_ERR_VALIDATION`, the error name, ...) when an exception was thrown. A specific thrown-error value is never replaced by the status code.
- Deliberately **not** recorded on the metric: `http.request.method_original` (bounded cardinality) and `server.address` / `server.port` (semconv opt-in), so the metric attributes stay low-cardinality.
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

The span is also assigned to `req.tracerSpanApi` as a deprecated compatibility alias. **Deprecated in favor of `OTelRequestSpan(req)`**: it keeps working for the whole 1.x line and is **removed in 2.0.0**. New code must use `OTelRequestSpan(req)`.

The two known consumers migrated to `OTelRequestSpan(req)` on 2026-10-02 (`common-utils` PR #27 and `kubernetes-web-lightclient` PR #45). No maintained consumer is expected to read the alias: the `cloudcost` copy (`cloudcost-server/src/OTelContext.ts`) is a dead local shim that nothing imports, and `telepathy` uses the exported hooks and `StandardTracer` without the alias.

**2.0.0 removal criterion:** before the 2.0.0 release, a code search of the `devopsplaybook-io` organization must return no maintained code reading `req.tracerSpanApi` outside this repository (the dead `cloudcost` shim must be deleted or migrated), and the alias is then removed from this package. Until then it stays available but deprecated.

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

## Documentation changes in 1.7.0

- Refreshed the `req.tracerSpanApi` deprecation note: both known consumers migrated on 2026-10-02, no maintained consumer remains, concrete 2.0.0 removal criterion.
- Fixed the `StandardMeter` link (wrong GitHub organization).
- Documented the intentional span-status asymmetry for thrown 4xx responses and the metric deviations (`<SERVICE_ID>.` prefix, no unit `s`).
- Recommended `unmatchedRouteSpanName: "method"` in the quick start; `"path"` remains the default.
- Added `repository`, `homepage`, `bugs` and `author` metadata to `package.json`.
- No runtime behaviour change.

## Behavior changes in 1.6.0

- **Duplicate registration across encapsulation no longer double-instruments**: registering the hooks at the root and again inside `fastify.register()` is detected (inherited `otelUtilsFastifyHooksRegistered` decorator) and ignored with a warning; a child registered before the root is neutralized per request. One span is created and ended per request instead of a leaked first span.
- **`onRequest` setup failures no longer leak spans**: a span created before a failure in the hook (e.g. a throwing `setAttribute`) is ended best effort before the request continues untraced.
- No new metric, no dependency change, additive and non-breaking — hence a minor version bump.

## Behavior changes in 1.5.0

- **HTTP server spans follow the current semconv attributes**: `url.scheme`, `server.address`, `server.port` and `network.protocol.version` are now set on every traced span (`server.address`/`server.port` are omitted when the request carries no usable `Host` information).
- **Returned 5xx responses record `error.type`**: when no exception was recorded, the status code as a string (`"500"`) is added to both the span and the `http.server.request.duration` histogram. Thrown errors keep their specific `error.type` (error name or code such as `FST_ERR_VALIDATION`).
- **Unknown HTTP methods are normalized**: methods outside the IANA set are recorded as `http.request.method=_OTHER`, with the verbatim method in `http.request.method_original` on the span. Span names use `_OTHER-<route|path>` (or `_OTHER` with `unmatchedRouteSpanName: "method"`) and the histogram records `_OTHER` only.
- **The duration histogram gains `url.scheme` and `network.protocol.version`**. No new metric is recorded by default.
- These are additive, non-breaking changes — hence a minor version bump.

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
