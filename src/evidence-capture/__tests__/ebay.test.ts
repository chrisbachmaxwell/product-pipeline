import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  EBAY_READ_SCOPES,
  EbayEvidenceError,
  createEbayEvidenceCollector,
  createEbayOrderWindow,
  type EbayEvidenceCollectorConfig,
  type EbayGetRequest,
  type EbayGetResponse,
  type EbayInjectedGetTransport,
} from "../ebay.js";

const CAPTURED_AT = "2026-08-11T18:00:00.000Z";
const START = "2026-08-10T18:00:00.000Z";
const END = CAPTURED_AT;
const USER_ID = "immutable-seller-42";
const MARKETPLACE = "EBAY_US";

function baseConfig(
  overrides: Partial<EbayEvidenceCollectorConfig> = {},
): EbayEvidenceCollectorConfig {
  return {
    environment: "production",
    capturedAtUtc: CAPTURED_AT,
    expectedIdentity: {
      userId: USER_ID,
      registrationMarketplaceId: MARKETPLACE,
    },
    authorization: {
      kind: "ephemeral-user-access-attestation",
      scopes: [
        EBAY_READ_SCOPES.identity,
        EBAY_READ_SCOPES.inventory,
        EBAY_READ_SCOPES.fulfillment,
      ],
      issuedAtUtc: "2026-08-11T17:00:00.000Z",
      expiresAtUtc: "2026-08-11T19:00:00.000Z",
      refreshSupported: false,
      credentialProvidedToCollector: false,
    },
    limits: {
      timeoutMs: 1_000,
      maxResponseBytes: 256 * 1_024,
      maxTotalResponseBytes: 1_024 * 1_024,
      maxInventoryPages: 10,
      maxInventoryItems: 100,
      maxOfferPages: 100,
      maxOffers: 500,
      maxOrderPages: 10,
      maxOrders: 500,
    },
    ...overrides,
  };
}

function identityBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    userId: USER_ID,
    registrationMarketplaceId: MARKETPLACE,
    username: "must-not-be-retained",
    businessAccount: {
      name: "Sensitive Company Name",
      primaryContact: { email: "buyer@example.test", phone: "+1-555-0100" },
    },
    ...overrides,
  };
}

function inventoryItem(sku: string, overrides: Record<string, unknown> = {}) {
  return {
    sku,
    locale: "en_US",
    condition: "USED_EXCELLENT",
    inventoryItemGroupKeys: [`group-${sku}`],
    availability: { shipToLocationAvailability: { quantity: 1 } },
    product: {
      title: "Product title is intentionally discarded",
      description: "Potentially sensitive description",
      imageUrls: ["https://example.test/private.jpg"],
    },
    ...overrides,
  };
}

function inventoryItems(count: number, prefix = "SKU") {
  return Array.from({ length: count }, (_unused, index) =>
    inventoryItem(`${prefix}-${String(index).padStart(3, "0")}`),
  );
}

function offer(offerId: string, sku: string, overrides: Record<string, unknown> = {}) {
  return {
    offerId,
    sku,
    marketplaceId: MARKETPLACE,
    format: "FIXED_PRICE",
    status: "PUBLISHED",
    availableQuantity: 1,
    categoryId: "31388",
    pricingSummary: { price: { currency: "USD", value: "199.00" } },
    listing: {
      listingId: `listing-${offerId}`,
      listingStatus: "ACTIVE",
      soldQuantity: 0,
      listingOnHold: false,
    },
    merchantLocationKey: "private-warehouse",
    ...overrides,
  };
}

function order(
  orderId: string,
  creationDate: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    orderId,
    creationDate,
    lastModifiedDate: creationDate,
    orderFulfillmentStatus: "NOT_STARTED",
    buyer: { username: "private-buyer", email: "buyer@example.test" },
    fulfillmentStartInstructions: [{ shippingStep: { shipTo: { fullName: "Private Person" } } }],
    lineItems: [{ lineItemId: "private-line-item", title: "Private product title" }],
    ...overrides,
  };
}

interface StubTransport {
  readonly transport: EbayInjectedGetTransport;
  readonly requests: EbayGetRequest[];
}

function stubTransport(
  handler: (request: EbayGetRequest) => EbayGetResponse | Promise<EbayGetResponse>,
  provenance: EbayInjectedGetTransport["provenance"] = {
    kind: "fixture",
    fixtureId: "ebay-authoritative-read-v1",
  },
): StubTransport {
  const requests: EbayGetRequest[] = [];
  return {
    requests,
    transport: {
      provenance,
      get: async (request) => {
        requests.push(request);
        return handler(request);
      },
    },
  };
}

function simpleInventoryTransport(environment: "production" | "sandbox" = "production") {
  const identityHost =
    environment === "production" ? "apiz.ebay.com" : "apiz.sandbox.ebay.com";
  const sellHost = environment === "production" ? "api.ebay.com" : "api.sandbox.ebay.com";
  return stubTransport((request) => {
    const url = new URL(request.url);
    if (url.host === identityHost && url.pathname === "/commerce/identity/v1/user/") {
      return { status: 200, body: identityBody() };
    }
    if (url.host !== sellHost) throw new Error("unexpected host");
    if (url.pathname === "/sell/inventory/v1/inventory_item") {
      return {
        status: 200,
        body: { limit: 200, total: 1, inventoryItems: [inventoryItem("SKU-1")] },
      };
    }
    if (url.pathname === "/sell/inventory/v1/offer") {
      return { status: 200, body: { limit: 25, total: 1, offers: [offer("OFFER-1", "SKU-1")] } };
    }
    throw new Error("unexpected fixture request");
  });
}

function simpleOrderTransport(
  orders = [order("ORDER-1", "2026-08-11T12:00:00.000Z")],
): StubTransport {
  return stubTransport((request) => {
    const url = new URL(request.url);
    if (url.pathname === "/commerce/identity/v1/user/") {
      return { status: 200, body: identityBody() };
    }
    if (url.pathname === "/sell/fulfillment/v1/order") {
      return {
        status: 200,
        body: { limit: 200, offset: 0, total: orders.length, orders },
      };
    }
    throw new Error("unexpected fixture request");
  });
}

function recentWindow() {
  return createEbayOrderWindow({ startUtc: START, endUtc: END, asOfUtc: CAPTURED_AT });
}

let globalFetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  globalFetchSpy = vi.fn(() => {
    throw new Error("global fetch must never be reachable");
  });
  vi.stubGlobal("fetch", globalFetchSpy);
});

afterEach(() => {
  expect(globalFetchSpy).not.toHaveBeenCalled();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("unwired GET-only boundary", () => {
  it("fails closed with no injected transport and never calls global fetch", async () => {
    const collector = createEbayEvidenceCollector(baseConfig());

    await expect(collector.collectInventoryAndOffers()).rejects.toMatchObject({
      code: "transport-unavailable",
    });
  });

  it.each([
    ["production", "apiz.ebay.com", "api.ebay.com"],
    ["sandbox", "apiz.sandbox.ebay.com", "api.sandbox.ebay.com"],
  ] as const)(
    "uses only exact %s identity and sell hosts",
    async (environment, identityHost, sellHost) => {
      const stub = simpleInventoryTransport(environment);
      const result = await createEbayEvidenceCollector(
        baseConfig({ environment }),
        stub.transport,
      ).collectInventoryAndOffers();

      expect(stub.requests.map((request) => new URL(request.url).host)).toEqual([
        identityHost,
        sellHost,
        sellHost,
      ]);
      expect(result.requests.map(({ host }) => host)).toEqual([
        identityHost,
        sellHost,
        sellHost,
      ]);
    },
  );

  it("hands the dispatcher only immutable GET metadata and no credential or body", async () => {
    const stub = simpleInventoryTransport();
    await createEbayEvidenceCollector(baseConfig(), stub.transport).collectInventoryAndOffers();

    for (const request of stub.requests) {
      expect(request.method).toBe("GET");
      expect(request.redirect).toBe("error");
      expect(request.headers).toEqual({ Accept: "application/json" });
      expect(request.credentialProvidedToCollector).toBe(false);
      expect(request.url.startsWith("https://")).toBe(true);
      expect(Object.keys(request).sort()).toEqual(
        [
          "credentialProvidedToCollector",
          "headers",
          "method",
          "redirect",
          "requiredScope",
          "signal",
          "url",
        ].sort(),
      );
      expect(JSON.stringify(request)).not.toMatch(/authorization|bearer|access.?token|secret/iu);
      expect(Object.isFrozen(request)).toBe(true);
      expect(Object.isFrozen(request.headers)).toBe(true);
    }
  });

  it("never upgrades fixture provenance into direct API evidence", async () => {
    const stub = simpleInventoryTransport();
    const result = await createEbayEvidenceCollector(
      baseConfig(),
      stub.transport,
    ).collectInventoryAndOffers();

    expect(result.evidenceMode).toBe("fixture");
    expect(result.transportProvenance).toEqual({
      kind: "fixture",
      fixtureId: "ebay-authoritative-read-v1",
    });
  });

  it("preserves an explicit direct transport label without inventing live completeness", async () => {
    const base = simpleInventoryTransport();
    const direct: EbayInjectedGetTransport = {
      provenance: { kind: "direct-ebay-api", captureSessionId: "session-20260811-01" },
      get: base.transport.get,
    };
    const result = await createEbayEvidenceCollector(
      baseConfig(),
      direct,
    ).collectInventoryAndOffers();

    expect(result.evidenceMode).toBe("direct-ebay-api");
    expect(result.coverage.allSellerListingsClaimed).toBe(false);
    expect(result.coverage.activeInventoryReportUsed).toBe(false);
  });

  it("redacts thrown transport details and upstream status bodies", async () => {
    const stub = stubTransport(() => {
      throw new Error("Bearer TOP-SECRET buyer@example.test https://secret.invalid?q=token");
    });

    let caught: unknown;
    try {
      await createEbayEvidenceCollector(baseConfig(), stub.transport).collectInventoryAndOffers();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(EbayEvidenceError);
    expect(JSON.stringify(caught)).toBe(
      '{"name":"EbayEvidenceError","code":"transport-failure","message":"eBay evidence capture denied (transport-failure)."}',
    );
    expect(JSON.stringify(caught)).not.toMatch(/TOP-SECRET|buyer@|secret\.invalid|bearer/iu);
  });

  it("aborts and reports only a redacted timeout", async () => {
    vi.useFakeTimers();
    const stub = stubTransport(
      () => new Promise<EbayGetResponse>(() => undefined),
    );
    const config = baseConfig({
      limits: { ...baseConfig().limits, timeoutMs: 100 },
    });
    const capture = createEbayEvidenceCollector(config, stub.transport).collectInventoryAndOffers();
    const rejection = expect(capture).rejects.toMatchObject({ code: "transport-timeout" });

    await vi.advanceTimersByTimeAsync(101);

    await rejection;
    expect(stub.requests[0]?.signal.aborted).toBe(true);
  });
});

describe("authorization and exact commerce identity", () => {
  it("rejects write, generic, unknown, and duplicate scopes before transport", () => {
    for (const scopes of [
      [EBAY_READ_SCOPES.identity, "https://api.ebay.com/oauth/api_scope/sell.inventory"],
      [EBAY_READ_SCOPES.identity, "https://api.ebay.com/oauth/api_scope"],
      [EBAY_READ_SCOPES.identity, "unknown.readonly"],
      [EBAY_READ_SCOPES.identity, EBAY_READ_SCOPES.identity],
    ]) {
      expect(() =>
        createEbayEvidenceCollector(
          baseConfig({
            authorization: {
              ...baseConfig().authorization,
              scopes: scopes as never,
            } as never,
          }),
        ),
      ).toThrowError(expect.objectContaining({ code: "authorization-scope-denied" }));
    }
  });

  it("rejects embedded token material, refresh support, and secret-like provenance", () => {
    const authorizationWithToken = {
      ...baseConfig().authorization,
      accessToken: "must-never-enter-this-boundary",
    };
    expect(() =>
      createEbayEvidenceCollector(
        baseConfig({ authorization: authorizationWithToken as never }),
      ),
    ).toThrowError(expect.objectContaining({ code: "invalid-authorization" }));

    expect(() =>
      createEbayEvidenceCollector(
        baseConfig({
          authorization: { ...baseConfig().authorization, refreshSupported: true } as never,
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "invalid-authorization" }));

    expect(() =>
      createEbayEvidenceCollector(baseConfig(), {
        provenance: { kind: "fixture", fixtureId: "access-token-secret" },
        get: async () => ({ status: 200, body: {} }),
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid-config" }));
  });

  it.each([
    ["2026-08-11T16:00:00.000Z", "2026-08-11T18:00:00.000Z", "authorization-expired"],
    ["2026-08-11T17:00:00.000Z", "2026-08-11T18:04:59.999Z", "authorization-near-expiry"],
    ["2026-08-11T16:00:00.000Z", "2026-08-11T19:00:00.001Z", "invalid-authorization"],
  ])("rejects invalid token lifetime %s to %s", (issuedAtUtc, expiresAtUtc, code) => {
    expect(() =>
      createEbayEvidenceCollector(
        baseConfig({
          authorization: { ...baseConfig().authorization, issuedAtUtc, expiresAtUtc },
        }),
      ),
    ).toThrowError(expect.objectContaining({ code }));
  });

  it("requires the exact identity scope before any collection", () => {
    expect(() =>
      createEbayEvidenceCollector(
        baseConfig({
          authorization: {
            ...baseConfig().authorization,
            scopes: [EBAY_READ_SCOPES.inventory],
          },
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "authorization-scope-denied" }));
  });

  it("preflights immutable user and registration marketplace before sell calls", async () => {
    const stub = stubTransport((request) => {
      const url = new URL(request.url);
      if (url.pathname === "/commerce/identity/v1/user/") {
        return { status: 200, body: identityBody({ userId: "different-seller" }) };
      }
      throw new Error("sell path must not be reached");
    });

    await expect(
      createEbayEvidenceCollector(baseConfig(), stub.transport).collectInventoryAndOffers(),
    ).rejects.toMatchObject({ code: "identity-mismatch" });
    expect(stub.requests).toHaveLength(1);
    expect(new URL(stub.requests[0]!.url).pathname).toBe("/commerce/identity/v1/user/");
  });

  it("requires a method-specific readonly scope before identity or sell traffic", async () => {
    const config = baseConfig({
      authorization: {
        ...baseConfig().authorization,
        scopes: [EBAY_READ_SCOPES.identity, EBAY_READ_SCOPES.inventory],
      },
    });
    const stub = simpleOrderTransport();

    await expect(
      createEbayEvidenceCollector(config, stub.transport).collectRecentOrders(recentWindow()),
    ).rejects.toMatchObject({ code: "authorization-scope-denied" });
    expect(stub.requests).toHaveLength(0);
  });
});

describe("Inventory API item and per-SKU offer enumeration", () => {
  it("enumerates Inventory-model records and offers with minimized immutable output", async () => {
    const stub = stubTransport((request) => {
      const url = new URL(request.url);
      if (url.pathname === "/commerce/identity/v1/user/") {
        return { status: 200, body: identityBody() };
      }
      if (url.pathname === "/sell/inventory/v1/inventory_item") {
        return {
          status: 200,
          body: {
            limit: 200,
            total: 2,
            inventoryItems: [inventoryItem("SKU-B"), inventoryItem("SKU-A")],
          },
        };
      }
      if (url.pathname === "/sell/inventory/v1/offer") {
        const sku = url.searchParams.get("sku")!;
        expect(url.searchParams.get("marketplace_id")).toBe(MARKETPLACE);
        expect(url.searchParams.get("limit")).toBe("25");
        expect(url.searchParams.get("offset")).toBe("0");
        return {
          status: 200,
          body: { limit: 25, total: 1, offers: [offer(`OFFER-${sku}`, sku)] },
        };
      }
      throw new Error("unexpected fixture request");
    });

    const result = await createEbayEvidenceCollector(
      baseConfig(),
      stub.transport,
    ).collectInventoryAndOffers();

    expect(result.complete).toBe(true);
    expect(result.records.inventoryItems.map(({ sku }) => sku)).toEqual(["SKU-A", "SKU-B"]);
    expect(result.records.offers.map(({ offerId }) => offerId)).toEqual([
      "OFFER-SKU-A",
      "OFFER-SKU-B",
    ]);
    expect(result.coverage).toEqual({
      model: "ebay-inventory-api-records-and-associated-offers-only",
      allSellerListingsClaimed: false,
      tradingApiListingsIncluded: false,
      activeInventoryReportUsed: false,
    });
    expect(result.safeguards).toEqual({
      getOnly: true,
      oauthRefreshAbsent: true,
      credentialsAbsentFromCollector: true,
      externalWritesSupported: false,
    });
    expect(result.recordDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/Sensitive Company|buyer@|private-warehouse|Product title|description/iu);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.records)).toBe(true);
    expect(Object.isFrozen(result.records.inventoryItems)).toBe(true);
    expect(Object.isFrozen(result.records.inventoryItems[0])).toBe(true);
    expect(Object.isFrozen(result.requests)).toBe(true);
    expect(result.requests.every(({ method }) => method === "GET")).toBe(true);
    expect(result.requests.every(({ path }) => !path.includes("?"))).toBe(true);
  });

  it("accepts a provably empty Inventory API account without offer requests", async () => {
    const stub = stubTransport((request) => {
      const path = new URL(request.url).pathname;
      if (path === "/commerce/identity/v1/user/") return { status: 200, body: identityBody() };
      if (path === "/sell/inventory/v1/inventory_item") {
        return { status: 200, body: { limit: 200, total: 0 } };
      }
      throw new Error("offers must not be queried without inventory SKUs");
    });

    const result = await createEbayEvidenceCollector(
      baseConfig(),
      stub.transport,
    ).collectInventoryAndOffers();

    expect(result.records).toEqual({ inventoryItems: [], offers: [] });
    expect(stub.requests).toHaveLength(2);
  });

  it("uses Inventory page-number offsets and accepts a non-full terminal page", async () => {
    const firstPage = inventoryItems(200, "PAGE-A");
    const terminal = inventoryItem("PAGE-B-000");
    const stub = stubTransport((request) => {
      const url = new URL(request.url);
      if (url.pathname === "/commerce/identity/v1/user/") {
        return { status: 200, body: identityBody() };
      }
      if (url.pathname === "/sell/inventory/v1/inventory_item") {
        if (url.searchParams.get("offset") === "0") {
          return {
            status: 200,
            body: {
              limit: 200,
              total: 201,
              inventoryItems: firstPage,
              next: "https://api.ebay.com/sell/inventory/v1/inventory_item?limit=200&offset=1",
            },
          };
        }
        expect(url.searchParams.get("offset")).toBe("1");
        return {
          status: 200,
          body: { limit: 200, total: 201, inventoryItems: [terminal] },
        };
      }
      if (url.pathname === "/sell/inventory/v1/offer") {
        return { status: 200, body: { limit: 25, total: 0 } };
      }
      throw new Error("unexpected fixture request");
    });
    const config = baseConfig({
      limits: {
        ...baseConfig().limits,
        maxInventoryItems: 250,
        maxOfferPages: 250,
      },
    });

    const result = await createEbayEvidenceCollector(
      config,
      stub.transport,
    ).collectInventoryAndOffers();

    expect(result.records.inventoryItems).toHaveLength(201);
    expect(
      stub.requests
        .filter((request) => new URL(request.url).pathname === "/sell/inventory/v1/inventory_item")
        .map((request) => new URL(request.url).searchParams.get("offset")),
    ).toEqual(["0", "1"]);
  });

  it("uses per-SKU offer page-number offsets and accepts a non-full terminal page", async () => {
    const firstPage = Array.from({ length: 25 }, (_unused, index) =>
      offer(`OFFER-${String(index).padStart(2, "0")}`, "SKU-1"),
    );
    const stub = stubTransport((request) => {
      const url = new URL(request.url);
      if (url.pathname === "/commerce/identity/v1/user/") {
        return { status: 200, body: identityBody() };
      }
      if (url.pathname === "/sell/inventory/v1/inventory_item") {
        return {
          status: 200,
          body: { limit: 200, total: 1, inventoryItems: [inventoryItem("SKU-1")] },
        };
      }
      if (url.searchParams.get("offset") === "0") {
        const next = new URL(url);
        next.searchParams.set("offset", "1");
        return {
          status: 200,
          body: { limit: 25, total: 26, offers: firstPage, next: next.toString() },
        };
      }
      expect(url.searchParams.get("offset")).toBe("1");
      return {
        status: 200,
        body: { limit: 25, total: 26, offers: [offer("OFFER-25", "SKU-1")] },
      };
    });

    const result = await createEbayEvidenceCollector(
      baseConfig(),
      stub.transport,
    ).collectInventoryAndOffers();

    expect(result.records.offers).toHaveLength(26);
    expect(
      stub.requests
        .filter((request) => new URL(request.url).pathname === "/sell/inventory/v1/offer")
        .map((request) => new URL(request.url).searchParams.get("offset")),
    ).toEqual(["0", "1"]);
  });

  it("fails on a missing continuation before the declared total", async () => {
    const stub = stubTransport((request) => {
      const path = new URL(request.url).pathname;
      if (path === "/commerce/identity/v1/user/") return { status: 200, body: identityBody() };
      return {
        status: 200,
        body: { limit: 200, total: 2, inventoryItems: [inventoryItem("SKU-1")] },
      };
    });

    await expect(
      createEbayEvidenceCollector(baseConfig(), stub.transport).collectInventoryAndOffers(),
    ).rejects.toMatchObject({ code: "incomplete-capture" });
  });

  it("fails on total drift across Inventory pages", async () => {
    const firstPage = inventoryItems(200, "DRIFT");
    const stub = stubTransport((request) => {
      const url = new URL(request.url);
      if (url.pathname === "/commerce/identity/v1/user/") {
        return { status: 200, body: identityBody() };
      }
      const offset = url.searchParams.get("offset");
      return offset === "0"
        ? {
            status: 200,
            body: {
              limit: 200,
              total: 201,
              inventoryItems: firstPage,
              next: "https://api.ebay.com/sell/inventory/v1/inventory_item?limit=200&offset=1",
            },
          }
        : {
            status: 200,
            body: { limit: 200, total: 202, inventoryItems: [inventoryItem("DRIFT-LAST")] },
          };
    });

    const config = baseConfig({
      limits: { ...baseConfig().limits, maxInventoryItems: 250 },
    });

    await expect(
      createEbayEvidenceCollector(config, stub.transport).collectInventoryAndOffers(),
    ).rejects.toMatchObject({ code: "incomplete-capture" });
  });

  it("fails on a cursor loop before emitting complete", async () => {
    const firstPage = inventoryItems(200, "LOOP-A");
    const secondPage = inventoryItems(200, "LOOP-B");
    const stub = stubTransport((request) => {
      const url = new URL(request.url);
      if (url.pathname === "/commerce/identity/v1/user/") {
        return { status: 200, body: identityBody() };
      }
      const offset = url.searchParams.get("offset");
      return {
        status: 200,
        body: {
          limit: 200,
          total: 401,
          inventoryItems: offset === "0" ? firstPage : secondPage,
          next: "https://api.ebay.com/sell/inventory/v1/inventory_item?limit=200&offset=1",
        },
      };
    });

    const config = baseConfig({
      limits: { ...baseConfig().limits, maxInventoryItems: 500 },
    });

    await expect(
      createEbayEvidenceCollector(config, stub.transport).collectInventoryAndOffers(),
    ).rejects.toMatchObject({ code: "pagination-loop" });
  });

  it("fails on duplicate stable SKUs", async () => {
    const firstPage = inventoryItems(200, "DUP");
    const stub = stubTransport((request) => {
      const url = new URL(request.url);
      if (url.pathname === "/commerce/identity/v1/user/") {
        return { status: 200, body: identityBody() };
      }
      const offset = url.searchParams.get("offset");
      return offset === "0"
        ? {
            status: 200,
            body: {
              limit: 200,
              total: 201,
              inventoryItems: firstPage,
              next: "https://api.ebay.com/sell/inventory/v1/inventory_item?limit=200&offset=1",
            },
          }
        : {
            status: 200,
            body: { limit: 200, total: 201, inventoryItems: [inventoryItem("DUP-000")] },
          };
    });

    const config = baseConfig({
      limits: { ...baseConfig().limits, maxInventoryItems: 250 },
    });

    await expect(
      createEbayEvidenceCollector(config, stub.transport).collectInventoryAndOffers(),
    ).rejects.toMatchObject({ code: "duplicate-stable-id" });
  });

  it.each([
    [offer("OFFER-1", "WRONG-SKU"), "incomplete-capture"],
    [offer("OFFER-1", "SKU-1", { marketplaceId: "EBAY_GB" }), "incomplete-capture"],
  ])("fails on offer ownership mismatch", async (rawOffer, code) => {
    const stub = stubTransport((request) => {
      const path = new URL(request.url).pathname;
      if (path === "/commerce/identity/v1/user/") return { status: 200, body: identityBody() };
      if (path === "/sell/inventory/v1/inventory_item") {
        return {
          status: 200,
          body: { limit: 200, total: 1, inventoryItems: [inventoryItem("SKU-1")] },
        };
      }
      return { status: 200, body: { limit: 25, total: 1, offers: [rawOffer] } };
    });

    await expect(
      createEbayEvidenceCollector(baseConfig(), stub.transport).collectInventoryAndOffers(),
    ).rejects.toMatchObject({ code });
  });

  it("fails when an offer ID is duplicated across enumerated SKUs", async () => {
    const stub = stubTransport((request) => {
      const url = new URL(request.url);
      if (url.pathname === "/commerce/identity/v1/user/") {
        return { status: 200, body: identityBody() };
      }
      if (url.pathname === "/sell/inventory/v1/inventory_item") {
        return {
          status: 200,
          body: {
            limit: 200,
            total: 2,
            inventoryItems: [inventoryItem("SKU-1"), inventoryItem("SKU-2")],
          },
        };
      }
      const sku = url.searchParams.get("sku")!;
      return {
        status: 200,
        body: { limit: 25, total: 1, offers: [offer("SAME-OFFER", sku)] },
      };
    });

    await expect(
      createEbayEvidenceCollector(baseConfig(), stub.transport).collectInventoryAndOffers(),
    ).rejects.toMatchObject({ code: "duplicate-stable-id" });
  });

  it("rejects a continuation that changes host, path, query, or page index", async () => {
    const firstPage = inventoryItems(200, "HOST-CHANGE");
    const stub = stubTransport((request) => {
      const path = new URL(request.url).pathname;
      if (path === "/commerce/identity/v1/user/") return { status: 200, body: identityBody() };
      return {
        status: 200,
        body: {
          limit: 200,
          total: 201,
          inventoryItems: firstPage,
          next: "https://attacker.invalid/sell/inventory/v1/inventory_item?limit=200&offset=1&token=secret",
        },
      };
    });

    const config = baseConfig({
      limits: { ...baseConfig().limits, maxInventoryItems: 250 },
    });

    await expect(
      createEbayEvidenceCollector(config, stub.transport).collectInventoryAndOffers(),
    ).rejects.toMatchObject({ code: "pagination-invalid" });
  });

  it("enforces record, page, and locally computed response-byte caps", async () => {
    const tooMany = stubTransport((request) => {
      const path = new URL(request.url).pathname;
      if (path === "/commerce/identity/v1/user/") return { status: 200, body: identityBody() };
      return {
        status: 200,
        body: { limit: 200, total: 2, inventoryItems: [inventoryItem("SKU-1")] },
      };
    });
    const recordCapConfig = baseConfig({
      limits: { ...baseConfig().limits, maxInventoryItems: 1 },
    });
    await expect(
      createEbayEvidenceCollector(recordCapConfig, tooMany.transport).collectInventoryAndOffers(),
    ).rejects.toMatchObject({ code: "response-limit-exceeded" });

    const oversized = stubTransport((request) => {
      const path = new URL(request.url).pathname;
      if (path === "/commerce/identity/v1/user/") return { status: 200, body: identityBody() };
      return {
        status: 200,
        body: {
          limit: 200,
          total: 1,
          inventoryItems: [inventoryItem("SKU-1")],
          ignoredButMeasured: "x".repeat(1_000),
        },
      };
    });
    const byteCapConfig = baseConfig({
      limits: {
        ...baseConfig().limits,
        maxResponseBytes: 512,
        maxTotalResponseBytes: 2_048,
      },
    });
    await expect(
      createEbayEvidenceCollector(byteCapConfig, oversized.transport).collectInventoryAndOffers(),
    ).rejects.toMatchObject({ code: "response-too-large" });
  });
});

describe("recent Fulfillment order evidence", () => {
  it.each([
    [{ endUtc: END, asOfUtc: CAPTURED_AT }, "missing start"],
    [
      {
        startUtc: "2026-08-04T17:59:59.999Z",
        endUtc: END,
        asOfUtc: CAPTURED_AT,
      },
      "over seven days",
    ],
    [
      {
        startUtc: "2026-08-04T18:00:00.000Z",
        endUtc: "2026-08-05T18:00:00.000Z",
        asOfUtc: CAPTURED_AT,
      },
      "historical one-day backfill",
    ],
    [
      {
        startUtc: START,
        endUtc: "2026-08-11T18:00:00.001Z",
        asOfUtc: CAPTURED_AT,
      },
      "future end",
    ],
  ])("rejects an unsafe order window: %s", (input, _label) => {
    expect(() => createEbayOrderWindow(input as never)).toThrowError(
      expect.objectContaining({ code: "invalid-order-window" }),
    );
  });

  it("rejects forged and capture-time-mismatched order windows before transport", async () => {
    const stub = simpleOrderTransport();
    const collector = createEbayEvidenceCollector(baseConfig(), stub.transport);

    await expect(
      collector.collectRecentOrders({
        startUtc: START,
        endUtc: END,
        asOfUtc: CAPTURED_AT,
        historicalBackfill: false,
        lowerBoundInclusive: true,
        upperBoundExclusive: true,
      } as never),
    ).rejects.toMatchObject({ code: "invalid-order-window" });
    await expect(
      collector.collectRecentOrders(
        createEbayOrderWindow({
          startUtc: "2026-08-10T17:00:00.000Z",
          endUtc: "2026-08-11T17:00:00.000Z",
          asOfUtc: "2026-08-11T17:00:00.000Z",
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid-order-window" });
    expect(stub.requests).toHaveLength(0);
  });

  it("queries eBay's inclusive range then post-filters the exclusive upper boundary", async () => {
    const rawOrders = [
      order("ORDER-START", START),
      order("ORDER-MIDDLE", "2026-08-11T12:00:00.000Z"),
      order("ORDER-END", END),
    ];
    const stub = simpleOrderTransport(rawOrders);

    const result = await createEbayEvidenceCollector(
      baseConfig(),
      stub.transport,
    ).collectRecentOrders(recentWindow());

    const orderRequest = stub.requests.find(
      (request) => new URL(request.url).pathname === "/sell/fulfillment/v1/order",
    )!;
    const orderUrl = new URL(orderRequest.url);
    expect(orderUrl.host).toBe("api.ebay.com");
    expect(orderUrl.searchParams.get("filter")).toBe(`creationdate:[${START}..${END}]`);
    expect(orderUrl.searchParams.get("limit")).toBe("200");
    expect(orderUrl.searchParams.get("offset")).toBe("0");
    expect(orderRequest.requiredScope).toBe(EBAY_READ_SCOPES.fulfillment);

    expect(result.complete).toBe(true);
    expect(result.rawInclusiveRecordCount).toBe(3);
    expect(result.records.map(({ orderId }) => orderId)).toEqual([
      "ORDER-MIDDLE",
      "ORDER-START",
    ]);
    expect(Object.keys(result.records[0]!).sort()).toEqual(
      ["orderId", "creationDate", "lastModifiedDate", "orderFulfillmentStatus"].sort(),
    );
    expect(result.coverage.window).toEqual({
      startUtc: START,
      endUtc: END,
      lowerBoundInclusive: true,
      upperBoundExclusive: true,
      ebayQueryUpperBoundIsInclusive: true,
      upperBoundaryPostFiltered: true,
    });
    expect(result.coverage.historicalBackfill).toBe(false);
    expect(result.coverage.cutoverWatermark).toBe(false);
    expect(result.safeguards.orderFieldsMinimized).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/buyer|email|address|lineItems|Private Person/iu);
    expect(Object.isFrozen(result.records)).toBe(true);
    expect(Object.isFrozen(result.records[0])).toBe(true);
  });

  it("validates Fulfillment row-offset pagination and stable total", async () => {
    const raw = Array.from({ length: 201 }, (_unused, index) =>
      order(
        `ORDER-${String(index).padStart(3, "0")}`,
        new Date(Date.parse(START) + index * 1_000).toISOString(),
      ),
    );
    const stub = stubTransport((request) => {
      const url = new URL(request.url);
      if (url.pathname === "/commerce/identity/v1/user/") {
        return { status: 200, body: identityBody() };
      }
      const offset = Number(url.searchParams.get("offset"));
      if (offset === 0) {
        const next = new URL(url);
        next.searchParams.set("offset", "200");
        return {
          status: 200,
          body: {
            limit: 200,
            offset: 0,
            total: 201,
            orders: raw.slice(0, 200),
            next: next.toString(),
          },
        };
      }
      return {
        status: 200,
        body: { limit: 200, offset: 200, total: 201, orders: raw.slice(200) },
      };
    });

    const result = await createEbayEvidenceCollector(
      baseConfig(),
      stub.transport,
    ).collectRecentOrders(recentWindow());

    expect(result.records).toHaveLength(201);
    expect(
      stub.requests
        .filter((request) => new URL(request.url).pathname === "/sell/fulfillment/v1/order")
        .map((request) => new URL(request.url).searchParams.get("offset")),
    ).toEqual(["0", "200"]);
  });

  it("fails on duplicate orders, total mismatch, and non-empty warnings", async () => {
    const cases: Array<{ body: Record<string, unknown>; code: string }> = [
      {
        body: {
          limit: 200,
          offset: 0,
          total: 2,
          orders: [
            order("ORDER-1", "2026-08-11T10:00:00.000Z"),
            order("ORDER-1", "2026-08-11T11:00:00.000Z"),
          ],
        },
        code: "duplicate-stable-id",
      },
      {
        body: {
          limit: 200,
          offset: 0,
          total: 2,
          orders: [order("ORDER-1", "2026-08-11T10:00:00.000Z")],
        },
        code: "incomplete-capture",
      },
      {
        body: {
          limit: 200,
          offset: 0,
          total: 1,
          orders: [order("ORDER-1", "2026-08-11T10:00:00.000Z")],
          warnings: [{ message: "partial result" }],
        },
        code: "incomplete-capture",
      },
    ];
    for (const testCase of cases) {
      const stub = stubTransport((request) =>
        new URL(request.url).pathname === "/commerce/identity/v1/user/"
          ? { status: 200, body: identityBody() }
          : { status: 200, body: testCase.body },
      );
      await expect(
        createEbayEvidenceCollector(baseConfig(), stub.transport).collectRecentOrders(
          recentWindow(),
        ),
      ).rejects.toMatchObject({ code: testCase.code });
    }
  });

  it("fails when an upstream order falls outside the exact inclusive query", async () => {
    const stub = simpleOrderTransport([
      order("ORDER-OLD", "2026-08-10T17:59:59.999Z"),
    ]);

    await expect(
      createEbayEvidenceCollector(baseConfig(), stub.transport).collectRecentOrders(
        recentWindow(),
      ),
    ).rejects.toMatchObject({ code: "incomplete-capture" });
  });

  it("rejects a Fulfillment next link that changes the mandatory creationdate filter", async () => {
    const firstPage = Array.from({ length: 200 }, (_unused, index) =>
      order(
        `FILTER-${String(index).padStart(3, "0")}`,
        new Date(Date.parse(START) + index * 1_000).toISOString(),
      ),
    );
    const stub = stubTransport((request) => {
      const url = new URL(request.url);
      if (url.pathname === "/commerce/identity/v1/user/") {
        return { status: 200, body: identityBody() };
      }
      const changed = new URL(url);
      changed.searchParams.set(
        "filter",
        "creationdate:[2026-01-01T00:00:00.000Z..2026-08-11T18:00:00.000Z]",
      );
      changed.searchParams.set("offset", "200");
      return {
        status: 200,
        body: {
          limit: 200,
          offset: 0,
          total: 201,
          orders: firstPage,
          next: changed.toString(),
        },
      };
    });

    await expect(
      createEbayEvidenceCollector(baseConfig(), stub.transport).collectRecentOrders(
        recentWindow(),
      ),
    ).rejects.toMatchObject({ code: "pagination-invalid" });
  });
});
