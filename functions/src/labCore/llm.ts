/*
 * One chat-model call, streamed.
 *
 * OpenAI goes through /v1/responses: that is where its GPT-5 models reason
 * while calling function tools (on /chat/completions a request with tools
 * has to pin reasoning off), and where its hosted web search rides along
 * with our function tools (OPENAI_WEB_SEARCH). The other providers this
 * project holds a key for (Google Gemini through its OpenAI-compatibility endpoint, xAI,
 * DeepSeek) speak /chat/completions with function tools and image parts, so
 * one call path serves them all; only the endpoint, the output-cap field and
 * a few provider extras differ. Both paths hand back the same ChatResult.
 */

import {
  MAX_OUTPUT_TOKENS,
  OPENAI_REASONING_EFFORT,
  OPENAI_WEB_SEARCH,
  type ChatModelSpec,
  type ChatProvider,
} from './config';
import {apiKeyFor} from './secrets';

export type ChatContentPart =
  | {type: 'text'; text: string}
  | {type: 'image_url'; image_url: {url: string}};

export type ChatMessage =
  | {role: 'system'; content: string}
  | {role: 'user'; content: string | ChatContentPart[]}
  | {
      role: 'assistant';
      content: string;
      tool_calls?: {
        id: string;
        type: 'function';
        function: {name: string; arguments: string};
        /** Gemini's thought signature for the call, as its endpoint handed it out (ToolCall.signature). */
        extra_content?: {google: {thought_signature: string}};
      }[];
    }
  | {role: 'tool'; tool_call_id: string; content: string};

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  /** The raw JSON argument string as the model wrote it. */
  args: string;
  /**
   * Gemini's thought signature: Google's OpenAI-compatible endpoint puts one
   * on the first tool call of a reply (extra_content.google.thought_signature).
   * It has to go back with the call (wireMessages), so it is stored with it.
   */
  signature?: string;
}

export interface ChatUsage {
  input: number;
  output: number;
  /** Tokens spent thinking, when the provider says (part of `output`). */
  reasoning?: number;
}

/** One step of a web search the provider ran for the model inside a reply (OpenAI's hosted web_search). */
export interface WebSearch {
  /** 'search', or 'open_page' / 'find_in_page' for a page it read. */
  action: string;
  queries?: string[];
  url?: string;
  pattern?: string;
  /** The pages a search turned up. */
  sources?: string[];
}

export interface ChatResult {
  text: string;
  toolCalls: ToolCall[];
  usage: ChatUsage | null;
  finishReason: string | null;
  provider: ChatProvider;
  model: string;
  ms: number;
  /** The web searches the model ran within this reply, in order. */
  webSearches?: WebSearch[];
}

export interface ChatCallbacks {
  /** A piece of the reply's text. */
  onText?: (delta: string) => void;
  /** A tool call's argument JSON as it grows (index = the call's position). */
  onToolArgs?: (index: number, name: string, argsSoFar: string) => void;
  /** A web search inside the reply started (true) or finished (false). */
  onWebSearch?: (searching: boolean) => void;
  /** The stream was cut and the same model is being called again from the start; what came so far is void. */
  onRetry?: (why: string) => void;
}

interface Endpoint {
  url: string;
  maxTokensParam: 'max_tokens' | 'max_completion_tokens';
  /** Extra body fields; `tools` says whether the request declares tools. */
  extras: (tools: boolean) => Record<string, unknown>;
  streamUsage: boolean;
}

function endpointFor(provider: ChatProvider): Endpoint {
  switch (provider) {
    case 'google':
      return {
        url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
        maxTokensParam: 'max_tokens',
        extras: () => ({}),
        // stream_options is not documented on this endpoint; a 400 would cost the turn.
        streamUsage: false,
      };
    case 'xai':
      return {
        url: 'https://api.x.ai/v1/chat/completions',
        maxTokensParam: 'max_tokens',
        extras: () => ({}),
        streamUsage: true,
      };
    case 'openai':
      // not used: OpenAI goes through the Responses API (callResponses)
      return {
        url: 'https://api.openai.com/v1/chat/completions',
        maxTokensParam: 'max_completion_tokens',
        extras: tools => (tools ? {reasoning_effort: 'none'} : {}),
        streamUsage: true,
      };
    case 'deepseek':
    default:
      return {
        url: 'https://api.deepseek.com/chat/completions',
        maxTokensParam: 'max_tokens',
        // Thinking works with tools, but a run took eight times as long and
        // one call's output came within reach of MAX_OUTPUT_TOKENS (10-09).
        extras: () => ({thinking: {type: 'disabled'}}),
        streamUsage: true,
      };
  }
}

/** A model error that is worth trying the next model for (nothing was streamed yet). */
export class ModelCallError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly streamed: boolean,
  ) {
    super(message);
  }
}

const CALL_TIMEOUT_MS = 240_000;

let idCounter = 0;
function freshCallId(): string {
  idCounter = (idCounter + 1) % 1_000_000;
  return `call_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

/** POST a streamed request; rejects with ModelCallError when the provider says no. */
async function post(url: string, key: string, body: unknown, signal: AbortSignal, spec: ChatModelSpec): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', Authorization: `Bearer ${key}`},
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    throw new ModelCallError(`request failed: ${(err as Error)?.message ?? err}`, null, false);
  }
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '');
    console.error('labProjects: model call failed', spec, res.status, detail.slice(0, 800));
    throw new ModelCallError(`HTTP ${res.status}: ${detail.slice(0, 300)}`, res.status, false);
  }
  return res;
}

/** Each `data:` line of a server-sent event stream, parsed, in order. */
async function readSse(body: ReadableStream<Uint8Array>, onJson: (json: any) => void): Promise<void> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = '';
  for (;;) {
    const {done, value} = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, {stream: true});
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) {
        continue;
      }
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') {
        continue;
      }
      let json: any;
      try {
        json = JSON.parse(payload);
      } catch {
        continue;
      }
      onJson(json);
    }
  }
}

/**
 * What Gemini accepts in place of a thought signature it did not hand out.
 * Gemini 3 refuses a request whose current turn (everything since the last
 * user message) holds a tool call without one — HTTP 400 "Function call is
 * missing a thought_signature" — and a call can lack one when another model
 * of the list wrote it or it was stored before signatures were kept. Google
 * documents this value for such calls; accepted by gemini-3.8-flash
 * (checked 2026-11-02, tmp probe), as was leaving earlier turns unsigned.
 */
export const SKIP_SIGNATURE = 'skip_thought_signature_validator';

/**
 * The conversation as one chat/completions provider takes it. Gemini gets each
 * call's thought signature back where it handed it out, and a reply whose
 * calls carry none gets SKIP_SIGNATURE on its first (the call a signature
 * rides on). The others never see the field: an endpoint that does not know
 * it may refuse the request.
 */
export function wireMessages(provider: ChatProvider, messages: ChatMessage[]): ChatMessage[] {
  return messages.map(m => {
    if (m.role !== 'assistant' || !m.tool_calls?.length) {
      return m;
    }
    if (provider !== 'google') {
      return {...m, tool_calls: m.tool_calls.map(({extra_content: _gone, ...c}) => c)};
    }
    if (m.tool_calls.some(c => c.extra_content?.google?.thought_signature)) {
      return m;
    }
    const [first, ...rest] = m.tool_calls;
    return {...m, tool_calls: [{...first, extra_content: {google: {thought_signature: SKIP_SIGNATURE}}}, ...rest]};
  });
}

/** One streamed call. Rejects with ModelCallError. */
export async function callChat(
  spec: ChatModelSpec,
  messages: ChatMessage[],
  tools: ToolSchema[],
  cb: ChatCallbacks = {},
): Promise<ChatResult> {
  return spec.provider === 'openai' ? callResponses(spec, messages, tools, cb) : callCompletions(spec, messages, tools, cb);
}

// ------------------------------------------------------- chat/completions

async function callCompletions(
  spec: ChatModelSpec,
  messages: ChatMessage[],
  tools: ToolSchema[],
  cb: ChatCallbacks,
): Promise<ChatResult> {
  const started = Date.now();
  const ep = endpointFor(spec.provider);
  const key = apiKeyFor(spec.provider);
  const body: Record<string, unknown> = {
    model: spec.model,
    [ep.maxTokensParam]: MAX_OUTPUT_TOKENS,
    stream: true,
    messages: wireMessages(spec.provider, messages),
    ...(tools.length > 0
      ? {
          tools: tools.map(t => ({
            type: 'function',
            function: {name: t.name, description: t.description, parameters: t.parameters},
          })),
        }
      : {}),
    ...(ep.streamUsage ? {stream_options: {include_usage: true}} : {}),
    ...ep.extras(tools.length > 0),
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  let streamed = false;
  try {
    const res = await post(ep.url, key, body, controller.signal, spec);
    let text = '';
    let finishReason: string | null = null;
    let usage: ChatUsage | null = null;
    const acc: {id: string; name: string; args: string; signature?: string}[] = [];
    await readSse(res.body!, json => {
      if (json?.error) {
        throw new ModelCallError(`stream error: ${JSON.stringify(json.error).slice(0, 300)}`, null, streamed);
      }
      const u = json?.usage;
      if (u && typeof u === 'object') {
        usage = {
          input: Number(u.prompt_tokens ?? u.input_tokens ?? 0) || 0,
          output: Number(u.completion_tokens ?? u.output_tokens ?? 0) || 0,
        };
        const r = Number(u.completion_tokens_details?.reasoning_tokens);
        if (Number.isFinite(r) && r > 0) {
          usage.reasoning = r;
        }
      }
      const choice = json?.choices?.[0];
      if (!choice) {
        return;
      }
      if (typeof choice.finish_reason === 'string') {
        finishReason = choice.finish_reason;
      }
      const delta = choice.delta ?? {};
      if (typeof delta.content === 'string' && delta.content) {
        text += delta.content;
        streamed = true;
        cb.onText?.(delta.content);
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = typeof tc.index === 'number' ? tc.index : acc.length;
          const slot = (acc[idx] ??= {id: '', name: '', args: ''});
          if (typeof tc.id === 'string' && tc.id) {
            slot.id = tc.id;
          }
          if (typeof tc.function?.name === 'string' && tc.function.name) {
            slot.name = tc.function.name;
          }
          if (typeof tc.function?.arguments === 'string') {
            slot.args += tc.function.arguments;
          }
          const signature = tc.extra_content?.google?.thought_signature;
          if (typeof signature === 'string' && signature) {
            slot.signature = signature;
          }
          streamed = true;
          cb.onToolArgs?.(idx, slot.name, slot.args);
        }
      }
    });
    const toolCalls: ToolCall[] = acc
      .filter(c => c && c.name)
      .map(c => ({
        id: c.id || freshCallId(),
        name: c.name,
        args: c.args || '{}',
        ...(c.signature ? {signature: c.signature} : {}),
      }));
    if (toolCalls.length === 0 && isMalformedCallReason(finishReason)) {
      // Gemini, through Google's OpenAI-compatible endpoint (2026-10-15,
      // project p5976be26): the model wrote a call whose arguments could not
      // be read, the provider dropped it and ended the reply after the text
      // ("I'm running that analysis now"). Nothing ran; the same call is
      // worth making again.
      throw new ModelCallError(`malformed function call: ${finishReason}`, null, streamed);
    }
    return {
      text,
      toolCalls,
      usage,
      finishReason,
      provider: spec.provider,
      model: spec.model,
      ms: Date.now() - started,
    };
  } catch (err) {
    if (err instanceof ModelCallError) {
      throw err;
    }
    throw new ModelCallError(`stream failed: ${(err as Error)?.message ?? err}`, null, streamed);
  } finally {
    clearTimeout(timer);
  }
}

// -------------------------------------------------------------- responses

const RESPONSES_URL = 'https://api.openai.com/v1/responses';

/**
 * The conversation as the Responses API takes it: the system text as
 * `instructions`, each user message as input parts (text, images as
 * input_image), the assistant's words as its message and each of its tool
 * calls as a function_call item, each result as a function_call_output. The
 * call ids are the ones stored with the turns, so a result finds its call.
 */
export function responsesInput(messages: ChatMessage[]): {instructions: string; input: Record<string, unknown>[]} {
  const instructions: string[] = [];
  const input: Record<string, unknown>[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      instructions.push(m.content);
    } else if (m.role === 'user') {
      const content =
        typeof m.content === 'string'
          ? [{type: 'input_text', text: m.content}]
          : m.content.map(p =>
              p.type === 'text' ? {type: 'input_text', text: p.text} : {type: 'input_image', image_url: p.image_url.url},
            );
      input.push({role: 'user', content});
    } else if (m.role === 'assistant') {
      if (m.content.trim()) {
        input.push({role: 'assistant', content: m.content});
      }
      for (const c of m.tool_calls ?? []) {
        input.push({type: 'function_call', call_id: c.id, name: c.function.name, arguments: c.function.arguments || '{}'});
      }
    } else {
      input.push({type: 'function_call_output', call_id: m.tool_call_id, output: m.content});
    }
  }
  return {instructions: instructions.join('\n\n'), input};
}

/** What a Responses stream has said so far. */
export interface ResponsesStream {
  text: string;
  /** Function calls in the order they were opened; `item` is the stream's own id for the call. */
  calls: {item: string; id: string; name: string; args: string}[];
  usage: ChatUsage | null;
  finishReason: string | null;
  /** A text delta or a call's arguments reached the caller. */
  streamed: boolean;
  done: boolean;
  /** The finished web-search steps, in order. */
  searches: WebSearch[];
}

export const emptyResponsesStream = (): ResponsesStream => ({
  text: '',
  calls: [],
  usage: null,
  finishReason: null,
  streamed: false,
  done: false,
  searches: [],
});

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** A finished web_search_call item as a WebSearch. */
function webSearchOf(item: any): WebSearch {
  const a = item?.action ?? {};
  const queries = strings(a.queries);
  if (queries.length === 0 && typeof a.query === 'string') {
    queries.push(a.query);
  }
  const sources = (Array.isArray(a.sources) ? a.sources : []).map((x: any) => x?.url).filter((u: unknown) => typeof u === 'string');
  return {
    action: typeof a.type === 'string' ? a.type : 'search',
    ...(queries.length ? {queries} : {}),
    ...(typeof a.url === 'string' ? {url: a.url} : {}),
    ...(typeof a.pattern === 'string' ? {pattern: a.pattern} : {}),
    ...(sources.length ? {sources} : {}),
  };
}

/**
 * One streamed event of the Responses API folded into the state. Throws
 * ModelCallError when the stream reports failure.
 */
export function responsesEvent(s: ResponsesStream, ev: any, cb: ChatCallbacks = {}): void {
  const type = typeof ev?.type === 'string' ? ev.type : '';
  const callAt = (item: string) => s.calls.findIndex(c => c.item === item);
  const tell = (i: number) => {
    s.streamed = true;
    cb.onToolArgs?.(i, s.calls[i].name, s.calls[i].args);
  };
  switch (type) {
    case 'error':
    case 'response.failed': {
      const detail = ev.response?.error ?? ev.error ?? ev;
      throw new ModelCallError(`stream error: ${JSON.stringify(detail).slice(0, 300)}`, null, s.streamed);
    }
    case 'response.output_text.delta': {
      if (typeof ev.delta === 'string' && ev.delta) {
        s.text += ev.delta;
        s.streamed = true;
        cb.onText?.(ev.delta);
      }
      return;
    }
    case 'response.web_search_call.in_progress':
      cb.onWebSearch?.(true);
      return;
    case 'response.web_search_call.completed':
      cb.onWebSearch?.(false);
      return;
    case 'response.output_item.added':
    case 'response.output_item.done': {
      const item = ev.item;
      if (item?.type === 'web_search_call' && type === 'response.output_item.done') {
        s.searches.push(webSearchOf(item));
        return;
      }
      if (!item || item.type !== 'function_call') {
        return;
      }
      const key = typeof item.id === 'string' ? item.id : `#${ev.output_index}`;
      let i = callAt(key);
      if (i < 0) {
        s.calls.push({item: key, id: '', name: '', args: ''});
        i = s.calls.length - 1;
      }
      const c = s.calls[i];
      if (typeof item.call_id === 'string' && item.call_id) {
        c.id = item.call_id;
      }
      if (typeof item.name === 'string' && item.name) {
        c.name = item.name;
      }
      if (typeof item.arguments === 'string' && item.arguments.length >= c.args.length) {
        c.args = item.arguments;
      }
      tell(i);
      return;
    }
    case 'response.function_call_arguments.delta': {
      const i = callAt(typeof ev.item_id === 'string' ? ev.item_id : `#${ev.output_index}`);
      if (i >= 0 && typeof ev.delta === 'string') {
        s.calls[i].args += ev.delta;
        tell(i);
      }
      return;
    }
    case 'response.function_call_arguments.done': {
      const i = callAt(typeof ev.item_id === 'string' ? ev.item_id : `#${ev.output_index}`);
      if (i >= 0 && typeof ev.arguments === 'string') {
        s.calls[i].args = ev.arguments;
        tell(i);
      }
      return;
    }
    case 'response.completed':
    case 'response.incomplete': {
      const r = ev.response ?? {};
      const u = r.usage;
      if (u && typeof u === 'object') {
        s.usage = {
          input: Number(u.input_tokens ?? 0) || 0,
          output: Number(u.output_tokens ?? 0) || 0,
        };
        const reasoning = Number(u.output_tokens_details?.reasoning_tokens);
        if (Number.isFinite(reasoning) && reasoning > 0) {
          s.usage.reasoning = reasoning;
        }
      }
      // the finished response is authoritative for the calls it holds
      for (const item of Array.isArray(r.output) ? r.output : []) {
        if (item?.type === 'function_call') {
          responsesEvent(s, {type: 'response.output_item.done', item}, cb);
        }
      }
      const reason = r.incomplete_details?.reason;
      s.finishReason =
        type === 'response.incomplete'
          ? reason === 'max_output_tokens'
            ? 'length'
            : String(reason ?? 'incomplete')
          : s.calls.length > 0
          ? 'tool_calls'
          : 'stop';
      s.done = true;
      return;
    }
    default:
      return;
  }
}

async function callResponses(
  spec: ChatModelSpec,
  messages: ChatMessage[],
  tools: ToolSchema[],
  cb: ChatCallbacks,
): Promise<ChatResult> {
  const started = Date.now();
  const key = apiKeyFor(spec.provider);
  const {instructions, input} = responsesInput(messages);
  const webSearch = OPENAI_WEB_SEARCH && tools.length > 0;
  const body: Record<string, unknown> = {
    model: spec.model,
    ...(instructions ? {instructions} : {}),
    input,
    // Not strict: the schemas have optional fields, and a strict call fills
    // every field (zeros, empty strings), which reads as a moment at 0 s.
    ...(tools.length > 0
      ? {
          tools: [
            ...tools.map(t => ({
              type: 'function',
              name: t.name,
              description: t.description,
              parameters: t.parameters,
              strict: false,
            })),
            // run by OpenAI within the reply; the text cites what it found as links
            ...(webSearch ? [{type: 'web_search'}] : []),
          ],
        }
      : {}),
    // the pages each search turned up, kept with the turn
    ...(webSearch ? {include: ['web_search_call.action.sources']} : {}),
    // a reply without tools is a summary or a name: a little thought is plenty
    reasoning: {effort: tools.length > 0 ? OPENAI_REASONING_EFFORT : 'low'},
    max_output_tokens: MAX_OUTPUT_TOKENS,
    // nothing is kept on OpenAI's side: the turns are the record, and a call
    // is rebuilt from them every time
    store: false,
    stream: true,
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  const s = emptyResponsesStream();
  try {
    const res = await post(RESPONSES_URL, key, body, controller.signal, spec);
    await readSse(res.body!, ev => responsesEvent(s, ev, cb));
    if (!s.done) {
      throw new ModelCallError('stream ended before the response completed', null, s.streamed);
    }
    const toolCalls: ToolCall[] = s.calls
      .filter(c => c.name)
      .map(c => ({id: c.id || freshCallId(), name: c.name, args: c.args || '{}'}));
    return {
      text: s.text,
      toolCalls,
      usage: s.usage,
      finishReason: s.finishReason,
      provider: spec.provider,
      model: spec.model,
      ms: Date.now() - started,
      ...(s.searches.length ? {webSearches: s.searches} : {}),
    };
  } catch (err) {
    if (err instanceof ModelCallError) {
      throw err;
    }
    throw new ModelCallError(`stream failed: ${(err as Error)?.message ?? err}`, null, s.streamed);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A stream the provider cut (the socket closed under the response, or it
 * ended without the completed event) rather than refused: the provider said
 * nothing against the request, so the same call is worth making again. Our
 * own timeout (an abort) is not one.
 */
export function isCutStream(err: unknown): boolean {
  return (
    err instanceof ModelCallError &&
    err.status == null &&
    /^stream (failed|ended)/.test(err.message) &&
    !/abort/i.test(err.message)
  );
}

/** A finish reason saying the provider dropped a call it could not read (Gemini's MALFORMED_FUNCTION_CALL). */
export function isMalformedCallReason(finishReason: string | null): boolean {
  return finishReason != null && /MALFORMED_FUNCTION_CALL/i.test(finishReason);
}

/** A call the provider dropped as malformed: the same call is worth making again on the same model. */
export function isMalformedCall(err: unknown): boolean {
  return err instanceof ModelCallError && err.status == null && /^malformed function call/.test(err.message);
}

/** The pause before a cut stream is called again. */
export const RETRY_PAUSE_MS = 2500;

/**
 * Try each model in order until one answers. A cut stream, or a call the
 * provider dropped as malformed, is called again once on the same model,
 * after a pause (a cut is usually a moment's thing: 10-14 saw pairs of cuts
 * half a minute apart; a malformed call is the model's slip, and a second
 * try usually reads). A model that already streamed part of an answer is not
 * retried on another (the user saw the text; a retry of the same model tells
 * the app with onRetry, so it can drop that text).
 */
export async function callChatWithFallback(
  specs: ChatModelSpec[],
  messages: ChatMessage[],
  tools: ToolSchema[],
  cb: ChatCallbacks = {},
  opts: {call?: typeof callChat; pauseMs?: number} = {},
): Promise<ChatResult> {
  const call = opts.call ?? callChat;
  const pauseMs = opts.pauseMs ?? RETRY_PAUSE_MS;
  let last: unknown = null;
  for (const spec of specs) {
    let err: unknown;
    try {
      return await call(spec, messages, tools, cb);
    } catch (e) {
      err = e;
    }
    if (isCutStream(err) || isMalformedCall(err)) {
      console.warn('labProjects: calling the model again', spec, (err as Error).message);
      cb.onRetry?.((err as Error).message);
      await new Promise(res => setTimeout(res, pauseMs));
      try {
        return await call(spec, messages, tools, cb);
      } catch (e) {
        err = e;
      }
    }
    last = err;
    if (err instanceof ModelCallError && err.streamed) {
      throw err;
    }
    console.warn('labProjects: model failed, trying the next', spec, (err as Error)?.message);
  }
  throw last ?? new Error('No chat model configured.');
}

/** A short non-streamed completion without tools (history summaries). */
export async function summarize(
  specs: ChatModelSpec[],
  system: string,
  content: string,
): Promise<string> {
  const result = await callChatWithFallback(
    specs,
    [
      {role: 'system', content: system},
      {role: 'user', content},
    ],
    [],
  );
  return result.text.trim();
}
