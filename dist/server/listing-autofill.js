/**
 * Listing preparation: fill the eBay item specifics a new product is missing
 * BEFORE publish day (operator ask 2026-10-06: "can the program add the
 * information needed to go on eBay whenever a new product is added instead
 * of waiting for the day we push it — and anything not published, use the
 * agent to work through it").
 *
 * Title derivation (camera/lens derivers, Shopify vendor/SKU) already fills
 * the SOURCE layer at read time. What remains are aspects eBay requires that
 * no rule can derive mechanically — the L73 gate's "eBay requires X, Y" skips
 * an employee had to hand-fill. Here Claude proposes those values from the
 * product's own title, brand, and description; every proposal is validated
 * against eBay's taxonomy (SELECTION_ONLY aspects must match an eBay value
 * exactly) and saved as a LOCAL draft revision only.
 *
 * ZERO provider writes happen here. The saved draft is reviewable and
 * editable in the listing editor like any operator save, and publishing still
 * runs the full per-item ceremony (preflight → dispatch → reconcile).
 */
import { info, warn } from '../utils/logger.js';
/** Aspects eBay enforces at publish on camera/lens categories without the
 * taxonomy marking them required (L67). Filled when the category lists them,
 * but never blocking. */
const BEST_EFFORT_ASPECTS = ['Brand', 'Model', 'Type'];
const MAX_DESCRIPTION_CHARS = 3_000;
const MAX_VALUE_CHARS = 65;
const PLACEHOLDER_VALUE = /^(unknown|n\/?a|not applicable|not specified|none|-+)$/iu;
/** One attempt per item per source state per day — no repeated AI spend on
 * an item whose title simply does not say. */
const ATTEMPT_MEMO_MS = 24 * 60 * 60 * 1000;
const MAX_MEMO_ENTRIES = 2_000;
/** The note publish-all has always attached to a first draft (L69). */
export function initialConditionDescription(chart) {
    return ((chart ? `${chart} ` : '') + 'The photographs show the exact item for sale.').slice(0, 1000);
}
function parseSpecifics(raw) {
    if (!raw)
        return {};
    try {
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
            return {};
        const result = {};
        for (const [name, values] of Object.entries(parsed)) {
            if (Array.isArray(values)) {
                result[name] = values.filter((value) => typeof value === 'string');
            }
        }
        return result;
    }
    catch {
        return {};
    }
}
function sortedJson(specifics) {
    // The create manifest demands alphabetically sorted keys (L67).
    const sorted = {};
    for (const key of Object.keys(specifics).sort())
        sorted[key] = specifics[key];
    return JSON.stringify(sorted);
}
function plainText(html) {
    if (!html)
        return null;
    const text = html.replace(/<[^>]*>/gu, ' ').replace(/&nbsp;/gu, ' ').replace(/\s+/gu, ' ').trim();
    return text === '' ? null : text.slice(0, MAX_DESCRIPTION_CHARS);
}
/**
 * Keep only proposals for aspects we asked about, with a usable value; a
 * SELECTION_ONLY aspect accepts only one of eBay's own values (canonical
 * casing), since anything else is refused at publish and burns an intent.
 */
export function validateProposals(needed, proposals) {
    const byName = new Map(needed.map((aspect) => [aspect.name.toLowerCase(), aspect]));
    const accepted = {};
    for (const proposal of proposals) {
        if (typeof proposal?.name !== 'string' || typeof proposal.value !== 'string')
            continue;
        const aspect = byName.get(proposal.name.trim().toLowerCase());
        if (!aspect || accepted[aspect.name])
            continue;
        const value = proposal.value.replace(/\s+/gu, ' ').trim();
        if (value === '' || value.length > MAX_VALUE_CHARS || PLACEHOLDER_VALUE.test(value))
            continue;
        if (aspect.mode === 'SELECTION_ONLY') {
            const match = aspect.values.find((allowed) => allowed.toLowerCase() === value.toLowerCase());
            if (match === undefined)
                continue;
            accepted[aspect.name] = [match];
        }
        else {
            accepted[aspect.name] = [value];
        }
    }
    return accepted;
}
const attemptMemo = new Map();
/** Test hook. */
export function resetAutofillMemo() { attemptMemo.clear(); }
/**
 * Fill the draft's missing item specifics for one catalog row. `extraAspects`
 * names aspects eBay refused a publish for (it enforces more than the
 * taxonomy marks required, L67); they count as blocking.
 */
export async function autofillListingAspects(catalogId, dependencies, options = {}) {
    const now = dependencies.now ?? Date.now;
    const dto = await dependencies.draftService.get(catalogId);
    const revisionDigest = dto.revision?.revisionDigest ?? null;
    const categoryId = dto.sections.listing.category.draft ?? dto.sections.listing.category.shopify;
    if (categoryId === null) {
        return { status: 'unavailable', filled: [], stillMissing: [], revisionDigest };
    }
    const taxonomy = await dependencies.getCategoryAspects(categoryId);
    if (!taxonomy.available) {
        return { status: 'unavailable', filled: [], stillMissing: [], revisionDigest };
    }
    const existing = parseSpecifics(dto.sections.content.itemSpecifics.draft
        ?? dto.sections.content.itemSpecifics.shopify);
    const present = new Set(Object.keys(existing).map((name) => name.toLowerCase()));
    const extra = new Set((options.extraAspects ?? []).map((name) => name.toLowerCase()));
    const blocking = [];
    const bestEffort = [];
    for (const raw of taxonomy.aspects) {
        const aspect = { name: raw.name, mode: raw.mode ?? 'FREE_TEXT', values: raw.values ?? [] };
        const key = aspect.name.toLowerCase();
        if (present.has(key))
            continue;
        if (raw.required || extra.has(key))
            blocking.push(aspect);
        else if (BEST_EFFORT_ASPECTS.some((name) => name.toLowerCase() === key))
            bestEffort.push(aspect);
        extra.delete(key);
    }
    // A refused aspect the taxonomy does not even list is still asked for.
    for (const name of options.extraAspects ?? []) {
        if (extra.has(name.toLowerCase()) && !present.has(name.toLowerCase())) {
            blocking.push({ name, mode: 'FREE_TEXT', values: [] });
        }
    }
    const blockingNames = blocking.map((aspect) => aspect.name);
    if (blocking.length === 0 && bestEffort.length === 0) {
        return { status: 'complete', filled: [], stillMissing: [], revisionDigest };
    }
    if (dependencies.propose === null) {
        return { status: blocking.length === 0 ? 'complete' : 'incomplete', filled: [], stillMissing: blockingNames, revisionDigest };
    }
    const needed = [...blocking, ...bestEffort];
    const memoKey = `${catalogId}|${dto.base.sourceDigest}|${needed.map((aspect) => aspect.name).sort().join(',')}`;
    const lastAttempt = attemptMemo.get(memoKey);
    if (lastAttempt !== undefined && now() - lastAttempt < ATTEMPT_MEMO_MS) {
        return { status: blocking.length === 0 ? 'complete' : 'incomplete', filled: [], stillMissing: blockingNames, revisionDigest };
    }
    if (attemptMemo.size >= MAX_MEMO_ENTRIES)
        attemptMemo.clear();
    attemptMemo.set(memoKey, now());
    const title = dto.sections.listing.title.draft ?? dto.sections.listing.title.shopify ?? '';
    let accepted = {};
    try {
        accepted = validateProposals(needed, await dependencies.propose({
            title,
            description: plainText(dto.sections.content.description.draft
                ?? dto.sections.content.description.shopify),
            existing,
            needed,
        }));
    }
    catch (error) {
        warn(`LISTING_AUTOFILL_PROPOSAL_FAILED ${error instanceof Error ? error.message.slice(0, 120) : ''}`);
    }
    const filled = Object.keys(accepted);
    const stillMissing = blockingNames.filter((name) => accepted[name] === undefined);
    if (filled.length === 0) {
        return { status: stillMissing.length === 0 ? 'complete' : 'incomplete', filled: [], stillMissing, revisionDigest };
    }
    // Save every existing draft leaf unchanged; only item specifics move. The
    // draft's specifics override replaces the source set wholesale, so the
    // merge carries the derived source aspects along.
    const field = (value) => value.draft;
    const sections = dto.sections;
    const saved = await dependencies.draftService.save({
        schemaVersion: 1,
        action: 'save_local_draft',
        catalogId,
        expectedRevisionDigest: revisionDigest,
        base: { sourceDigest: dto.base.sourceDigest, ebayDigest: dto.base.ebayDigest },
        draft: {
            title: field(sections.listing.title),
            category: field(sections.listing.category),
            condition: field(sections.listing.condition),
            conditionDescription: dto.revision === null
                ? (sections.listing.conditionDescription.draft
                    ?? initialConditionDescription(sections.listing.conditionDescription.shopify))
                : field(sections.listing.conditionDescription),
            description: field(sections.content.description),
            images: field(sections.content.images),
            itemSpecifics: sortedJson({ ...existing, ...accepted }),
            fulfillmentPolicyId: field(sections.delivery.fulfillmentPolicyId),
            paymentPolicyId: field(sections.delivery.paymentPolicyId),
            returnPolicyId: field(sections.delivery.returnPolicyId),
            merchantLocation: field(sections.delivery.merchantLocation),
        },
    }, options.actor ?? 'listing-autofill');
    info(`[Listing Autofill] ${catalogId}: filled ${filled.join(', ')}`
        + (stillMissing.length > 0 ? `; still needs ${stillMissing.join(', ')}` : ''));
    return {
        status: stillMissing.length === 0 ? 'filled' : 'incomplete',
        filled,
        stillMissing,
        revisionDigest: saved.revision?.revisionDigest ?? revisionDigest,
    };
}
/** eBay 25002 names one missing aspect per refusal (L62). */
export function missingAspectFromProviderMessage(message) {
    if (!message)
        return null;
    const match = /item specific ([^.]{1,65}?) is missing/iu.exec(message);
    return match ? match[1].trim() : null;
}
const SYSTEM_PROMPT = 'You fill in eBay item specifics for listings from Used Camera Gear, a store '
    + 'selling used cameras, lenses, lighting and accessories. You are given a product\'s title, '
    + 'description, the item specifics it already has, and the item specifics it still needs. '
    + 'For each needed aspect, give a value ONLY when the title or description states it, or when '
    + 'it is a fixed, well-known specification of the exact product model named (for example the '
    + 'mount or maximum aperture of a specific lens model). Never guess: if you are not certain, '
    + 'leave that aspect out. When allowed values are listed, use one of them exactly. Values are '
    + 'short (under 65 characters) and buyer-facing — no notes or explanations.';
const RESPONSE_SCHEMA = {
    type: 'object',
    properties: {
        aspects: {
            type: 'array',
            items: {
                type: 'object',
                properties: { name: { type: 'string' }, value: { type: 'string' } },
                required: ['name', 'value'],
                additionalProperties: false,
            },
        },
    },
    required: ['aspects'],
    additionalProperties: false,
};
function proposalPrompt(input) {
    const needed = input.needed.map((aspect) => {
        const allowed = aspect.values.length > 0
            ? (aspect.mode === 'SELECTION_ONLY' ? ` — must be one of: ${aspect.values.join(' | ')}`
                : ` — common values: ${aspect.values.join(' | ')}`)
            : '';
        return `- ${aspect.name}${allowed}`;
    }).join('\n');
    return `TITLE\n${input.title}\n\nDESCRIPTION\n${input.description ?? '(none)'}\n\n`
        + `ITEM SPECIFICS ALREADY SET\n${JSON.stringify(input.existing)}\n\n`
        + `ITEM SPECIFICS NEEDED\n${needed}`;
}
/**
 * The Claude-backed proposer, or null when no Claude connection is armed
 * (Settings → Connections or ANTHROPIC_API_KEY; L79). Raw fetch like the
 * incident diagnosis: no new dependencies (project rule).
 */
export async function createClaudeAspectProposer(dependencies = {}) {
    const readKey = dependencies.readKey
        ?? (await import('./connections.js')).readAnthropicKey;
    const resolved = readKey();
    if (resolved === null)
        return null;
    const key = resolved.key;
    const fetchImpl = dependencies.fetchImpl ?? fetch;
    const model = process.env.LISTING_AUTOFILL_MODEL ?? 'claude-opus-5-5';
    const call = async (input, withFallbacks) => fetchImpl('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'x-api-key': key,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
            ...(withFallbacks ? { 'anthropic-beta': 'server-side-fallback-2026-07-01' } : {}),
        },
        body: JSON.stringify({
            model,
            max_tokens: 4_000,
            output_config: { effort: 'low', format: { type: 'json_schema', schema: RESPONSE_SCHEMA } },
            ...(withFallbacks ? { fallbacks: 'default' } : {}),
            system: SYSTEM_PROMPT,
            messages: [{ role: 'user', content: proposalPrompt(input) }],
        }),
    });
    return async (input) => {
        let response = await call(input, true);
        // The fallback beta is an enhancement; never let it be the reason the
        // fill does not run.
        if (response.status === 400)
            response = await call(input, false);
        if (response.status !== 200)
            throw new Error(`autofill http ${response.status}`);
        const body = await response.json();
        if (body.stop_reason === 'refusal')
            return [];
        const text = (body.content ?? [])
            .filter((block) => block.type === 'text' && typeof block.text === 'string')
            .map((block) => block.text)
            .join('')
            .trim();
        const parsed = JSON.parse(text);
        return Array.isArray(parsed.aspects)
            ? parsed.aspects
            : [];
    };
}
