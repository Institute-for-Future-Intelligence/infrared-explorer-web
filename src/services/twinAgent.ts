/**
 * The wire to the twin agent's conversation (functions/src/twinAgent/; docs/digital-twin-plan.md
 * §43.5): the same request and chunk shapes as the recording AI's (services/recordingAi.ts), one more
 * chunk — the twin record the finish tool wrote — and `fresh`, which starts the conversation over.
 */
import { httpsCallable } from 'firebase/functions';
import type { QaModel, TwinBuildingRecord } from '../types';
import { firebaseFunctions } from './firebase';
import {
  RecTurnError,
  type RecStreamChunk,
  type RecTurnInput,
  type RecTurnOutcome,
  type RecTurnRequest,
} from './recordingAi';

export type TwinAgentChunk = RecStreamChunk | { t: 'twin'; record: TwinBuildingRecord };

export interface TwinAgentOutcome extends RecTurnOutcome {
  /** The finish tool wrote the twin during this request. */
  finished?: boolean;
}

const TURN_TIMEOUT_MS = 570_000;

function callableCode(e: unknown): string | null {
  const code = (e as { code?: unknown })?.code;
  return typeof code === 'string' ? code.replace(/^functions\//, '') : null;
}

export function streamTwinAgentTurn(opts: {
  expId: string;
  input: RecTurnInput;
  model: QaModel;
  browserTools: readonly string[];
  /** With the first message: throw the last conversation away and start again. */
  fresh?: boolean;
  onChunk: (chunk: TwinAgentChunk) => void;
}): RecTurnRequest & { done: Promise<TwinAgentOutcome> } {
  const controller = new AbortController();
  const done = (async (): Promise<TwinAgentOutcome> => {
    const fn = httpsCallable<Record<string, unknown>, TwinAgentOutcome, TwinAgentChunk>(
      firebaseFunctions,
      'twinAgentTurn',
      {
        timeout: TURN_TIMEOUT_MS,
      },
    );
    try {
      const { stream, data } = await fn.stream(
        {
          expId: opts.expId,
          input: opts.input,
          model: opts.model,
          browserTools: [...opts.browserTools],
          ...(opts.fresh ? { fresh: true } : {}),
        },
        { signal: controller.signal },
      );
      void data.catch(() => {});
      for await (const chunk of stream) {
        if (chunk && typeof chunk === 'object' && 't' in chunk) {
          try {
            opts.onChunk(chunk);
          } catch {
            // a rendering problem must not kill the stream
          }
        }
      }
      return await data;
    } catch (e) {
      if (controller.signal.aborted) throw new RecTurnError('Cancelled.', null, true);
      const raw = (e as Error)?.message ?? '';
      throw new RecTurnError(raw || 'Something went wrong.', callableCode(e));
    }
  })();
  return { done, abort: () => controller.abort() };
}
