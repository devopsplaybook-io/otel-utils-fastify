import Fastify, { FastifyInstance } from "fastify";
import http from "node:http";
import { AddressInfo } from "node:net";
import {
  context as otelContext,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  Span,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import type {
  StandardLogger,
  StandardTracer,
} from "@devopsplaybook.io/otel-utils";
import {
  StandardTracerFastifyRegisterHooks,
  OTelRequestContext,
  OTelRequestSpan,
} from "./StandardTracerFastify";

// ---------------------------------------------------------------------------
// Real SDK setup
// ---------------------------------------------------------------------------

const CALLER_TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
const CALLER_SPAN_ID = "b7ad6b7169203331";
const TRACEPARENT = `00-${CALLER_TRACE_ID}-${CALLER_SPAN_ID}-01`;

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});
// Registers the global tracer provider and an AsyncLocalStorageContextManager,
// so `context.with(...)` and the parent resolution below behave as in production.
provider.register();
const sdkTracer = provider.getTracer("otel-utils-fastify-integration");

/**
 * Duck-type of `StandardTracer` on top of a real SDK tracer.
 *
 * The integration tests need the exported spans in memory, but the real
 * `StandardTracer` builds its own provider and exporter (making an
 * `InMemorySpanExporter` impossible to inject); its own semantics are covered
 * by the `otel-utils` test suite. The hooks only rely on the
 * `startSpan(name, parentSpan?, options?)` contract, mirrored here.
 */
const testTracer = {
  startSpan: (
    name: string,
    parentSpan?: Span,
    options?: { kind?: SpanKind },
  ): Span => {
    const parentContext = parentSpan
      ? trace.setSpan(otelContext.active(), parentSpan)
      : otelContext.active();
    return sdkTracer.startSpan(name, options, parentContext) as unknown as Span;
  },
};

const testLogger = {
  createModuleLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
};

function registerHooks(app: FastifyInstance): void {
  StandardTracerFastifyRegisterHooks(
    app,
    testTracer as unknown as StandardTracer,
    testLogger as unknown as StandardLogger,
  );
}

async function waitFor(assertion: () => void, timeoutMs = 3000) {
  const start = Date.now();
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() - start > timeoutMs) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

async function listen(app: FastifyInstance): Promise<number> {
  await app.listen({ host: "127.0.0.1", port: 0 });
  return (app.server.address() as AddressInfo).port;
}

beforeEach(() => {
  exporter.reset();
});

afterAll(async () => {
  await provider.shutdown();
});

// ---------------------------------------------------------------------------
// Request span correlation (H1)
// ---------------------------------------------------------------------------

describe("request span correlation", () => {
  function buildApp() {
    const app = Fastify();
    registerHooks(app);
    app.get("/api/files/:id", async (req, res) => {
      const requestContext = OTelRequestContext(req);
      if (requestContext) {
        otelContext.with(requestContext, () => {
          testTracer.startSpan("handler-child-context").end();
        });
      }
      testTracer
        .startSpan("handler-child-explicit", OTelRequestSpan(req))
        .end();
      return res.send({ ok: true });
    });
    return app;
  }

  test("a handler span is a child of the HTTP span without an incoming traceparent", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/api/files/123" });
    expect(res.statusCode).toBe(200);

    const spans = exporter.getFinishedSpans();
    const httpSpan = spans.find((s) => s.name === "GET-/api/files/_id");
    expect(httpSpan).toBeDefined();
    expect(httpSpan!.kind).toBe(SpanKind.SERVER);
    expect(httpSpan!.attributes["http.request.method"]).toBe("GET");
    expect(httpSpan!.attributes["url.path"]).toBe("/api/files/123");
    expect(httpSpan!.attributes["http.route"]).toBe("/api/files/:id");
    expect(httpSpan!.attributes["http.response.status_code"]).toBe(200);
    expect(httpSpan!.status.code).toBe(SpanStatusCode.OK);
    expect(httpSpan!.parentSpanContext).toBeUndefined();

    const contextChild = spans.find((s) => s.name === "handler-child-context");
    const explicitChild = spans.find(
      (s) => s.name === "handler-child-explicit",
    );
    expect(contextChild).toBeDefined();
    expect(explicitChild).toBeDefined();
    for (const child of [contextChild!, explicitChild!]) {
      expect(child.spanContext().traceId).toBe(httpSpan!.spanContext().traceId);
      expect(child.parentSpanContext?.spanId).toBe(
        httpSpan!.spanContext().spanId,
      );
    }
  });

  test("the HTTP span joins the caller trace and parents handler spans when a traceparent is sent", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/files/42",
      headers: { traceparent: TRACEPARENT },
    });
    expect(res.statusCode).toBe(200);

    const spans = exporter.getFinishedSpans();
    const httpSpan = spans.find((s) => s.name === "GET-/api/files/_id");
    expect(httpSpan).toBeDefined();
    expect(httpSpan!.spanContext().traceId).toBe(CALLER_TRACE_ID);
    expect(httpSpan!.parentSpanContext?.spanId).toBe(CALLER_SPAN_ID);
    expect(httpSpan!.kind).toBe(SpanKind.SERVER);

    const contextChild = spans.find((s) => s.name === "handler-child-context");
    const explicitChild = spans.find(
      (s) => s.name === "handler-child-explicit",
    );
    for (const child of [contextChild!, explicitChild!]) {
      expect(child.spanContext().traceId).toBe(CALLER_TRACE_ID);
      expect(child.parentSpanContext?.spanId).toBe(
        httpSpan!.spanContext().spanId,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Span ending on abort and timeout (M1, real sockets)
// ---------------------------------------------------------------------------

describe("span ending on abort and timeout", () => {
  test("a client abort ends the HTTP span with ERROR", async () => {
    const app = Fastify();
    registerHooks(app);
    app.get("/api/hang", async () => new Promise(() => {}));
    const port = await listen(app);
    try {
      await new Promise<void>((resolve) => {
        const req = http.get(
          { host: "127.0.0.1", port, path: "/api/hang" },
          () => resolve(),
        );
        req.on("error", () => resolve());
        setTimeout(() => {
          req.destroy();
          resolve();
        }, 100);
      });

      await waitFor(() => {
        expect(exporter.getFinishedSpans().length).toBe(1);
      });
      const [span] = exporter.getFinishedSpans();
      expect(span.name).toBe("GET-/api/hang");
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.attributes["error.type"]).toBe("client_abort");
    } finally {
      await app.close();
    }
  });

  test("a connection timeout ends the HTTP span with ERROR", async () => {
    const app = Fastify({ connectionTimeout: 150 });
    registerHooks(app);
    app.get("/api/hang", async () => new Promise(() => {}));
    const port = await listen(app);
    try {
      const client = http.get({ host: "127.0.0.1", port, path: "/api/hang" });
      client.on("error", () => {});

      await waitFor(() => {
        expect(exporter.getFinishedSpans().length).toBe(1);
      });
      const [span] = exporter.getFinishedSpans();
      expect(span.name).toBe("GET-/api/hang");
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.attributes["error.type"]).toBe("timeout");
      client.destroy();
    } finally {
      await app.close();
    }
  });
});
