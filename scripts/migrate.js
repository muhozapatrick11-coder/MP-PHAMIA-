'use strict';
require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is required. Use a dedicated development/staging database first.');
  process.exit(1);
}

(async () => {
  const pool = new Pool({
    connectionString,
    ssl: process.env.PGSSLMODE === 'require' || process.env.NODE_ENV === 'production' || /sslmode=require/i.test(connectionString)
      ? { rejectUnauthorized: process.env.PGSSL_REJECT_UNAUTHORIZED !== 'false' }
      : false,
  });
  try {
    const schemaPath = path.join(__dirname, '..', 'db', 'schema.sql');
    const sql = fs.readFileSync(schemaPath, 'utf8');
    await pool.query(sql);
    const check = await pool.query(`
      SELECT
        (SELECT COUNT(*)::int FROM plans WHERE code IN ('trial','free','premium','business')) AS plans,
        to_regclass('public.subscriptions') IS NOT NULL AS subscriptions_table,
        to_regclass('public.payments') IS NOT NULL AS payments_table,
        EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.payments'::regclass AND conname='payments_provider_check' AND pg_get_constraintdef(oid) LIKE '%momo%') AS momo_provider_enabled
    `);
    const result = check.rows[0];
    if (result.plans !== 4 || !result.subscriptions_table || !result.payments_table || !result.momo_provider_enabled) {
      throw new Error(`Schema verification failed: ${JSON.stringify(result)}`);
    }
    console.log(`Migration/schema application succeeded. Plans=${result.plans}; subscriptions table=${result.subscriptions_table}; payments table=${result.payments_table}; MoMo provider=${result.momo_provider_enabled}.`);
  } catch (error) {
    console.error('Migration/schema application failed:', error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
