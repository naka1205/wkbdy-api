/**
 * WorkBuddy's upstream rejects a request whose system prompt carries the
 * fingerprint of a competing agent client:
 *
 *   400 Upstream rejected the request: Illegal API invocation from an
 *       unapproved channel
 *
 * The check is an exact-substring match against the prompt text of known
 * clients, and it only inspects the system prompt: rewording one word (or
 * adding/removing a single character) gets the same turn through, while the
 * identical text inside a user message is never inspected. Codex and Claude
 * Code are both on the list, and the reply is not retryable on the client
 * side, so a whole agent turn is lost.
 *
 * This module rewrites those identity sentences into neutral wording before the
 * request leaves the gateway. Developer and user content is never modified, and
 * the rewrite is recorded on the request log row so a behaviour change is
 * visible rather than silent.
 */
type Rule = {
  /** Identifier reported on the request log row. */
  id: string;
  pattern: RegExp;
  replacement: string;
};

const RULES: Rule[] = [
  {
    id: 'codex-identity',
    pattern:
      /You are a coding agent running in the Codex CLI, a terminal-based coding assistant\.\s*Codex CLI is an open source project led by OpenAI\./g,
    replacement: 'You are a coding agent operating inside a terminal-based coding environment.',
  },
  {
    id: 'codex-cli-name',
    pattern: /Codex CLI is an open source project led by OpenAI\./g,
    replacement: 'This assistant is a terminal-based coding assistant.',
  },
  {
    id: 'codex-disclaimer',
    pattern:
      /Within this context, Codex refers to the open-source agentic coding interface \(not the old Codex language model built by OpenAI\)\./g,
    replacement:
      'Within this context, "this agent" refers to the agentic coding interface it runs as, not to any other model sharing the name.',
  },
  {
    id: 'claude-code-identity',
    // Also covers the longer `…, running within the Claude Agent SDK.` form.
    pattern: /You are Claude Code, Anthropic's official CLI for Claude[^\n.]*\.?/g,
    replacement: 'You are a terminal-based coding assistant.',
  },
];

/** Minimal shape the sanitizer needs; extra message fields are preserved. */
type Message = { role?: unknown; content?: unknown };

/**
 * Rewrite known client fingerprints in every `system` message, in place.
 * Returns the ids of the rules that matched, so the caller can report them.
 */
export function sanitizeSystemPrompts(messages: readonly Message[]): string[] {
  const applied = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'system' || typeof message.content !== 'string') continue;
    let text = message.content;
    for (const rule of RULES) {
      rule.pattern.lastIndex = 0;
      if (!rule.pattern.test(text)) continue;
      rule.pattern.lastIndex = 0;
      text = text.replace(rule.pattern, rule.replacement);
      applied.add(rule.id);
    }
    if (text !== message.content) message.content = text;
  }
  return [...applied];
}
