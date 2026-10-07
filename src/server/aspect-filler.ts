/**
 * Item-specifics agent — writes the required eBay aspects a ready item is
 * missing, so publish-all no longer stops at "eBay requires Mount, Type…".
 *
 * LOCAL-DRAFT ONLY: this module never talks to eBay or Shopify. It asks
 * Claude (the Settings → Connections key) for values grounded in the
 * item's own title and description, and the caller saves them as an
 * ordinary draft revision. Publishing still runs the full per-item
 * ceremony, and the operator can override any value in the editor.
 *
 * Accuracy guards (a wrong aspect is a wrong public listing):
 * - only the category's REQUIRED aspects that are missing are requested
 * - the model must mark each value confident; an aspect it cannot settle
 *   (or that does not exist for this kind of item, e.g. Focal Length on a
 *   teleconverter) gets eBay's sanctioned "Does not apply" rather than a
 *   guess, so publishing never waits on manual entry (operator, 2026-10-07)
 * - SELECTION_ONLY aspects must match one of eBay's own values exactly
 * - names/values obey the draft validator's bounds (≤65 chars)
 * - any transport/parse failure fills nothing (the gate's skip stands)
 */

export type MissingAspect = Readonly<{
  name: string;
  mode: 'FREE_TEXT' | 'SELECTION_ONLY';
  values: readonly string[];
}>;

export type AspectFillRequest = Readonly<{
  title: string;
  description: string | null;
  categoryId: string;
  existing: Readonly<Record<string, readonly string[]>>;
  missing: readonly MissingAspect[];
}>;

export type AspectFillResult = Readonly<{
  filled: Record<string, string[]>;
  unresolved: string[];
}>;

/** Raw model call: returns the JSON text of the structured response. */
export type AspectModelCall = (system: string, user: string, schema: object) => Promise<string>;

const MAX_VALUE = 65;
export const DOES_NOT_APPLY = 'Does not apply';
const MAX_DESCRIPTION = 6_000;

const SYSTEM = 'You fill in eBay item specifics for a used camera-gear store. '
  + 'For each requested aspect, give the value that is true of THIS exact item, '
  + 'using its title and description and well-established product facts for the '
  + 'named model (e.g. a lens model\'s mount, focal length, maximum aperture, and '
  + 'focus type). When the aspect lists allowed values, answer with one of them '
  + 'exactly as written. When an aspect does not exist for this kind of item '
  + '(e.g. Focal Length on a teleconverter or a camera strap), answer '
  + '"Does not apply" with confident true. Set confident to false whenever the '
  + 'item text and the named model do not settle the value — a wrong value '
  + 'misdescribes a real listing; an unsure aspect is published as "Does not apply".';

const SCHEMA = {
  type: 'object',
  properties: {
    aspects: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          value: { type: 'string' },
          confident: { type: 'boolean' },
        },
        required: ['name', 'value', 'confident'],
        additionalProperties: false,
      },
    },
  },
  required: ['aspects'],
  additionalProperties: false,
} as const;

function plainText(html: string | null): string | null {
  if (html === null) return null;
  const text = html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  return text.length === 0 ? null : text.slice(0, MAX_DESCRIPTION);
}

function userPrompt(request: AspectFillRequest): string {
  const lines = [
    `TITLE: ${request.title}`,
    `EBAY CATEGORY ID: ${request.categoryId}`,
    `ITEM SPECIFICS ALREADY SET: ${JSON.stringify(request.existing)}`,
    `DESCRIPTION: ${plainText(request.description) ?? '(none)'}`,
    '',
    'REQUIRED ASPECTS TO FILL:',
  ];
  for (const aspect of request.missing) {
    lines.push(aspect.mode === 'SELECTION_ONLY' && aspect.values.length > 0
      ? `- ${aspect.name} (choose exactly one of: ${aspect.values.join(' | ')})`
      : `- ${aspect.name}${aspect.values.length > 0
        ? ` (common values: ${aspect.values.slice(0, 25).join(' | ')})` : ''}`);
  }
  return lines.join('\n');
}

/** Validate the model's answer against the request; never trusts it blindly. */
export function acceptAspectAnswer(request: AspectFillRequest, answerJson: string): AspectFillResult {
  const filled: Record<string, string[]> = {};
  let answers: unknown = null;
  try {
    answers = (JSON.parse(answerJson) as { aspects?: unknown }).aspects;
  } catch {
    answers = null;
  }
  const byName = new Map<string, { value: string; confident: boolean }>();
  if (Array.isArray(answers)) {
    for (const entry of answers as Array<Record<string, unknown>>) {
      if (entry && typeof entry.name === 'string' && typeof entry.value === 'string'
        && typeof entry.confident === 'boolean') {
        byName.set(entry.name.trim().toLowerCase(),
          { value: entry.value.trim(), confident: entry.confident });
      }
    }
  }
  for (const aspect of request.missing) {
    const answer = byName.get(aspect.name.toLowerCase());
    if (!answer || !answer.confident || answer.value.length === 0
      || answer.value.length > MAX_VALUE) continue;
    let value: string | undefined = answer.value;
    if (aspect.mode === 'SELECTION_ONLY' && aspect.values.length > 0) {
      value = aspect.values.find((allowed) => allowed.toLowerCase() === answer.value.toLowerCase());
    }
    if (value !== undefined) filled[aspect.name] = [value];
  }
  // Anything still unanswered gets eBay's "Does not apply" instead of
  // blocking the publish: always for free-text aspects, and for
  // selection-only aspects when eBay's own list offers it.
  for (const aspect of request.missing) {
    if (filled[aspect.name] !== undefined) continue;
    const offered = aspect.values.find((allowed) => allowed.toLowerCase() === DOES_NOT_APPLY.toLowerCase());
    if (aspect.mode !== 'SELECTION_ONLY' || aspect.values.length === 0) {
      filled[aspect.name] = [DOES_NOT_APPLY];
    } else if (offered !== undefined) {
      filled[aspect.name] = [offered];
    }
  }
  const unresolved = request.missing.map((aspect) => aspect.name)
    .filter((name) => filled[name] === undefined);
  return { filled, unresolved };
}

async function defaultModelCall(system: string, user: string, schema: object): Promise<string> {
  const resolved = (await import('./connections.js')).readAnthropicKey();
  if (resolved === null) throw new Error('unarmed');
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': resolved.key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.ASPECT_FILL_MODEL ?? 'claude-opus-5-5',
      max_tokens: 4_000,
      output_config: { effort: 'medium', format: { type: 'json_schema', schema } },
      system,
      messages: [{ role: 'user', content: user }],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (response.status !== 200) throw new Error(`aspect fill http ${response.status}`);
  const body = await response.json() as {
    stop_reason?: string;
    content?: Array<{ type: string; text?: string }>;
  };
  if (body.stop_reason !== 'end_turn') throw new Error(`aspect fill stop ${body.stop_reason ?? 'none'}`);
  return (body.content ?? [])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('');
}

/** True when a Claude key is connected (env or Settings → Connections). */
export async function aspectFillerArmed(): Promise<boolean> {
  try {
    return (await import('./connections.js')).readAnthropicKey() !== null;
  } catch {
    return false;
  }
}

export async function fillMissingAspects(
  request: AspectFillRequest,
  callModel: AspectModelCall = defaultModelCall,
): Promise<AspectFillResult> {
  if (request.missing.length === 0) return { filled: {}, unresolved: [] };
  try {
    const answer = await callModel(SYSTEM, userPrompt(request), SCHEMA);
    return acceptAspectAnswer(request, answer);
  } catch {
    return { filled: {}, unresolved: request.missing.map((aspect) => aspect.name) };
  }
}
