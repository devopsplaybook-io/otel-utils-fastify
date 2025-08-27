import { StandardLogger, StandardTracer } from "@devopsplaybook.io/otel-utils";
import {
  defaultTextMapGetter,
  ROOT_CONTEXT,
  SpanStatusCode,
} from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { api } from "@opentelemetry/sdk-node";
import { Span } from "@opentelemetry/sdk-trace-base";
import {
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_URL_PATH,
} from "@opentelemetry/semantic-conventions";
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

const propagator = new W3CTraceContextPropagator();

export function StandardTracerFastifyRegisterHooks(
  fastify: FastifyInstance,
  standardTracer: StandardTracer,
  standardLogger: StandardLogger,
  options?: StandardTracerFastifyRegisterHooksOptions
): void {
  const logger = standardLogger.createModuleLogger("Fastify");

  fastify.addHook("onRequest", async (req: FastifyRequest) => {
    if (!req.url.startsWith(options?.rootApiPath || "/api")) {
      return;
    }

    const spanName = `${req.method}-${req.url}`;
    const urlName = req.url;
    const callerContext = propagator.extract(
      ROOT_CONTEXT,
      req.headers,
      defaultTextMapGetter
    );
    api.context.with(callerContext, () => {
      const span = standardTracer.startSpan(spanName);
      span.setAttribute(ATTR_HTTP_REQUEST_METHOD, req.method);
      span.setAttribute(ATTR_URL_PATH, urlName);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (req as any).tracerSpanApi = span;
    });
  });

  fastify.addHook(
    "onResponse",
    async (req: FastifyRequest, reply: FastifyReply) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const span = (req as any).tracerSpanApi as Span;
      if (reply.statusCode > 299) {
        span.status.code = SpanStatusCode.ERROR;
      } else {
        span.status.code = SpanStatusCode.OK;
      }
      span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, reply.statusCode);
      span.end();
    }
  );

  fastify.addHook(
    "onError",
    async (req: FastifyRequest, reply: FastifyReply, error) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const span = (req as any).tracerSpanApi as Span;
      span.status.code = SpanStatusCode.ERROR;
      span.recordException(error);
      logger.error(error);
    }
  );
}

export interface StandardTracerFastifyRegisterHooksOptions {
  rootApiPath?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function OTelRequestSpan(req: any): Span {
  return req.tracerSpanApi;
}
