import { EventEmitter } from 'events';
import type { FastifyReply } from 'fastify';
import { addClient, checkSSERateLimit, closeSSE, getClientCount, initSSE } from '../src/sse';

const CHANNEL = 'pullmint:execution-updates';

const mockHandlers = new Map<string, (...args: unknown[]) => void>();
const mockSubscribe = jest.fn().mockResolvedValue(undefined);
const mockUnsubscribe = jest.fn().mockResolvedValue(undefined);
const mockQuit = jest.fn().mockResolvedValue('OK');
const mockOn = jest.fn((event: string, handler: (...args: unknown[]) => void) => {
  mockHandlers.set(event, handler);
});

jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    subscribe: mockSubscribe,
    on: mockOn,
    unsubscribe: mockUnsubscribe,
    quit: mockQuit,
  }));
});

function createMockReply(throwOnWrite = false): {
  reply: FastifyReply;
  write: jest.Mock;
  end: jest.Mock;
  emitClose: () => void;
} {
  const emitter = new EventEmitter();

  const write = jest.fn((_: string) => {
    if (throwOnWrite) {
      throw new Error('client disconnected');
    }
  });
  const end = jest.fn();

  const raw = {
    write,
    end,
    on: jest.fn((event: string, handler: () => void) => {
      emitter.on(event, handler);
      return raw;
    }),
  };

  return {
    reply: { raw } as unknown as FastifyReply,
    write,
    end,
    emitClose: () => {
      emitter.emit('close');
    },
  };
}

describe('sse', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockHandlers.clear();
    mockSubscribe.mockResolvedValue(undefined);
    process.env.REDIS_URL = 'redis://test-redis:6379';
  });

  afterEach(async () => {
    delete process.env.REDIS_URL;
    await closeSSE();
  });

  it('initializes Redis subscriber and subscribes to channel', () => {
    initSSE();

    const IORedis = jest.requireMock('ioredis') as jest.Mock;
    expect(IORedis).toHaveBeenCalledWith('redis://test-redis:6379');
    expect(mockSubscribe).toHaveBeenCalledWith(CHANNEL);
    expect(mockOn).toHaveBeenCalledWith('message', expect.any(Function));
    expect(mockOn).toHaveBeenCalledWith('error', expect.any(Function));
  });

  it('logs subscribe failure without throwing', async () => {
    mockSubscribe.mockRejectedValueOnce(new Error('subscribe failed'));
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

    initSSE();
    await Promise.resolve();

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'Failed to subscribe to execution updates channel:',
      expect.any(Error)
    );

    consoleErrorSpy.mockRestore();
  });

  it('adds clients and removes them on close event', () => {
    const client = createMockReply();

    const result = addClient(client.reply, null, '127.0.0.1');
    expect(result).toEqual({ ok: true });
    expect(getClientCount()).toBe(1);

    client.emitClose();
    expect(getClientCount()).toBe(0);
  });

  it('enforces maximum concurrent connections per IP', () => {
    for (let i = 0; i < 5; i += 1) {
      const client = createMockReply();
      expect(addClient(client.reply, null, '10.0.0.5')).toEqual({ ok: true });
    }

    const sixthClient = createMockReply();
    expect(addClient(sixthClient.reply, null, '10.0.0.5')).toEqual({ ok: false });
    expect(getClientCount()).toBe(5);
  });

  it('fans out message to all matching clients and respects repo filter', () => {
    initSSE();

    const clientAll = createMockReply();
    const clientMatchingRepo = createMockReply();
    const clientOtherRepo = createMockReply();

    addClient(clientAll.reply, null, '10.0.0.1');
    addClient(clientMatchingRepo.reply, 'org/repo', '10.0.0.2');
    addClient(clientOtherRepo.reply, 'other/repo', '10.0.0.3');

    const messageHandler = mockHandlers.get('message');
    expect(messageHandler).toBeDefined();

    const payload = {
      executionId: 'exec-1',
      repoFullName: 'org/repo',
      prNumber: 12,
      status: 'analyzing',
      riskScore: 55,
      updatedAt: 1710000000000,
    };

    messageHandler?.(CHANNEL, JSON.stringify(payload));

    expect(clientAll.write).toHaveBeenCalledWith(
      `id: ${String(payload.updatedAt)}\ndata: ${JSON.stringify(payload)}\n\n`
    );
    expect(clientMatchingRepo.write).toHaveBeenCalledTimes(1);
    expect(clientOtherRepo.write).not.toHaveBeenCalled();
  });

  it('logs parse errors for malformed Redis messages', () => {
    initSSE();

    const client = createMockReply();
    addClient(client.reply, null, '10.0.0.4');

    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

    const messageHandler = mockHandlers.get('message');
    messageHandler?.(CHANNEL, 'not-json');

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'Failed to parse SSE message from Redis:',
      'not-json'
    );
    expect(client.write).not.toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  it('removes disconnected clients when write throws', () => {
    initSSE();

    const client = createMockReply(true);
    addClient(client.reply, null, '10.0.0.9');
    expect(getClientCount()).toBe(1);

    const messageHandler = mockHandlers.get('message');
    const payload = {
      executionId: 'exec-2',
      repoFullName: 'org/repo',
      prNumber: 4,
      status: 'queued',
      riskScore: null,
      updatedAt: 1710000001000,
    };
    messageHandler?.(CHANNEL, JSON.stringify(payload));

    expect(getClientCount()).toBe(0);
  });

  it('logs Redis subscriber error events', () => {
    initSSE();

    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
    const errorHandler = mockHandlers.get('error');

    errorHandler?.(new Error('subscriber failure'));

    expect(consoleErrorSpy).toHaveBeenCalledWith('SSE Redis subscriber error:', expect.any(Error));

    consoleErrorSpy.mockRestore();
  });

  it('closes all clients and subscriber connection on shutdown', async () => {
    initSSE();

    const clientA = createMockReply();
    const clientB = createMockReply();
    addClient(clientA.reply, null, '10.0.1.1');
    addClient(clientB.reply, 'org/repo', '10.0.1.2');

    await closeSSE();

    expect(clientA.end).toHaveBeenCalledTimes(1);
    expect(clientB.end).toHaveBeenCalledTimes(1);
    expect(mockUnsubscribe).toHaveBeenCalledWith(CHANNEL);
    expect(mockQuit).toHaveBeenCalledTimes(1);
    expect(getClientCount()).toBe(0);

    await expect(closeSSE()).resolves.toBeUndefined();
  });

  it('rate limits repeated SSE connection attempts per IP', () => {
    for (let i = 0; i < 20; i += 1) {
      expect(checkSSERateLimit('10.10.10.10')).toBe(true);
    }

    expect(checkSSERateLimit('10.10.10.10')).toBe(false);
    expect(checkSSERateLimit('10.10.10.11')).toBe(true);
  });
});
