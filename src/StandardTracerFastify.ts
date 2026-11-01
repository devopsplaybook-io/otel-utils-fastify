import {
  StandardLogger,
  StandardMeter,
  StandardTracer,
} from "@devopsplaybook.io/otel-utils";
import {
  Context,
  context,
  defaultTextMapGetter,
  Histogram,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import type { Span } from "@opentelemetry/sdk-trace";
import {
  ATTR_ERROR_TYPE,
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_REQUEST_METHOD_ORIGINAL,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_HTTP_ROUTE,
  ATTR_NETWORK_PROTOCOL_VERSION,
  ATTR_SERVER_ADDRESS,
  ATTR_SERVER_PORT,
  ATTR_URL_PATH,
  ATTR_URL_SCHEME,
  HTTP_REQUEST_METHOD_VALUE_OTHER,
  METRIC_HTTP_SERVER_REQUEST_DURATION,
} from "@opentelemetry/semantic-conventions";
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

const propagator = new W3CTraceContextPropagator();
// Same sanitization as @devopsplaybook.io/otel-utils, applied here so that
// `ignoreList` entries are matched against the exported span name.
const SPAN_NAME_SANITIZE_RE = /[^a-zA-Z0-9-_/]/g;
const DEFAULT_ROOT_API_PATH = "/api";
const INTERNAL_URL_BASE = "http://internal";

const HTTP_SERVER_REQUEST_DURATION_UNIT = "s";
const HTTP_SERVER_REQUEST_DURATION_DESCRIPTION =
  "Duration of HTTP server requests.";
// OTel semconv recommended explicit bucket boundaries for
// http.server.request.duration (seconds).
const DEFAULT_HTTP_SERVER_REQUEST_DURATION_BUCKET_BOUNDARIES: readonly number[] =
  [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10];

// Known methods of the semconv `http.request.method` enum. Everything else is
// recorded as `_OTHER` (with the verbatim method in
// `http.request.method_original`) to keep the attribute cardinality bounded.
const KNOWN_HTTP_METHODS = new Set([
  "CONNECT",
  "DELETE",
  "GET",
  "HEAD",
  "OPTIONS",
  "PATCH",
  "POST",
  "PUT",
  "TRACE",
]);

interface RequestState {
  span: Span;
  context: Context;
  startTime: bigint;
  errorType?: string;
  histogram?: Histogram;
}

// One record per traced request. The span (and its context and start time) is
// created by the first registration in hook execution order that traces the
// request; the histogram is filled by the first such registration that has a
// `standardMeter`, so an observation is never attributed to a registration
// that does not trace the request.
const requestStates = new WeakMap<FastifyRequest, RequestState>();
const registeredFastifyInstances = new WeakSet<FastifyInstance>();
// Decorators are inherited by encapsulated child instances, so the marker
// detects a registration made on any ancestor of the current instance.
const REGISTERED_DECORATOR_NAME = "otelUtilsFastifyHooksRegistered";

type FastifyRequestWithSpanAlias = FastifyRequest & { tracerSpanApi?: Span };

/**
 * Metadata and aggregation of the `http.server.request.duration` histogram.
 * Defaults reproduce the OTel HTTP semantic conventions.
 */
export interface StandardTracerFastifyHistogramOptions {
  /**
   * Histogram unit. Defaults to the semconv unit `"s"`. Durations are always
   * recorded in seconds, so overriding this only relabels the metric.
   */
  unit?: string;
  /** Defaults to the semconv description `"Duration of HTTP server requests."`. */
  description?: string;
  /**
   * Explicit bucket boundaries in seconds. Defaults to the semconv
   * recommended boundaries (0.005 s … 10 s).
   */
  explicitBucketBoundaries?: number[];
}

/**
 * Options for {@link StandardTracerFastifyRegisterHooks}.
 */
export interface StandardTracerFastifyRegisterHooksOptions {
  /**
   * Root path prefix for API routes.
   * Only requests under this path (the path itself or paths starting with
   * `"<rootApiPath>/"`) will be traced. Default `"/api"`.
   */
  rootApiPath?: string;
  /**
   * Span names to skip by exact match (e.g. `"GET-/api/health"`).
   * Checked first, with a linear scan over the array entries.
   * Format: `"METHOD-/route"` — the same sanitized format used for span names,
   * with the route template for parameterized routes (e.g.
   * `"GET-/api/files/_id"` for `/api/files/:id`). Unknown methods are named
   * `_OTHER` (e.g. `"_OTHER-/api/files/_id"`).
   */
  ignoreList?: string[];
  /**
   * Span names to skip when the span name **starts with** one of these strings.
   * Checked after exact match. Uses native `String.prototype.startsWith`.
   * Example: `["GET-/api/public/"]` ignores all GET requests under that prefix.
   */
  ignoreListPrefix?: string[];
  /**
   * Span names to skip when the span name **ends with** one of these strings.
   * Checked last. Uses native `String.prototype.endsWith`.
   * Example: `["/health", "/metrics"]` ignores all methods targeting those paths.
   */
  ignoreListSuffix?: string[];
  /**
   * Span-name policy for requests that did not match a route (e.g. 404s).
   *
   * - `"path"` (default): span name falls back to the sanitized request path.
   *   Unbounded span-name cardinality from scanner/probe traffic and attack
   *   payloads recorded as span names are possible; the current HTTP semantic
   *   conventions recommend a low-cardinality name when available.
   * - `"method"`: span name is the request method only (e.g. `GET`), keeping
   *   cardinality bounded. Note that `ignoreList`/`ignoreListPrefix`/
   *   `ignoreListSuffix` then match `"GET"` for unmatched requests (or
   *   `"_OTHER"` for unknown methods).
   *
   * The full request path is always kept in the `url.path` attribute.
   * Matched routes are unaffected.
   */
  unmatchedRouteSpanName?: "path" | "method";
  /**
   * Optional {@link StandardMeter} used to record the
   * `http.server.request.duration` histogram (in seconds) for traced requests.
   * The histogram is created with the semconv unit `"s"`, the semconv
   * description and the semconv recommended explicit bucket boundaries; see
   * {@link histogramOptions} to change them.
   * Recorded attributes: `http.request.method` (normalized to `_OTHER` for
   * unknown methods), `url.scheme`, `network.protocol.version`, `http.route`
   * (only when a route matched) and `http.response.status_code` — or
   * `error.type` instead of a status code for aborted/timed-out requests.
   * Returned 5xx responses also carry `error.type` (the status code as a
   * string, or the specific value recorded by `onError`). Note that
   * {@link StandardMeter} prefixes the metric name with the service id by
   * default, so it is exported as `<SERVICE_ID>.http.server.request.duration`;
   * set {@link unprefixedMetricName} to export the exact semconv name.
   * When omitted, no metrics are recorded.
   *
   * Ownership across registrations: a traced request produces at most one
   * observation, recorded by the first registration in hook execution order
   * that traces the request and provides a `standardMeter`. A registration
   * that filters the request out never records for it, even when it has a
   * meter. Hook ordering therefore never changes where an observation is
   * attributed.
   */
  standardMeter?: StandardMeter;
  /**
   * Metadata and bucket boundaries of the `http.server.request.duration`
   * histogram. Defaults: unit `"s"`, semconv description and semconv
   * recommended boundaries. Only used when `standardMeter` is provided.
   * Values are always recorded in seconds, so changing `unit` only relabels
   * the metric.
   */
  histogramOptions?: StandardTracerFastifyHistogramOptions;
  /**
   * Export the histogram under the exact semconv name
   * `http.server.request.duration` instead of the default
   * `<SERVICE_ID>.http.server.request.duration`. Default `false` (the
   * prefixed name is kept for compatibility).
   */
  unprefixedMetricName?: boolean;
}

/**
 * Registers Fastify lifecycle hooks that automatically create and manage
 * OpenTelemetry spans for each matching API request.
 *
 * - Extracts incoming W3C trace context from request headers for distributed tracing.
 * - Creates a `SpanKind.SERVER` span named `METHOD-<route>` (route template for
 *   matched routes, e.g. `GET-/api/files/_id` for `/api/files/:id`; path or
 *   method fallback when no route matched, see `unmatchedRouteSpanName`), with
 *   `http.request.method`, `http.request.method_original` (unknown methods
 *   only), `url.path`, `url.scheme`, `server.address`, `server.port`,
 *   `network.protocol.version` and `http.route` (route template) attributes.
 *   Unknown HTTP methods are normalized to `_OTHER` in the span name and
 *   `http.request.method`.
 * - Sets the span status according to the current HTTP semantic conventions for
 *   server spans: unset for 1xx-4xx responses, ERROR for 5xx responses and
 *   exceptions. A span that already recorded an error is never downgraded.
 *   Returned 5xx responses without a recorded exception also carry
 *   `error.type` set to the status code as a string.
 * - Ends the span on response, handler error, client abort or connection timeout.
 * - Logs errors via the provided {@link StandardLogger} with trace context;
 *   client errors (`statusCode < 500`) are logged at warn level.
 * - Tracing is fail-open: a fault in any hook is caught, logged once at warn
 *   level and the request continues untraced. A span created before an
 *   `onRequest` setup failure is ended (best effort) so it is not leaked.
 * - Skips OPTIONS requests and requests outside the configured `rootApiPath`.
 * - Additional filtering via `ignoreList` (exact), `ignoreListPrefix`, `ignoreListSuffix`
 *   — checked in that order with short-circuit evaluation.
 *
 * Register the hooks **once**, at the root of the Fastify instance: a second
 * registration on the same instance or on an encapsulated child of an
 * already-registered instance is ignored with a warning (detected through the
 * inherited `otelUtilsFastifyHooksRegistered` decorator). A child registered
 * before its root cannot be detected at registration time and is additionally
 * neutralized per request, so a request is never instrumented twice. Hooks
 * registered inside an encapsulated plugin only see the requests routed
 * through that plugin scope.
 *
 * **Telemetry ownership:** the first registration in hook execution order that
 * traces a request creates its span; the first tracing registration that has a
 * `standardMeter` supplies the `http.server.request.duration` histogram for it.
 * The instrument is created once per registration, with unit `s`, the semconv
 * description and the semconv recommended boundaries (see
 * `histogramOptions`), and exported under the semconv name when
 * `unprefixedMetricName` is set (default: `<SERVICE_ID>.…`).
 * A request traced only by registrations without a meter records no metric.
 * Hook ordering therefore never changes which span or observation a request
 * gets, and there is at most one observation per traced request.
 *
 * Use {@link OTelRequestContext} (or {@link OTelRequestSpan} as an explicit
 * parent) inside route handlers to attach the work of the request to the
 * HTTP span.
 *
 * @param fastify         - The Fastify instance to attach hooks to.
 * @param standardTracer  - A configured {@link StandardTracer} instance.
 * @param standardLogger  - A configured {@link StandardLogger} instance.
 * @param options         - Optional path filtering and ignore lists.
 */
export function StandardTracerFastifyRegisterHooks(
  fastify: FastifyInstance,
  standardTracer: StandardTracer,
  standardLogger: StandardLogger,
  options?: StandardTracerFastifyRegisterHooksOptions,
): void {
  const logger = standardLogger.createModuleLogger("Fastify");

  if (
    registeredFastifyInstances.has(fastify) ||
    fastify.hasDecorator(REGISTERED_DECORATOR_NAME)
  ) {
    logger.warn(
      "StandardTracerFastifyRegisterHooks is already registered on this Fastify instance or an encapsulated parent instance: ignoring the duplicate registration.",
    );
    return;
  }
  fastify.decorate(REGISTERED_DECORATOR_NAME, true);
  registeredFastifyInstances.add(fastify);

  const rootApiPath = normalizeRootApiPath(options?.rootApiPath);
  const unmatchedRouteSpanName = options?.unmatchedRouteSpanName ?? "path";
  const {
    histogramOptions,
    standardMeter,
    unprefixedMetricName,
  }: StandardTracerFastifyRegisterHooksOptions = options ?? {};
  const requestDurationHistogram = standardMeter?.createHistogram(
    METRIC_HTTP_SERVER_REQUEST_DURATION,
    {
      unit: histogramOptions?.unit ?? HTTP_SERVER_REQUEST_DURATION_UNIT,
      description:
        histogramOptions?.description ??
        HTTP_SERVER_REQUEST_DURATION_DESCRIPTION,
      advice: {
        explicitBucketBoundaries: [
          ...(histogramOptions?.explicitBucketBoundaries ??
            DEFAULT_HTTP_SERVER_REQUEST_DURATION_BUCKET_BOUNDARIES),
        ],
      },
      unprefixed: unprefixedMetricName === true,
    },
  );

  // Per-registration guard against per-request log flooding when tracing fails.
  let hookFailureLogged = false;
  const logHookFailureOnce = (hook: string, error: unknown): void => {
    if (hookFailureLogged) {
      return;
    }
    hookFailureLogged = true;
    try {
      logger.warn(
        `Tracing hook "${hook}" failed (${
          error instanceof Error ? error.message : String(error)
        }): continuing without tracing.`,
      );
    } catch {
      // A failing logger must not affect the request either.
    }
  };

  const clearRequestState = (req: FastifyRequest): void => {
    requestStates.delete(req);
    // Deprecated alias: assigning undefined avoids a V8 hidden-class
    // transition per request; the tests assert `!== undefined`.
    (req as FastifyRequestWithSpanAlias).tracerSpanApi = undefined;
  };

  interface TracedRequest {
    spanName: string;
    path: string;
    routeTemplate?: string;
    method: string;
  }

  // Returns the span identity for a request this registration would trace, or
  // `undefined` when the request is filtered out. Used both by span creation
  // and by metric adoption so that a registration records only for requests it
  // would itself trace.
  const getTracedRequest = (req: FastifyRequest): TracedRequest | undefined => {
    if (req.method === "OPTIONS") {
      return undefined;
    }
    const path = getRequestPath(req.url);
    if (
      rootApiPath !== "/" &&
      path !== rootApiPath &&
      !path.startsWith(`${rootApiPath}/`)
    ) {
      return undefined;
    }
    const routeTemplate = req.routeOptions.url;
    const method = normalizeHttpMethod(req.method);
    let spanName: string;
    if (routeTemplate) {
      spanName = sanitizeSpanName(`${method}-${routeTemplate}`);
    } else if (unmatchedRouteSpanName === "method") {
      spanName = sanitizeSpanName(method);
    } else {
      spanName = sanitizeSpanName(`${method}-${path}`);
    }
    if (
      options?.ignoreList?.includes(spanName) ||
      options?.ignoreListPrefix?.some((p) => spanName.startsWith(p)) ||
      options?.ignoreListSuffix?.some((s) => spanName.endsWith(s))
    ) {
      return undefined;
    }
    return { spanName, path, routeTemplate, method };
  };

  const endSpan = (
    req: FastifyRequest,
    end: { statusCode?: number; errorType?: string } = {},
  ): void => {
    const state = requestStates.get(req);
    if (!state) {
      return;
    }
    const { span, startTime, histogram, errorType: recordedErrorType } = state;
    const errorRecorded = recordedErrorType !== undefined;
    clearRequestState(req);
    try {
      if (end.errorType) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        span.setAttribute(ATTR_ERROR_TYPE, end.errorType);
      } else if (end.statusCode !== undefined) {
        // Status policy per the current OTel HTTP semantic conventions for
        // server spans: leave the status unset for 1xx-4xx, ERROR for 5xx.
        // A span on which onError already recorded an error is never
        // downgraded (defense in depth; onError set ERROR already).
        if (!errorRecorded && end.statusCode >= 500) {
          span.setStatus({ code: SpanStatusCode.ERROR });
          // Semconv: returned 5xx responses carry error.type. A specific value
          // recorded by onError is already set and must not be overwritten.
          span.setAttribute(ATTR_ERROR_TYPE, String(end.statusCode));
        }
        span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, end.statusCode);
      }
      if (histogram) {
        // The start time is captured with the span, so a histogram always has
        // one; the observation belongs to the registration that supplied it.
        const durationSeconds =
          Number(process.hrtime.bigint() - startTime) / 1e9;
        const attributes: Record<string, string | number> = {
          [ATTR_HTTP_REQUEST_METHOD]: normalizeHttpMethod(req.method),
          [ATTR_URL_SCHEME]: req.protocol,
          [ATTR_NETWORK_PROTOCOL_VERSION]: req.raw.httpVersion,
        };
        const routeTemplate = req.routeOptions.url;
        if (routeTemplate) {
          attributes[ATTR_HTTP_ROUTE] = routeTemplate;
        }
        if (end.errorType) {
          attributes[ATTR_ERROR_TYPE] = end.errorType;
        } else if (end.statusCode !== undefined) {
          attributes[ATTR_HTTP_RESPONSE_STATUS_CODE] = end.statusCode;
          if (end.statusCode >= 500) {
            // A specific thrown-error value wins over the status-code default.
            attributes[ATTR_ERROR_TYPE] =
              recordedErrorType ?? String(end.statusCode);
          }
        }
        histogram.record(durationSeconds, attributes);
      }
    } finally {
      span.end();
    }
  };

  fastify.addHook("onRequest", async (req: FastifyRequest) => {
    let span: Span | undefined;
    try {
      // Defense in depth for a child scope registered before its root: the
      // decorator cannot detect that ordering (decorators only flow
      // downwards), so the first hook to run owns the request's span.
      const existing = requestStates.get(req);
      if (existing) {
        // A later registration may supply the meter only when it would itself
        // trace the request; a filtering registration never records for it.
        if (
          !existing.histogram &&
          requestDurationHistogram &&
          getTracedRequest(req)
        ) {
          existing.histogram = requestDurationHistogram;
        }
        return;
      }
      const traced = getTracedRequest(req);
      if (!traced) {
        return;
      }
      const callerContext = propagator.extract(
        ROOT_CONTEXT,
        req.headers,
        defaultTextMapGetter,
      );
      // The span is created inside the extracted context so that it becomes a
      // child of the caller span when the request carries a `traceparent`.
      span = context.with(callerContext, () =>
        standardTracer.startSpan(traced.spanName, undefined, {
          kind: SpanKind.SERVER,
        }),
      );
      span.setAttribute(ATTR_HTTP_REQUEST_METHOD, traced.method);
      if (traced.method === HTTP_REQUEST_METHOD_VALUE_OTHER) {
        span.setAttribute(ATTR_HTTP_REQUEST_METHOD_ORIGINAL, req.method);
      }
      span.setAttribute(ATTR_URL_PATH, traced.path);
      span.setAttribute(ATTR_URL_SCHEME, req.protocol);
      if (req.hostname) {
        span.setAttribute(ATTR_SERVER_ADDRESS, req.hostname);
      }
      if (req.port !== null) {
        span.setAttribute(ATTR_SERVER_PORT, req.port);
      }
      span.setAttribute(ATTR_NETWORK_PROTOCOL_VERSION, req.raw.httpVersion);
      if (traced.routeTemplate) {
        span.setAttribute(ATTR_HTTP_ROUTE, traced.routeTemplate);
      }
      requestStates.set(req, {
        span,
        context: trace.setSpan(callerContext, span),
        startTime: process.hrtime.bigint(),
        histogram: requestDurationHistogram,
      });
      // Deprecated alias kept for consumers that reimplemented the accessor
      // (`req.tracerSpanApi` before 1.1.0); use OTelRequestSpan(req) instead.
      (req as FastifyRequestWithSpanAlias).tracerSpanApi = span;
    } catch (error) {
      // End a span created before the failure; the guard keeps the hook
      // fail-open even when span.end itself throws.
      try {
        span?.end();
      } catch {
        // Instrumentation must never affect the request.
      }
      // Only clear state this registration created, never another one's.
      if (span) {
        clearRequestState(req);
      }
      logHookFailureOnce("onRequest", error);
    }
  });

  fastify.addHook(
    "onResponse",
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        endSpan(req, { statusCode: reply.statusCode });
      } catch (error) {
        logHookFailureOnce("onResponse", error);
      }
    },
  );

  fastify.addHook("onError", async (req: FastifyRequest, _reply, error) => {
    try {
      const state = requestStates.get(req);
      if (!state) {
        return;
      }
      const { span } = state;
      const normalizedError =
        error instanceof Error ? error : new Error(String(error));
      const errorType = getErrorType(normalizedError);
      state.errorType = errorType;
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.setAttribute(ATTR_ERROR_TYPE, errorType);
      span.recordException(normalizedError);
      if (isClientError(normalizedError)) {
        logger.warn(normalizedError.message, span);
      } else {
        logger.error(normalizedError.message, normalizedError, span);
      }
    } catch (hookError) {
      logHookFailureOnce("onError", hookError);
    }
  });

  fastify.addHook("onRequestAbort", async (req: FastifyRequest) => {
    try {
      endSpan(req, { errorType: "client_abort" });
    } catch (error) {
      logHookFailureOnce("onRequestAbort", error);
    }
  });

  fastify.addHook("onTimeout", async (req: FastifyRequest, _reply) => {
    try {
      endSpan(req, { errorType: "timeout" });
    } catch (error) {
      logHookFailureOnce("onTimeout", error);
    }
  });
}

function normalizeRootApiPath(rootApiPath?: string): string {
  const normalized = (rootApiPath || DEFAULT_ROOT_API_PATH).replace(/\/+$/, "");
  return normalized === "" ? "/" : normalized;
}

function sanitizeSpanName(name: string): string {
  return name.replace(SPAN_NAME_SANITIZE_RE, "_");
}

/**
 * Maps the request method to its `http.request.method` semconv value: known
 * IANA methods are recorded as-is, anything else as `_OTHER` to keep the
 * attribute (and span-name) cardinality bounded.
 */
function normalizeHttpMethod(method: string): string {
  return KNOWN_HTTP_METHODS.has(method)
    ? method
    : HTTP_REQUEST_METHOD_VALUE_OTHER;
}

/**
 * Extracts the pathname from a request target. Origin-form targets
 * (`/path?query`, virtually all traffic) are split directly; absolute-form
 * targets (e.g. `GET http://host/path HTTP/1.1`, allowed by HTTP/1.1 but rare
 * in practice) are parsed with the URL parser. Unparseable targets cannot
 * reach this function: the HTTP parser rejects them before the hooks run, and
 * a residual parse failure is caught by the fail-open `onRequest` guard.
 */
function getRequestPath(url: string): string {
  if (url.startsWith("/")) {
    return url.split("?")[0];
  }
  return new URL(url, INTERNAL_URL_BASE).pathname;
}

function isClientError(error: Error): boolean {
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return typeof statusCode === "number" && statusCode < 500;
}

/**
 * Low-cardinality `error.type` value: the error name when it is not the
 * generic `Error`, otherwise its `code` (e.g. `FST_ERR_VALIDATION` for Fastify
 * validation errors), otherwise `"Error"`.
 */
function getErrorType(error: Error): string {
  if (error.name && error.name !== "Error") {
    return error.name;
  }
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && code !== "") {
    return code;
  }
  return "Error";
}

/**
 * Retrieves the OpenTelemetry span associated with a Fastify request.
 *
 * The span is created during the `onRequest` hook and stored, with the rest of
 * the per-request state, in an internal `WeakMap` keyed on the request object.
 * Returns `undefined` when no span exists (e.g., the request was skipped by
 * filtering) or once the span ended.
 *
 * Use it to parent spans created in route handlers:
 * `standardTracer.startSpan("my-work", OTelRequestSpan(req))`.
 *
 * @param req - The Fastify request object.
 * @returns The active span, or `undefined` if no span was created for this request.
 */
export function OTelRequestSpan(req: FastifyRequest): Span | undefined {
  return requestStates.get(req)?.span;
}

/**
 * Retrieves the OpenTelemetry context associated with a Fastify request.
 *
 * The context holds the incoming W3C trace context with the HTTP request span
 * set as the active span, so spans created inside
 * `context.with(OTelRequestContext(req), () => ...)` become children of the
 * HTTP span. Returns `undefined` when no span was created (skipped request)
 * or once the span ended.
 *
 * @param req - The Fastify request object.
 * @returns The request context, or `undefined` if no span was created for this request.
 */
export function OTelRequestContext(req: FastifyRequest): Context | undefined {
  return requestStates.get(req)?.context;
}
