# MP PHARMAI test and acceptance plan

Run in a disposable staging database with fictional test data. Record tester, date, build, steps, expected result, actual result, evidence and defect ID. Do not test using live patient records or production stock.

| ID | Test | Expected result | Status |
|---|---|---|---|
| AUTH-01 | Register with valid details and configured SMTP | Verification email sent; account cannot log in before verification | Not run |
| AUTH-02 | Login with wrong password / unverified / inactive account | Generic denial; no token issued | Not run |
| AUTH-03 | Try endpoint with missing, invalid and expired JWT | 401; no data disclosed | Not run |
| AUTH-04 | Staff member requests another organization's resource | 403/404; no cross-tenant disclosure | Not run |
| AUTH-05 | Attempt role-restricted admin operation as cashier | 403 | Not run |
| RATE-01 | Exceed API and auth rate limits | 429 response; normal requests recover after window | Not run |
| STOCK-01 | Receive valid product batch with future expiry | Purchase, batch, movement and audit rows committed together | Not run |
| STOCK-02 | Receive expired batch | Request rejected; no purchase or stock movement committed | Not run |
| STOCK-03 | Receive duplicate batch | Quantity changes only according to defined receiving policy; audit and purchase lines correct | Not run |
| STOCK-04 | Attempt negative, zero, fractional or extreme quantity | Validation rejects invalid quantities | Not run |
| STOCK-05 | Quarantine a batch then attempt sale | Batch blocked from sale; reason and actor retained | Not run |
| STOCK-06 | Record supplier return/disposal | Quantity reduced correctly; disposition event and audit evidence saved | Not run |
| STOCK-07 | Try to dispose more than on-hand quantity | Rejected; no partial corruption | Not run |
| SALE-01 | Sell available, non-expired batch | Sale and sale lines committed; stock deducted once | Not run |
| SALE-02 | Sell expired, quarantined, recalled or insufficient stock | Rejected; no sale committed | Not run |
| SALE-03 | Concurrent sales compete for final units | No oversell; transaction isolation/locking behaves correctly | Not run |
| SALE-04 | Duplicate receipt number | Rejected without duplicate sale | Not run |
| SALE-05 | Verify receipt totals, unit price and batch traceability | Reconciles to sale line and batch movement data | Not run |
| BRANCH-01 | User accesses assigned branch | Permitted only for assigned branch | Not run |
| BRANCH-02 | User accesses unassigned branch | Denied | Not run |
| DATA-01 | Verify public catalogue response | No patient data, supplier, batch ID, lot, exact quantity or cost exposed | Not run |
| DATA-02 | Search logs and browser storage for sensitive data | No passwords, tokens, patient data or secrets logged/stored in localStorage | Not run |
| BACKUP-01 | Restore latest encrypted backup into isolated environment | Database restores and reconciles; evidence recorded | Not run |
| OUTAGE-01 | Simulate DB/network outage | Clear safe failure; no false success; no duplicated transaction on retry | Not run |
| REC-01 | Recall a batch | Stock blocked, affected sales traceable, disposition documented | Not run |
| FEFO-01 | Two valid batches have different expiry dates | UI/work instruction selects earliest eligible expiry; pharmacist confirms | Not run |
| UI-01 | All dashboard screens run against database, not localStorage | No demo write path available in production | Not run |
| UI-02 | Mobile layout, scanner, printing and keyboard-only use | Usable and accessible on supported devices | Not run |

## Acceptance criteria
- All critical and high-severity defects closed.
- No cross-organization or cross-branch data leakage.
- No overselling, expired stock sale, or sale of quarantined stock.
- Backup restoration successfully demonstrated.
- All critical workflows persist in database and have traceable audit evidence.
- Responsible pharmacist, owner and technical lead sign the release record.
