import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import * as zlib from 'node:zlib';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { CustomModel, ProxyStartOptions } from '../proxy';
import { listenProxy } from '../proxy/listen';
import { CloudCodeRouting } from '../proxy/cloudCodeRouting';
import * as modelCatalog from '../proxy/modelCatalog';
import * as modelIdentity from '../modelIdentity';
import * as modelUtils from '../proxy/modelUtils';
import * as customRequest from '../proxy/customRequest';
import * as shared from '../proxy/shared';
import * as subagentRouting from '../proxy/subagentRouting';
import * as subagentModels from '../proxy/subagentModels';
import { validateCustomModel } from '../schemaValidator';

vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

type Provider = 'google' | 'openai' | 'anthropic';
type Invocation = { Model?: string; Prompt: string; TypeName?: string };
type ToolCall = { id?: string; name: string; args: { Subagents: Invocation[] } };
type Candidate = { content?: { parts?: { text?: string; functionCall?: ToolCall }[] } };
type Payload = { response?: Payload; candidates?: Candidate[] };
type UpstreamRequest = { provider: Provider; model: string; payload: Record<string, unknown>; wire: string };
const servers: http.Server[] = [];
const proxies: { stopProxy(): Promise<void> }[] = [];
const directories: string[] = [];
const compiled = ts.transpileModule(fs.readFileSync(path.resolve('src/proxy.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;

afterEach(async () => {
  customRequest.stopCustomRequests();
  for (const server of servers) server.closeAllConnections();
  for (const proxy of proxies.splice(0)) await proxy.stopProxy();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  subagentRouting.subagentRouting.clear();
  for (const directory of directories.splice(0)) {
    if (path.dirname(directory) !== path.resolve(tmpdir()) || !path.basename(directory).startsWith('agy-subagent-'))
      throw new Error('Unexpected fixture cleanup path');
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
afterAll(shared.stopCleanupInterval);

async function serve(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  return `http://127.0.0.1:${await listenProxy(server, 0)}`;
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

// Only the transparent Google transport destination is substituted. Generation uses
// the actual proxy router, bridge, translators and runtime through localhost sockets.
async function fixture(models: CustomModel[], fallback: string) {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'agy-subagent-'));
  directories.push(directory);
  fs.writeFileSync(path.join(directory, 'custom_models.json'), JSON.stringify({ models }));
  const dependencies: Record<string, unknown> = {
    http: {
      ...http,
      createServer: (handler: http.RequestListener) => {
        const server = http.createServer(handler);
        servers.push(server);
        return server;
      },
    },
    https: {
      request: (target: URL, options: http.RequestOptions, callback: (response: http.IncomingMessage) => void) =>
        http.request(new URL(target.pathname + target.search, fallback), options, callback),
    },
    fs,
    path,
    zlib,
    electron: { app: { getAppPath: () => directory } },
    'electron-log': { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
    './proxy/shared': shared,
    './proxy/modelUtils': modelUtils,
    './proxy/modelCatalog': modelCatalog,
    './modelIdentity': modelIdentity,
    './proxy/cloudCodeRouting': { CloudCodeRouting },
    './proxy/subagentRouting': subagentRouting,
    './proxy/subagentModels': subagentModels,
    './proxy/customRequest': customRequest,
    './modelStore': { readModelConfig: () => models.map((model) => ({ ...model })) },
    './schemaValidator': { validateCustomModel },
    './cryptoStore': { decryptModels: (values: CustomModel[]) => values },
    './proxy/listen': {
      getRequiredProxyPort: () => undefined,
      listenProxy: (server: http.Server) => listenProxy(server, 0),
    },
  };
  const module = {
    exports: {} as { startProxy(options: ProxyStartOptions): Promise<number>; stopProxy(): Promise<void> },
  };
  runInNewContext(compiled, {
    module,
    exports: module.exports,
    URL,
    Buffer,
    process,
    setTimeout,
    clearTimeout,
    require: (id: string) => {
      if (!Object.hasOwn(dependencies, id)) throw new Error(`Unexpected proxy dependency: ${id}`);
      return dependencies[id];
    },
  });
  proxies.push(module.exports);
  return `http://127.0.0.1:${await module.exports.startProxy({ dataDirectory: directory })}`;
}

function model(origin: string, provider: Provider, name: string): CustomModel {
  return {
    name: `models/${name}`,
    displayName: name,
    description: '',
    provider,
    apiKey: 'none',
    apiUrl: `${origin}/${provider}/v1${provider === 'google' ? 'beta' : provider === 'openai' ? '/chat/completions' : '/messages'}`,
    externalModelName: name,
    maxRetries: 0,
  };
}

const schema = {
  functionDeclarations: [
    {
      name: 'invoke_subagent',
      parametersJsonSchema: {
        type: 'object',
        properties: {
          Subagents: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                Model: { type: 'string', enum: ['inherit', 'flash', 'pro'] },
                Prompt: { type: 'string' },
                TypeName: { type: 'string' },
              },
              required: ['Model', 'Prompt'],
            },
          },
        },
        required: ['Subagents'],
      },
    },
  ],
};

const sse = (res: http.ServerResponse, value: unknown) =>
  res.write(`data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`);

function reply(res: http.ServerResponse, provider: Provider, stream: boolean, invocations?: Invocation[]) {
  const args = { Subagents: invocations };
  const tool = { name: 'invoke_subagent', args };
  if (!stream) {
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify(
        provider === 'google'
          ? {
              candidates: [
                {
                  content: { role: 'model', parts: invocations ? [{ functionCall: tool }] : [{ text: 'CHILD OK' }] },
                  finishReason: 'STOP',
                },
              ],
            }
          : provider === 'openai'
            ? {
                choices: [
                  {
                    message: invocations
                      ? {
                          tool_calls: [
                            {
                              id: 'shared-id',
                              type: 'function',
                              function: { name: tool.name, arguments: JSON.stringify(args) },
                            },
                          ],
                        }
                      : { content: 'CHILD OK' },
                    finish_reason: invocations ? 'tool_calls' : 'stop',
                  },
                ],
              }
            : {
                id: 'shared-message',
                type: 'message',
                content: invocations
                  ? [{ type: 'tool_use', id: 'shared-id', name: tool.name, input: args }]
                  : [{ type: 'text', text: 'CHILD OK' }],
                stop_reason: invocations ? 'tool_use' : 'end_turn',
              },
      ),
    );
    return;
  }
  res.setHeader('Content-Type', 'text/event-stream');
  if (provider === 'google') {
    sse(res, {
      candidates: [
        {
          content: { role: 'model', parts: invocations ? [{ functionCall: tool }] : [{ text: 'CHILD OK' }] },
          finishReason: 'STOP',
        },
      ],
    });
  } else if (provider === 'openai') {
    if (invocations) {
      const json = JSON.stringify(args);
      const middle = Math.floor(json.length / 2);
      sse(res, {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'shared-id',
                  type: 'function',
                  function: { name: tool.name, arguments: json.slice(0, middle) },
                },
              ],
            },
          },
        ],
      });
      sse(res, {
        choices: [
          {
            delta: { tool_calls: [{ index: 0, function: { arguments: json.slice(middle) } }] },
            finish_reason: 'tool_calls',
          },
        ],
      });
    } else {
      sse(res, { choices: [{ delta: { content: 'CHILD OK' }, finish_reason: 'stop' }] });
    }
    sse(res, '[DONE]');
  } else {
    sse(res, { type: 'message_start', message: { id: 'shared-message' } });
    if (invocations) {
      const json = JSON.stringify(args);
      const middle = Math.floor(json.length / 2);
      sse(res, {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'shared-id', name: tool.name, input: {} },
      });
      for (const fragment of [json.slice(0, middle), json.slice(middle)])
        sse(res, {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: fragment },
        });
    } else {
      sse(res, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      sse(res, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'CHILD OK' } });
    }
    sse(res, { type: 'content_block_stop', index: 0 });
    sse(res, { type: 'message_delta', delta: { stop_reason: invocations ? 'tool_use' : 'end_turn' } });
    sse(res, { type: 'message_stop' });
  }
  res.end();
}

async function providerFixture(choose: (request: UpstreamRequest) => Invocation[] | undefined) {
  const requests: UpstreamRequest[] = [];
  const url = await serve(async (req, res) => {
    const payload = await readBody(req);
    const provider = req.url!.split('/')[1] as Provider;
    const externalModel = String(payload.model || decodeURIComponent(req.url!.match(/\/models\/([^:]+):/)?.[1] || ''));
    const request = { provider, model: externalModel, payload, wire: JSON.stringify(payload) };
    requests.push(request);
    reply(res, provider, payload.stream === true || req.url!.includes('streamGenerateContent'), choose(request));
  });
  return { url, requests };
}

async function request(
  url: string,
  selected: string,
  text: string,
  stream: boolean,
  identity: string,
  contents?: unknown[],
) {
  return fetch(`${url}/v1internal:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: selected,
      request: {
        labels: { cascade_id: identity },
        contents: contents || [{ role: 'user', parts: [{ text }] }],
        tools: [schema],
      },
    }),
  });
}

async function toolCalls(response: Response, stream: boolean) {
  expect(response.status).toBe(200);
  const payloads: Payload[] = stream
    ? (await response.text())
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => JSON.parse(line.slice(6)))
    : [await response.json()];
  return payloads
    .flatMap((payload) => (payload.response || payload).candidates || [])
    .flatMap((candidate) => candidate.content?.parts || [])
    .flatMap((part) => (part.functionCall ? [part.functionCall] : []));
}

const crossProviderCases = (['google', 'openai', 'anthropic'] as const).flatMap((parentProvider) =>
  (['google', 'openai', 'anthropic'] as const)
    .filter((childProvider) => childProvider !== parentProvider)
    .flatMap((childProvider) => [false, true].map((stream) => ({ parentProvider, childProvider, stream }))),
);

describe('subagent bridge through native-shaped HTTP requests', () => {
  it.each(crossProviderCases)(
    'routes the first child $parentProvider → $childProvider, stream=$stream',
    async ({ parentProvider, childProvider, stream }) => {
      const upstream = await providerFixture((input) =>
        input.model === 'parent'
          ? [{ Model: 'models/child', Prompt: 'Execute CHILD TASK', TypeName: 'research' }]
          : undefined,
      );
      const parent = model(upstream.url, parentProvider, 'parent');
      const child = model(upstream.url, childProvider, 'child');
      const proxy = await fixture([parent, child], upstream.url);
      const [call] = await toolCalls(
        await request(proxy, parent.name, 'Start parent', stream, 'parent-cascade'),
        stream,
      );
      expect(call.name).toBe('invoke_subagent');
      const [invocation] = call.args.Subagents;
      expect(invocation).toMatchObject({ Model: 'inherit', TypeName: 'research' });
      expect(invocation.Prompt).toContain('Execute CHILD TASK');
      expect(invocation.Prompt).not.toBe('Execute CHILD TASK');
      expect(invocation.Prompt).not.toContain(child.name);

      // No functionResponse has been sent back to the parent when the child starts.
      const response = await request(proxy, parent.name, invocation.Prompt, stream, 'child-cascade');
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('CHILD OK');
      expect(upstream.requests.map(({ provider, model: selected }) => [provider, selected])).toEqual([
        [parentProvider, 'parent'],
        [childProvider, 'child'],
      ]);
      expect(upstream.requests[1].wire).toContain('Execute CHILD TASK');
      expect(upstream.requests[1].wire).not.toContain('antigravity-subagent-route:');
      // The provider sees a selectable custom-model field, not the IDE's tier-only enum.
      expect(upstream.requests[0].wire).toContain('exact saved name');
      expect(upstream.requests[0].wire).not.toContain('"enum":["inherit","flash","pro"]');
    },
  );

  it('keeps concurrent ID-less Google parents and two siblings independent', async () => {
    const upstream = await providerFixture((input) =>
      input.model === 'parent'
        ? input.wire.includes('PARENT A')
          ? [
              { Model: 'models/child-a', Prompt: 'TASK A' },
              { Model: 'models/child-b', Prompt: 'TASK A SIBLING' },
            ]
          : [{ Model: 'models/child-b', Prompt: 'TASK B' }]
        : undefined,
    );
    const parent = model(upstream.url, 'google', 'parent');
    const children = [model(upstream.url, 'openai', 'child-a'), model(upstream.url, 'anthropic', 'child-b')];
    const proxy = await fixture([parent, ...children], upstream.url);
    const [[callA], [callB]] = await Promise.all([
      request(proxy, parent.name, 'PARENT A', true, 'parent-a').then((response) => toolCalls(response, true)),
      request(proxy, parent.name, 'PARENT B', true, 'parent-b').then((response) => toolCalls(response, true)),
    ]);
    const all = [...callA.args.Subagents, ...callB.args.Subagents];
    expect(new Set(all.map((invocation) => invocation.Prompt)).size).toBe(3);
    const responses = await Promise.all([
      request(proxy, parent.name, callB.args.Subagents[0].Prompt, true, 'child-b'),
      request(proxy, parent.name, callA.args.Subagents[1].Prompt, false, 'child-a-sibling'),
      request(proxy, parent.name, callA.args.Subagents[0].Prompt, true, 'child-a'),
    ]);
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('CHILD OK');
    }
    const childRequests = upstream.requests.filter((input) => input.model !== 'parent');
    expect(childRequests).toHaveLength(3);
    for (const childRequest of childRequests) {
      expect(childRequest.model).toBe(
        childRequest.wire.includes('TASK A') && !childRequest.wire.includes('SIBLING') ? 'child-a' : 'child-b',
      );
      expect(childRequest.wire).not.toContain('antigravity-subagent-route:');
    }
  });

  it('does not route a parent history or a later built-in invocation to a stale custom child', async () => {
    const builtinRequests: Record<string, unknown>[] = [];
    const builtin = await serve(async (req, res) => {
      builtinRequests.push(await readBody(req));
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: 'BUILTIN OK' }] } }] } }));
    });
    const upstream = await providerFixture((input) =>
      input.model === 'parent'
        ? [{ Model: input.wire.includes('USE BUILTIN') ? 'pro' : 'models/child', Prompt: 'Fresh task' }]
        : undefined,
    );
    const parent = model(upstream.url, 'google', 'parent');
    const child = model(upstream.url, 'openai', 'child');
    const proxy = await fixture([parent, child], builtin);
    const [first] = await toolCalls(await request(proxy, parent.name, 'USE CUSTOM', false, 'parent'), false);
    const history = [
      { role: 'model', parts: [{ functionCall: first }] },
      {
        role: 'user',
        parts: [
          { functionResponse: { name: first.name, response: { output: '{"conversationId":"existing-child"}' } } },
        ],
      },
      { role: 'user', parts: [{ text: 'USE BUILTIN' }] },
    ];
    const [next] = await toolCalls(await request(proxy, parent.name, '', false, 'parent', history), false);
    expect(next.args.Subagents).toEqual([{ Model: 'pro', Prompt: 'Fresh task' }]);
    expect(upstream.requests.map((input) => input.model)).toEqual(['parent', 'parent']);
    expect(upstream.requests[1].wire).not.toContain('antigravity-subagent-route:');
    expect(upstream.requests[1].wire).toContain(child.name);
    const builtinResponse = await request(
      proxy,
      'gemini-native-pro',
      next.args.Subagents[0].Prompt,
      false,
      'builtin-child',
    );
    expect(builtinResponse.status).toBe(200);
    expect(await builtinResponse.text()).toContain('BUILTIN OK');
    expect(builtinRequests).toHaveLength(1);
    expect(builtinRequests[0].model).toBe('gemini-native-pro');
    expect(upstream.requests).toHaveLength(2);
  });

  it('rejects an expired or unknown opaque route instead of forwarding it upstream', async () => {
    const upstream = await providerFixture(() => undefined);
    const parent = model(upstream.url, 'google', 'parent');
    const proxy = await fixture([parent], upstream.url);
    const response = await request(
      proxy,
      parent.name,
      'Task\n\n[antigravity-subagent-route:11111111-1111-4111-8111-111111111111]',
      false,
      'unknown-child',
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(upstream.requests).toHaveLength(0);
  });

  it.each(['openai', 'anthropic'] as const)(
    'restores ID-less Google parent history when switching to %s',
    async (provider) => {
      const upstream = await providerFixture((input) =>
        input.model === 'parent-google' ? [{ Model: 'models/child', Prompt: 'Preserve the child task' }] : undefined,
      );
      const originalParent = model(upstream.url, 'google', 'parent-google');
      const switchedParent = model(upstream.url, provider, 'parent-switched');
      const child = model(upstream.url, 'google', 'child');
      const proxy = await fixture([originalParent, switchedParent, child], upstream.url);
      const [first] = await toolCalls(await request(proxy, originalParent.name, 'Start parent', true, 'parent'), true);
      const childResponse = await request(proxy, originalParent.name, first.args.Subagents[0].Prompt, false, 'child');
      expect(childResponse.status).toBe(200);
      expect(await childResponse.text()).toContain('CHILD OK');
      const history = [
        { role: 'user', parts: [{ text: 'Start parent' }] },
        { role: 'model', parts: [{ functionCall: first }] },
        {
          role: 'user',
          parts: [{ functionResponse: { name: first.name, response: { output: '{"conversationId":"child"}' } } }],
        },
        { role: 'user', parts: [{ text: 'Summarize the result' }] },
      ];
      const response = await request(proxy, switchedParent.name, '', true, 'parent', history);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('CHILD OK');
      expect(upstream.requests.map((input) => [input.provider, input.model])).toEqual([
        ['google', 'parent-google'],
        ['google', 'child'],
        [provider, 'parent-switched'],
      ]);
      const wire = upstream.requests[2].wire;
      expect(wire).toContain('Preserve the child task');
      expect(wire).not.toContain('antigravity-subagent-route:');
      const messages = upstream.requests[2].payload.messages as {
        role: string;
        tool_calls?: { function: { arguments: string } }[];
        content?: { type: string; input?: unknown }[];
      }[];
      const assistant = messages.find((message) => message.role === 'assistant')!;
      const replay =
        provider === 'openai'
          ? JSON.parse(assistant.tool_calls![0].function.arguments)
          : assistant.content!.find((content) => content.type === 'tool_use')!.input;
      expect(replay).toEqual({ Subagents: [{ Model: child.name, Prompt: 'Preserve the child task' }] });
    },
  );

  it('rejects contradictory known markers without dispatching either route', async () => {
    const upstream = await providerFixture((input) =>
      input.model === 'parent'
        ? [
            { Model: 'models/child-a', Prompt: 'TASK A' },
            { Model: 'models/child-b', Prompt: 'TASK B' },
          ]
        : undefined,
    );
    const parent = model(upstream.url, 'google', 'parent');
    const proxy = await fixture(
      [parent, model(upstream.url, 'openai', 'child-a'), model(upstream.url, 'anthropic', 'child-b')],
      upstream.url,
    );
    const [call] = await toolCalls(await request(proxy, parent.name, 'Start parent', false, 'parent'), false);
    const contradictory = call.args.Subagents.map((invocation) => invocation.Prompt).join('\n');
    const response = await request(proxy, parent.name, contradictory, false, 'child');
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(upstream.requests).toHaveLength(1);
  });

  it.each([true, false])(
    'keeps the actual child model for grandchildren with explicit inherit=%s',
    async (explicit) => {
      const upstream = await providerFixture((input) =>
        input.model === 'parent'
          ? [{ Model: 'models/child', Prompt: 'SPAWN NESTED' }]
          : input.wire.includes('SPAWN NESTED')
            ? [{ ...(explicit ? { Model: 'inherit' } : {}), Prompt: 'Final grandchild task' }]
            : undefined,
      );
      const parent = model(upstream.url, 'google', 'parent');
      const child = model(upstream.url, 'anthropic', 'child');
      const proxy = await fixture([parent, child], upstream.url);
      const [parentCall] = await toolCalls(await request(proxy, parent.name, 'Start parent', true, 'parent'), true);
      const [childCall] = await toolCalls(
        await request(proxy, parent.name, parentCall.args.Subagents[0].Prompt, true, 'child'),
        true,
      );
      const grandchildResponse = await request(
        proxy,
        parent.name,
        childCall.args.Subagents[0].Prompt,
        true,
        'grandchild',
      );
      expect(grandchildResponse.status).toBe(200);
      expect(await grandchildResponse.text()).toContain('CHILD OK');
      expect(upstream.requests.map((input) => [input.provider, input.model])).toEqual([
        ['google', 'parent'],
        ['anthropic', 'child'],
        ['anthropic', 'child'],
      ]);
      expect(upstream.requests[2].wire).not.toContain('antigravity-subagent-route:');
      // Continuations remain on the same child after the transport marker is stripped.
      const continued = await request(proxy, parent.name, 'Continue grandchild', false, 'grandchild');
      expect(continued.status).toBe(200);
      expect(await continued.text()).toContain('CHILD OK');
      expect(upstream.requests[3].model).toBe('child');
    },
  );

  it('routes standard Gemini generation before a built-in URL selector reaches Google', async () => {
    const upstream = await providerFixture((input) =>
      input.model === 'parent' ? [{ Model: 'models/child', Prompt: 'STANDARD CHILD TASK' }] : undefined,
    );
    const parent = model(upstream.url, 'openai', 'parent');
    const child = model(upstream.url, 'google', 'child');
    const proxy = await fixture([parent, child], upstream.url);
    const [call] = await toolCalls(await request(proxy, parent.name, 'Start parent', false, 'parent'), false);
    const response = await fetch(`${proxy}/v1beta/models/gemini-native-pro:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId: 'standard-child',
        contents: [{ role: 'user', parts: [{ text: call.args.Subagents[0].Prompt }] }],
      }),
    });
    expect(response.status).toBe(200);
    const wire = await response.text();
    expect(wire).toContain('CHILD OK');
    expect(wire).not.toContain('"response":');
    expect(upstream.requests.map((input) => [input.provider, input.model])).toEqual([
      ['openai', 'parent'],
      ['google', 'child'],
    ]);
    expect(upstream.requests[1].wire).not.toContain('antigravity-subagent-route:');
  });

  it.each(['cloud-code', 'standard'] as const)(
    'restores parent history when switching to a native model over %s',
    async (transport) => {
      const builtinRequests: Record<string, unknown>[] = [];
      const builtin = await serve(async (req, res) => {
        builtinRequests.push(await readBody(req));
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'NATIVE PARENT OK' }] } }] }));
      });
      const upstream = await providerFixture((input) =>
        input.model === 'parent' ? [{ Model: 'models/child', Prompt: 'Preserve the original task' }] : undefined,
      );
      const parent = model(upstream.url, 'google', 'parent');
      const child = model(upstream.url, 'openai', 'child');
      const proxy = await fixture([parent, child], builtin);
      const [call] = await toolCalls(await request(proxy, parent.name, 'Start parent', false, 'parent'), false);
      const history = [
        { role: 'user', parts: [{ text: 'Start parent' }] },
        { role: 'model', parts: [{ functionCall: call }] },
        {
          role: 'user',
          parts: [{ functionResponse: { name: call.name, response: { output: '{"conversationId":"child"}' } } }],
        },
        { role: 'user', parts: [{ text: 'Summarize with the native model' }] },
      ];
      const response =
        transport === 'cloud-code'
          ? await fetch(`${proxy}/v1internal:generateContent`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                model: 'gemini-native-pro',
                conversationId: 'parent',
                sessionId: 'outer-session',
                request: { contents: history, tools: [schema] },
              }),
            })
          : await fetch(`${proxy}/v1beta/models/gemini-native-pro:generateContent`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ labels: { cascade_id: 'parent' }, contents: history, tools: [schema] }),
            });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('NATIVE PARENT OK');
      expect(upstream.requests).toHaveLength(1);
      expect(builtinRequests).toHaveLength(1);
      const forwarded = builtinRequests[0];
      expect(JSON.stringify(forwarded)).not.toContain('antigravity-subagent-route:');
      const nativeBody = (transport === 'cloud-code' ? forwarded.request : forwarded) as {
        contents: { parts: { functionCall?: ToolCall }[] }[];
        tools: unknown[];
      };
      expect(nativeBody.contents[1].parts[0].functionCall?.args).toEqual({
        Subagents: [{ Model: child.name, Prompt: 'Preserve the original task' }],
      });
      expect(nativeBody.tools).toEqual([schema]);
      if (transport === 'cloud-code') {
        expect(forwarded.conversationId).toBe('parent');
        expect(forwarded.sessionId).toBe('outer-session');
        expect(nativeBody).not.toHaveProperty('conversationId');
        expect(nativeBody).not.toHaveProperty('sessionId');
      }
      expect(JSON.stringify(nativeBody.tools)).toContain('"enum":["inherit","flash","pro"]');
    },
  );

  it('rejects malformed Cloud Code contents before any upstream request', async () => {
    const upstream = await providerFixture(() => undefined);
    const parent = model(upstream.url, 'google', 'parent');
    const proxy = await fixture([parent], upstream.url);
    const response = await fetch(`${proxy}/v1internal:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: parent.name, request: { contents: {} } }),
    });
    expect(response.status).toBe(400);
    expect(upstream.requests).toHaveLength(0);
  });

  it.each([false, true])(
    'rewrites a stock-model parent invoke_subagent so a custom child spawns, stream=%s',
    async (stream) => {
      const googleRequests: Record<string, unknown>[] = [];
      const builtin = await serve(async (req, res) => {
        googleRequests.push(await readBody(req));
        const candidate = {
          content: {
            role: 'model',
            parts: [
              {
                functionCall: {
                  name: 'invoke_subagent',
                  args: {
                    Subagents: [
                      { Model: 'models/child', Prompt: 'Execute CHILD TASK', TypeName: 'research' },
                    ],
                  },
                },
              },
            ],
          },
          finishReason: 'STOP',
        };
        if (stream) {
          res.setHeader('Content-Type', 'text/event-stream');
          sse(res, { candidates: [candidate] });
          res.end();
        } else {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ candidates: [candidate] }));
        }
      });
      const upstream = await providerFixture(() => undefined);
      const child = model(upstream.url, 'openai', 'child');
      const proxy = await fixture([child], builtin);

      const [call] = await toolCalls(
        await request(proxy, 'gemini-native-pro', 'Start parent', stream, 'parent-cascade'),
        stream,
      );
      expect(call.name).toBe('invoke_subagent');
      const [invocation] = call.args.Subagents;
      expect(invocation).toMatchObject({ Model: 'inherit', TypeName: 'research' });
      expect(invocation.Prompt).toContain('Execute CHILD TASK');
      expect(invocation.Prompt).toContain('antigravity-subagent-route:');
      expect(googleRequests).toHaveLength(1);

      // The stock child inherits the native parent's model but carries the marker;
      // the first child request is rerouted to the configured custom model.
      const childResponse = await request(proxy, 'gemini-native-pro', invocation.Prompt, stream, 'child-cascade');
      expect(childResponse.status).toBe(200);
      expect(await childResponse.text()).toContain('CHILD OK');
      expect(upstream.requests.map((input) => [input.provider, input.model])).toEqual([
        ['openai', 'child'],
      ]);
    },
  );
});
