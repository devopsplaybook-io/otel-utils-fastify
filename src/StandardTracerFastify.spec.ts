import Fastify from "fastify";
import { SpanStatusCode } from "@opentelemetry/api";
import {
  StandardTracerFastifyRegisterHooks,
  StandardTracerFastifyRegisterHooksOptions,
  OTelRequestSpan,
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
      error: jest.fn(),
    }),
  };
}

/** Build a Fastify app with hooks registered and a few test routes. */
function buildApp(options?: StandardTracerFastifyRegisterHooksOptions) {
  const mockSpan = createMockSpan();
  const mockTracer = createMockTracer(mockSpan);
  const mockLogger = createMockLogger();

  const app = Fastify();

  app.get("/api/test", async () => ({ ok: true }));
  app.get("/api/status", async (_req, res) =>
    res.status(400).send({ error: "bad" }),
  );
  app.get("/api/error-test", async () => {
    throw new Error("test error");
  });
  app.get("/api/echo", async (req, res) => {
    const span = OTelRequestSpan(req);
    return res.send({ hasSpan: !!span });
  });
  app.options("/api/echo", async (req, res) => {
    const span = OTelRequestSpan(req);
    return res.send({ hasSpan: !!span });
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
    expect(mockTracer.startSpan).toHaveBeenCalledWith("GET-/api/v2/data");
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
    expect(mockTracer.startSpan).toHaveBeenCalledWith("GET-/api/pub/health");
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
    expect(mockTracer.startSpan).toHaveBeenCalledWith("GET-/api/health");
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
    expect(mockTracer.startSpan).toHaveBeenCalledWith("GET-/api/test");
  });

  test("traces when callerContext propagation works silently", async () => {
    const { app, mockTracer } = buildApp();
    await app.inject({
      method: "GET",
      url: "/api/test",
      headers: {
        traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
      },
    });
    expect(mockTracer.startSpan).toHaveBeenCalledWith("GET-/api/test");
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
    expect(mockTracer.startSpan).toHaveBeenCalledWith("GET-/api/test");
  });

  test("strips query string from span name", async () => {
    const { app, mockTracer } = buildApp();
    await app.inject({ method: "GET", url: "/api/test?foo=bar" });
    expect(mockTracer.startSpan).toHaveBeenCalledWith("GET-/api/test");
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
});

// ---------------------------------------------------------------------------
// OTelRequestSpan
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
