import {
  StandardLogger,
  StandardMeter,
  StandardTracer,
} from "@devopsplaybook.io/otel-utils";
import {
  Context,
  context,
  defaultTextMapGetter,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { Span } from "@opentelemetry/sdk-trace-base";
import {
  ATTR_ERROR_TYPE,
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_HTTP_ROUTE,
  ATTR_URL_PATH,
  METRIC_HTTP_SERVER_REQUEST_DURATION,
} from "@opentelemetry/semantic-conventions";
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

const propagator = new W3CTraceContextPropagator();
// Same sanitization as @devopsplaybook.io/otel-utils, applied here so that
// `ignoreList` entries are matched against the exported span name.
const SPAN_NAME_SANITIZE_RE = /[^a-zA-Z0-9-_/]/g;
const DEFAULT_ROOT_API_PATH = "/api";
const INTERNAL_URL_BASE = "http://internal";

const requestSpans = new WeakMap<FastifyRequest, Span>();
const requestContexts = new WeakMap<FastifyRequest, Context>();
const requestStartTimes = new WeakMap<FastifyRequest, bigint>();
const requestsWithRecordedErrors = new WeakSet<FastifyRequest>();
const registeredFastifyInstances = new WeakSet<FastifyInstance>();

type FastifyRequestWithSpanAlias = FastifyRequest & { tracerSpanApi?: Span };

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
   * `"GET-/api/files/_id"` for `/api/files/:id`).
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
   *   `ignoreListSuffix` then match `"GET"` for unmatched requests.
   *
   * The full request path is always kept in the `url.path` attribute.
   * Matched routes are unaffected.
   */
  unmatchedRouteSpanName?: "path" | "method";
  /**
   * Optional {@link StandardMeter} used to record the
   * `http.server.request.duration` histogram (in seconds) for traced requests.
   * Recorded attributes: `http.request.method`, `http.route` (only when a
   * route matched) and `http.response.status_code` — or `error.type` instead
   * of a status code for aborted/timed-out requests. Note that
   * {@link StandardMeter} prefixes the metric name with the service id, so it
   * is exported as `<SERVICE_ID>.http.server.request.duration`.
   * When omitted, no metrics are recorded.
   */
  standardMeter?: StandardMeter;
}

/**
 * Registers Fastify lifecycle hooks that automatically create and manage
 * OpenTelemetry spans for each matching API request.
 *
 * - Extracts incoming W3C trace context from request headers for distributed tracing.
 * - Creates a `SpanKind.SERVER` span named `METHOD-<route>` (route template for
 *   matched routes, e.g. `GET-/api/files/_id` for `/api/files/:id`; path or
 *   method fallback when no route matched, see `unmatchedRouteSpanName`), with
 *   `http.request.method`, `url.path` (path only, no query string) and
 *   `http.route` (route template) attributes.
 * - Sets the span status according to the current HTTP semantic conventions for
 *   server spans: unset for 1xx-4xx responses, ERROR for 5xx responses and
 *   exceptions. A span that already recorded an error is never downgraded.
 * - Ends the span on response, handler error, client abort or connection timeout.
 * - Logs errors via the provided {@link StandardLogger} with trace context;
 *   client errors (`statusCode < 500`) are logged at warn level.
 * - Tracing is fail-open: a fault in any hook is caught, logged once at warn
 *   level and the request continues untraced.
 * - Skips OPTIONS requests and requests outside the configured `rootApiPath`.
 * - Additional filtering via `ignoreList` (exact), `ignoreListPrefix`, `ignoreListSuffix`
 *   — checked in that order with short-circuit evaluation.
 *
 * Register the hooks **once**, at the root of the Fastify instance: a second
 * registration on the same instance is ignored (with a warning), and hooks
 * registered inside an encapsulated plugin only see the requests routed
 * through that plugin scope.
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

  if (registeredFastifyInstances.has(fastify)) {
    logger.warn(
      "StandardTracerFastifyRegisterHooks is already registered on this Fastify instance: ignoring the duplicate registration.",
    );
    return;
  }
  registeredFastifyInstances.add(fastify);

  const rootApiPath = normalizeRootApiPath(options?.rootApiPath);
  const unmatchedRouteSpanName = options?.unmatchedRouteSpanName ?? "path";
  const requestDurationHistogram = options?.standardMeter?.createHistogram(
    METRIC_HTTP_SERVER_REQUEST_DURATION,
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
    requestSpans.delete(req);
    requestContexts.delete(req);
    requestStartTimes.delete(req);
    requestsWithRecordedErrors.delete(req);
    // Deprecated alias: assigning undefined avoids a V8 hidden-class
    // transition per request; the tests assert `!== undefined`.
    (req as FastifyRequestWithSpanAlias).tracerSpanApi = undefined;
  };

  const endSpan = (
    req: FastifyRequest,
    end: { statusCode?: number; errorType?: string } = {},
  ): void => {
    const span = requestSpans.get(req);
    if (!span) {
      return;
    }
    const errorRecorded = requestsWithRecordedErrors.has(req);
    const startTime = requestStartTimes.get(req);
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
        }
        span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, end.statusCode);
      }
      if (requestDurationHistogram) {
        // The start time is always set in onRequest when the histogram is
        // configured (same guard), so the lookup cannot miss here.
        const durationSeconds =
          Number(process.hrtime.bigint() - (startTime as bigint)) / 1e9;
        const attributes: Record<string, string | number> = {
          [ATTR_HTTP_REQUEST_METHOD]: req.method,
        };
        const routeTemplate = req.routeOptions.url;
        if (routeTemplate) {
          attributes[ATTR_HTTP_ROUTE] = routeTemplate;
        }
        if (end.errorType) {
          attributes[ATTR_ERROR_TYPE] = end.errorType;
        } else if (end.statusCode !== undefined) {
          attributes[ATTR_HTTP_RESPONSE_STATUS_CODE] = end.statusCode;
        }
        requestDurationHistogram.record(durationSeconds, attributes);
      }
    } finally {
      span.end();
    }
  };

  fastify.addHook("onRequest", async (req: FastifyRequest) => {
    try {
      if (req.method === "OPTIONS") {
        return;
      }
      const path = getRequestPath(req.url);
      if (
        rootApiPath !== "/" &&
        path !== rootApiPath &&
        !path.startsWith(`${rootApiPath}/`)
      ) {
        return;
      }
      const routeTemplate = req.routeOptions.url;
      let spanName: string;
      if (routeTemplate) {
        spanName = sanitizeSpanName(`${req.method}-${routeTemplate}`);
      } else if (unmatchedRouteSpanName === "method") {
        spanName = sanitizeSpanName(req.method);
      } else {
        spanName = sanitizeSpanName(`${req.method}-${path}`);
      }
      if (
        options?.ignoreList?.includes(spanName) ||
        options?.ignoreListPrefix?.some((p) => spanName.startsWith(p)) ||
        options?.ignoreListSuffix?.some((s) => spanName.endsWith(s))
      ) {
        return;
      }
      const callerContext = propagator.extract(
        ROOT_CONTEXT,
        req.headers,
        defaultTextMapGetter,
      );
      // The span is created inside the extracted context so that it becomes a
      // child of the caller span when the request carries a `traceparent`.
      const span = context.with(callerContext, () =>
        standardTracer.startSpan(spanName, undefined, {
          kind: SpanKind.SERVER,
        }),
      );
      span.setAttribute(ATTR_HTTP_REQUEST_METHOD, req.method);
      span.setAttribute(ATTR_URL_PATH, path);
      if (routeTemplate) {
        span.setAttribute(ATTR_HTTP_ROUTE, routeTemplate);
      }
      requestSpans.set(req, span);
      requestContexts.set(req, trace.setSpan(callerContext, span));
      if (requestDurationHistogram) {
        requestStartTimes.set(req, process.hrtime.bigint());
      }
      // Deprecated alias kept for consumers that reimplemented the accessor
      // (`req.tracerSpanApi` before 1.1.0); use OTelRequestSpan(req) instead.
      (req as FastifyRequestWithSpanAlias).tracerSpanApi = span;
    } catch (error) {
      clearRequestState(req);
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
      const span = requestSpans.get(req);
      if (!span) {
        return;
      }
      requestsWithRecordedErrors.add(req);
      const normalizedError =
        error instanceof Error ? error : new Error(String(error));
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.setAttribute(ATTR_ERROR_TYPE, getErrorType(normalizedError));
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
 * The span is created during the `onRequest` hook and stored in an internal
 * `WeakMap` keyed on the request object. Returns `undefined` when no span
 * exists (e.g., the request was skipped by filtering) or once the span ended.
 *
 * Use it to parent spans created in route handlers:
 * `standardTracer.startSpan("my-work", OTelRequestSpan(req))`.
 *
 * @param req - The Fastify request object.
 * @returns The active span, or `undefined` if no span was created for this request.
 */
export function OTelRequestSpan(req: FastifyRequest): Span | undefined {
  return requestSpans.get(req);
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
  return requestContexts.get(req);
}
