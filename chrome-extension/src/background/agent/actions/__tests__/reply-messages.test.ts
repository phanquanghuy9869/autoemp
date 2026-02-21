import { describe, expect, it, vi } from 'vitest';
import type { AgentContext } from '../../types';
import { ActionBuilder } from '../builder';
import { getReplyMessagesActionSchema } from '../schemas';

describe('get_reply_messages action', () => {
  it('mock chrome i18n for test runtime', () => {
    (
      globalThis as unknown as {
        chrome: { i18n: { getMessage: (key: string, substitutions?: string[] | string) => string } };
      }
    ).chrome = {
      i18n: {
        getMessage: (_key: string, substitutions?: string[] | string) => {
          if (Array.isArray(substitutions) && substitutions.length > 0) {
            return substitutions[0] ?? '';
          }
          if (typeof substitutions === 'string') {
            return substitutions;
          }
          return 'ok';
        },
      },
    };
  });

  it('validates schema with non-empty incoming messages', () => {
    const result = getReplyMessagesActionSchema.schema.safeParse({
      intent: 'Reply to messages',
      incoming_messages: [
        {
          text: 'hello',
          sender_name: 'Alice',
          timestamp: '2026-02-21T10:30:00Z',
        },
      ],
    });

    expect(result.success).toBe(true);
  });

  it('returns ["Hello world"] payload', async () => {
    const emitEvent = vi.fn(async () => {});
    const context = {
      emitEvent,
    } as unknown as AgentContext;

    const builder = new ActionBuilder(context, {} as never);
    const actions = builder.buildDefaultActions();
    const replyAction = actions.find(action => action.name() === 'get_reply_messages');

    expect(replyAction).toBeDefined();

    const result = await replyAction!.call({
      intent: 'Reply now',
      incoming_messages: [
        {
          text: 'message 1',
          sender_name: 'Alice',
          timestamp: '2026-02-21T10:30:00Z',
        },
        {
          text: 'message 2',
          sender_name: 'Bob',
          timestamp: '2026-02-21T10:31:00Z',
        },
      ],
    });

    expect(result.includeInMemory).toBe(true);
    expect(result.extractedContent).toContain('["Hello world"]');
    expect(emitEvent).toHaveBeenCalledTimes(2);
  });
});
