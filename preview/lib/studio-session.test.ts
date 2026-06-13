/**
 * Light tests for studio.session.* — assert correct URL, method, and request body.
 * We mock globalThis.fetch so no network calls are made.
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {studio} from './studio';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function okJson(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {'content-type': 'application/json'},
  });
}

/** A mock streaming Response (body doesn't matter for URL/method tests). */
function okStream(): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.close();
    },
  });
  return new Response(stream, {status: 200});
}

// ---------------------------------------------------------------------------
// Setup: replace globalThis.fetch for each test
// ---------------------------------------------------------------------------
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// studio.session.start
// ---------------------------------------------------------------------------
describe('studio.session.start', () => {
  it('POSTs to /api/session/start with topic only', async () => {
    fetchMock.mockResolvedValue(okStream());
    await studio.session.start('deep sea creatures');
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/session/start');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.topic).toBe('deep sea creatures');
    expect(body.autoRun).toBeUndefined();
    expect(body.targetLength).toBeUndefined();
  });

  it('includes autoRun + targetLength when opts provided', async () => {
    fetchMock.mockResolvedValue(okStream());
    await studio.session.start('antikythera', {autoRun: true, targetLength: 60});
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.topic).toBe('antikythera');
    expect(body.autoRun).toBe(true);
    expect(body.targetLength).toBe(60);
  });

  it('returns the raw Response (not parsed)', async () => {
    const fakeRes = okStream();
    fetchMock.mockResolvedValue(fakeRes);
    const result = await studio.session.start('test');
    expect(result).toBe(fakeRes);
  });
});

// ---------------------------------------------------------------------------
// studio.session.approve
// ---------------------------------------------------------------------------
describe('studio.session.approve', () => {
  it('POSTs to the correct approve URL with gate', async () => {
    fetchMock.mockResolvedValue(okStream());
    await studio.session.approve('sid-abc', 'script');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/session/sid-abc/approve');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.gate).toBe('script');
    expect(body.voice).toBeUndefined();
    expect(body.speed).toBeUndefined();
  });

  it('includes voice + speed when opts provided', async () => {
    fetchMock.mockResolvedValue(okStream());
    await studio.session.approve('sid-xyz', 'voice', {voice: 'alloy', speed: 1.1});
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.gate).toBe('voice');
    expect(body.voice).toBe('alloy');
    expect(body.speed).toBe(1.1);
  });
});

// ---------------------------------------------------------------------------
// studio.session.state
// ---------------------------------------------------------------------------
describe('studio.session.state', () => {
  it('GETs /api/session/[id]/state and returns parsed JSON', async () => {
    const fakeState = {
      sid: 'sid-test',
      scenes: [],
      gates: {},
      autoRun: false,
    };
    fetchMock.mockResolvedValue(okJson(fakeState));
    const result = await studio.session.state('sid-test');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit | undefined];
    expect(url).toBe('/api/session/sid-test/state');
    expect(init?.method).toBeUndefined(); // default GET
    expect(result).toEqual(fakeState);
  });
});

// ---------------------------------------------------------------------------
// studio.session.setAutoRun
// ---------------------------------------------------------------------------
describe('studio.session.setAutoRun', () => {
  it('POSTs to /api/session/[id]/set-auto-run with flag:true', async () => {
    fetchMock.mockResolvedValue(okJson({ok: true}));
    const result = await studio.session.setAutoRun('sid-ar', true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/session/sid-ar/set-auto-run');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.flag).toBe(true);
    expect(result).toEqual({ok: true});
  });

  it('POSTs with flag:false', async () => {
    fetchMock.mockResolvedValue(okJson({ok: true}));
    await studio.session.setAutoRun('sid-ar', false);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.flag).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// studio.session.previewReopen
// ---------------------------------------------------------------------------
describe('studio.session.previewReopen', () => {
  it('POSTs to /api/session/[id]/preview-reopen with gate', async () => {
    const fakeResponse = {gate: 'voice', reruns: ['voice', 'scenes'], staleGates: ['scenes']};
    fetchMock.mockResolvedValue(okJson(fakeResponse));
    const result = await studio.session.previewReopen('sid-pr', 'voice');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/session/sid-pr/preview-reopen');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.gate).toBe('voice');
    expect(result).toEqual(fakeResponse);
  });
});
