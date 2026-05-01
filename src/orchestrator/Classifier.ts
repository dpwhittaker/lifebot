import type { ThreadSummary } from '../threads/types';

export type ClassifierResult =
  | { kind: 'match'; threadId: string; confidence: 'low' | 'medium' | 'high' }
  | { kind: 'new'; suggestedName?: string }
  | { kind: 'unknown' };

export type ClassifierOptions = {
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
};

const SYSTEM_INSTRUCTION = `You decide whether a short audio snippet belongs to one of the user's existing recurring conversations ("threads"), to a brand-new topic, or whether you can't tell yet.

Be conservative. The user might mention another thread in passing ("this reminds me of D&D") without actually wanting to switch contexts — that is a passing reference, NOT a thread match. Only return a "thread" match when the conversation is *clearly and substantively* about that thread's topic.

Reply ONLY as JSON of the shape:
{"choice": "thread", "threadId": "...", "confidence": "low|medium|high"}
or
{"choice": "new", "suggestedName": "<short name for a new thread>"}
or
{"choice": "unknown"}

Use confidence "high" only when you're sure. "unknown" is fine — the user's current thread will stay selected.`;

/**
 * Classify the start of an ad-hoc session into one of the user's threads,
 * or signal that it's a new topic. Costs one Gemini call.
 */
export async function classifyConversation(
  opts: ClassifierOptions,
  threads: ThreadSummary[],
  heard: string,
): Promise<ClassifierResult> {
  if (!heard.trim()) return { kind: 'unknown' };
  const fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);

  const directory = threads
    .map((t) => {
      const group = t.group ? ` [${t.group}]` : '';
      const desc = t.summary?.trim()
        ? ` — ${t.summary.trim().replace(/\n+/g, ' ').slice(0, 200)}`
        : t.systemPromptPreview
          ? ` — ${t.systemPromptPreview.slice(0, 100)}`
          : '';
      return `- id=${t.id}${group} name="${t.name}"${desc}`;
    })
    .join('\n');

  const userText =
    `Existing threads:\n${directory || '(none yet)'}\n\n` +
    `Conversation start (transcript):\n"${heard.slice(0, 600)}"`;

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${opts.model}:generateContent` +
    `?key=${encodeURIComponent(opts.apiKey)}`;

  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
  };

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return { kind: 'unknown' };
  }
  if (!res.ok) return { kind: 'unknown' };
  const json = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  return parseClassifierResponse(text, threads);
}

function parseClassifierResponse(raw: string, threads: ThreadSummary[]): ClassifierResult {
  const stripped = raw
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '');
  let parsed: {
    choice?: string;
    threadId?: string;
    confidence?: string;
    suggestedName?: string;
  };
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return { kind: 'unknown' };
  }
  if (parsed.choice === 'thread' && typeof parsed.threadId === 'string') {
    if (!threads.some((t) => t.id === parsed.threadId)) return { kind: 'unknown' };
    const conf = (parsed.confidence ?? 'medium') as 'low' | 'medium' | 'high';
    return { kind: 'match', threadId: parsed.threadId, confidence: conf };
  }
  if (parsed.choice === 'new') {
    return {
      kind: 'new',
      suggestedName: typeof parsed.suggestedName === 'string' ? parsed.suggestedName : undefined,
    };
  }
  return { kind: 'unknown' };
}
