import Fastify, { FastifyInstance } from "fastify";
import http from "node:http";
import { AddressInfo } from "node:net";
import {
  context as otelContext,
  type MetricOptions,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import {
  AggregationTemporality,
  type DataPoint,
  DataPointType,
  type Histogram,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type Span,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import type {
  StandardLogger,
  StandardMeter,
  StandardTracer,
} from "@devopsplaybook.io/otel-utils";
import {
  StandardTracerFastifyRegisterHooks,
  StandardTracerFastifyRegisterHooksOptions,
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
const provider = new TracerProvider({
  spanProcessors: [new SimpleSpanProcessor({ exporter })],
});
// OTel v3 removed register(): install the global tracer provider and an
// AsyncLocalStorageContextManager explicitly, so `context.with(...)` and the
// parent resolution below behave as in production.
trace.setGlobalTracerProvider(provider);
otelContext.setGlobalContextManager(
  new AsyncLocalStorageContextManager().enable(),
);
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

function registerHooks(
  app: FastifyInstance,
  options?: StandardTracerFastifyRegisterHooksOptions,
  logger: StandardLogger = testLogger as unknown as StandardLogger,
): void {
  StandardTracerFastifyRegisterHooks(
    app,
    testTracer as unknown as StandardTracer,
    logger,
    options,
  );
}

function createRecordingLogger() {
  const warnings: string[] = [];
  const logger = {
    createModuleLogger: () => ({
      info: () => {},
      warn: (message: string) => {
        warnings.push(message);
      },
      error: () => {},
    }),
  };
  return { logger: logger as unknown as StandardLogger, warnings };
}

function createRecordingMeter() {
  const observations: Array<{
    value: number;
    attributes: Record<string, unknown>;
  }> = [];
  const meter = {
    createHistogram: () => ({
      record: (value: number, attributes: Record<string, unknown>) => {
        observations.push({ value, attributes });
      },
    }),
  };
  return { meter: meter as unknown as StandardMeter, observations };
}

const TEST_SERVICE_NAME = "otel-utils-fastify-test";

const SEMCONV_BOUNDARIES = [
  0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10,
];

/**
 * Mirrors `StandardMeter` 1.9.1 name prefixing on top of a real SDK
 * `MeterProvider`, so the exported histogram metadata and buckets can be
 * asserted without a collector.
 */
function createSdkMeterHarness(serviceName = TEST_SERVICE_NAME) {
  const exporter = new InMemoryMetricExporter(
    AggregationTemporality.CUMULATIVE,
  );
  const reader = new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: 60_000,
  });
  const provider = new MeterProvider({ readers: [reader] });
  const sdkMeter = provider.getMeter(`${serviceName}:test`);
  const meter = {
    createHistogram: (
      name: string,
      options?: MetricOptions & { unprefixed?: boolean },
    ) => {
      const { unprefixed, ...instrumentOptions } = options ?? {};
      return sdkMeter.createHistogram(
        unprefixed ? name : `${serviceName}.${name}`,
        instrumentOptions,
      );
    },
  } as unknown as StandardMeter;

  const collect = async () => {
    await provider.forceFlush();
    const exported = exporter.getMetrics();
    return exported[exported.length - 1].scopeMetrics.flatMap(
      (scopeMetrics) => scopeMetrics.metrics,
    );
  };

  return { meter, collect, shutdown: () => provider.shutdown() };
}

function nonzeroBucket(point: DataPoint<Histogram>): number {
  return point.value.buckets.counts.findIndex((count) => count > 0);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    // Span status is left unset for 1xx-4xx per the HTTP semantic conventions.
    expect(httpSpan!.status.code).toBe(SpanStatusCode.UNSET);
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
// Error handling (A1)
// ---------------------------------------------------------------------------

describe("error handling", () => {
  test("keeps the error disposition when a custom error handler answers 2xx", async () => {
    const app = Fastify();
    registerHooks(app);
    app.get("/api/swallow", async () => {
      throw new Error("swallowed failure");
    });
    app.setErrorHandler((_error, _req, reply) => {
      reply.status(200).send({ swallowed: true });
    });

    const res = await app.inject({ method: "GET", url: "/api/swallow" });
    expect(res.statusCode).toBe(200);

    const spans = exporter.getFinishedSpans();
    const span = spans.find((s) => s.name === "GET-/api/swallow");
    expect(span).toBeDefined();
    expect(span!.status.code).toBe(SpanStatusCode.ERROR);
    expect(span!.attributes["error.type"]).toBe("Error");
    expect(span!.attributes["http.response.status_code"]).toBe(200);
    expect(span!.events.some((event) => event.name === "exception")).toBe(true);
  });

  test("leaves the span status unset on a 4xx response", async () => {
    const app = Fastify();
    registerHooks(app);
    app.get("/api/teapot", async (_req, reply) =>
      reply.status(418).send({ error: "teapot" }),
    );

    const res = await app.inject({ method: "GET", url: "/api/teapot" });
    expect(res.statusCode).toBe(418);

    const spans = exporter.getFinishedSpans();
    const span = spans.find((s) => s.name === "GET-/api/teapot");
    expect(span).toBeDefined();
    expect(span!.status.code).toBe(SpanStatusCode.UNSET);
    expect(span!.attributes["http.response.status_code"]).toBe(418);
    expect(span!.attributes["error.type"]).toBeUndefined();
  });

  test("records error.type on a returned 5xx response", async () => {
    const { meter, observations } = createRecordingMeter();
    const app = Fastify();
    registerHooks(app, { standardMeter: meter });
    app.get("/api/server-error", async (_req, reply) =>
      reply.status(500).send({ error: "boom" }),
    );

    const res = await app.inject({ method: "GET", url: "/api/server-error" });
    expect(res.statusCode).toBe(500);

    const span = exporter
      .getFinishedSpans()
      .find((s) => s.name === "GET-/api/server-error");
    expect(span).toBeDefined();
    expect(span!.status.code).toBe(SpanStatusCode.ERROR);
    expect(span!.attributes["http.response.status_code"]).toBe(500);
    expect(span!.attributes["error.type"]).toBe("500");
    expect(observations).toHaveLength(1);
    expect(observations[0].attributes["error.type"]).toBe("500");
    expect(observations[0].attributes["http.response.status_code"]).toBe(500);
  });

  test("keeps the specific error.type on a thrown 5xx response", async () => {
    const { meter, observations } = createRecordingMeter();
    const app = Fastify();
    registerHooks(app, { standardMeter: meter });
    app.get("/api/boom", async () => {
      throw new Error("boom");
    });

    const res = await app.inject({ method: "GET", url: "/api/boom" });
    expect(res.statusCode).toBe(500);

    const span = exporter
      .getFinishedSpans()
      .find((s) => s.name === "GET-/api/boom");
    expect(span).toBeDefined();
    expect(span!.status.code).toBe(SpanStatusCode.ERROR);
    expect(span!.attributes["error.type"]).toBe("Error");
    expect(observations).toHaveLength(1);
    expect(observations[0].attributes["error.type"]).toBe("Error");
  });
});

// ---------------------------------------------------------------------------
// HTTP server span attributes (M2, L4)
// ---------------------------------------------------------------------------

describe("HTTP server span attributes", () => {
  test("records url.scheme, server.address, server.port and network.protocol.version", async () => {
    const app = Fastify();
    registerHooks(app);
    app.get("/api/files/:id", async () => ({ ok: true }));

    const res = await app.inject({ method: "GET", url: "/api/files/1" });
    expect(res.statusCode).toBe(200);

    const span = exporter
      .getFinishedSpans()
      .find((s) => s.name === "GET-/api/files/_id");
    expect(span).toBeDefined();
    expect(span!.attributes["url.scheme"]).toBe("http");
    expect(span!.attributes["server.address"]).toBe("localhost");
    expect(span!.attributes["server.port"]).toBe(80);
    expect(span!.attributes["network.protocol.version"]).toBe("1.1");
  });

  test("honours trustProxy for url.scheme, server.address and server.port", async () => {
    const app = Fastify({ trustProxy: true });
    registerHooks(app);
    app.get("/api/test", async () => ({ ok: true }));

    const res = await app.inject({
      method: "GET",
      url: "/api/test",
      headers: {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "api.example.com:8443",
      },
    });
    expect(res.statusCode).toBe(200);

    const span = exporter
      .getFinishedSpans()
      .find((s) => s.name === "GET-/api/test");
    expect(span).toBeDefined();
    expect(span!.attributes["url.scheme"]).toBe("https");
    expect(span!.attributes["server.address"]).toBe("api.example.com");
    expect(span!.attributes["server.port"]).toBe(8443);
  });

  test("normalizes an unknown method to _OTHER in the span name and attributes", async () => {
    const app = Fastify();
    registerHooks(app);
    app.get("/api/files/:id", async () => ({ ok: true }));

    const res = await app.inject({
      // PROPFIND is a valid IANA method outside Fastify's HTTPMethods union.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      method: "PROPFIND" as any,
      url: "/api/files/123",
    });
    expect(res.statusCode).toBe(404);

    const span = exporter
      .getFinishedSpans()
      .find((s) => s.name === "_OTHER-/api/files/123");
    expect(span).toBeDefined();
    expect(span!.attributes["http.request.method"]).toBe("_OTHER");
    expect(span!.attributes["http.request.method_original"]).toBe("PROPFIND");
    // The verbatim method must never leak into the span name.
    expect(
      exporter.getFinishedSpans().some((s) => s.name.includes("PROPFIND")),
    ).toBe(false);
  });

  test("uses verbatim semconv span names for matched routes", async () => {
    const app = Fastify();
    registerHooks(app, { spanNameFormat: "semconv" });
    app.get("/api/files/:id", async () => ({ ok: true }));

    const res = await app.inject({ method: "GET", url: "/api/files/123" });
    expect(res.statusCode).toBe(200);

    const span = exporter
      .getFinishedSpans()
      .find((s) => s.name === "GET /api/files/:id");
    expect(span).toBeDefined();
    expect(span!.attributes["http.route"]).toBe("/api/files/:id");
    expect(span!.attributes["url.path"]).toBe("/api/files/123");
    expect(span!.attributes["http.request.method"]).toBe("GET");
  });

  test("strips IPv6 brackets from server.address", async () => {
    const app = Fastify();
    registerHooks(app);
    app.get("/api/test", async () => ({ ok: true }));

    const res = await app.inject({
      method: "GET",
      url: "/api/test",
      headers: { host: "[::1]:8080" },
    });
    expect(res.statusCode).toBe(200);

    const span = exporter
      .getFinishedSpans()
      .find((s) => s.name === "GET-/api/test");
    expect(span).toBeDefined();
    expect(span!.attributes["server.address"]).toBe("::1");
    expect(span!.attributes["server.port"]).toBe(8080);
  });

  test("records QUERY as a known method", async () => {
    const app = Fastify();
    registerHooks(app);
    app.route({
      method: "QUERY",
      url: "/api/query/:id",
      handler: async () => ({ ok: true }),
    });

    const res = await app.inject({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      method: "QUERY" as any,
      url: "/api/query/7",
      payload: "{}",
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(200);

    const span = exporter
      .getFinishedSpans()
      .find((s) => s.name === "QUERY-/api/query/_id");
    expect(span).toBeDefined();
    expect(span!.attributes["http.request.method"]).toBe("QUERY");
    expect(span!.attributes["http.request.method_original"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Span ending on abort and timeout (M1, real sockets)
// ---------------------------------------------------------------------------

describe("span ending on abort and timeout", () => {
  test("a client abort ends the HTTP span with ERROR", async () => {
    const { meter, observations } = createRecordingMeter();
    const app = Fastify();
    registerHooks(app, { standardMeter: meter });
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
      expect(observations).toHaveLength(1);
      expect(observations[0].attributes["error.type"]).toBe("client_abort");
    } finally {
      await app.close();
    }
  });

  test("a connection timeout ends the HTTP span with ERROR", async () => {
    const { meter, observations } = createRecordingMeter();
    const app = Fastify({ connectionTimeout: 150 });
    registerHooks(app, { standardMeter: meter });
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
      expect(observations).toHaveLength(1);
      expect(observations[0].attributes["error.type"]).toBe("timeout");
      client.destroy();
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Encapsulated duplicate registration (M3)
// ---------------------------------------------------------------------------

describe("encapsulated duplicate registration", () => {
  test("instruments a request once when the hooks are also registered on a child instance", async () => {
    const startedSpanNames: string[] = [];
    const countingTracer = {
      startSpan: (
        name: string,
        parentSpan?: Span,
        options?: { kind?: SpanKind },
      ): Span => {
        startedSpanNames.push(name);
        return testTracer.startSpan(name, parentSpan, options);
      },
    };

    const app = Fastify();
    StandardTracerFastifyRegisterHooks(
      app,
      countingTracer as unknown as StandardTracer,
      testLogger as unknown as StandardLogger,
    );
    app.register(async (child) => {
      StandardTracerFastifyRegisterHooks(
        child,
        countingTracer as unknown as StandardTracer,
        testLogger as unknown as StandardLogger,
      );
      child.get("/api/child", async () => ({ ok: true }));
    });

    const res = await app.inject({ method: "GET", url: "/api/child" });
    expect(res.statusCode).toBe(200);
    expect(startedSpanNames).toEqual(["GET-/api/child"]);

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("GET-/api/child");
    expect(spans[0].attributes["http.response.status_code"]).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Cross-registration telemetry ownership
// ---------------------------------------------------------------------------

describe("cross-registration telemetry ownership", () => {
  interface CrossRegistrationSetup {
    child?: StandardTracerFastifyRegisterHooksOptions;
    root?: StandardTracerFastifyRegisterHooksOptions;
  }

  /**
   * Registers the child hooks inside `app.register()` and the root hooks in
   * `app.after()`, which makes the child hooks run first for requests routed
   * through the child scope (child registered before its root).
   */
  function buildCrossRegisteredApp({ child, root }: CrossRegistrationSetup) {
    const { logger, warnings } = createRecordingLogger();
    const app = Fastify();
    app.register(async (childInstance) => {
      registerHooks(childInstance, child, logger);
      childInstance.get("/api/child", async () => ({ ok: true }));
    });
    app.after(() => {
      registerHooks(app, root, logger);
    });
    return { app, warnings };
  }

  test("meter only on the root: one observation recorded with the root meter", async () => {
    const root = createRecordingMeter();
    const { app, warnings } = buildCrossRegisteredApp({
      root: { standardMeter: root.meter },
    });

    const res = await app.inject({ method: "GET", url: "/api/child" });
    expect(res.statusCode).toBe(200);

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("GET-/api/child");
    expect(root.observations).toHaveLength(1);
    expect(root.observations[0].attributes).toEqual({
      "http.request.method": "GET",
      "url.scheme": "http",
      "network.protocol.version": "1.1",
      "http.route": "/api/child",
      "http.response.status_code": 200,
    });
    expect(warnings).toEqual([]);
  });

  test("meter only on the child and the child traces: one observation with the child meter", async () => {
    const child = createRecordingMeter();
    const { app, warnings } = buildCrossRegisteredApp({
      child: { standardMeter: child.meter },
    });

    await app.inject({ method: "GET", url: "/api/child" });

    expect(exporter.getFinishedSpans()).toHaveLength(1);
    expect(child.observations).toHaveLength(1);
    expect(warnings).toEqual([]);
  });

  test("meter only on the child and the child filters: no throw, no observation, one span", async () => {
    const child = createRecordingMeter();
    const { app, warnings } = buildCrossRegisteredApp({
      // The child filters the request out; the root (default "/api") traces it.
      child: { standardMeter: child.meter, rootApiPath: "/api/other" },
    });

    const res = await app.inject({ method: "GET", url: "/api/child" });
    expect(res.statusCode).toBe(200);

    expect(exporter.getFinishedSpans()).toHaveLength(1);
    expect(child.observations).toHaveLength(0);
    // Ends the span created by the root without touching a missing start time,
    // so no hook failure is logged.
    expect(warnings).toEqual([]);
  });

  test("meters on both: one observation, by the registration that created the span", async () => {
    const child = createRecordingMeter();
    const root = createRecordingMeter();
    const { app, warnings } = buildCrossRegisteredApp({
      child: { standardMeter: child.meter },
      root: { standardMeter: root.meter },
    });

    await app.inject({ method: "GET", url: "/api/child" });

    expect(exporter.getFinishedSpans()).toHaveLength(1);
    expect(child.observations).toHaveLength(1);
    expect(root.observations).toHaveLength(0);
    expect(warnings).toEqual([]);
  });

  test("no meter anywhere: span behaviour unchanged", async () => {
    const { app, warnings } = buildCrossRegisteredApp({});

    await app.inject({ method: "GET", url: "/api/child" });

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("GET-/api/child");
    expect(spans[0].attributes["http.response.status_code"]).toBe(200);
    expect(spans[0].attributes["http.route"]).toBe("/api/child");
    expect(warnings).toEqual([]);
  });

  test("meter only on the root and the root filters: the filtering registration does not record", async () => {
    const root = createRecordingMeter();
    const { app, warnings } = buildCrossRegisteredApp({
      root: { standardMeter: root.meter, rootApiPath: "/api/other" },
    });

    await app.inject({ method: "GET", url: "/api/child" });

    expect(exporter.getFinishedSpans()).toHaveLength(1);
    expect(root.observations).toHaveLength(0);
    expect(warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// http.server.request.duration semconv histogram (real SDK)
// ---------------------------------------------------------------------------

describe("http.server.request.duration semconv histogram", () => {
  test("exports the semconv metadata and distinct sub-second buckets", async () => {
    const harness = createSdkMeterHarness();
    const app = Fastify();
    registerHooks(app, { standardMeter: harness.meter });
    app.get("/api/fast", async () => {
      await delay(1);
      return { ok: true };
    });
    app.get("/api/medium", async () => {
      await delay(50);
      return { ok: true };
    });
    app.get("/api/slow", async () => {
      await delay(1100);
      return { ok: true };
    });

    try {
      expect(
        (await app.inject({ method: "GET", url: "/api/fast" })).statusCode,
      ).toBe(200);
      expect(
        (await app.inject({ method: "GET", url: "/api/medium" })).statusCode,
      ).toBe(200);
      expect(
        (await app.inject({ method: "GET", url: "/api/slow" })).statusCode,
      ).toBe(200);

      const metrics = await harness.collect();
      expect(metrics).toHaveLength(1);
      const metric = metrics[0];
      expect(metric.descriptor.name).toBe(
        `${TEST_SERVICE_NAME}.http.server.request.duration`,
      );
      expect(metric.descriptor.unit).toBe("s");
      expect(metric.descriptor.description).toBe(
        "Duration of HTTP server requests.",
      );

      if (metric.dataPointType !== DataPointType.HISTOGRAM) {
        throw new Error("expected a histogram metric");
      }
      const points = metric.dataPoints;
      expect(points).toHaveLength(3);
      for (const point of points) {
        expect(point.value.buckets.boundaries).toEqual(SEMCONV_BOUNDARIES);
        expect(point.value.count).toBe(1);
      }

      const byRoute = new Map(
        points.map((point) => [String(point.attributes["http.route"]), point]),
      );
      const fastBucket = nonzeroBucket(byRoute.get("/api/fast")!);
      const mediumBucket = nonzeroBucket(byRoute.get("/api/medium")!);
      const slowBucket = nonzeroBucket(byRoute.get("/api/slow")!);
      // Ranges absorb CI jitter; the point is that the observations no longer
      // share a single coarse bucket.
      expect([0, 1]).toContain(fastBucket);
      expect([3, 4]).toContain(mediumBucket);
      expect(slowBucket).toBe(10);
      expect(new Set([fastBucket, mediumBucket, slowBucket]).size).toBe(3);
    } finally {
      await app.close();
      await harness.shutdown();
    }
  });

  test("unprefixedMetricName: true exports the exact semconv name", async () => {
    const harness = createSdkMeterHarness();
    const app = Fastify();
    registerHooks(app, {
      standardMeter: harness.meter,
      unprefixedMetricName: true,
    });
    app.get("/api/test", async () => ({ ok: true }));

    try {
      await app.inject({ method: "GET", url: "/api/test" });

      const metrics = await harness.collect();
      expect(metrics).toHaveLength(1);
      expect(metrics[0].descriptor.name).toBe("http.server.request.duration");
    } finally {
      await app.close();
      await harness.shutdown();
    }
  });

  test("honours custom boundaries without changing span behaviour", async () => {
    const harness = createSdkMeterHarness();
    const customBoundaries = [0.001, 0.01, 0.1, 1, 10];
    const app = Fastify();
    registerHooks(app, {
      standardMeter: harness.meter,
      histogramOptions: { explicitBucketBoundaries: customBoundaries },
    });
    app.get("/api/fast", async () => {
      await delay(1);
      return { ok: true };
    });

    try {
      const res = await app.inject({ method: "GET", url: "/api/fast" });
      expect(res.statusCode).toBe(200);

      const metrics = await harness.collect();
      expect(metrics).toHaveLength(1);
      if (metrics[0].dataPointType !== DataPointType.HISTOGRAM) {
        throw new Error("expected a histogram metric");
      }
      const [point] = metrics[0].dataPoints;
      expect(point.value.buckets.boundaries).toEqual(customBoundaries);

      const span = exporter
        .getFinishedSpans()
        .find((s) => s.name === "GET-/api/fast");
      expect(span).toBeDefined();
      expect(span!.attributes["http.response.status_code"]).toBe(200);
    } finally {
      await app.close();
      await harness.shutdown();
    }
  });
});
