import Fastify, { FastifyInstance } from "fastify";
import http from "node:http";
import { AddressInfo } from "node:net";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import {
  StandardTracerFastifyRegisterHooks,
  StandardTracerFastifyRegisterHooksOptions,
  OTelRequestSpan,
  OTelRequestContext,
} from "./StandardTracerFastify";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockSpan() {
  return {
    setAttribute: jest.fn().mockReturnThis(),
    setStatus: jest.fn().mockReturnThis(),
    end: jest.fn(),
    recordException: jest.fn(),
  };
}

function createMockTracer(mockSpan: ReturnType<typeof createMockSpan>) {
  return { startSpan: jest.fn().mockReturnValue(mockSpan) };
}

function createMockLogger() {
  return {
    createModuleLogger: jest.fn().mockReturnValue({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    }),
  };
}

/** Build a Fastify app with hooks registered and a few test routes. */
function buildApp(
  options?: StandardTracerFastifyRegisterHooksOptions,
  fastifyOptions?: { connectionTimeout?: number },
) {
  const mockSpan = createMockSpan();
  const mockTracer = createMockTracer(mockSpan);
  const mockLogger = createMockLogger();

  const app = Fastify(fastifyOptions);

  app.get("/api/test", async () => ({ ok: true }));
  app.get("/api/status", async (_req, res) =>
    res.status(400).send({ error: "bad" }),
  );
  app.get("/api/error-test", async () => {
    throw new Error("test error");
  });
  app.get("/api/throw-string", async () => {
    throw "string error";
  });
  app.get("/api/hang", async () => new Promise(() => {}));
  app.get("/api/files/:id", async () => ({ ok: true }));
  app.get("/api/echo", async (req, res) => {
    const span = OTelRequestSpan(req);
    return res.send({ hasSpan: !!span });
  });
  app.options("/api/echo", async (req, res) => {
    const span = OTelRequestSpan(req);
    return res.send({ hasSpan: !!span });
  });
  app.get("/api/context", async (req, res) => {
    const span = OTelRequestSpan(req);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const alias = (req as any).tracerSpanApi;
    return res.send({
      hasSpan: !!span,
      hasAlias: alias !== undefined,
      aliasEqualsSpan: !!span && alias === span,
      hasContext: !!OTelRequestContext(req),
    });
  });
  app.get("/api/pub/health", async () => ({ ok: true }));
  app.get("/api/pub/metrics", async () => ({ ok: true }));
  app.get("/api/health", async () => ({ ok: true }));

  StandardTracerFastifyRegisterHooks(
    app,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockTracer as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockLogger as any,
    options,
  );

  return { app, mockSpan, mockTracer, mockLogger };
}

/** Poll an assertion until it passes or the timeout is reached. */
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

// ---------------------------------------------------------------------------
// Request filtering
// ---------------------------------------------------------------------------

describe("request filtering", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("skips OPTIONS requests", async () => {
    const { app, mockTracer } = buildApp();
    await app.inject({ method: "OPTIONS", url: "/api/test" });
    expect(mockTracer.startSpan).not.toHaveBeenCalled();
  });

  test("skips requests outside rootApiPath", async () => {
    const { app, mockTracer } = buildApp({ rootApiPath: "/api/v2" });
    await app.inject({ method: "GET", url: "/api/test" });
    expect(mockTracer.startSpan).not.toHaveBeenCalled();
  });

  test("traces requests inside rootApiPath", async () => {
    const { app, mockTracer } = buildApp({ rootApiPath: "/api/v2" });
    app.get("/api/v2/data", async () => ({ ok: true }));
    await app.inject({ method: "GET", url: "/api/v2/data" });
    expect(mockTracer.startSpan).toHaveBeenCalledWith(
      "GET-/api/v2/data",
      undefined,
      { kind: SpanKind.SERVER },
    );
  });

  test("does not trace paths sharing the root path prefix only", async () => {
    const { app, mockTracer } = buildApp();
    await app.inject({ method: "GET", url: "/apiary/x" });
    await app.inject({ method: "GET", url: "/apiv2" });
    expect(mockTracer.startSpan).not.toHaveBeenCalled();
  });

  test("traces the root path itself", async () => {
    const { app, mockTracer } = buildApp({ rootApiPath: "/api/test" });
    await app.inject({ method: "GET", url: "/api/test" });
    expect(mockTracer.startSpan).toHaveBeenCalledTimes(1);
  });

  test("traces the root path itself (default rootApiPath)", async () => {
    const { app, mockTracer } = buildApp();
    app.get("/api", async () => ({ ok: true }));
    await app.inject({ method: "GET", url: "/api" });
    expect(mockTracer.startSpan).toHaveBeenCalledTimes(1);
  });

  test("traces every path when rootApiPath is /", async () => {
    const { app, mockTracer } = buildApp({ rootApiPath: "/" });
    await app.inject({ method: "GET", url: "/api/test" });
    expect(mockTracer.startSpan).toHaveBeenCalledTimes(1);
  });

  test("skips requests matching exact ignoreList", async () => {
    const { app, mockTracer } = buildApp({ ignoreList: ["GET-/api/test"] });
    await app.inject({ method: "GET", url: "/api/test" });
    expect(mockTracer.startSpan).not.toHaveBeenCalled();
  });

  test("traces requests not in ignoreList", async () => {
    const { app, mockTracer } = buildApp({ ignoreList: ["GET-/api/other"] });
    await app.inject({ method: "GET", url: "/api/test" });
    expect(mockTracer.startSpan).toHaveBeenCalled();
  });

  test("skips parameterized routes matching the sanitized ignoreList entry", async () => {
    const { app, mockTracer } = buildApp({
      ignoreList: ["GET-/api/files/_id"],
    });
    await app.inject({ method: "GET", url: "/api/files/123" });
    expect(mockTracer.startSpan).not.toHaveBeenCalled();
  });

  test("skips requests matching ignoreListPrefix", async () => {
    const { app, mockTracer } = buildApp({
      ignoreListPrefix: ["GET-/api/pub"],
    });
    await app.inject({ method: "GET", url: "/api/pub/health" });
    expect(mockTracer.startSpan).not.toHaveBeenCalled();
  });

  test("skips requests matching ignoreListPrefix (nested path)", async () => {
    const { app, mockTracer } = buildApp({
      ignoreListPrefix: ["GET-/api/pub"],
    });
    await app.inject({ method: "GET", url: "/api/pub/metrics" });
    expect(mockTracer.startSpan).not.toHaveBeenCalled();
  });

  test("does not skip requests not matching ignoreListPrefix", async () => {
    const { app, mockTracer } = buildApp({
      ignoreListPrefix: ["GET-/api/private"],
    });
    await app.inject({ method: "GET", url: "/api/pub/health" });
    expect(mockTracer.startSpan).toHaveBeenCalledWith(
      "GET-/api/pub/health",
      undefined,
      { kind: SpanKind.SERVER },
    );
  });

  test("skips requests matching ignoreListSuffix", async () => {
    const { app, mockTracer } = buildApp({
      ignoreListSuffix: ["/health"],
    });
    await app.inject({ method: "GET", url: "/api/health" });
    expect(mockTracer.startSpan).not.toHaveBeenCalled();
  });

  test("does not skip requests not matching ignoreListSuffix", async () => {
    const { app, mockTracer } = buildApp({
      ignoreListSuffix: ["/other"],
    });
    await app.inject({ method: "GET", url: "/api/health" });
    expect(mockTracer.startSpan).toHaveBeenCalledWith(
      "GET-/api/health",
      undefined,
      { kind: SpanKind.SERVER },
    );
  });

  test("skips when exact match takes priority over prefix", async () => {
    const { app, mockTracer } = buildApp({
      ignoreList: ["GET-/api/test"],
      ignoreListPrefix: ["GET-/api/other"],
    });
    await app.inject({ method: "GET", url: "/api/test" });
    expect(mockTracer.startSpan).not.toHaveBeenCalled();
  });

  test("traces when no ignore list matches", async () => {
    const { app, mockTracer } = buildApp({
      ignoreList: ["GET-/api/health"],
      ignoreListPrefix: ["GET-/api/pub"],
      ignoreListSuffix: ["/metrics"],
    });
    await app.inject({ method: "GET", url: "/api/test" });
    expect(mockTracer.startSpan).toHaveBeenCalledWith(
      "GET-/api/test",
      undefined,
      { kind: SpanKind.SERVER },
    );
  });
});

// ---------------------------------------------------------------------------
// Span lifecycle
// ---------------------------------------------------------------------------

describe("span lifecycle", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("creates span with method-path name on onRequest", async () => {
    const { app, mockTracer } = buildApp();
    await app.inject({ method: "GET", url: "/api/test" });
    expect(mockTracer.startSpan).toHaveBeenCalledWith(
      "GET-/api/test",
      undefined,
      { kind: SpanKind.SERVER },
    );
  });

  test("uses the route template for parameterized routes", async () => {
    const { app, mockTracer, mockSpan } = buildApp();
    await app.inject({ method: "GET", url: "/api/files/123" });
    await app.inject({ method: "GET", url: "/api/files/987" });
    expect(mockTracer.startSpan).toHaveBeenCalledTimes(2);
    expect(mockTracer.startSpan).toHaveBeenNthCalledWith(
      1,
      "GET-/api/files/_id",
      undefined,
      { kind: SpanKind.SERVER },
    );
    expect(mockTracer.startSpan).toHaveBeenNthCalledWith(
      2,
      "GET-/api/files/_id",
      undefined,
      { kind: SpanKind.SERVER },
    );
    expect(mockSpan.setAttribute).toHaveBeenCalledWith(
      "http.route",
      "/api/files/:id",
    );
  });

  test("falls back to the path for unmatched routes", async () => {
    const { app, mockTracer, mockSpan } = buildApp();
    const res = await app.inject({ method: "GET", url: "/api/unknown/42" });
    expect(res.statusCode).toBe(404);
    expect(mockTracer.startSpan).toHaveBeenCalledWith(
      "GET-/api/unknown/42",
      undefined,
      { kind: SpanKind.SERVER },
    );
    expect(mockSpan.setAttribute).not.toHaveBeenCalledWith(
      "http.route",
      expect.anything(),
    );
  });

  test("strips query string from span name", async () => {
    const { app, mockTracer, mockSpan } = buildApp();
    await app.inject({ method: "GET", url: "/api/files/123?token=secret" });
    expect(mockTracer.startSpan).toHaveBeenCalledWith(
      "GET-/api/files/_id",
      undefined,
      { kind: SpanKind.SERVER },
    );
    expect(mockSpan.setAttribute).toHaveBeenCalledWith(
      "url.path",
      "/api/files/123",
    );
    expect(mockSpan.setAttribute).not.toHaveBeenCalledWith(
      "url.query",
      expect.anything(),
    );
  });

  test("sets http.request_method attribute", async () => {
    const { app, mockSpan } = buildApp();
    await app.inject({ method: "POST", url: "/api/test" });
    expect(mockSpan.setAttribute).toHaveBeenCalledWith(
      "http.request.method",
      "POST",
    );
  });

  test("sets url.path attribute", async () => {
    const { app, mockSpan } = buildApp();
    await app.inject({ method: "GET", url: "/api/test" });
    expect(mockSpan.setAttribute).toHaveBeenCalledWith("url.path", "/api/test");
  });

  test("sets status and ends span on success response", async () => {
    const { app, mockSpan } = buildApp();
    await app.inject({ method: "GET", url: "/api/test" });
    expect(mockSpan.setStatus).toHaveBeenCalledWith({
      code: SpanStatusCode.OK,
    });
    expect(mockSpan.setAttribute).toHaveBeenCalledWith(
      "http.response.status_code",
      200,
    );
    expect(mockSpan.end).toHaveBeenCalledTimes(1);
  });

  test("sets ERROR status on 4xx response", async () => {
    const { app, mockSpan } = buildApp();
    await app.inject({ method: "GET", url: "/api/status" });
    expect(mockSpan.setStatus).toHaveBeenCalledWith({
      code: SpanStatusCode.ERROR,
    });
  });

  test("records exception on handler error", async () => {
    const { app, mockSpan } = buildApp();
    await app.inject({ method: "GET", url: "/api/error-test" });
    expect(mockSpan.recordException).toHaveBeenCalledWith(expect.any(Error));
    expect(mockSpan.setStatus).toHaveBeenCalledWith({
      code: SpanStatusCode.ERROR,
    });
    expect(mockSpan.setAttribute).toHaveBeenCalledWith("error.type", "Error");
    expect(mockSpan.end).toHaveBeenCalledTimes(1);
  });

  test("normalizes thrown non-Error values", async () => {
    const { app, mockSpan, mockLogger } = buildApp();
    await app.inject({ method: "GET", url: "/api/throw-string" });
    expect(mockSpan.recordException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "string error" }),
    );
    const moduleLogger = mockLogger.createModuleLogger.mock.results[0].value;
    expect(moduleLogger.error).toHaveBeenCalledWith(
      "string error",
      expect.any(Error),
      expect.any(Object),
    );
    expect(mockSpan.end).toHaveBeenCalledTimes(1);
  });

  test("logger.error is called on handler error", async () => {
    const { app, mockLogger } = buildApp();
    await app.inject({ method: "GET", url: "/api/error-test" });
    const moduleLogger = mockLogger.createModuleLogger.mock.results[0].value;
    expect(moduleLogger.error).toHaveBeenCalledWith(
      "test error",
      expect.any(Error),
      expect.any(Object),
    );
  });

  test("does not log when the erroring request is not traced", async () => {
    const { app, mockLogger, mockTracer } = buildApp({
      ignoreList: ["GET-/api/error-test"],
    });
    const res = await app.inject({ method: "GET", url: "/api/error-test" });
    expect(res.statusCode).toBe(500);
    expect(mockTracer.startSpan).not.toHaveBeenCalled();
    const moduleLogger = mockLogger.createModuleLogger.mock.results[0].value;
    expect(moduleLogger.error).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Client abort and connection timeout (real sockets)
// ---------------------------------------------------------------------------

describe("span ending on abort and timeout", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("ends the span with ERROR on client abort", async () => {
    const { app, mockSpan } = buildApp();
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
        expect(mockSpan.end).toHaveBeenCalledTimes(1);
      });
      expect(mockSpan.setStatus).toHaveBeenCalledWith({
        code: SpanStatusCode.ERROR,
      });
      expect(mockSpan.setAttribute).toHaveBeenCalledWith(
        "error.type",
        "client_abort",
      );
    } finally {
      await app.close();
    }
  });

  test("ends the span with ERROR on connection timeout", async () => {
    const { app, mockSpan } = buildApp(undefined, { connectionTimeout: 150 });
    const port = await listen(app);
    try {
      const client = http.get({ host: "127.0.0.1", port, path: "/api/hang" });
      client.on("error", () => {});
      await waitFor(() => {
        expect(mockSpan.end).toHaveBeenCalledTimes(1);
      });
      expect(mockSpan.setStatus).toHaveBeenCalledWith({
        code: SpanStatusCode.ERROR,
      });
      expect(mockSpan.setAttribute).toHaveBeenCalledWith(
        "error.type",
        "timeout",
      );
      client.destroy();
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Registration guard
// ---------------------------------------------------------------------------

describe("registration guard", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("warns and ignores a second registration on the same instance", async () => {
    const { app, mockTracer, mockLogger } = buildApp();
    const secondLogger = createMockLogger();

    StandardTracerFastifyRegisterHooks(
      app,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockTracer as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      secondLogger as any,
    );

    const secondModuleLogger =
      secondLogger.createModuleLogger.mock.results[0].value;
    expect(secondModuleLogger.warn).toHaveBeenCalledTimes(1);
    expect(
      mockLogger.createModuleLogger.mock.results[0].value.warn,
    ).not.toHaveBeenCalled();

    await app.inject({ method: "GET", url: "/api/test" });
    expect(mockTracer.startSpan).toHaveBeenCalledTimes(1);
    expect(mockTracer.startSpan).toHaveBeenCalledWith(
      "GET-/api/test",
      undefined,
      { kind: SpanKind.SERVER },
    );
  });
});

// ---------------------------------------------------------------------------
// OTelRequestSpan / OTelRequestContext / req.tracerSpanApi
// ---------------------------------------------------------------------------

describe("OTelRequestSpan", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("returns a span for traced requests", async () => {
    const { app } = buildApp();
    const res = await app.inject({ method: "GET", url: "/api/echo" });
    expect(JSON.parse(res.body)).toEqual({ hasSpan: true });
  });

  test("returns undefined for OPTIONS requests", async () => {
    const { app } = buildApp();
    const res = await app.inject({ method: "OPTIONS", url: "/api/echo" });
    expect(JSON.parse(res.body)).toEqual({ hasSpan: false });
  });

  test("returns undefined for requests outside rootApiPath", async () => {
    const { app } = buildApp({ rootApiPath: "/api/v2" });
    const res = await app.inject({ method: "GET", url: "/api/echo" });
    expect(JSON.parse(res.body)).toEqual({ hasSpan: false });
  });

  test("returns undefined for requests matching ignoreList", async () => {
    const { app } = buildApp({ ignoreList: ["GET-/api/echo"] });
    const res = await app.inject({ method: "GET", url: "/api/echo" });
    expect(JSON.parse(res.body)).toEqual({ hasSpan: false });
  });

  test("returns undefined for requests matching ignoreListPrefix", async () => {
    const { app } = buildApp({ ignoreListPrefix: ["GET-/api/ech"] });
    const res = await app.inject({ method: "GET", url: "/api/echo" });
    expect(JSON.parse(res.body)).toEqual({ hasSpan: false });
  });

  test("returns undefined for requests matching ignoreListSuffix", async () => {
    const { app } = buildApp({ ignoreListSuffix: ["/echo"] });
    const res = await app.inject({ method: "GET", url: "/api/echo" });
    expect(JSON.parse(res.body)).toEqual({ hasSpan: false });
  });
});

describe("OTelRequestContext and req.tracerSpanApi", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("exposes the context and the deprecated alias for traced requests", async () => {
    const { app } = buildApp();
    const res = await app.inject({ method: "GET", url: "/api/context" });
    expect(JSON.parse(res.body)).toEqual({
      hasSpan: true,
      hasAlias: true,
      aliasEqualsSpan: true,
      hasContext: true,
    });
  });

  test("returns undefined for untraced requests", async () => {
    const { app } = buildApp({ ignoreList: ["GET-/api/context"] });
    const res = await app.inject({ method: "GET", url: "/api/context" });
    expect(JSON.parse(res.body)).toEqual({
      hasSpan: false,
      hasAlias: false,
      aliasEqualsSpan: false,
      hasContext: false,
    });
  });
});
