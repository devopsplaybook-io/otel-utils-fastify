# otel-utils-fastify

Fastify integration for `@devopsplaybook.io/otel-utils`. Automatically creates and manages OpenTelemetry spans for HTTP requests via Fastify lifecycle hooks.

## Installation

```bash
npm install @devopsplaybook.io/otel-utils-fastify
```

Peer dependencies that must be installed and configured in the consuming project:

| Peer dependency                 | Version  |
| ------------------------------- | -------- |
| `@devopsplaybook.io/otel-utils` | `^1.9.1` |
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
  // Optional: export the exact semconv metric name
  // `http.server.request.duration` instead of `<SERVICE_ID>.…`
  unprefixedMetricName: true,
  // Optional: emit current OTel HTTP semconv span names
  // (`GET /api/files/:id`); the default "legacy" format is unchanged.
  // spanNameFormat: "semconv",
  // Optional: extra known methods on top of the built-in set (additive only)
  // knownHttpMethods: ["PROPFIND"],
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

> **Production tip:** set `unmatchedRouteSpanName: "method"` (or opt in to `spanNameFormat: "semconv"`, which always names unmatched requests after the method) to keep span-name cardinality bounded when scanners and probes hit unmatched routes (404s) with arbitrary paths; `"path"` remains the default for backward compatibility. The full request path is always kept in `url.path`.

## Exported API

### `StandardTracerFastifyRegisterHooks(fastify, standardTracer, standardLogger, options?)`

Registers five Fastify hooks:

| Hook             | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `onRequest`      | Extracts W3C trace context from incoming headers. Creates a `SpanKind.SERVER` span named after the route: `METHOD-<route template>` in the default `"legacy"` format (path or method fallback when no route matched, see `unmatchedRouteSpanName`; unknown methods use `_OTHER`) or `{method} {route}` with `spanNameFormat: "semconv"` (see [Span naming](#span-naming-and-attributes)). Stores the span, its context, the start time and the owning histogram in one internal per-request state record (a `WeakMap` keyed on the request). Skips OPTIONS requests, paths outside `rootApiPath`, and ignored span names. |
| `onResponse`     | Ends the span: records `http.response.status_code` and sets the span status per the current OTel HTTP semantic conventions for server spans — **unset for 1xx–4xx, ERROR for 5xx** — then ends the span and clears the per-request state. A span on which `onError` already recorded an error keeps its ERROR status. Returned 5xx responses without a recorded exception also get `error.type` set to the status code as a string (e.g. `"500"`).                                                                                                                                                                        |
| `onError`        | Sets span status to ERROR, records `error.type` and the exception, and logs the error via `ModuleLogger` with trace context: **`warn` (no stack) for client errors** (`statusCode < 500`, e.g. validation 400 or 403), `error` otherwise. Non-`Error` throws are normalized to an `Error` first.                                                                                                                                                                                                                                                                                                                          |
| `onRequestAbort` | Ends the span with ERROR status and `error.type = "client_abort"` when the client aborts the request.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `onTimeout`      | Ends the span with ERROR status and `error.type = "timeout"` when the connection times out.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

Registration is idempotent across the instance tree: a second registration on the same instance **or on an encapsulated child of an already-registered instance** is ignored with a warning. The internal `otelUtilsFastifyHooksRegistered` decorator marks a registered instance and is inherited by encapsulated children; a child registered before its root cannot be detected at registration time and is additionally neutralized per request, so a request is never instrumented twice. Hooks are registered globally and cannot be removed — register them **once**, at the root of the Fastify instance.

**Telemetry ownership across registrations:** a traced request produces one span and **at most one** `http.server.request.duration` observation, regardless of hook ordering. The span is created by the first registration in hook execution order that traces the request. The observation is recorded by the first registration in hook execution order that both **traces the request** and provides a `standardMeter`; a registration that filters the request out never records for it. Consequently, a request traced only by registrations without a `standardMeter` records no metric, while a metered root still records it when an unmetered child registers first.

Tracing is **fail-open**: a fault in any hook (including a throwing tracer, span or logger) is caught, logged once at warn level through the `ModuleLogger`, and the request continues untraced — instrumentation never fails the request. If `onRequest` fails after the span was created, the span is ended (best effort) before the request continues untraced, so it is not leaked.

**Options:**

| Field                    | Type                                     | Default    | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------ | ---------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rootApiPath`            | `string?`                                | `"/api"`   | Only trace the path itself and paths under `"<rootApiPath>/"` (boundary check: `/apiary` is **not** traced, `/apiary/...` neither). `"/"` traces everything. Normalized at registration with a warning: trimmed, a missing leading `/` is prepended and trailing slashes are removed; `""` (or whitespace-only) means `"/"` (traces every path).                                                                                                                                                                                                                                                                                                                                |
| `spanNameFormat`         | `"legacy" \| "semconv"?`                 | `"legacy"` | Span-name format. `"legacy"`: `METHOD-<route>` (`GET-/api/files/_id`), sanitized, with the path or method fallback for unmatched routes. `"semconv"`: `{method} {route}` with the verbatim route template (`GET /api/files/:id`; only control characters are stripped), `HTTP` as the method for unknown methods, and the method only for unmatched routes (never the URI path). Ignore lists match the exported name, so their content differs between formats.                                                                                                                                                                                                                |
| `knownHttpMethods`       | `string[]?`                              | —          | Additional known HTTP methods on top of the built-in set (RFC 9110 methods plus `PATCH` and `QUERY`). Entries are trimmed, uppercased and deduplicated; invalid entries warn and are ignored. Additive only — built-in methods can never become `_OTHER`.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `ignoreList`             | `string[]?`                              | —          | Exact span names to skip, matching the exported format (e.g. `"GET-/api/files/_id"` in legacy, `"GET /api/files/:id"` in semconv). Entries are trimmed and normalized for the selected format at registration (so `"GET-/api/files/:id"` matches without manual sanitization); invalid entries warn and are ignored.                                                                                                                                                                                                                                                                                                                                                            |
| `ignoreListPrefix`       | `string[]?`                              | —          | Skip when the span name **starts with** any of these (native `startsWith`). Entries are trimmed and normalized for the selected format at registration; invalid entries warn and are ignored.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `ignoreListSuffix`       | `string[]?`                              | —          | Skip when the span name **ends with** any of these (native `endsWith`). Entries are trimmed and normalized for the selected format at registration; invalid entries warn and are ignored.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `unmatchedRouteSpanName` | `"path" \| "method"?`                    | `"path"`   | Span-name policy for requests that did not match a route (e.g. 404s) in the `"legacy"` format; ignored with `spanNameFormat: "semconv"`, where unmatched requests are always named after the method only. `"path"`: sanitized request path — today's behavior; note the unbounded cardinality from scanner/probe traffic and that attacker payloads end up as span names. `"method"`: method only (e.g. `GET`), keeping cardinality bounded; ignore lists then match `"GET"` for unmatched requests. Invalid values warn and fall back to `"path"`. Unknown methods use `_OTHER` with either policy. The full path is always kept in `url.path`; matched routes are unaffected. |
| `standardMeter`          | `StandardMeter?`                         | —          | When provided, records the `http.server.request.duration` histogram (seconds) for traced requests, created with the semconv unit, description and bucket boundaries. See [Metrics](#metrics-http-server-requestduration) below.                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `histogramOptions`       | `StandardTracerFastifyHistogramOptions?` | —          | `{ unit?: string; description?: string; explicitBucketBoundaries?: number[] }` — metadata and aggregation of the duration histogram. Defaults are the semconv values (unit `s`, description `Duration of HTTP server requests.`, semconv boundaries). Only used when `standardMeter` is provided. Values are always recorded in seconds, so overriding `unit` only relabels the metric.                                                                                                                                                                                                                                                                                         |
| `unprefixedMetricName`   | `boolean?`                               | `false`    | Export the histogram under the exact semconv name `http.server.request.duration` instead of the default `<SERVICE_ID>.http.server.request.duration`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

All three ignore lists are checked **in order** (exact → prefix → suffix) with **short-circuit evaluation** — as soon as one matches, the remaining checks are skipped for maximum performance.

### Span naming and attributes

Span names depend on `spanNameFormat` (default `"legacy"`):

| Request                             | `"legacy"` (default)                                               | `"semconv"`              |
| ----------------------------------- | ------------------------------------------------------------------ | ------------------------ |
| Matched `/api/files/:id`, `GET`     | `GET-/api/files/_id`                                               | `GET /api/files/:id`     |
| Matched `/api/files/:id`, unknown   | `_OTHER-/api/files/_id`                                            | `HTTP /api/files/:id`    |
| Matched route, extended method      | `PROPFIND-/api/...`                                                | `PROPFIND /api/...`      |
| Unmatched, `GET`                    | `GET-/api/unknown` (`GET` with `unmatchedRouteSpanName: "method"`) | `GET` (never the path)   |
| Unmatched, unknown method           | `_OTHER-/api/unknown` (`_OTHER` with the method policy)            | `HTTP`                   |
| Unmatched route with a query string | never includes the query                                           | never includes the query |

- `"legacy"`: `METHOD-<route>` with the route template for matched routes, and the sanitized request path or the method as fallback for unmatched routes (see `unmatchedRouteSpanName`). Unknown methods are normalized to `_OTHER` in both the span name and `http.request.method`. Names are sanitized with the same regex used by `@devopsplaybook.io/otel-utils` (`[^a-zA-Z0-9-_/]` → `_`).
- `"semconv"`: `{method} {route}` using the verbatim route template (`:id`, spaces and regex parameters are preserved; only ASCII control characters are stripped). Unknown methods use `HTTP` as the `{method}` in the span name while `http.request.method` stays `_OTHER` and `http.request.method_original` records the verbatim method. Unmatched requests (404s, scanner/probe traffic) are named after the method only (`GET`, or `HTTP` for unknown methods) — **never** the URI path — keeping cardinality bounded. `unmatchedRouteSpanName` is ignored in this format.
- Ignore lists (`ignoreList`, `ignoreListPrefix`, `ignoreListSuffix`) match the exported span name, so their content differs between formats (`GET-/api/files/_id` versus `GET /api/files/:id`). Entries are trimmed and normalized automatically at registration for the selected format.
- The query string is never part of the span name.
- Spans are created with `SpanKind.SERVER` and the usual synthetic `StandardTracer` attributes (`http.request_method=BACKEND`, synthetic `http.route`) are **not** added — real HTTP attributes are set instead.

Attributes set on each HTTP span:

| Attribute                      | Value                                                                                                                                                                                                                                                                                                    |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `http.request.method`          | Request method (`GET`, `POST`, ...). Known methods are the RFC 9110 methods plus `PATCH` and `QUERY`, extended by `knownHttpMethods`; anything else is recorded as `_OTHER`                                                                                                                              |
| `http.request.method_original` | Verbatim request method — only when `http.request.method` is `_OTHER`                                                                                                                                                                                                                                    |
| `url.path`                     | Request path, **without** query string                                                                                                                                                                                                                                                                   |
| `url.scheme`                   | `http` or `https` from `req.protocol` (honours Fastify `trustProxy`)                                                                                                                                                                                                                                     |
| `server.address`               | `req.hostname` with a single pair of surrounding IPv6 brackets removed (`[::1]` → `::1`) — omitted when empty (e.g. HTTP/1.0 request without `Host`)                                                                                                                                                     |
| `server.port`                  | `req.port` — omitted when absent                                                                                                                                                                                                                                                                         |
| `network.protocol.version`     | `req.raw.httpVersion` (e.g. `1.1`, `1.0`)                                                                                                                                                                                                                                                                |
| `http.route`                   | Route template — only when the request matched a route                                                                                                                                                                                                                                                   |
| `http.response.status_code`    | Response status code                                                                                                                                                                                                                                                                                     |
| `error.type`                   | `error.name` when it is not the generic `Error`, otherwise `error.code` (e.g. `FST_ERR_VALIDATION` for Fastify errors), otherwise `Error`; `client_abort` / `timeout` for aborted/timed out requests; the status code as a string (e.g. `"500"`) for returned 5xx responses without a recorded exception |

The query string is not recorded (`url.query` is not set).

`server.address` and `server.port` are derived from the client-controlled `Host` header — or from `X-Forwarded-Host` when Fastify `trustProxy` is enabled and the connecting peer is trusted — so they are only as trustworthy as the deployment's proxy configuration. `server.address` is the IP literal or hostname with a single pair of surrounding IPv6 brackets stripped (`[::1]` → `::1`), as the semantic conventions require. Arbitrary `Host` values also become attribute values: if inbound host names are not constrained by a proxy or load balancer, that introduces cardinality. There is no configured server-address override; the values always come from the request and the Fastify proxy configuration.

### Span status: returned vs thrown 4xx

Span status follows the OTel HTTP semantic conventions for **returned** responses: **unset for 1xx–4xx** and **ERROR for 5xx**. **Thrown** errors are intentionally different: `onError` always sets ERROR and records `error.type` and the exception, even when Fastify turns the thrown error into a 4xx response (for example a validation error producing a 400). An exception is treated as an error regardless of the status code it produces, whereas a deliberately returned 4xx response is not a server error. This asymmetry is intentional; do not report it as a bug.

### Metrics: `http.server.request.duration`

When a [`StandardMeter`](https://github.com/devopsplaybook-io/otel-utils) is passed in `standardMeter`, the hooks record one histogram observation per traced request at span end:

- Name: `http.server.request.duration`, imported from the OTel semantic conventions as `METRIC_HTTP_SERVER_REQUEST_DURATION`. The histogram is created with the semconv metadata:
  - unit `s` (values are recorded in **seconds**);
  - description `Duration of HTTP server requests.`;
  - the semconv recommended explicit bucket boundaries, in seconds: `[0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10]`. These fine-grained sub-second buckets make p50/p95/p99 latency derivable from the metric (the SDK's millisecond-oriented default boundaries put every request under 5 seconds into a single bucket).
  - One deliberate deviation remains: `StandardMeter` prefixes the service id by default, so the metric is exported as `<SERVICE_ID>.http.server.request.duration`. This is kept unchanged for compatibility. Set `unprefixedMetricName: true` to export the exact semconv name `http.server.request.duration` instead.
  - `histogramOptions` overrides `unit`, `description` and/or `explicitBucketBoundaries` (forwarded verbatim, no validation). Values are always recorded in seconds, so overriding `unit` only relabels the metric.
  - The instrument name is exact, but backend conventions may still apply at scrape/export time (e.g. Prometheus appends `_seconds` to a histogram whose unit is `s`).
- Attributes: `http.request.method` (normalized to `_OTHER` for methods outside the known set), the required `url.scheme`, the recommended `network.protocol.version`, `http.route` (only when a route matched) and `http.response.status_code` — or `error.type` (`client_abort` / `timeout`) instead of a status code for aborted/timed-out requests.
- Returned 5xx responses also carry `error.type`: the status code as a string (e.g. `"500"`), or the specific value recorded by `onError` (`FST_ERR_VALIDATION`, the error name, ...) when an exception was thrown. A specific thrown-error value is never replaced by the status code.
- Deliberately **not** recorded on the metric: `http.request.method_original` (bounded cardinality) and `server.address` / `server.port` (semconv opt-in), so the metric attributes stay low-cardinality.
- The same `rootApiPath` / ignore-list filtering applies: only traced requests record, and the histogram counts are the traced request counts.

**Ownership across registrations.** When several registrations see the same request (for example hooks registered on an encapsulated child and on its root), the request still produces exactly one observation. It is recorded with the histogram of the first registration in hook execution order that **traces the request and has a `standardMeter`**. A registration that filters the request out (`rootApiPath`, ignore lists, OPTIONS) never records for it, even when it has a meter. A registration without `standardMeter` produces no metric even when another registration has one; a request traced only by unmetered registrations records nothing. Hook ordering therefore never changes which span or observation a request gets.

```typescript
const meter = new StandardMeter(config);
StandardTracerFastifyRegisterHooks(fastify, tracer, logger, {
  standardMeter: meter,
  // Optional: export the exact semconv name instead of
  // `<SERVICE_ID>.http.server.request.duration`
  unprefixedMetricName: true,
  // Optional: override the histogram metadata and bucket boundaries.
  // Values are always recorded in seconds.
  // histogramOptions: {
  //   explicitBucketBoundaries: [0.001, 0.01, 0.1, 1, 10],
  // },
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
  │           └── WeakMap<req, { span, context, startTime, errorType?, histogram? }>
  └── Route handler
        └── OTelRequestSpan(req)
              or context.with(OTelRequestContext(req), () => ...)
onResponse / onError / onRequestAbort / onTimeout
  └── WeakMap.get(req) → per-request state
        ├── span.setStatus({ code })
        ├── span.setAttribute(...)
        ├── histogram.record(duration)  ← only when the owning state has one
        ├── span.end() / span.recordException(error)
        └── WeakMap.delete(req)
```

The span, context, start time and owning histogram are stored in one per-request state record in a `WeakMap` rather than as properties on the request object, avoiding type pollution and allowing natural garbage collection. The `tracerSpanApi` alias is set to `undefined` when the span ends (it is a plain property, so it must be cleaned up explicitly).

## Documentation and dependency changes in 1.11.0

- Aligned the peer-dependency table with `package.json`: `@devopsplaybook.io/otel-utils` is `^1.9.1` (it was still documented as `^1.3.0`).
- Corrected the dependency table: the `Span` type comes from the declared `@opentelemetry/sdk-trace` dependency; `@opentelemetry/sdk-trace-base` is only transitive.
- Removed version-anchored wording from the server-address, 1.3.0 peer and 1.7.0 metric notes, so they describe the current code and the deviations that remain: the `<SERVICE_ID>.` metric prefix (opt out with `unprefixedMetricName`), the legacy default span-name format (`spanNameFormat: "semconv"` opt-in) and the `"path"` fallback for unmatched routes (`unmatchedRouteSpanName: "method"` recommended).
- Lockfile-only dependency refresh (no declared range changed): `fast-uri` 4.2.1 → 4.2.3 and its nested 3.1.8 copies → 3.1.9, `babel-plugin-istanbul` 8.0.0 → 8.0.2. `npm audit --omit=dev` reports 0 vulnerabilities; the remaining advisories are confined to the Jest 30 development chain, which has no non-breaking fix.
- No runtime behaviour change.

## Behavior changes in 1.10.0

- **`QUERY` is a known HTTP method**: requests using `QUERY` are recorded as `http.request.method=QUERY` (and `QUERY`-prefixed legacy span names) instead of `_OTHER`. This is an intentional correction to the current HTTP semantic conventions; no other method changes.
- **IPv6 `server.address` is an IP literal**: a single pair of surrounding brackets is stripped from `req.hostname` (`[::1]` → `::1`); `server.port` is unchanged and non-IPv6 hosts are unaffected.
- **New opt-in `spanNameFormat: "semconv"`**: emits `GET /api/files/:id`, `HTTP <route>` for unknown methods and method-only names for unmatched routes (never the URI path). The default `"legacy"` format is unchanged.
- **New additive `knownHttpMethods`**: extends the built-in known method set (RFC 9110 methods plus `PATCH` and `QUERY`). Entries are trimmed, uppercased and deduplicated; invalid entries warn and are ignored. Built-in methods can never be replaced.
- **Options are validated and normalized at registration** (a warning and a safe fallback instead of silently misbehaving): `rootApiPath: "api"` now traces `/api/...` (previously it traced nothing), `""` now means `/` (trace everything), invalid `unmatchedRouteSpanName`/`spanNameFormat` values fall back, and invalid ignore-list entries are ignored. Ignore-list entries are trimmed and sanitized automatically, so `GET-/api/files/:id` matches the exported `GET-/api/files/_id`.
- No new metric and no breaking export or option-name change — hence a minor version bump.

Consumers opt in to `spanNameFormat: "semconv"` and update ignore lists to the exported names (`GET /api/files/:id`). `QUERY` and the IPv6 fix take effect automatically. `rootApiPath` values without a leading slash now work (with a warning); an empty string now means `/`.

## Behavior changes in 1.9.0

- **The `http.server.request.duration` histogram is semconv-compliant**: it is now created with the semconv unit `s`, the description `Duration of HTTP server requests.` and the semconv recommended explicit bucket boundaries `[0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10]` seconds. Previously the SDK's millisecond-oriented defaults put every request under 5 seconds into one bucket, making p50/p95/p99 impossible to derive.
- **New `histogramOptions`**: override the histogram `unit`, `description` and/or `explicitBucketBoundaries`. Values are always recorded in seconds, so overriding `unit` only relabels the metric.
- **New `unprefixedMetricName`**: set to `true` to export the exact semconv name `http.server.request.duration`. The default name `<SERVICE_ID>.http.server.request.duration` is unchanged for compatibility.
- No new metric and no span behaviour change. Additive and non-breaking — hence a minor version bump.

## Bug fixes in 1.8.0

- **Cross-registration telemetry ownership fixed**: the per-request span, context, start time and metric histogram are now stored in a single per-request state record owned by the registration that created the span. Previously they lived in four module-level `WeakMap`s shared by every registration while each registration recorded with its own histogram, so a request handled by a child scope registered before its root could silently record no observation, or the `onResponse` hook could throw `Cannot mix BigInt and other types, use explicit conversions` when the span creator had no meter and the ending registration did. A traced request now produces one span and at most one observation, recorded with the meter of the first registration in hook execution order that traces the request and has a `standardMeter`.
- No new option, no new metric, and no change to metric names, units or bucket boundaries. Single-registration behaviour is unchanged.

## Documentation changes in 1.7.0

- Refreshed the `req.tracerSpanApi` deprecation note: both known consumers migrated on 2026-10-02, no maintained consumer remains, concrete 2.0.0 removal criterion.
- Fixed the `StandardMeter` link (wrong GitHub organization).
- Documented the intentional span-status asymmetry for thrown 4xx responses and the metric deviations as they stood then (`<SERVICE_ID>.` prefix and the SDK default unit/boundaries; the unit, description and buckets have been semconv-aligned since 1.9.0).
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
- Introduced the `@devopsplaybook.io/otel-utils` peer requirement for `StandardTracer.startSpan(name, parentSpan?, options?)` (the current peer range is in [Installation](#installation)).

## Dependencies

| Package                               | Type       | Purpose                                                    |
| ------------------------------------- | ---------- | ---------------------------------------------------------- |
| `@devopsplaybook.io/otel-utils`       | peer       | StandardTracer, StandardMeter and StandardLogger instances |
| `fastify`                             | peer       | Fastify web framework (v5)                                 |
| `@opentelemetry/api`                  | dependency | Context, span kind/status and histogram types              |
| `@opentelemetry/core`                 | dependency | W3C trace context propagator                               |
| `@opentelemetry/sdk-trace`            | dependency | `Span` type used by the hooks                              |
| `@opentelemetry/semantic-conventions` | dependency | HTTP semantic attribute and metric-name constants          |

## Build, lint, test

```bash
npm run build    # tsc → dist/, then type-checks the spec files (tsc --noEmit)
npm run lint     # oxlint index.ts src && prettier --check .
npm run format   # prettier --write .
npm test         # jest --coverage (coverage thresholds enforced)
```
