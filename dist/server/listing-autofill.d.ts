type Field = Readonly<{
    shopify: string | null;
    draft: string | null;
}>;
export type AutofillDraftDto = Readonly<{
    revision: null | Readonly<{
        revisionDigest: string;
    }>;
    base: Readonly<{
        sourceDigest: string;
        ebayDigest: string;
    }>;
    sections: Readonly<{
        listing: Readonly<{
            title: Field;
            category: Field;
            condition: Field;
            conditionDescription: Field;
        }>;
        content: Readonly<{
            description: Field;
            images: Field;
            itemSpecifics: Field;
        }>;
        delivery: Readonly<{
            fulfillmentPolicyId: Field;
            paymentPolicyId: Field;
            returnPolicyId: Field;
            merchantLocation: Field;
        }>;
    }>;
}>;
export type AutofillDraftService = Readonly<{
    get: (catalogId: string) => Promise<AutofillDraftDto>;
    save: (request: unknown, actor: string) => Promise<{
        revision: {
            revisionDigest: string;
        } | null;
    }>;
}>;
export type NeededAspect = Readonly<{
    name: string;
    mode: 'FREE_TEXT' | 'SELECTION_ONLY';
    values: readonly string[];
}>;
export type AspectProposalInput = Readonly<{
    title: string;
    description: string | null;
    existing: Readonly<Record<string, readonly string[]>>;
    needed: readonly NeededAspect[];
}>;
/** Returns raw name → value proposals; validation happens afterwards. */
export type AspectProposer = (input: AspectProposalInput) => Promise<ReadonlyArray<{
    name: string;
    value: string;
}>>;
export type AutofillResult = Readonly<{
    status: 'complete' | 'filled' | 'incomplete' | 'unavailable';
    /** Aspect names this pass added to the draft. */
    filled: readonly string[];
    /** Publish-blocking aspects still empty after this pass. */
    stillMissing: readonly string[];
    /** The draft revision to publish from (new when this pass saved). */
    revisionDigest: string | null;
}>;
export type AutofillDependencies = Readonly<{
    draftService: AutofillDraftService;
    getCategoryAspects: (categoryId: string) => Promise<Readonly<{
        available: boolean;
        aspects: ReadonlyArray<Readonly<{
            name: string;
            required: boolean;
            mode?: 'FREE_TEXT' | 'SELECTION_ONLY';
            values?: readonly string[];
        }>>;
    }>>;
    /** null when no Claude connection is armed: the pass still reports gaps. */
    propose: AspectProposer | null;
    now?: () => number;
}>;
/** The note publish-all has always attached to a first draft (L69). */
export declare function initialConditionDescription(chart: string | null): string;
/**
 * Keep only proposals for aspects we asked about, with a usable value; a
 * SELECTION_ONLY aspect accepts only one of eBay's own values (canonical
 * casing), since anything else is refused at publish and burns an intent.
 */
export declare function validateProposals(needed: readonly NeededAspect[], proposals: ReadonlyArray<{
    name: string;
    value: string;
}>): Record<string, string[]>;
/** Test hook. */
export declare function resetAutofillMemo(): void;
/**
 * Fill the draft's missing item specifics for one catalog row. `extraAspects`
 * names aspects eBay refused a publish for (it enforces more than the
 * taxonomy marks required, L67); they count as blocking.
 */
export declare function autofillListingAspects(catalogId: string, dependencies: AutofillDependencies, options?: Readonly<{
    extraAspects?: readonly string[];
    actor?: string;
}>): Promise<AutofillResult>;
/** eBay 25002 names one missing aspect per refusal (L62). */
export declare function missingAspectFromProviderMessage(message: string | null): string | null;
/**
 * The Claude-backed proposer, or null when no Claude connection is armed
 * (Settings → Connections or ANTHROPIC_API_KEY; L79). Raw fetch like the
 * incident diagnosis: no new dependencies (project rule).
 */
export declare function createClaudeAspectProposer(dependencies?: Readonly<{
    fetchImpl?: typeof fetch;
    readKey?: () => {
        key: string;
    } | null;
}>): Promise<AspectProposer | null>;
export {};
