import { RESPONSIBILITIES, type OperatorConfig } from '../config.js';

export function validConfig(overrides: Partial<OperatorConfig> = {}): OperatorConfig {
  const ownership = Object.fromEntries(
    RESPONSIBILITIES.map((responsibility) => [
      responsibility,
      {
        currentOwner: responsibility === 'reconciliation' ? 'product-pipeline' : 'marketplace-connect',
        productPipelineAccess: 'read-only',
      },
    ]),
  ) as OperatorConfig['ownership'];

  return {
    schemaVersion: 1,
    project: 'product-pipeline',
    lane: 'production-shadow',
    mode: 'read-only',
    dryRun: true,
    writesEnabled: false,
    identities: {
      shopifyStoreDomain: 'usedcameragear.myshopify.com',
      ebayEnvironment: 'production',
      ebaySellerAccount: 'usedcam-0',
      marketplaceConnectAccount: 'usedcam-0',
    },
    ownership,
    orders: {
      importEnabled: false,
      historicalBackfill: false,
      cutoverWatermarkUtc: null,
    },
    testLane: {
      shopifyVariantGids: [],
      skus: [],
      ebayListingIds: [],
      responsibilities: [],
    },
    audit: {
      logPath: '.local/operator-audit/operator-cli.jsonl',
    },
    ...overrides,
  };
}
