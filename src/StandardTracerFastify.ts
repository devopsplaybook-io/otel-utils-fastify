import { StandardLogger, StandardTracer } from "@devopsplaybook.io/otel-utils";
import {
  context,
  defaultTextMapGetter,
  ROOT_CONTEXT,
  SpanStatusCode,
} from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { Span } from "@opentelemetry/sdk-trace-base";
import {
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_URL_PATH,
} from "@opentelemetry/semantic-conventions";
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

const propagator = new W3CTraceContextPropagator();
const requestSpans = new WeakMap<FastifyRequest, Span>();

/**
 * Options for {@link StandardTracerFastifyRegisterHooks}.
 */
export interface StandardTracerFastifyRegisterHooksOptions {
  /**
   * Root path prefix for API routes.
   * Only requests starting with this path will be traced. Default `"/api"`.
   */
  rootApiPath?: string;
  /**
   * Span names to skip by exact match (e.g. `"GET-/api/health"`).
   * Checked first — O(1) per entry via hash-optimized string compare.
   * Format: `"METHOD-/path"` — the same format used for span names.
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
 * - Records HTTP method, URL path, and response status code as span attributes.
 * - Marks spans as ERROR on 4xx/5xx responses or when exceptions occur.
 * - Logs errors via the provided {@link StandardLogger} with trace context.
 * - Skips OPTIONS requests and requests outside the configured `rootApiPath`.
 * - Additional filtering via `ignoreList` (exact), `ignoreListPrefix`, `ignoreListSuffix`
 *   — checked in that order with short-circuit evaluation for maximum performance.
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

  fastify.addHook("onRequest", async (req: FastifyRequest) => {
    if (
      req.method === "OPTIONS" ||
      !req.url.startsWith(options?.rootApiPath || "/api")
    ) {
      return;
    }
    const spanName = `${req.method}-${req.url.split("?")[0]}`;
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
    context.with(callerContext, () => {
      const span = standardTracer.startSpan(spanName);
      span.setAttribute(ATTR_HTTP_REQUEST_METHOD, req.method);
      span.setAttribute(ATTR_URL_PATH, req.url);
      requestSpans.set(req, span);
    });
  });

  fastify.addHook(
    "onResponse",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const span = requestSpans.get(req);
      if (!span) {
        return;
      }
      span.setStatus({
        code: reply.statusCode > 299 ? SpanStatusCode.ERROR : SpanStatusCode.OK,
      });
      span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, reply.statusCode);
      span.end();
      requestSpans.delete(req);
    },
  );

  fastify.addHook(
    "onError",
    async (req: FastifyRequest, _reply: FastifyReply, error: Error) => {
      const span = requestSpans.get(req);
      if (!span) {
        return;
      }
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.recordException(error);
      logger.error(error.message, error, span);
    },
  );
}

/**
 * Retrieves the OpenTelemetry span associated with a Fastify request.
 *
 * The span is created during the `onRequest` hook and stored in an internal
 * `WeakMap` keyed on the request object. Returns `undefined` when no span
 * exists (e.g., the request was skipped by filtering).
 *
 * @param req - The Fastify request object.
 * @returns The active span, or `undefined` if no span was created for this request.
 */
export function OTelRequestSpan(req: FastifyRequest): Span | undefined {
  return requestSpans.get(req);
}
