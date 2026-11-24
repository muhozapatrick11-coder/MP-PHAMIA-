'use strict';
// End-to-end billing test. Uses ONLY TEST_DATABASE_URL and the local test-payment adapter.
// Never point TEST_DATABASE_URL at a production database.
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');

const dbUrl = process.env.TEST_DATABASE_URL;
if (!dbUrl) {
  console.error('Set TEST_DATABASE_URL to a dedicated disposable PostgreSQL database. Production DATABASE_URL is intentionally not used.');
  process.exit(1);
}
const secret = crypto.randomBytes(32).toString('hex');
const port = Number(process.env.TEST_PORT || 4317);
const baseUrl = `http://127.0.0.1:${port}`;
const email = `trix-e2e-${Date.now()}@example.invalid`;
const pool = new Pool({ connectionString: dbUrl, ssl: process.env.TEST_PGSSL === 'true' ? { rejectUnauthorized: false } : false });
let child;
let organizationId;
let userId;
let branchId;
const assert = (condition, message) => { if (!condition) throw new Error(message); };
async function request(path, { method = 'GET', token, body, expectedStatus } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const raw = await response.text();
  let data;
  try { data = JSON.parse(raw); } catch { data = raw; }
  if (expectedStatus !== undefined && response.status !== expectedStatus) {
    throw new Error(`${method} ${path}: expected HTTP ${expectedStatus}, received ${response.status}; response=${String(raw).slice(0, 500)}`);
  }
  return { response, data };
}
async function waitForServer() {
  const deadline = Date.now() + 15000;
  let lastError;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) throw new Error(`Server exited early with code ${child.exitCode}`);
    try {
      const r = await fetch(`${baseUrl}/api/health`);
      if (r.ok) return;
      lastError = new Error(`health returned ${r.status}`);
    } catch (e) { lastError = e; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Server did not become healthy: ${lastError?.message || 'timeout'}`);
}

(async () => {
  let failures = 0;
  const pass = label => { console.log(`PASS ${label}`); };
  try {
    // Apply the project's schema to the dedicated test database.
    const fs = require('node:fs');
    const path = require('node:path');
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
    const plans = await pool.query("SELECT code FROM plans WHERE code IN ('trial','free','premium','business') ORDER BY code");
    assert(plans.rowCount === 4, 'Expected all four subscription plans after schema application');
    pass('schema migration and plan seed');

    const org = (await pool.query('INSERT INTO organizations(name) VALUES($1) RETURNING id', [`E2E Test Pharmacy ${Date.now()}`])).rows[0];
    organizationId = org.id;
    const branch = (await pool.query("INSERT INTO branches(organization_id,code,name) VALUES($1,'MAIN','E2E Main') RETURNING id", [organizationId])).rows[0];
    branchId = branch.id;
    const user = (await pool.query(`INSERT INTO users(organization_id,full_name,email,password_hash,role,email_verified_at)
      VALUES($1,'TRIX E2E Owner',$2,'not-used-in-token-test','owner',now()) RETURNING id`, [organizationId, email])).rows[0];
    userId = user.id;
    await pool.query('INSERT INTO user_branch_access(user_id,branch_id) VALUES($1,$2)', [userId, branchId]);
    await pool.query("INSERT INTO subscriptions(organization_id,plan_code,status,starts_at,ends_at) VALUES($1,'trial','trial',now(),now()+interval '30 days')", [organizationId]);
    const token = jwt.sign({ sub: userId, org: organizationId, role: 'owner' }, secret, { algorithm: 'HS256', expiresIn: '10m' });

    child = spawn(process.execPath, ['src/server.js'], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, DATABASE_URL: dbUrl, JWT_SECRET: secret, NODE_ENV: 'test', PAYMENT_PROVIDER_MODE: 'test', APP_ORIGIN: baseUrl, PUBLIC_APP_URL: baseUrl, PORT: String(port), PLATFORM_OWNER_EMAILS: email },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', d => process.stdout.write(`[server] ${d}`));
    child.stderr.on('data', d => process.stderr.write(`[server] ${d}`));
    await waitForServer();
    pass('server health check');

    const planList = await request('/api/plans', { expectedStatus: 200 });
    assert(Array.isArray(planList.data.plans) && planList.data.plans.some(p => p.code === 'premium'), 'Premium missing from plan catalogue');
    pass('public plans catalogue');

    const checkout = await request('/api/billing/checkout', { method: 'POST', token, body: { plan: 'premium', interval: 'monthly' }, expectedStatus: 201 });
    assert(checkout.data.mode === 'test' && checkout.data.checkoutUrl.includes('/api/billing/test-checkout'), 'Checkout did not return local test adapter URL');
    pass('server-priced test checkout creation');

    const checkoutPage = await fetch(checkout.data.checkoutUrl);
    const checkoutHtml = await checkoutPage.text();
    assert(checkoutPage.status === 200 && checkoutHtml.includes('DEVELOPMENT TEST ONLY'), 'Test checkout page missing or not labelled');
    pass('test checkout page is clearly labelled');

    const txRef = new URL(checkout.data.checkoutUrl).searchParams.get('tx_ref');
    const completed = await request('/api/billing/test/complete', { method: 'POST', body: { tx_ref: txRef }, expectedStatus: 200 });
    assert(completed.data.result.plan === 'premium', 'Payment activation did not report Premium');
    pass('test payment activation');

    const summary = await request('/api/billing/summary', { token, expectedStatus: 200 });
    assert(summary.data.subscription.plan_code === 'premium' && summary.data.subscription.status === 'active', 'Subscription not active after test payment');
    assert(summary.data.payments.some(p => p.provider_tx_ref === txRef && p.status === 'successful'), 'Successful payment not present in history');
    pass('subscription and payment history updated');

    await request('/api/billing/test/complete', { method: 'POST', body: { tx_ref: txRef }, expectedStatus: 409 });
    pass('duplicate test payment rejected');

    const momo = await request('/api/billing/momo/request', { method: 'POST', token, body: { plan: 'premium', interval: 'monthly' }, expectedStatus: 201 });
    assert(momo.data.provider === 'momo' && momo.data.recipientNumber, 'MoMo instructions/recipient missing');
    const momoRef = momo.data.payment.provider_tx_ref;
    const momoBefore = await request('/api/billing/summary', { token, expectedStatus: 200 });
    assert(momoBefore.data.payments.some(p => p.provider === 'momo' && p.provider_tx_ref === momoRef && p.status === 'pending'), 'MoMo request should remain pending');
    await request(`/api/owner/payments/${encodeURIComponent(momoRef)}/confirm-momo`, { method: 'POST', token, body: { confirmReceived: true }, expectedStatus: 400 });
    await request('/api/billing/momo/submit-reference', { method: 'POST', token, body: { txRef: momoRef, momoTransactionReference: `MOMO-E2E-${Date.now()}` }, expectedStatus: 200 });
    const momoApproved = await request(`/api/owner/payments/${encodeURIComponent(momoRef)}/confirm-momo`, { method: 'POST', token, body: { confirmReceived: true }, expectedStatus: 200 });
    assert(momoApproved.data.result.plan === 'premium', 'MoMo manual approval did not activate Premium');
    const momoAfter = await request('/api/billing/summary', { token, expectedStatus: 200 });
    assert(momoAfter.data.payments.some(p => p.provider === 'momo' && p.provider_tx_ref === momoRef && p.status === 'successful'), 'Approved MoMo payment not recorded as successful');
    pass('MoMo request, transaction reference, owner approval and subscription activation');

    const ownerRevenue = await request('/api/owner/revenue', { token, expectedStatus: 200 });
    assert(Number(ownerRevenue.data.summary.successful_payments) >= 1, 'Owner revenue summary did not include successful test payment');
    pass('allowlisted owner revenue endpoint');

    await pool.query("UPDATE subscriptions SET status='active',ends_at=now()-interval '1 day' WHERE organization_id=$1", [organizationId]);
    await request('/api/branches', { token, expectedStatus: 402 });
    pass('expired subscription blocks operational API');

    const free = await request('/api/billing/select-free', { method: 'POST', token, body: {}, expectedStatus: 200 });
    assert(free.data.subscription.plan_code === 'free' && free.data.subscription.access_allowed === true, 'Free plan was not activated');
    await request('/api/branches', { token, expectedStatus: 200 });
    pass('Free plan restores access with limited plan');

    await request('/api/branches', { method: 'POST', token, body: { code: 'SECOND', name: 'Second Branch' }, expectedStatus: 403 });
    pass('Free plan branch limit enforced');

    console.log('\nRESULT: All local PostgreSQL + test-adapter billing checks passed. No real money was charged.');
  } catch (error) {
    console.error(`\nFAIL: ${error.stack || error.message}`);
    failures += 1;
  } finally {
    if (child && child.exitCode === null) child.kill('SIGTERM');
    try {
      if (organizationId) {
        await pool.query('DELETE FROM user_branch_access WHERE user_id=$1', [userId]);
        await pool.query('DELETE FROM audit_logs WHERE organization_id=$1', [organizationId]);
        await pool.query('DELETE FROM payments WHERE organization_id=$1', [organizationId]);
        await pool.query('DELETE FROM subscriptions WHERE organization_id=$1', [organizationId]);
        await pool.query('DELETE FROM branches WHERE organization_id=$1', [organizationId]);
        await pool.query('DELETE FROM users WHERE organization_id=$1', [organizationId]);
        await pool.query('DELETE FROM organizations WHERE id=$1', [organizationId]);
      }
    } catch (cleanupError) {
      console.error(`Cleanup warning: ${cleanupError.message}`);
      failures += 1;
    }
    await pool.end();
    if (failures) process.exitCode = 1;
  }
})();
