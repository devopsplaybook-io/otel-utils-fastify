import { StandardLogger, StandardTracer } from "@devopsplaybook.io/otel-utils";
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
} from "@opentelemetry/semantic-conventions";
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

const propagator = new W3CTraceContextPropagator();
// Same sanitization as @devopsplaybook.io/otel-utils, applied here so that
// `ignoreList` entries are matched against the exported span name.
const SPAN_NAME_SANITIZE_RE = /[^a-zA-Z0-9-_/]/g;
const DEFAULT_ROOT_API_PATH = "/api";

const requestSpans = new WeakMap<FastifyRequest, Span>();
const requestContexts = new WeakMap<FastifyRequest, Context>();
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
}

/**
 * Registers Fastify lifecycle hooks that automatically create and manage
 * OpenTelemetry spans for each matching API request.
 *
 * - Extracts incoming W3C trace context from request headers for distributed tracing.
 * - Creates a `SpanKind.SERVER` span named `METHOD-<route>` (route template for
 *   matched routes, e.g. `GET-/api/files/_id` for `/api/files/:id`; path
 *   fallback when no route matched), with `http.request.method`, `url.path`
 *   (path only, no query string) and `http.route` (route template) attributes.
 * - Marks spans as ERROR on 4xx/5xx responses or when exceptions occur.
 * - Ends the span on response, handler error, client abort or connection timeout.
 * - Logs errors via the provided {@link StandardLogger} with trace context.
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

  const endSpan = (
    req: FastifyRequest,
    end: { statusCode?: number; errorType?: string } = {},
  ): void => {
    const span = requestSpans.get(req);
    if (!span) {
      return;
    }
    requestSpans.delete(req);
    requestContexts.delete(req);
    delete (req as FastifyRequestWithSpanAlias).tracerSpanApi;
    if (end.errorType) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.setAttribute(ATTR_ERROR_TYPE, end.errorType);
    } else if (end.statusCode !== undefined) {
      span.setStatus({
        code: end.statusCode > 299 ? SpanStatusCode.ERROR : SpanStatusCode.OK,
      });
      span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, end.statusCode);
    }
    span.end();
  };

  fastify.addHook("onRequest", async (req: FastifyRequest) => {
    if (req.method === "OPTIONS") {
      return;
    }
    const path = req.url.split("?")[0];
    if (
      rootApiPath !== "/" &&
      path !== rootApiPath &&
      !path.startsWith(`${rootApiPath}/`)
    ) {
      return;
    }
    const routeTemplate = req.routeOptions.url;
    const spanName = sanitizeSpanName(`${req.method}-${routeTemplate || path}`);
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
    // Deprecated alias kept for consumers that reimplemented the accessor
    // (`req.tracerSpanApi` before 1.1.0); use OTelRequestSpan(req) instead.
    (req as FastifyRequestWithSpanAlias).tracerSpanApi = span;
  });

  fastify.addHook(
    "onResponse",
    async (req: FastifyRequest, reply: FastifyReply) => {
      endSpan(req, { statusCode: reply.statusCode });
    },
  );

  fastify.addHook("onError", async (req: FastifyRequest, _reply, error) => {
    const span = requestSpans.get(req);
    if (!span) {
      return;
    }
    const normalizedError =
      error instanceof Error ? error : new Error(String(error));
    span.setStatus({ code: SpanStatusCode.ERROR });
    span.setAttribute(ATTR_ERROR_TYPE, normalizedError.name);
    span.recordException(normalizedError);
    logger.error(normalizedError.message, normalizedError, span);
  });

  fastify.addHook("onRequestAbort", async (req: FastifyRequest) => {
    endSpan(req, { errorType: "client_abort" });
  });

  fastify.addHook("onTimeout", async (req: FastifyRequest, _reply) => {
    endSpan(req, { errorType: "timeout" });
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
