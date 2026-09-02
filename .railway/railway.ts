import { defineRailway, github, preserve, project, service, volume } from "railway/iac";

export default defineRailway(() => {
  const ebaySyncAppVolumeNih = volume("ebay-sync-app-volume--nih", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "us-west2", sizeMB: 50000 });
  const productPipeline = service("product-pipeline", {
    source: github("chrisbachmaxwell/product-pipeline", { checkSuites: false }),
    replicas: { "us-west2": 1 },
    networking: { privateNetworkEndpoint: "ebay-sync-app" },
    volumeMounts: { "/data": ebaySyncAppVolumeNih },
    env: { AI_PROPOSAL_OPENAI_API_KEY: preserve(), DATABASE_PATH: preserve(), DRIVE_MODE: preserve(), EBAY_APP_ID: preserve(), EBAY_CERT_ID: preserve(), EBAY_DEV_ID: preserve(), EBAY_RU_NAME: preserve(), GCS_BUCKET: preserve(), GCS_PROJECT_ID: preserve(), LISTING_CONTROL_DATABASE_PATH: preserve(), LISTING_CONTROL_SINGLE_WRITER_ACK: preserve(), NODE_ENV: preserve(), PHOTOROOM_TEMPLATE_ID: preserve(), SHOPIFY_API_VERSION: preserve(), SHOPIFY_CLIENT_ID: preserve(), SHOPIFY_CLIENT_SECRET: preserve() },
  });

  // NOTE — do not add cron services that mount this volume.
  //
  // A Railway volume attaches to exactly ONE service. Declaring
  // `volumeMounts: { "/data": ebaySyncAppVolumeNih }` on additional services
  // does not share it: Railway MOVES the attachment to the last declaring
  // service, silently detaching it from product-pipeline. The running
  // container keeps its mount until the next deploy, so the damage is latent
  // rather than immediate — the web service comes up with no /data, meaning no
  // migration store and no ebaysync.db.
  //
  // This was done and reverted on 2026-09-02. Scheduled inventory sweeps must
  // therefore run against the product-pipeline container (which holds the
  // volume) from an external scheduler via `railway ssh`, not as sibling
  // Railway cron services.

  return project("product-pipeline", {
    resources: [productPipeline, ebaySyncAppVolumeNih],
  });
});
