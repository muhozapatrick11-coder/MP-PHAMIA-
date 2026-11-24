# API route checklist

| Method | Route | Access |
|---|---|---|
| POST | `/api/auth/register` | Public, SMTP required |
| GET | `/api/auth/verify?token=` | Public, single-use token |
| POST | `/api/auth/login` | Public, verified account only |
| POST | `/api/auth/forgot-password` | Public, rate-limited |
| POST | `/api/auth/reset-password` | Public, expiring token |
| GET | `/api/me` | Authenticated |
| GET | `/api/branches` | Authenticated, assigned branches |
| POST | `/api/branches` | Owner/admin |
| POST | `/api/branches/:branchId/access` | Owner/admin |
| POST | `/api/products` | Owner/admin/pharmacist/stock controller |
| GET | `/api/products/lookup?barcode=` | Authenticated |
| GET | `/api/stock?branchId=` | Authenticated, assigned branch |
| POST | `/api/stock/:batchId/quarantine` | Owner/admin/pharmacist/stock controller; assigned branch |
| POST | `/api/stock/:batchId/dispositions` | Owner/admin/pharmacist/stock controller; quarantined batch only |
| POST | `/api/inspections` | Owner/admin/pharmacist/stock controller; assigned branch |
| GET | `/api/inspections?branchId=` | Authenticated, assigned branch |
| GET | `/api/catalog?search=` | Authenticated; reference catalogue and organization products, stock only from assigned branches |
| GET | `/api/sales?branchId=` | Owner/admin/pharmacist/cashier; assigned branch sales history |
| POST | `/api/sales` | Owner/admin/pharmacist/cashier |
| POST | `/api/transfers` | Owner/admin/pharmacist/stock controller |
| POST | `/api/transfers/:id/receive` | Authorized destination branch user |
| GET | `/api/reports/expiry` | Authenticated organization report |
| GET | `/api/health` | Health check |

### Receive a purchase into branch stock
`POST /api/purchases/receive` (Bearer token; owner/admin/pharmacist/stock_controller)

```json
{
  "branchId": "<branch-uuid>",
  "supplierName": "Verified supplier name",
  "invoiceNumber": "INV-2026-001",
  "items": [
    {
      "productId": "<product-uuid>",
      "batchNumber": "BATCH-001",
      "expiryDate": "2027-12-31",
      "quantity": 120,
      "reorderLevel": 20,
      "unitCost": 150,
      "unitPrice": 220
    }
  ]
}
```
The server checks branch access and product ownership, blocks expired stock, updates or creates the batch, records stock movements, creates a purchase record, and writes an audit log in one database transaction.


### Quarantine a batch
`POST /api/stock/:batchId/quarantine`

```json
{
  "branchId": "<authorized-branch-uuid>",
  "reason": "Damaged outer packaging; pharmacist review required",
  "notes": "Incident or supplier reference, if applicable"
}
```

### Record a return or disposal
`POST /api/stock/:batchId/dispositions`

```json
{
  "branchId": "<authorized-branch-uuid>",
  "type": "return_to_supplier",
  "quantity": 12,
  "reason": "Supplier return approved under local procedure",
  "referenceNumber": "RET-2026-001",
  "notes": "Optional additional record"
}
```
Use `type: "disposal"` for a disposal record. The batch must already be quarantined, damaged or recalled. Quantity is checked under a database lock, then stock movements, a control event and an audit log are written in the same transaction.

### Record a routine stock inspection
`POST /api/inspections`

```json
{
  "branchId": "<authorized-branch-uuid>",
  "storageConditions": "Storage temperature checked against the product requirements",
  "packagingCondition": "Outer packs inspected",
  "expiryCheck": "FEFO and expiry dates reviewed",
  "discrepancies": "None found",
  "notes": "Weekly inspection completed; follow-up recorded where needed"
}
```

### Search the central medicine catalogue
`GET /api/catalog?search=paracetamol` returns curated reference entries plus the organization's saved product records. Reference entries are not stock, prescribing advice, proof of Rwanda registration, or a complete list of all medicines and diseases. The product-stock list only includes batches at branches assigned to the signed-in user.

### Read central sales history
`GET /api/sales?branchId=<branch-uuid>` returns recorded sale lines for an authorized branch, including receipt number, medicine, batch, quantity, unit price and payment method. Sales are ordered newest first.

### Record a central sale
`POST /api/sales` uses a branch UUID and batch UUIDs from `GET /api/stock?branchId=...`. The server validates stock availability, expiry and quantities, then saves the sale, sale items, stock movements and audit log in a single database transaction. The browser must not treat local/demo stock as central inventory.


## Plans, billing and subscriptions

- `GET /api/plans` — public database-backed plans and limits.
- `GET /api/subscription` — authenticated plan, status, expiry, access flag, features and limits.
- `GET /api/billing/summary` — authenticated subscription and last 20 payment records.
- `POST /api/billing/select-free` — owner/admin selects the limited Free plan.
- `POST /api/billing/checkout` — owner/admin starts checkout. Body: `{"plan":"premium","interval":"monthly"}` or `{"plan":"business","interval":"annual"}`. Amounts are read from the database.
- `GET /api/billing/flutterwave/callback` — public provider return endpoint; verifies provider transaction before subscription activation.
- `POST /api/billing/flutterwave/webhook` — checks `verif-hash`, verifies transaction server-side, then idempotently applies the payment.
- `GET /api/billing/test-checkout` and `POST /api/billing/test/complete` — only available when `PAYMENT_PROVIDER_MODE=test` and `NODE_ENV` is not `production`.
- `GET /api/owner/me` — whether the authenticated email is on `PLATFORM_OWNER_EMAILS`.
- `GET /api/owner/revenue` — platform-owner-only gross revenue, subscription counts and latest 100 payments.

New accounts receive a 30-day trial. Expired trials/paid plans are locked at the operational API layer; the billing endpoints remain accessible. The limited Free plan can be selected to continue with its configured limits. Never enable the test payment adapter in production. Set Flutterwave secret keys only as server environment variables, configure the provider webhook URL to `/api/billing/flutterwave/webhook`, and apply `db/schema.sql` before starting the app.


## Manual Mobile Money (MoMo)

- `POST /api/billing/momo/request` — authenticated pharmacy owner/admin creates a pending Premium/Business payment and receives the configured recipient number and payment instructions.
- `POST /api/billing/momo/submit-reference` — authenticated pharmacy owner/admin submits the official MoMo transaction ID; this does not activate the plan.
- `POST /api/owner/payments/:txRef/confirm-momo` — platform-owner allowlist only; after checking the actual receiving account statement, send `{\"confirmReceived\":true}` to manually approve and activate the subscription. This endpoint is not connected to a MoMo API and must not be used without checking receipt.

Set `MOMO_PAYMENT_NUMBER` on the server. Default value in this package is the number supplied for this project, `+25079829779`; verify the account is controlled by the intended recipient before public launch.
