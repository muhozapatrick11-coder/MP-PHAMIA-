# MP PHARMAI production launch checklist

**Status:** planning and evidence register; no item is marked complete by this document. The ZIP is not a production deployment or regulatory certificate.

## A. Legal and premises gate — owner + responsible pharmacist
- [ ] Confirm the correct Rwanda FDA premise category and obtain the premise registration / operational licence for the exact location and activity.
- [ ] Confirm current NPC registration and practising licence for every pharmacy professional who will practise; appoint and document the responsible pharmacist arrangement.
- [ ] Confirm premises inspection, approved layout, storage, sanitation, security, utilities and temperature-monitoring requirements.
- [ ] Confirm applicable requirements for prescription-only products, controlled drugs, importation, medical devices, veterinary products and any other product classes stocked.
- [ ] Confirm business registration, tax, invoicing, accounting, employment and insurer/claims requirements with competent authorities and advisers.

## B. Data protection gate — designated privacy lead / counsel
- [ ] Map data controller, processor and third-party roles, including hosting, email, analytics and insurer integrations.
- [ ] Assess registration obligations with the Data Protection & Privacy Office.
- [ ] Create a processing-activities inventory, privacy notice, data retention schedule, access/rectification request workflow, processor contracts and breach response procedure.
- [ ] Complete a data protection impact assessment where required / appropriate, especially before processing health records at scale.
- [ ] Minimize patient data; define lawful basis and access need; prohibit real patient data in prototype/localStorage pages.

## C. Production engineering gate — technical lead
- [ ] Deploy Node.js 20+ and PostgreSQL on managed infrastructure; database is not publicly reachable.
- [ ] Set `NODE_ENV=production`, a unique random `JWT_SECRET` (32+ characters), exact HTTPS `APP_ORIGIN`, HTTPS `PUBLIC_APP_URL`, SMTP credentials, and `TRUST_PROXY=1` only behind the trusted hosting proxy.
- [ ] Use TLS to database with provider-appropriate certificate verification; restrict database roles and network access.
- [ ] Configure automated encrypted backups, off-site retention, restore tests and documented RPO/RTO.
- [ ] Configure centralized logs, uptime/DB monitoring, error alerting, dependency scanning and vulnerability response.
- [ ] Add MFA for privileged accounts, session revocation/refresh-token strategy, account lockout/risk controls and periodic access review.
- [ ] Remove demo/localStorage write paths or clearly disable them in production. All live transactions must use authenticated API routes and durable database records.
- [ ] Review CORS allowlist, rate limits, security headers, secrets, payment settings and public customer directory exposure.

## D. Data migration gate — stock controller + pharmacist
- [ ] Physically count all opening stock.
- [ ] Verify product name, generic name, active ingredient, strength, dosage form, pack size, manufacturer, registration status and prescription classification.
- [ ] Capture actual supplier, invoice, manufacturer batch/lot, expiry, received quantity, cost, price, branch and storage conditions.
- [ ] Reconcile database totals to signed physical count; investigate every discrepancy.
- [ ] Delete/replace fictional demo stock; never merge fictional quantities into real opening balances.
- [ ] Have responsible pharmacist approve the validated catalogue and restricted-product rules.

## E. Operational validation gate — pharmacist + business owner
- [ ] Complete test cases in `TEST_AND_ACCEPTANCE_PLAN.md` in a non-production environment.
- [ ] Train all staff and retain attendance/competency evidence.
- [ ] Approve controlled SOPs in `SOP_TEMPLATES.md` and localize them to the premises.
- [ ] Run a simulated day, stock count, expiry check, recall, system outage and restore exercise.
- [ ] Obtain written sign-off from owner, responsible pharmacist and technical lead; maintain defect and risk registers.

## Go-live decision
Go live only when A–E are evidenced, critical/high defects are closed, the responsible pharmacist approves clinical/dispensing workflows, and all required external approvals are in force. If any gate fails, remain in test mode.
