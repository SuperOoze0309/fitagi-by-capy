import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { AiService } from '@/services/ai';
import { ContextBuilder } from '@/services/ai/contextBuilder';
import { OpenAiCompatibleProvider } from '@/services/ai/openaiProvider';
import { initStorage, resetStorageForTests } from '@/storage';
import { MemoryAdapter } from '@/test/MemoryAdapter';
import { initRepositories, repositories, resetRepositoriesForTests } from '@/repositories';
import { DEFAULT_SETTINGS } from '@/repositories/settingsRepository';
import type { Settings } from '@/domain/types';

/**
 * Streaming has to actually stream.
 *
 * `LlmProvider.streamChat` is optional, so a provider whose method is named
 * differently still satisfies the interface. That is what happened: the implementation
 * was called `chatStream` while the service looked up `streamChat`, found nothing, and
 * quietly took the non-streaming path — every answer arrived in one piece while the
 * README promised a reply typed onto the screen. No build could catch it.
 *
 * These tests drive the real `AiService` with a fetch double and assert on how many
 * times the delta callback fires and in what order, which is the behaviour a user sees.
 */

const STREAMING_SETTINGS: Settings = {
  ...DEFAULT_SETTINGS,
  aiEnabled: true,
  aiBaseUrl: 'https://example.test/v1',
  aiModel: 'gpt-4o-mini',
  aiApiKey: 'test-key',
};

/** An SSE body that reports text, a tool-free finish, and then a keep-alive. */
function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]!));
        index += 1;
        return;
      }
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function event(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}

describe('streaming through the real service', () => {
  let requests: { stream: unknown; url: string }[] = [];

  beforeEach(async () => {
    requests = [];
    await initStorage(new MemoryAdapter());
    initRepositories();
  });

  afterEach(() => {
    resetRepositoriesForTests();
    resetStorageForTests();
  });

  function serviceWith(response: Response): AiService {
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const payload = JSON.parse(String(init.body ?? '{}')) as { stream?: unknown };
      requests.push({ stream: payload.stream, url: String(url) });
      return response;
    }) as unknown as typeof fetch;
    return new AiService(repositories(), STREAMING_SETTINGS, fetchImpl);
  }

  it('asks the endpoint to stream', async () => {
    const service = serviceWith(sseResponse([event('hi'), 'data: [DONE]\n\n']));
    await service.askStreaming('How is my bench?', 'coach', () => undefined);

    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.stream, true, 'the request must set stream: true');
    assert.match(String(requests[0]?.url), /chat\/completions$/);
  });

  it('delivers each fragment separately, in order', async () => {
    const service = serviceWith(
      sseResponse([
        event('Your bench '),
        event('is up '),
        event('5 kg.'),
        'data: [DONE]\n\n',
      ]),
    );

    const deltas: string[] = [];
    const { answer } = await service.askStreaming('How is my bench?', 'coach', (delta) => {
      deltas.push(delta);
    });

    assert.deepEqual(deltas, ['Your bench ', 'is up ', '5 kg.'], 'one callback per fragment');
    assert.equal(answer, 'Your bench is up 5 kg.', 'and the full answer is assembled');
  });

  it('emits a fragment before the response has finished', async () => {
    // The point of streaming: the first text reaches the screen while the endpoint is
    // still talking. A whole-answer fallback can never satisfy this.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(event('first')));
        await gate;
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    const response = new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });

    const service = serviceWith(response);
    const deltas: string[] = [];
    const pending = service.askStreaming('Anything?', 'coach', (delta) => deltas.push(delta));

    // Let the microtask queue drain: the first delta must already be here.
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(deltas, ['first'], 'the first fragment arrives before the stream ends');

    release();
    await pending;
    assert.deepEqual(deltas, ['first']);
  });

  it('uses the whole body once when the endpoint ignores the stream flag', async () => {
    const response = new Response(
      JSON.stringify({ choices: [{ message: { content: 'One shot answer.' } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );

    const service = serviceWith(response);
    const deltas: string[] = [];
    const { answer } = await service.askStreaming('Anything?', 'coach', (delta) =>
      deltas.push(delta),
    );

    assert.deepEqual(deltas, ['One shot answer.'], 'degraded to a single delta, not an error');
    assert.equal(answer, 'One shot answer.');
  });
});

describe('the provider the app builds', () => {
  it('exposes streamChat, the name the service calls', async () => {
    await initStorage(new MemoryAdapter());
    initRepositories();

    const contextBuilder = new ContextBuilder(repositories());
    const provider = new OpenAiCompatibleProvider(
      { baseUrl: 'https://example.test/v1', model: 'test-model', apiKey: 'test-key' },
      contextBuilder,
      (async () => new Response('{}')) as unknown as typeof fetch,
    );

    assert.equal(
      typeof provider.streamChat,
      'function',
      'a rename on either side of this contract is what silently disabled streaming',
    );

    resetRepositoriesForTests();
    resetStorageForTests();
  });
});
