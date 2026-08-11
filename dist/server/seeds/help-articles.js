/**
 * Help article seed — upserts FAQ articles for all shipped features.
 *
 * Idempotent: uses INSERT OR IGNORE by question text.
 * Called on server startup in src/server/index.ts.
 *
 * ## Help Documentation Rule
 * When shipping a new feature, add an article here:
 *   1. Add an entry to the `articles` array below.
 *   2. Use the appropriate category string.
 *   3. Write the answer in clear, concise language with step-by-step instructions.
 */
const articles = [
    // ─────────────────────────────────────────────
    // Getting Started
    // ─────────────────────────────────────────────
    {
        question: 'What is ProductPipeline?',
        category: 'Getting Started',
        sort_order: 1,
        answer: `ProductPipeline is being rebuilt as a simple, operator-safe replacement for Shopify Marketplace Connect's Used Camera Gear eBay integration.

**Current phase:** ProductPipeline is an observation-only shadow. Marketplace Connect remains the production owner for eBay-to-Shopify order import, price, and inventory. ProductPipeline cannot publish, sync, import, update, or delete external commerce data in this phase.

Use ProductPipeline to review the current ownership policy, local listing/order evidence, exceptions, and offline reconciliation results. AI enrichment, automated image processing, pipeline execution, chat actions, and unsafe bulk-sync controls are legacy scope and are not part of the migration target.

Source, deployment, and live proof are separate: a healthy local screen or consistent local snapshot does not prove Shopify/eBay parity or authorize a cutover.`,
    },
    {
        question: 'Why are ProductPipeline write actions quarantined?',
        category: 'Getting Started',
        sort_order: 0,
        answer: `Marketplace Connect is still the accepted production writer for eBay-to-Shopify orders, price, and inventory. ProductPipeline is therefore hard-coded to **shadow read-only** until a separately approved responsibility cutover.

**What operators should see:**
- Overview, Listings, Orders, Reconciliation, and Settings identify the incumbent owner and shadow status.
- Non-read requests beneath \`/api\` are denied with a writer-quarantined response.
- The scheduler and cloud watcher are not mounted.
- Shopify/eBay webhooks record redacted receipt metadata only and dispatch no work.
- Historical eBay orders are never eligible for Shopify creation; the cutover watermark is unset.

**Safe commands:**
\`\`\`sh
npm run cli -- status
npm run operator -- preflight --config config/operator-shadow.example.json
npm run operator -- ownership --config config/operator-shadow.example.json
npm run operator -- reconcile --config config/operator-shadow.example.json --snapshot .local/operator-reconciliation/snapshot.json
npm run operator -- audit verify --file .local/operator-audit/operator-cli.jsonl
\`\`\`

The operator CLI accepts strict, redacted, local snapshots and appends digest/count/decision evidence to a local hash-chained audit. It has no remote client or application-database adapter, performs zero external writes, and never proves live parity.

Do not disable Marketplace Connect, create a cutover watermark, import an order, or try to bypass the quarantine. Those steps require separate review, evidence, and explicit authorization.`,
    },
    {
        question: 'How do I get started?',
        category: 'Getting Started',
        sort_order: 3,
        answer: `Start in observation-only mode; do not connect credentials, enable a writer, or use a real order/listing as a test.

1. Open **Overview** and confirm the page reports Marketplace Connect as incumbent and ProductPipeline as shadow read-only.
2. Review **Listings** and **Orders** as local evidence only. Historical order rows are not import candidates.
3. Open **Reconciliation** to review local-ledger exceptions and proof limits. A clean local result is not Shopify/eBay parity.
4. Open **Settings** to confirm the watermark is missing and external writes/historical backfill are denied. Stale legacy toggles do not override the policy.
5. For repository-local verification, run \`npm run cli -- status\` and the operator CLI commands in the quarantine help article.

Any live read connection, sandbox action, canary, ownership transfer, Marketplace Connect change, or external write requires its own scoped authorization and evidence.`,
    },
    // ─────────────────────────────────────────────
    // Products / Review Queue
    // ─────────────────────────────────────────────
    {
        question: 'How do I review and approve products?',
        category: 'Products',
        sort_order: 1,
        answer: `The Review Queue shows products that have been processed by the pipeline but not yet listed on eBay. Staff review them here before they go live.

**Workflow:**
1. Go to **Products → Review Queue**. Products waiting for review appear here with their AI-generated description and processed images.
2. Read the draft description. Edit it directly if anything needs tweaking.
3. Scroll through the product photos. Reorder them if needed (first photo becomes the eBay hero image).
4. Check the eBay category and condition description. Adjust if needed.
5. Click **Approve & List** to publish immediately to eBay, or **Approve** to mark as ready without listing yet.
6. Click **Reject** to send the product back for re-processing or to skip it entirely.

Products in the queue stay there until explicitly approved or rejected. You can filter by status, date, or product type using the toolbar at the top of the queue.`,
    },
    {
        question: 'How do I reorder product photos?',
        category: 'Products',
        sort_order: 2,
        answer: `You can drag and drop photos into any order in the Review Queue and the Photo Editor. The first photo in the list becomes the **hero image** — it's the main image displayed on the eBay listing.

**How to reorder:**
1. Open a product in the **Review Queue** or **Photo Editor**.
2. Hover over any photo thumbnail — a drag handle (⠿) appears in the top-left corner.
3. Click and hold the handle, then drag the photo to its new position.
4. Release to drop it. The order updates immediately.
5. Click **Save** (or **Approve & List**) to persist the new order.

**Tips:**
- Put your sharpest, most flattering shot first — eBay shows this as the primary listing image in search results.
- eBay allows up to 12 photos. If you have more, the extras are trimmed automatically.
- You can also reorder photos in the **Bulk Edit** view if you're working on multiple products at once.`,
    },
    {
        question: 'How do I bulk edit photos?',
        category: 'Products',
        sort_order: 3,
        answer: `Bulk photo editing lets you select multiple photos across a product and apply the same transformation to all of them at once — useful for fixing rotation on a batch of images or resizing consistently.

**How to bulk edit:**
1. Open a product in the **Photo Editor**.
2. Click the **Select** button (top toolbar) to enter selection mode. Checkboxes appear on each photo.
3. Click the photos you want to edit. Use **Select All** to grab everything.
4. With photos selected, use the action bar that appears at the bottom:
   - **Rotate Left / Right** — rotates all selected photos 90°
   - **Resize** — applies the same scale percentage to all selected photos
   - **Reset** — reverts selected photos to their original state
5. Click **Apply** to commit the changes.
6. Click **Save** to write the updated images back to the product.

Bulk edits are non-destructive until you hit Save — you can undo individual steps with Ctrl+Z (or ⌘Z on Mac) before saving.`,
    },
    {
        question: 'How does the photo editor work?',
        category: 'Products',
        sort_order: 4,
        answer: `The Photo Editor lets you fine-tune individual product images — rotating, scaling, and repositioning the product against its background — before the image is sent to eBay.

**Opening the editor:**
Click the pencil icon on any photo thumbnail in the Review Queue or Product detail page.

**Editor controls:**
- **Rotate** — Use the rotation wheel or type a degree value. 90° increments have shortcut buttons.
- **Scale** — Drag the scale slider or type a percentage. Scales the product relative to the background canvas.
- **Reposition** — Click and drag the product to move it within the frame. Useful for centering off-center shots.
- **Background** — Choose a background color or template (white, gray, custom branded). Applies via PhotoRoom.
- **Reset** — Reverts all edits on the current photo to the original processed version.

**Saving:**
Click **Save Photo** to apply your edits to this photo only, or **Save All** to apply and return to the product view. Changes sync to the product draft and will be used when the product is listed on eBay.`,
    },
    {
        question: 'How do I trigger the image processing pipeline?',
        category: 'Products',
        sort_order: 5,
        answer: `Image processing runs the product photos through PhotoRoom to remove backgrounds, crop, and enhance them for eBay listings.

**Automatic processing (recommended):**
Enable **Auto-Images** in **Settings → Pipeline**. When turned on, every product that enters the pipeline automatically has its images processed before reaching the Review Queue — no manual action needed.

**Manual trigger:**
1. Open a product from the **Review Queue** or **Products** list.
2. Click the **Process Images** button (pipeline icon) in the product toolbar.
3. A progress indicator shows each image as it's sent to PhotoRoom and returned.
4. Processed images appear in the photo grid immediately. Review and approve when ready.

**Re-processing:**
If an image comes back looking wrong (bad crop, color bleed), click **Reprocess** on that specific image to try again. You can also edit processing parameters in the photo editor before re-running.

**Status:**
Check **Pipeline → Images** for a full queue of pending, processing, and completed images across all products.`,
    },
    // ─────────────────────────────────────────────
    // eBay
    // ─────────────────────────────────────────────
    {
        question: 'How do I list a product on eBay?',
        category: 'eBay',
        sort_order: 1,
        answer: `There are two ways to list a product on eBay: the Review Queue approval flow and the manual Listing Prep page.

**Via Review Queue (recommended):**
1. Go to **Products → Review Queue**.
2. Find the product you want to list. Review the description, photos, category, and condition.
3. Make any edits needed, then click **Approve & List**.
4. ProductPipeline creates the eBay listing immediately using your field mappings. You'll see the eBay listing ID in the product detail once it's live.

**Via eBay Listing Prep:**
1. Go to a product's detail page and click **eBay Listing Prep**.
2. This page shows a pre-filled form with all the eBay fields: title, description, category, condition, price, shipping, and images.
3. Review and edit any field, then click **List on eBay**.
4. The listing goes live and the product is marked as "Listed."

**After listing:**
The product appears in **eBay → Listings** with its status. Inventory changes on Shopify will automatically sync to the eBay listing if inventory sync is enabled.`,
    },
    {
        question: 'How do I change the eBay category?',
        category: 'eBay',
        sort_order: 2,
        answer: `You can change the eBay category for a product from the Review Queue or the eBay Listing Prep page.

**Using the category dropdown:**
1. Open the product in the **Review Queue** or **eBay Listing Prep**.
2. Find the **eBay Category** field.
3. Click the dropdown — it's searchable. Type a keyword (e.g. "mirrorless", "lens", "flash") to filter the list of eBay categories.
4. Select the correct category from the results.

**Manual category ID entry:**
If you know the eBay category ID (a number like \`31388\` for cameras), you can type it directly into the category field. The field accepts both text search and numeric IDs.

**Finding category IDs:**
eBay's category tree is extensive. If you're unsure of an ID, search eBay for a similar item and note the category shown on that listing, or use eBay's Category Finder tool at developer.ebay.com.

**Per-product overrides:**
Category changes made in the Review Queue or Listing Prep are saved as per-product overrides. They persist across re-listings and don't affect the global category mapping for other products.`,
    },
    {
        question: 'What are condition descriptions?',
        category: 'eBay',
        sort_order: 3,
        answer: `Condition descriptions are short notes that explain the specific condition of an individual item — scratches, missing accessories, functional quirks, etc. They appear in the eBay listing to help buyers understand exactly what they're getting.

**Auto-populated from Pictureline grades:**
When a product enters the pipeline from Pictureline's grading system, its condition grade (e.g. "Excellent", "Good", "Fair") is mapped to a default condition description template. For example, "Excellent" might auto-fill as: *"Item shows light cosmetic wear consistent with normal use. All functions work perfectly."*

**Editing condition descriptions:**
1. Open the product in the **Review Queue** or **eBay Listing Prep**.
2. Find the **Condition Description** field — it's pre-filled from the grade template.
3. Edit the text to add specific details: which lens element has a scratch, whether the strap is missing, etc.
4. Changes save automatically when you approve or list the product.

**Managing templates:**
To edit the default templates used for each grade, go to **Settings → Condition Descriptions** (coming soon — currently the templates live in \`src/config/condition-descriptions.ts\`).`,
    },
    {
        question: 'How does eBay order sync work?',
        category: 'eBay',
        sort_order: 4,
        answer: `eBay-to-Shopify order sync is **not active in ProductPipeline's current migration phase**. Marketplace Connect remains the sole production importer.

ProductPipeline's legacy importer remains in source for historical analysis, but it cannot be triggered: non-read API calls are denied, the scheduler is not mounted, eBay webhooks dispatch no order work, the legacy CLI has no order command, the sync service denies at entry, and Shopify order creation independently fails closed.

**Non-negotiable order rules:**
- Never import or backfill historical eBay orders.
- Never create a Shopify order while the cutover watermark is unset.
- Never let ProductPipeline and Marketplace Connect create orders concurrently.
- A local order row or clean offline reconciliation is not live eligibility or parity evidence.

ProductPipeline had a 2026-02-11 incident in which historical eBay orders were imported into Shopify and cascaded to Lightspeed, creating duplicates alongside the incumbent integration. A future order importer therefore requires an explicit immutable UTC watermark, durable marketplace/account/order idempotency, one-writer proof, approval, audit, remote reconciliation, canary evidence, and rollback before a separately authorized cutover.

Operators should review **Orders** and **Reconciliation** only; there is no approved sync or import action in this phase.`,
    },
    // ─────────────────────────────────────────────
    // Pipeline
    // ─────────────────────────────────────────────
    {
        question: 'What is the automated pipeline?',
        category: 'Pipeline',
        sort_order: 1,
        answer: `The automated pipeline is the end-to-end flow that takes a product from StyleShoots (the photo capture system) all the way to a live eBay listing with minimal human intervention.

**Full flow:**
1. **StyleShoots → Shopify**: A product is photographed and the images are uploaded. A Shopify product draft is created with the photos and basic metadata (title, SKU, condition grade).
2. **AI Enrichment**: The pipeline picks up the new Shopify product and sends it to GPT. GPT generates an eBay-optimized title (≤80 characters) and a compelling description based on the product data and Pictureline condition grade.
3. **Image Processing**: Product photos are sent to PhotoRoom for background removal, cropping, and enhancement. Processed images replace the raw photos on the product.
4. **Review Queue**: The enriched, image-processed product lands in the Review Queue for a staff member to review. They verify the AI description, adjust photos if needed, and approve.
5. **eBay Listing**: On approval, the product is listed on eBay using the configured field mappings. The eBay listing ID is stored for future sync operations.

**Monitoring:** Track all pipeline jobs at **Pipeline → Overview**. Each job shows its current stage, timestamps, and any errors.`,
    },
    {
        question: 'How do AI descriptions work?',
        category: 'Pipeline',
        sort_order: 2,
        answer: `AI descriptions are generated by GPT (OpenAI) during the pipeline enrichment stage. They produce eBay-ready titles and body descriptions from your product data.

**What GPT uses as input:**
- Product title from Shopify
- Shopify product type and vendor
- Condition grade from Pictureline (e.g. "Excellent", "Good", "Fair")
- Existing Shopify description (if any)
- The configured description prompt from Settings

**What GPT generates:**
- **Title**: An eBay-optimized title up to 80 characters. Includes brand, model, and key specs. Written for search discoverability.
- **Description**: A multi-paragraph HTML description suitable for the eBay listing body. Covers product highlights, condition details, and what's included.

**Reviewing and editing:**
AI descriptions land in the **Review Queue** and are fully editable. Staff should read every description before approving — AI occasionally hallucinates specs or misidentifies a model. Edit in the text field directly before approving.

**Customizing the prompt:**
Go to **Settings → Pipeline → Description Prompt** to edit the system prompt sent to GPT. You can tune the tone, structure, required sections, or add brand-specific instructions.

**Enabling/disabling:**
Toggle **Auto-Descriptions** in **Settings → Pipeline**. When off, products skip AI enrichment and land in the Review Queue with their original Shopify description.`,
    },
    {
        question: 'What are pipeline settings?',
        category: 'Pipeline',
        sort_order: 3,
        answer: `Pipeline settings control which automatic stages run when a new product enters the pipeline. Find them at **Settings → Pipeline**.

**Auto-Descriptions**
Toggle: on/off. When enabled, new products are automatically sent to GPT for title and description generation before they reach the Review Queue. When disabled, products arrive with their original Shopify content.

**Auto-Images**
Toggle: on/off. When enabled, product photos are automatically sent to PhotoRoom for background removal and enhancement. When disabled, raw photos from Shopify are used as-is.

**Description Prompt**
A text field containing the system prompt sent to GPT for description generation. Edit this to change the tone, format, required sections, or any brand-specific instructions. Leave blank to use the built-in default prompt.

**PhotoRoom Template ID**
Optional. Enter a PhotoRoom template ID to apply a specific background or framing to processed images. Leave blank to use the default white background.

**Tips:**
- Enable both Auto-Descriptions and Auto-Images for a fully hands-off pipeline.
- Disable either toggle temporarily if you're troubleshooting AI or image quality issues.
- The description prompt is the biggest lever for improving AI output quality — iterate on it.`,
    },
    // ─────────────────────────────────────────────
    // Settings
    // ─────────────────────────────────────────────
    {
        question: 'How do I connect Shopify?',
        category: 'Settings',
        sort_order: 1,
        answer: `Connecting Shopify gives ProductPipeline access to read your products, create orders, and sync inventory.

**Steps:**
1. Go to **Settings → Shopify**.
2. Enter your Shopify store URL (e.g. \`yourstore.myshopify.com\`).
3. Enter your Shopify Admin API access token. To generate one:
   - In Shopify Admin, go to **Settings → Apps and sales channels → Develop apps**.
   - Create a new app (or use an existing one).
   - Under **Configuration**, grant the scopes: \`read_products\`, \`write_products\`, \`read_orders\`, \`write_orders\`, \`read_inventory\`, \`write_inventory\`.
   - Under **API credentials**, copy the **Admin API access token**.
4. Paste the token into ProductPipeline and click **Save**.
5. The Dashboard will show a green "Shopify Connected" status.

**Troubleshooting:**
- If you see "Unauthorized", double-check the token and scopes.
- Tokens don't expire but can be revoked from Shopify's app settings.
- ProductPipeline only needs access to your Shopify Admin, not the Storefront API.`,
    },
    {
        question: 'How do I connect eBay?',
        category: 'Settings',
        sort_order: 2,
        answer: `Connecting eBay allows ProductPipeline to create and manage listings, sync inventory, and import orders on your behalf.

**Steps:**
1. Go to **Settings → eBay**.
2. Click **Connect eBay Account**.
3. You'll be redirected to eBay's OAuth authorization page. Sign in with the eBay seller account you want to use.
4. Review the permissions ProductPipeline is requesting (listing management, order management, inventory) and click **Agree**.
5. You'll be redirected back to ProductPipeline. The Settings page will show your eBay username and token expiry date.

**Token management:**
- eBay access tokens expire after 2 hours but are refreshed automatically using the long-lived refresh token (valid 18 months).
- If the refresh token expires, you'll need to re-authorize from this page.
- The Dashboard shows a warning badge if eBay auth needs attention.

**Troubleshooting:**
- If listings fail with "Invalid token" errors, re-authorize here.
- Make sure you're authorizing with the correct eBay seller account — the one where listings should appear.
- eBay sandbox accounts require a separate authorization flow not covered here.`,
    },
    {
        question: 'How do I edit condition descriptions?',
        category: 'Settings',
        sort_order: 3,
        answer: `Condition description templates define the default text used for each Pictureline condition grade when a product is auto-processed through the pipeline.

**Current status: coming soon via UI**
A dedicated Settings page for editing condition description templates is planned. For now, templates are defined in code at \`src/config/condition-descriptions.ts\`.

**Current templates (as of Feb 2026):**

| Grade | Default description |
|-------|-------------------|
| New | Brand new, unused, in original packaging. |
| Excellent | Minimal cosmetic wear. All functions work perfectly. |
| Good | Light use, minor cosmetic marks. Fully functional. |
| Fair | Visible wear but fully functional. See photos for details. |
| For Parts | Not fully functional. Sold as-is for parts or repair. |

**Editing templates today:**
1. Open \`src/config/condition-descriptions.ts\` in your editor.
2. Update the text for any grade.
3. Deploy the change (Railway auto-deploys on \`git push origin main\`).

**Per-product overrides:**
Regardless of the template, you can always edit the condition description for an individual product in the Review Queue or eBay Listing Prep page. Per-product edits override the template.`,
    },
    {
        question: 'How do I vote on feature requests?',
        category: 'Settings',
        sort_order: 4,
        answer: `Feature Requests are a shared wishlist for ProductPipeline improvements. You can upvote requests to help prioritize what gets built next.

**How to vote:**
1. Go to **Settings & Analytics → Feature Requests**.
2. Find a request you support.
3. Click **Vote**. Your vote is counted immediately and the vote total updates.
4. You can only vote once per request from a browser.

**Tips:**
- Add context in the description when you submit your own request — clear use cases get prioritized faster.
- Sort requests by status to see what's planned or in progress.`,
    },
];
/**
 * Seed help articles into the help_questions table.
 * Uses INSERT OR IGNORE so existing articles are never overwritten.
 * Safe to call on every server startup.
 */
export function seedHelpArticles(db) {
    // Ensure sort_order column exists (migration guard)
    const cols = db.prepare('PRAGMA table_info(help_questions)').all().map((c) => c.name);
    if (!cols.includes('sort_order')) {
        db.exec('ALTER TABLE help_questions ADD COLUMN sort_order INTEGER DEFAULT 0');
    }
    const insert = db.prepare(`
    INSERT OR IGNORE INTO help_questions
      (question, answer, status, answered_by, category, sort_order)
    VALUES (?, ?, 'published', 'System', ?, ?)
  `);
    let inserted = 0;
    for (const article of articles) {
        const result = insert.run(article.question, article.answer, article.category, article.sort_order);
        if (result.changes > 0)
            inserted++;
    }
    if (inserted > 0) {
        console.info(`[Help] Seeded ${inserted} new help article(s)`);
    }
}
