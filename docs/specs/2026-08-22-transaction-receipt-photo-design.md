# Transaction receipt photos — design

**Date:** 2026-08-22
**Status:** approved, in implementation
**Spans:** `intent-api-spec`, `intent-backend-service`, `intent-app`

## Goal

Let a user attach one photo (a receipt) to a transaction — from camera or photo
library — when creating it, and change or remove it when editing.

## Decisions

| Question | Decision |
|---|---|
| Scope | One photo per transaction, camera **or** gallery; set on create, changeable on edit |
| Storage | S3 with presigned URLs — image bytes never pass through the JVM |
| Upload timing | On pick, into `pending/`; backend promotes to `receipts/` on save |
| Orphan cleanup | S3 lifecycle rule expires `pending/` after 1 day — no backend job |
| Read path | Short-lived presigned GET (`receiptUrl`) inline on `TransactionResponse` |
| Lanes | Real S3, one bucket per lane; dev keys in `.env`, EC2 instance role in staging/prod |

Context for the storage decision: the EC2 box already runs two Postgres, two
Redis and two JVMs, with the staging heap capped at 320 MB. Anything that
streams image bytes through Spring competes with that.

## Contract (`intent-api-spec` 3.0.0 → 3.1.0, additive)

New endpoint `POST /api/v1/transactions/receipt-upload-url`, a literal sibling of
`{transactionId}` like the existing `/titles` and `/descriptions`.

- `ReceiptUploadUrlRequest` — `contentType` (image/jpeg | image/png), `contentLength`
- `ReceiptUploadUrlResponse` — `uploadUrl`, `objectKey`, `expiresAt`

Field additions:

- `CreateTransactionRequest.receiptKey` — optional, the `pending/...` key
- `UpdateTransactionRequest.receiptKey` — optional, see PUT semantics
- `TransactionResponse.receiptKey` + `receiptUrl` — stable identity + ephemeral URL

**The client never chooses the key.** The server generates it with the caller's
userId in the prefix, and a presigned PUT is only valid for the key it signed.

**PUT is a full replacement**, so the three edit intents are expressible without
distinguishing "absent" from "explicit null" (which would drag `JsonNullable`
into the generated models):

- keep — echo the current `receiptKey` back
- replace — send the new `pending/...` key
- remove — omit the field

## Backend (`intent-backend-service`)

New module `com.aurum.silver.attachment`, one class, no repository:

`ReceiptStorageService`

- `createUploadTarget(userId, contentType, contentLength)` → `pending/{userId}/{uuid}.jpg`,
  presigned PUT with content-type and content-length **locked into the signature**
  (S3 itself then rejects a client that declares 200 KB and streams 2 GB)
- `promote(userId, transactionId, pendingKey)` → verify prefix ownership, copy to
  `receipts/{userId}/{transactionId}/{uuid}.jpg`, delete pending
- `presignGet(key)` → nullable, ~15 min TTL
- `delete(key)`

Supporting: `config/properties/S3Properties` (bucket, region, presignTtl,
maxUploadBytes) following the `FirebaseProperties` pattern; `config/S3Config`
exposing `S3Client` + `S3Presigner` via `DefaultCredentialsProvider`, which
resolves env vars locally and the instance role on EC2 with no profile-specific
code. `pom.xml` gains its first `<dependencyManagement>` block for the AWS SDK
BOM — Boot 4.1's parent manages nothing from AWS.

Transaction domain:

- `Transaction.receiptKey` (`receipt_key`, nullable, length 255)
- migration `036_add_receipt_key_to_transactions.yaml`, no index (never filtered on)
- `createTransaction` promotes **after** the insert — the final key embeds the
  generated transactionId
- `updateTransaction` does the three-way keep/replace/remove compare
- `deleteTransaction` removes the object

**Ordering rule:** copies happen inside the DB transaction; deletes are deferred
to `afterCommit` via `TransactionSynchronization`. A delete that ran inline
before a rollback would leave a live row pointing at bytes that no longer exist —
unrecoverable. The opposite failure (commit fails after a copy) leaves a stray
object, which is the failure worth choosing. No compensation logic.

**Mapper:** `receiptUrl` is filled via `@Mapper(uses = ReceiptStorageService.class)`
with a `@Named` qualifier rather than at each call site. `toResponse` has five
call sites and one of them is in `BudgetController` — a different domain. This
bends the mapper's "lookups stay in the service" rule; the distinction is that
presigning is a pure local HMAC with no invariant to bypass.

`ModuleBoundaryTest.DOMAINS` gains `"attachment"`. The guard rule only polices
repository access and this module has none, but an unlisted package makes
`domainOf()` return null and mislabel it in any future violation message.

## App (`intent-app`)

**A native rebuild is required** — two independent triggers per `WORKFLOW.md`: a
new npm dep with native code (`expo-image-picker`), and the `app.json` plugin
entry for iOS permission strings. OTA cannot carry it.

`services/attachmentApi.ts` — two functions that deliberately do not share a
transport:

- `requestReceiptUploadUrl(...)` through `apiClient` + `apiRequest()`, house pattern
- `uploadReceipt(...)` through a **bare `fetch`, never `apiClient`** — apiClient
  attaches `Authorization: Bearer <jwt>` to everything and owns 401-refresh. S3
  rejects a request carrying two auth mechanisms, and an S3 403 would otherwise
  burn the rotating refresh token for an unrelated failure.

`components/shared/ReceiptPicker.tsx` — new design-system primitive holding a
small state machine (idle → picking → uploading → uploaded(pendingKey) | error),
`quality: 0.7`, `allowsEditing: true`, permissions mirroring `QrScanner.tsx`.
Uploading on pick means the picker owns the upload; the form never learns what S3
is, and `handleSubmit` only passes one more field.

Rendering uses React Native's built-in `Image` (already used in
`WelcomeScreen.tsx` for a bundled asset), not `expo-image`: avoids a second
native dep, and its caching advantage is void because `receiptUrl` rotates on
every fetch. This is the app's first **remote** image, so loading and error
states are new ground.

Cleanup in scope: `services/transactionApi.ts` hand-rolls
`CreateTransactionRequest` instead of importing from `generated/api.ts`. Adding
`receiptKey` to a hand-maintained duplicate is how contracts drift — switch it to
`components['schemas']['CreateTransactionRequest']`.

## Infrastructure (manual — blocks end-to-end testing only)

- Buckets `silver-receipts-{dev,staging,prod}`, Block Public Access fully on
- Lifecycle rule expiring `pending/` after 1 day
- Dev IAM user limited to Put/Get/DeleteObject on `silver-receipts-dev/*`
- Staging/prod via EC2 instance role, no keys on the box

## Sequencing

Forced by the pinned-artifact build:

1. `intent-api-spec` — edit YAML, version 3.1.0, `pnpm build`, `pnpm publish:maven`
2. `intent-backend-service` — bump `<api-spec.version>`, then code
3. `intent-app` — `pnpm generate:api`, then code

The backend cannot compile before step 1 installs the artifact into `~/.m2`.

## Testing

- `ReceiptStorageServiceTest` with mocked `S3Client` / `S3Presigner`. The critical
  case: **promote rejects a key whose prefix is not the caller's** — the single
  assertion standing between a tampered `receiptKey` and another user's bytes.
- `TransactionServiceTest` cases for keep / replace / remove.
- `attachmentApi.test.ts` asserting the S3 PUT carries **no** Authorization header.
- `./mvnw test`, then `npm run lint && npm run typecheck && npm test`, then
  `pnpm check:native` (expected to report a fingerprint change).
