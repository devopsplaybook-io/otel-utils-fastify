import Fastify, { FastifyInstance } from "fastify";
import http from "node:http";
import net, { AddressInfo } from "node:net";
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

function createMockMeter() {
  const histogram = { record: jest.fn() };
  return {
    createHistogram: jest.fn().mockReturnValue(histogram),
    histogram,
  };
}

interface BuildAppOverrides {
  tracer?: unknown;
  logger?: unknown;
}

/** Build a Fastify app with hooks registered and a few test routes. */
function buildApp(
  options?: StandardTracerFastifyRegisterHooksOptions,
  fastifyOptions?: { connectionTimeout?: number },
  overrides?: BuildAppOverrides,
) {
  const mockSpan = createMockSpan();
  const mockTracer = createMockTracer(mockSpan);
  const mockLogger = createMockLogger();

  const app = Fastify(fastifyOptions);

  app.get("/api/test", async () => ({ ok: true }));
  app.get("/api/status", async (_req, res) =>
    res.status(400).send({ error: "bad" }),
  );
  app.get("/api/server-error", async (_req, res) =>
    res.status(500).send({ error: "boom" }),
  );
  app.get("/api/error-test", async () => {
    throw new Error("test error");
  });
  app.get("/api/throw-string", async () => {
    throw "string error";
  });
  app.get("/api/forbidden", async () => {
    throw Object.assign(new Error("forbidden"), { statusCode: 403 });
  });
  app.get("/api/unavailable", async () => {
    throw Object.assign(new Error("unavailable"), { statusCode: 503 });
  });
  app.get("/api/validation-error", async () => {
    throw Object.assign(new Error("validation failed"), {
      code: "FST_ERR_VALIDATION",
      statusCode: 400,
    });
  });
  app.get("/api/custom-name-error", async () => {
    throw Object.assign(new Error("custom failure"), { name: "CustomError" });
  });
  app.get("/api/empty-name-error", async () => {
    throw Object.assign(new Error("empty name"), { name: "", code: "MY_CODE" });
  });
  app.get("/api/empty-code-error", async () => {
    throw Object.assign(new Error("empty code"), { name: "", code: "" });
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
    (overrides?.tracer ?? mockTracer) as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (overrides?.logger ?? mockLogger) as any,
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

  test("traces absolute-form request targets", async () => {
    const { app, mockTracer, mockSpan } = buildApp();
    const port = await listen(app);
    try {
      const response = await new Promise<string>((resolve) => {
        const socket = net.connect(port, "127.0.0.1", () => {
          socket.write(
            "GET http://example.com/api/abs HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n",
          );
        });
        let data = "";
        socket.on("data", (chunk) => {
          data += chunk.toString();
        });
        socket.on("close", () => resolve(data));
        socket.on("error", () => resolve(data));
      });
      expect(response.split("\r\n")[0]).toContain("404");
      await waitFor(() => {
        expect(mockSpan.end).toHaveBeenCalledTimes(1);
      });
      expect(mockTracer.startSpan).toHaveBeenCalledWith(
        "GET-/api/abs",
        undefined,
        { kind: SpanKind.SERVER },
      );
      expect(mockSpan.setAttribute).toHaveBeenCalledWith(
        "url.path",
        "/api/abs",
      );
    } finally {
      await app.close();
    }
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

  test("leaves span status unset and ends span on success response", async () => {
    const { app, mockSpan } = buildApp();
    await app.inject({ method: "GET", url: "/api/test" });
    expect(mockSpan.setStatus).not.toHaveBeenCalled();
    expect(mockSpan.setAttribute).toHaveBeenCalledWith(
      "http.response.status_code",
      200,
    );
    expect(mockSpan.end).toHaveBeenCalledTimes(1);
  });

  test("leaves span status unset on 4xx response", async () => {
    const { app, mockSpan } = buildApp();
    await app.inject({ method: "GET", url: "/api/status" });
    expect(mockSpan.setStatus).not.toHaveBeenCalled();
    expect(mockSpan.setAttribute).toHaveBeenCalledWith(
      "http.response.status_code",
      400,
    );
    expect(mockSpan.end).toHaveBeenCalledTimes(1);
  });

  test("sets ERROR status on 5xx response", async () => {
    const { app, mockSpan } = buildApp();
    await app.inject({ method: "GET", url: "/api/server-error" });
    expect(mockSpan.setStatus).toHaveBeenCalledWith({
      code: SpanStatusCode.ERROR,
    });
    expect(mockSpan.setAttribute).toHaveBeenCalledWith(
      "http.response.status_code",
      500,
    );
    expect(mockSpan.end).toHaveBeenCalledTimes(1);
  });

  test("keeps the recorded error when the error handler answers 2xx", async () => {
    const { app, mockSpan, mockLogger } = buildApp();
    app.setErrorHandler((_error, _req, reply) => {
      reply.status(200).send({ swallowed: true });
    });
    const res = await app.inject({ method: "GET", url: "/api/error-test" });
    expect(res.statusCode).toBe(200);
    expect(mockSpan.setStatus).toHaveBeenCalledWith({
      code: SpanStatusCode.ERROR,
    });
    expect(mockSpan.setStatus).not.toHaveBeenCalledWith({
      code: SpanStatusCode.OK,
    });
    expect(mockSpan.setAttribute).toHaveBeenCalledWith("error.type", "Error");
    expect(mockSpan.recordException).toHaveBeenCalledWith(expect.any(Error));
    expect(mockSpan.setAttribute).toHaveBeenCalledWith(
      "http.response.status_code",
      200,
    );
    expect(mockSpan.end).toHaveBeenCalledTimes(1);
    const moduleLogger = mockLogger.createModuleLogger.mock.results[0].value;
    expect(moduleLogger.error).toHaveBeenCalledTimes(1);
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
    expect(moduleLogger.warn).not.toHaveBeenCalled();
  });

  test("logs 4xx client errors at warn level without the error object", async () => {
    const { app, mockLogger, mockSpan } = buildApp();
    await app.inject({ method: "GET", url: "/api/forbidden" });
    const moduleLogger = mockLogger.createModuleLogger.mock.results[0].value;
    expect(moduleLogger.warn).toHaveBeenCalledWith("forbidden", mockSpan);
    expect(moduleLogger.error).not.toHaveBeenCalled();
  });

  test("logs errors with a 5xx statusCode at error level", async () => {
    const { app, mockLogger } = buildApp();
    await app.inject({ method: "GET", url: "/api/unavailable" });
    const moduleLogger = mockLogger.createModuleLogger.mock.results[0].value;
    expect(moduleLogger.error).toHaveBeenCalledWith(
      "unavailable",
      expect.any(Error),
      expect.any(Object),
    );
    expect(moduleLogger.warn).not.toHaveBeenCalled();
  });

  test("uses error.code as error.type for Fastify-generated errors", async () => {
    const { app, mockSpan } = buildApp();
    await app.inject({ method: "GET", url: "/api/validation-error" });
    expect(mockSpan.setAttribute).toHaveBeenCalledWith(
      "error.type",
      "FST_ERR_VALIDATION",
    );
  });

  test("uses a specific error name as error.type when not generic", async () => {
    const { app, mockSpan } = buildApp();
    await app.inject({ method: "GET", url: "/api/custom-name-error" });
    expect(mockSpan.setAttribute).toHaveBeenCalledWith(
      "error.type",
      "CustomError",
    );
  });

  test("falls back to error.code when the error name is empty", async () => {
    const { app, mockSpan } = buildApp();
    await app.inject({ method: "GET", url: "/api/empty-name-error" });
    expect(mockSpan.setAttribute).toHaveBeenCalledWith("error.type", "MY_CODE");
  });

  test("falls back to Error when name and code are empty", async () => {
    const { app, mockSpan } = buildApp();
    await app.inject({ method: "GET", url: "/api/empty-code-error" });
    expect(mockSpan.setAttribute).toHaveBeenCalledWith("error.type", "Error");
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
// Fail-open hooks (A2)
// ---------------------------------------------------------------------------

describe("fail-open hooks", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("serves requests untraced and warns once when the tracer throws", async () => {
    const mockLogger = createMockLogger();
    const { app } = buildApp(undefined, undefined, {
      tracer: {
        startSpan: jest.fn(() => {
          throw "tracer exploded";
        }),
      },
      logger: mockLogger,
    });

    const res1 = await app.inject({ method: "GET", url: "/api/test" });
    const res2 = await app.inject({ method: "GET", url: "/api/test" });
    expect(res1.statusCode).toBe(200);
    expect(res2.statusCode).toBe(200);

    const moduleLogger = mockLogger.createModuleLogger.mock.results[0].value;
    expect(moduleLogger.warn).toHaveBeenCalledTimes(1);
    expect(moduleLogger.warn.mock.calls[0][0]).toContain("tracer exploded");
    expect(moduleLogger.warn.mock.calls[0][0]).toContain("onRequest");
  });

  test("serves requests untraced when span operations throw", async () => {
    const throwingSpan = {
      setAttribute: jest.fn(() => {
        throw new Error("span exploded");
      }),
      setStatus: jest.fn(() => {
        throw new Error("span exploded");
      }),
      end: jest.fn(() => {
        throw new Error("span exploded");
      }),
      recordException: jest.fn(() => {
        throw new Error("span exploded");
      }),
    };
    const { app, mockLogger } = buildApp(undefined, undefined, {
      tracer: { startSpan: jest.fn().mockReturnValue(throwingSpan) },
    });

    const res = await app.inject({ method: "GET", url: "/api/test" });
    expect(res.statusCode).toBe(200);
    const moduleLogger = mockLogger.createModuleLogger.mock.results[0].value;
    expect(moduleLogger.warn).toHaveBeenCalledTimes(1);
    expect(moduleLogger.warn.mock.calls[0][0]).toContain("span exploded");
  });

  test("serves requests when the logger itself throws", async () => {
    const throwingLogger = {
      createModuleLogger: jest.fn().mockReturnValue({
        info: jest.fn(),
        warn: jest.fn(() => {
          throw new Error("logger exploded");
        }),
        error: jest.fn(),
      }),
    };
    const { app } = buildApp(undefined, undefined, {
      tracer: {
        startSpan: jest.fn(() => {
          throw new Error("tracer exploded");
        }),
      },
      logger: throwingLogger,
    });

    const res = await app.inject({ method: "GET", url: "/api/test" });
    expect(res.statusCode).toBe(200);
    const moduleLogger =
      throwingLogger.createModuleLogger.mock.results[0].value;
    expect(moduleLogger.warn).toHaveBeenCalledTimes(1);
  });

  test("keeps the response when span.end throws on response", async () => {
    const span = createMockSpan();
    span.end.mockImplementation(() => {
      throw new Error("end exploded");
    });
    const { app, mockLogger } = buildApp(undefined, undefined, {
      tracer: { startSpan: jest.fn().mockReturnValue(span) },
    });

    const res = await app.inject({ method: "GET", url: "/api/test" });
    expect(res.statusCode).toBe(200);
    expect(span.end).toHaveBeenCalledTimes(1);
    const moduleLogger = mockLogger.createModuleLogger.mock.results[0].value;
    expect(moduleLogger.warn).toHaveBeenCalledTimes(1);
    expect(moduleLogger.warn.mock.calls[0][0]).toContain("end exploded");
    expect(moduleLogger.warn.mock.calls[0][0]).toContain("onResponse");
  });

  test("keeps the response when span.setStatus throws in onError", async () => {
    const span = createMockSpan();
    span.setStatus.mockImplementation(() => {
      throw new Error("status exploded");
    });
    const { app, mockLogger } = buildApp(undefined, undefined, {
      tracer: { startSpan: jest.fn().mockReturnValue(span) },
    });

    const res = await app.inject({ method: "GET", url: "/api/error-test" });
    expect(res.statusCode).toBe(500);
    expect(span.end).toHaveBeenCalledTimes(1);
    expect(span.setAttribute).toHaveBeenCalledWith(
      "http.response.status_code",
      500,
    );
    const moduleLogger = mockLogger.createModuleLogger.mock.results[0].value;
    expect(moduleLogger.warn).toHaveBeenCalledTimes(1);
    expect(moduleLogger.warn.mock.calls[0][0]).toContain("status exploded");
    expect(moduleLogger.warn.mock.calls[0][0]).toContain("onError");
  });

  test("warns and ends the span when the abort hook fails", async () => {
    const span = createMockSpan();
    span.setStatus.mockImplementation(() => {
      throw new Error("abort exploded");
    });
    const { app, mockLogger } = buildApp(undefined, undefined, {
      tracer: { startSpan: jest.fn().mockReturnValue(span) },
    });
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
        expect(span.end).toHaveBeenCalledTimes(1);
      });
      const moduleLogger = mockLogger.createModuleLogger.mock.results[0].value;
      expect(moduleLogger.warn).toHaveBeenCalledTimes(1);
      expect(moduleLogger.warn.mock.calls[0][0]).toContain("abort exploded");
    } finally {
      await app.close();
    }
  });

  test("warns and ends the span when the timeout hook fails", async () => {
    const span = createMockSpan();
    span.setStatus.mockImplementation(() => {
      throw new Error("timeout exploded");
    });
    const { app, mockLogger } = buildApp(
      undefined,
      { connectionTimeout: 150 },
      { tracer: { startSpan: jest.fn().mockReturnValue(span) } },
    );
    const port = await listen(app);
    try {
      const client = http.get({ host: "127.0.0.1", port, path: "/api/hang" });
      client.on("error", () => {});
      await waitFor(() => {
        expect(span.end).toHaveBeenCalledTimes(1);
      });
      const moduleLogger = mockLogger.createModuleLogger.mock.results[0].value;
      expect(moduleLogger.warn).toHaveBeenCalledTimes(1);
      expect(moduleLogger.warn.mock.calls[0][0]).toContain("timeout exploded");
      client.destroy();
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// unmatchedRouteSpanName option (B1)
// ---------------------------------------------------------------------------

describe("unmatchedRouteSpanName option", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("uses the method as span name for unmatched routes when set to method", async () => {
    const { app, mockTracer, mockSpan } = buildApp({
      unmatchedRouteSpanName: "method",
    });
    const res = await app.inject({ method: "GET", url: "/api/unknown/42" });
    expect(res.statusCode).toBe(404);
    expect(mockTracer.startSpan).toHaveBeenCalledWith("GET", undefined, {
      kind: SpanKind.SERVER,
    });
    expect(mockSpan.setAttribute).toHaveBeenCalledWith(
      "url.path",
      "/api/unknown/42",
    );
    expect(mockSpan.setAttribute).not.toHaveBeenCalledWith(
      "http.route",
      expect.anything(),
    );
  });

  test("uses the request method for unmatched non-GET requests", async () => {
    const { app, mockTracer } = buildApp({
      unmatchedRouteSpanName: "method",
    });
    await app.inject({ method: "POST", url: "/api/unknown" });
    expect(mockTracer.startSpan).toHaveBeenCalledWith("POST", undefined, {
      kind: SpanKind.SERVER,
    });
  });

  test("keeps the route template for matched routes with method policy", async () => {
    const { app, mockTracer } = buildApp({
      unmatchedRouteSpanName: "method",
    });
    await app.inject({ method: "GET", url: "/api/files/123" });
    expect(mockTracer.startSpan).toHaveBeenCalledWith(
      "GET-/api/files/_id",
      undefined,
      { kind: SpanKind.SERVER },
    );
  });

  test("keeps the path fallback by default", async () => {
    const { app, mockTracer } = buildApp();
    await app.inject({ method: "GET", url: "/api/unknown/42" });
    expect(mockTracer.startSpan).toHaveBeenCalledWith(
      "GET-/api/unknown/42",
      undefined,
      { kind: SpanKind.SERVER },
    );
  });
});

// ---------------------------------------------------------------------------
// standardMeter option (B2)
// ---------------------------------------------------------------------------

describe("standardMeter option", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("records the request duration histogram with method, route and status", async () => {
    const meter = createMockMeter();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { app } = buildApp({ standardMeter: meter as any });

    await app.inject({ method: "GET", url: "/api/test" });

    expect(meter.createHistogram).toHaveBeenCalledWith(
      "http.server.request.duration",
    );
    expect(meter.histogram.record).toHaveBeenCalledTimes(1);
    const [value, attributes] = meter.histogram.record.mock.calls[0];
    expect(typeof value).toBe("number");
    expect(value).toBeGreaterThanOrEqual(0);
    expect(attributes).toEqual({
      "http.request.method": "GET",
      "http.route": "/api/test",
      "http.response.status_code": 200,
    });
  });

  test("omits http.route for unmatched routes", async () => {
    const meter = createMockMeter();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { app } = buildApp({ standardMeter: meter as any });

    await app.inject({ method: "GET", url: "/api/unknown/42" });

    expect(meter.histogram.record).toHaveBeenCalledTimes(1);
    const [, attributes] = meter.histogram.record.mock.calls[0];
    expect(attributes).toEqual({
      "http.request.method": "GET",
      "http.response.status_code": 404,
    });
  });

  test("does not record for ignored requests", async () => {
    const meter = createMockMeter();
    const { app } = buildApp({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      standardMeter: meter as any,
      ignoreList: ["GET-/api/test"],
    });

    await app.inject({ method: "GET", url: "/api/test" });

    expect(meter.histogram.record).not.toHaveBeenCalled();
  });

  test("records error.type instead of a status code on client abort", async () => {
    const meter = createMockMeter();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { app } = buildApp({ standardMeter: meter as any });
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
        expect(meter.histogram.record).toHaveBeenCalledTimes(1);
      });
      const [, attributes] = meter.histogram.record.mock.calls[0];
      expect(attributes).toEqual({
        "http.request.method": "GET",
        "http.route": "/api/hang",
        "error.type": "client_abort",
      });
    } finally {
      await app.close();
    }
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
