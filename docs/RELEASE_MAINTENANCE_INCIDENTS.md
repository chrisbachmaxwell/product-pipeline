# Release-Maintenance Incident Register

Release and data-store maintenance must leave a credential-free evidence trail. Incident records may name a credential class and its rotation status, but must never contain a credential value, masked suffix, user token, personal data, environment dump, raw command output, or copied transcript fragment.

## RMI-2026-08-14-001 — Maintenance tooling exposed credential material

**Status:** Open; maintenance stopped and containment in progress. Local listing-control writes remain frozen, the active deployment still has its earlier environment snapshot, and the version-2-to-version-3 migration must not resume until every gate below is complete.

### Impact and confirmed boundary

- During Railway release maintenance, a wrapper invoked through `railway ssh ... sh -lc` unexpectedly emitted the container environment before the intended checks.
- A separate broad browser DOM inspection on an eBay credential page rendered a short-lived eBay user token. The token is not reproduced or fingerprinted here. Broad DOM, accessibility-tree, page-source, network-body, or full-page screenshot capture is now forbidden on credential, token, secret, recovery-code, or private-key pages; use only exact narrow controls and value-free state checks.
- Treat every credential class present in that environment as exposed. This record intentionally does not reproduce, summarize, mask, hash, suffix, or otherwise fingerprint any value.
- No Shopify, eBay, Marketplace Connect, Lightspeed, listing, order, price, inventory, mapping, policy, or other commerce write occurred.
- The emitted output is not accepted as verification evidence. The intended store checks, schema state, release state, and migration readiness must be re-established later through the safe command boundary below.
- Local draft/proposal writes and listing-control migration activity remain frozen. The last safely documented Production baseline remains the previously verified schema-version-2 store; this incident does not establish a newer state.

### Evidence versus inference

Confirmed evidence is limited to the unexpected environment emission, the stopped maintenance attempt, zero commerce writes, and the continuing local-write freeze. This record does not claim that a third party used any exposed credential. Rotation is mandatory because non-use cannot be proven and continued reliance on the exposed generations would be unsafe.

### Confirmed rotation scope — class names only

The private incident inventory identified eight credential classes. The class labels below are intentionally value-free:

1. Dedicated OpenAI listing-proposal API authority.
2. Legacy OpenAI API authority.
3. Internal operator API authority.
4. eBay Production application/user authority.
5. Google Cloud service-account private-key authority.
6. Shopify app client-secret authority.
7. PhotoRoom API authority.
8. TradeInManager service-account password authority.

Every class must have its exposed generation revoked or deleted at the authoritative issuer. Create a replacement only when that capability is still required and separately authorized; unused legacy authority should remain removed. Provider rotation may require invalidating dependent sessions or obtaining fresh human consent, but those dependent artifacts must never be copied into this record.

### Containment progress at 2026-08-14T18:55:16Z

- The exposed dedicated OpenAI proposal-key generation was revoked. A new purpose-specific service-account key was created and stored only in Railway's secret-management surface; it has not been used to resume proposal writes or the schema migration.
- The exposed legacy OpenAI key and an unused temporary replacement were revoked. The legacy `OPENAI_API_KEY` Railway variable was removed because no mounted Production route requires it.
- The Production-disabled internal `API_KEY` Railway variable was removed.
- The unmounted legacy Google, PhotoRoom, and TradeInManager Railway secret variables were removed. Their issuer-side key or password revocation remains pending and must be completed before this incident closes.
- The eBay Production application/user authority and Shopify client-secret authority remain pending issuer-side rotation. The eBay user token must be revoked before the old Cert ID is expired; Shopify rotation requires a coordinated new-secret and access-token maintenance window.
- `LISTING_CONTROL_SINGLE_WRITER_ACK` remains absent, so local draft/proposal writes stay frozen. The running application has not been restarted onto the staged replacement configuration, and the schema-version-3 migration has not begun.

These bullets record only class-level state and UTC time. They do not prove a replacement value, provider acceptance, runtime use, or feature readiness.

| Credential class | Railway/control-plane containment | Issuer-side status | Runtime status |
|---|---|---|---|
| Dedicated OpenAI proposal authority | Clean replacement staged | Exposed generation revoked | Replacement not deployed or used |
| Legacy OpenAI authority | Variable removed | Exposed and unused temporary generations revoked | Not mounted; old deployment snapshot remains |
| Internal operator authority | Variable removed | No external issuer; final invalidation requires retiring the old deployment snapshot | Production code rejects this principal |
| eBay Production application/user authority | Existing variables still attached to the old deployment | Token revocation and Cert rotation pending | Read-only catalog may still use old authority |
| Google service-account authority | Variable removed from current Railway configuration | Service-account disable/key deletion pending | Unmounted; old deployment snapshot remains |
| Shopify client-secret authority | Existing variable still attached to the old deployment | Coordinated secret and access-token rotation pending | Signed-in auth/read path still uses old authority |
| PhotoRoom API authority | Variable removed from current Railway configuration | Provider revocation pending | Unmounted; old deployment snapshot remains |
| TradeInManager password authority | Variables removed from current Railway configuration | Password reset/session revocation pending | Unmounted; old deployment snapshot remains |

### Immediate containment

1. Stop the maintenance sequence and do not rerun, quote, copy, summarize, transform, or attach the emitted output.
2. Keep local draft/proposal writers and every listing-control migration action stopped. A replacement proposal key may remain staged in Railway's secret-management surface, but do not restart a write-capable local-state path, use the key, or treat a healthy public endpoint as permission to resume.
3. Limit the incident record to fixed facts and class-level remediation status. Handle transcript access and retention only through the authorized incident owner; never move the output into repository files, issues, chat, screenshots, or test fixtures.
4. Use the Railway control plane or another owner-approved secret-management surface—not a container shell—to make a private inventory of every credential class present at the time of exposure.
5. Revoke or delete each exposed generation at its authoritative issuer; favor a contained outage over a credential-overlap window because external commerce writers are already quarantined. Replace only the capabilities authorized to resume, configure them through the approved secret-management surface, and invalidate any issuer-required dependent authority in the same rotation window.

### Prohibited remote maintenance patterns

- Never invoke `railway ssh ... sh -lc`. Do not substitute `sh -c`, `bash -lc`, `bash -c`, an interactive shell, a login shell, a profile-loading shell, or another general-purpose remote wrapper.
- Never inspect or enumerate a remote process or container environment. Prohibited mechanisms include environment-printing commands, shell state/export dumps, process-environment files, tracing/debug modes that echo variables, diagnostic wrappers that capture the environment, and exception handlers that serialize it.
- Never pass a secret in a command argument, inline assignment, shell fragment, temporary script, pasted terminal input, or captured output. Never use a masked value or suffix as incident evidence.
- Never fall back to an arbitrary remote shell because the approved fixed command cannot express an operation. Stop and create or review a safe single-purpose maintenance path first.
- On any credential or token page, never capture the full DOM, accessibility tree, page source, network payload, console payload, or full-page screenshot. Interact only through exact narrow locators whose output is known not to contain a value, and return only value-free counts or status labels.

### Required command boundary

After credential rotation, Production maintenance may use only one of these forms:

1. A fixed, single-purpose process invocation whose executable and arguments are allowlisted for exactly one operation; or
2. A version-controlled, reviewed maintenance script pinned to the reviewed release revision and limited to exactly one documented operation.

The command or script must not spawn a general-purpose shell, read or enumerate the environment except for individually allowlisted inputs required by the operation, enable tracing, print command arguments containing authority, serialize process state, or include raw exception objects. Its stdout and stderr contract must be reviewed to emit zero environment output and only fixed, redacted result fields. Validate that contract in an isolated non-Production run before first Production use. If the existing tooling cannot meet this boundary, maintenance remains blocked.

The inner `listing-control-admin` operations documented elsewhere are not an approved remote transport by themselves. They must be reached through the fixed command boundary above; shell-wrapping a documented command is forbidden.

### Credential-rotation and resume gate

- [ ] The private, authoritative inventory confirms the eight classes above without copying values into the incident record.
- [ ] Every exposed generation is revoked or deleted; each still-required class has a new issuer-generated credential, unused classes remain removed, and any issuer-required dependent authority is invalidated.
- [ ] Railway configuration has been updated through the approved secret-management surface and no old generation remains attached to the service, deployment, job, or maintenance context.
- [ ] The rotation register records class, role-owned completion status, and UTC completion time only—no values, masked suffixes, user tokens, personal data, or raw provider output.
- [ ] A fixed single-purpose command or audited script has passed review and an isolated zero-environment-output check for each required Production operation.
- [ ] The exact Railway service, one-writer topology, volume attachment, stopped-writer state, and listing-control store baseline have been re-verified without a remote shell or environment introspection.
- [ ] A consistent restorable backup has been created and verified while writers remain stopped, using the existing backup gates.
- [ ] Credential-free resume proof separately covers the deployed secret generation at class/status/time granularity, public `/health`, signed-in App Bridge authentication, Shopify webhook authentication, a fresh strict-identity catalog/workspace read, and proposal readiness. `/health` alone proves none of the rotated credentials. No check may write commerce state.
- [ ] An authorized human explicitly approves lifting the local-write freeze and starting a new maintenance window.

Only after every item is complete may the version-2-to-version-3 migration procedure begin from its first precondition. A successful rotation, deployment, health response, or store verification alone does not resume maintenance.

### Closure gate

Close this incident only after the rotation and resume gate is evidenced, the safe command boundary is the only documented Production path, the store is re-verified through that boundary, and the incident owner explicitly lifts the freeze. Migration success is a later, separate result; it is not required to close the credential exposure, and incident closure does not authorize a commerce write.
