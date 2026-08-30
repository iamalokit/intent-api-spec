# Transaction auto-categorisation — design

**Date:** 2026-08-29
**Status:** approved, in implementation
**Spans:** `intent-api-spec`, `intent-backend-service`, `intent-app`

## Goal

Learn each user's own categorisation behaviour so a new DEBIT transaction is
pre-categorised: auto-filled to a budget when the user has categorised the same
merchant before, or offered as a tap-to-accept suggestion when a keyword match
against their budgets is the best guess. Corrections retrain the memory.

## Decisions

| Question | Decision |
|---|---|
| What is a "category" | An existing user-defined **Budget** (DEBIT-only). No new Category entity. |
| Learning mechanism | Deterministic per-user rules `normalised(merchant/title) → budget`, upserted on every categorisation, plus a cold-start keyword match against the user's active budgets + their icons' keywords. No ML, no LLM. |
| Apply behaviour | Exact learned-rule match → `autoApply: true`, client sets the budget silently with a reversible indicator. Partial-rule or keyword match → `autoApply: false`, client shows a tap-to-accept chip. |
| Suggestion timing | Create-time only (polled, debounced, in the New Transaction form). |
| Correction path | `budgetId` added to `UpdateTransactionRequest` + a budget field on the Edit form. Edit-time changes also feed learning. |
| Visibility | A category chip on transaction rows (budget name). |

## Contract (`intent-api-spec` 3.1.0 → 3.2.0, additive)

New endpoint `GET /api/v1/transactions/category-suggestion`, a literal sibling of
`{transactionId}` like `/titles` and `/receipt-upload-url`.

- `TransactionCategorySuggestionResponse` — `budgetId` (nullable), `budgetName`
  (nullable), `autoApply` (bool), `source` (`LEARNED_RULE | KEYWORD | NONE`).
  Always returned with a body; `source: NONE` + null `budgetId` means "nothing
  matched". Chosen over `204` so the app's hand-written axios layer needs no
  status-branching and the body can carry `source`/`budgetName`.
- Query params `title` and `type` are **both optional** — a `required` param
  that is absent throws `MissingServletRequestParameterException`, unhandled by
  `GlobalExceptionHandler`, which would 500. Blank title ⇒ `NONE`.

Field additions:

- `UpdateTransactionRequest.budgetId` — optional, `nullable`. **Full replacement**
  (like `receiptKey`): send an id to (re)categorise, send `null`/omit to clear.
  This keeps "absent vs explicit null" out of the generated models — same choice
  the receipt design made. The Edit form always sends the field (value or null).
- `transactions-id.yaml` PUT gains a `409` (archived budget) and its stale
  description ("only accountId/amount/description") is corrected.

## Backend (`intent-backend-service`)

Folded into the existing `transaction/` module (as `RecurringTransactionRule`
already is) — no new domain, no `ModuleBoundaryTest` change.

**New entity** `TransactionCategoryRule` (table `transaction_category_rules`,
migration `037`): `user` FK, `budget` FK (`ON DELETE CASCADE`), `merchantKey`
(normalised title, unique per user), `matchCount`, timestamps.

**`MerchantKeyNormalizer`** (pure) — lowercase, strip punctuation, drop
digit-bearing tokens and payment-rail stopwords (`upi`, `pos`, `ref`, …),
`distinct().sorted()` (order-independent), cap 6 tokens. Blank result ⇒ no rule.

**`TransactionCategoryKeywordMatcher`** (pure) — server port of
`intent-app/utils/iconMatcher.ts` (exact=4, word=2, substring=1, tie-break by
icon `sortOrder`), scoring a title against each active budget's name + its
linked `MasterIcon`'s `category`/`keywords`.

**`TransactionCategorizationService`**:
- `suggest(phone, title, type)` — exact rule (autoApply) → partial rule (Jaccard
  ≥ 0.5, not autoApply) → keyword match (not autoApply) → `NONE`.
- `recordAssignment(user, title, budget)` — `REQUIRES_NEW`, errors swallowed +
  logged; upsert: new / same-budget `matchCount++` / different-budget replace +
  reset.

**Hooks** in `TransactionService`: after `createTransaction` and
`updateTransaction` (DEBIT + budget present/changed), register an `afterCommit`
synchronisation calling `recordAssignment`. `afterCommit` + `REQUIRES_NEW` +
swallow so a learning bug can never roll back or 500 the transaction write.
`updateTransaction` also gains a DEBIT-only budget full-replacement block
(resolve owned budget, reject archived, `setBudget`).

`BudgetService.findActiveBudgets(phone)` — new lightweight lookup (no computed
fields) for the matcher; transaction domain reaches budget data only via the
service (`ModuleBoundaryTest`). `@Lazy BudgetService` in the new service breaks
the `BudgetService → TransactionService → … → BudgetService` cycle.

Reused: `CursorPaginator.forUser`, `BudgetService.findOwnedBudget`,
`MasterIconService.listIcons()` (cached), `BudgetArchivedException` (→409).

## App (`intent-app`)

**OTA-only** — no native dependency, no `app.json` change. `pnpm check:native`
expected to report no fingerprint change.

- `services/transactionApi.ts` — `suggestTransactionCategory(token, {title, type,
  signal})`; `updateTransaction` unchanged (its body type gains `budgetId` on
  regen).
- `hooks/queries/useBudgets.ts` — `useBudgets()` / `useBudgetNameMap()` (a
  single cached budget fetch for the row chip).
- `hooks/useTransactionCategorySuggestion.ts` — debounced (~400ms), DEBIT-only,
  aborts stale requests, reports only.
- `CreateTransactionForm` — mirrors the existing `iconManuallySet` pattern in
  `CreateBudgetForm`: `budgetTouchedManually` guard, an auto-apply effect, a
  `Sparkles` "Auto-categorised · change" indicator, and a "Suggested: X" chip.
- `EditTransactionForm` — a budget `Dropdown` (DEBIT only), submit sends
  `budgetId` (value or explicit `null`). No auto-suggest here.
- `TransactionCard` — optional `budgetName` prop → ` · {name}` in brand text,
  matching `DailyTrendView`'s existing chip. Passed by `TransactionsScreen` and
  `FilteredTransactionsView`.

## Sequencing

Forced by the pinned-artifact build:

1. `intent-api-spec` — edit YAML, version 3.2.0, `pnpm build`, `pnpm publish:maven`
2. `intent-backend-service` — bump `<api-spec.version>`, migration, then code
3. `intent-app` — `pnpm generate:api`, then code

## Testing

- `MerchantKeyNormalizerTest`, `TransactionCategoryKeywordMatcherTest` — pure unit.
- `TransactionCategorizationServiceTest`, `TransactionServiceTest` additions —
  `@SpringBootTest` against real Postgres; the critical cases are the
  `recordAssignment` upsert branches and archived-budget handling.
- One MockMvc test for the suggestion endpoint shape.
- App: `useTransactionCategorySuggestion` (debounce/abort/gating),
  `transactionApi` (URL/params), Create/Edit form behaviour.
- `./mvnw`/`mvn verify`, then `npm run lint && npm run typecheck && npm test`,
  then `pnpm check:native` (expected: no fingerprint change).

## Risk

`PUT /transactions/{id}` omitting `budgetId` now uncategorises the transaction
(full-replacement). The only caller is `EditTransactionForm`, shipped in
lockstep via OTA. Same risk class as the already-accepted `receiptKey` behaviour.
