/**
 * In-memory conversation state + pure message assembly for the AI Helper.
 *
 * Pure (no `vscode` import) so it is unit-testable headless and so the provider
 * stays a thin translator to `vscode.LanguageModelChatMessage`. History is held
 * only in memory by design — transcripts can contain telemetry-derived content,
 * so nothing is persisted to disk.
 */

/** Role of a stored turn. */
export type ChatRole = 'user' | 'assistant';

/** One stored conversation turn. */
export interface ChatMessage {
  role: ChatRole;
  text: string;
}

/** A turn assembled for the model request (same shape; mapped to the LM API by the provider). */
export type AssembledMessage = ChatMessage;

/** Mutable in-memory transcript for one AI Helper view. */
export class Conversation {
  private readonly messages: ChatMessage[] = [];

  /** Append a turn. Empty/whitespace-only text is ignored. */
  append(role: ChatRole, text: string): void {
    if (text.trim().length === 0) {
      return;
    }
    this.messages.push({ role, text });
  }

  /** Reset to an empty transcript ("New chat"). */
  clear(): void {
    this.messages.length = 0;
  }

  /** Whether no turns have been recorded yet. */
  isEmpty(): boolean {
    return this.messages.length === 0;
  }

  /** The recorded turns, oldest first (read-only snapshot). */
  get history(): readonly ChatMessage[] {
    return [...this.messages];
  }
}

/**
 * Assemble the messages for one model request: a leading `user` turn carrying the
 * grounding preamble (the Copilot LM API has no system role), followed by the
 * conversation history in order. The current user turn is expected to already be
 * the last entry of `history`.
 */
export function assembleMessages(
  preamble: string,
  history: readonly ChatMessage[],
): AssembledMessage[] {
  return [{ role: 'user', text: preamble }, ...history];
}
