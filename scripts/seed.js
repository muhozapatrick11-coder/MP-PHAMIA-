'use strict';
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is required in .env to run the seed script.');
  process.exit(1);
}

const DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || 'PharmacyDemo#2026';

function isoOffset(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

(async () => {
  const pool = new Pool({
    connectionString,
    ssl: process.env.PGSSLMODE === 'require' || process.env.NODE_ENV === 'production' || /sslmode=require/i.test(connectionString)
      ? { rejectUnauthorized: process.env.PGSSL_REJECT_UNAUTHORIZED !== 'false' }
      : false,
  });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Organization (idempotent by access_code)
    let org = (await client.query("SELECT id, name, access_code FROM organizations WHERE access_code='MPDEMO2026'")).rows[0];
    if (!org) {
      org = (await client.query(
        "INSERT INTO organizations(name, country_code, access_code) VALUES('MP PHARMAI Demo Pharmacy', 'RW', 'MPDEMO2026') RETURNING id, name, access_code"
      )).rows[0];
    }

    // 2. Active Business subscription (so multi-branch & transfers work out of the box)
    await client.query(`
      INSERT INTO subscriptions(organization_id, plan_code, status, starts_at, ends_at, updated_at)
      VALUES($1, 'business', 'active', now(), now() + interval '30 days', now())
      ON CONFLICT (organization_id) DO UPDATE
        SET plan_code='business', status='active', ends_at=GREATEST(subscriptions.ends_at, now() + interval '30 days'), updated_at=now()
    `, [org.id]);

    // 3. Branches
    const branchDefs = [
      { code: 'MAIN', name: 'MP PHARMAI Kigali Central', address: 'KN 4 Ave, Nyarugenge, Kigali' },
      { code: 'MUSANZE', name: 'MP PHARMAI Musanze Branch', address: 'RN 4, Muhoza, Musanze' },
    ];
    const branches = {};
    for (const b of branchDefs) {
      const row = (await client.query(`
        INSERT INTO branches(organization_id, code, name, address, active)
        VALUES($1, $2, $3, $4, true)
        ON CONFLICT (organization_id, code) DO UPDATE SET name=EXCLUDED.name, address=EXCLUDED.address, active=true
        RETURNING id, code, name
      `, [org.id, b.code, b.name, b.address])).rows[0];
      branches[b.code] = row;
    }

    // 4. Role-based sample users (one for each role + 1 pending user for approval workflow)
    const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 12);
    const userDefs = [
      { fullName: 'Patrick Owner', username: 'owner_demo', email: 'owner@mppharmai.demo', role: 'owner', active: true, status: 'approved', branchCodes: ['MAIN', 'MUSANZE'] },
      { fullName: 'Aline Admin', username: 'admin_demo', email: 'admin@mppharmai.demo', role: 'admin', active: true, status: 'approved', branchCodes: ['MAIN', 'MUSANZE'] },
      { fullName: 'Dr. Eric Pharmacist', username: 'pharm_demo', email: 'pharmacist@mppharmai.demo', role: 'pharmacist', active: true, status: 'approved', branchCodes: ['MAIN', 'MUSANZE'] },
      { fullName: 'Jean Stock Controller', username: 'stock_demo', email: 'stock@mppharmai.demo', role: 'stock_controller', active: true, status: 'approved', branchCodes: ['MAIN'] },
      { fullName: 'Diane Cashier', username: 'cashier_demo', email: 'cashier@mppharmai.demo', role: 'cashier', active: true, status: 'approved', branchCodes: ['MAIN'] },
      { fullName: 'Claude Claims Officer', username: 'claims_demo', email: 'claims@mppharmai.demo', role: 'claims', active: true, status: 'approved', branchCodes: ['MAIN'] },
      { fullName: 'Pending Staff Applicant', username: 'pending_demo', email: 'pending@mppharmai.demo', role: 'pharmacist', active: false, status: 'pending', requestedRole: 'pharmacist', branchCodes: ['MAIN'] },
    ];

    const usersByRole = {};
    for (const u of userDefs) {
      let existing = (await client.query('SELECT id FROM users WHERE lower(email)=lower($1)', [u.email])).rows[0];
      let userId;
      if (existing) {
        await client.query(`
          UPDATE users SET organization_id=$1, full_name=$2, username=$3, password_hash=$4, role=$5, active=$6,
            approval_status=$7, requested_role=$8, email_verified_at=CASE WHEN $7='approved' THEN COALESCE(email_verified_at, now()) ELSE NULL END
          WHERE id=$9
        `, [org.id, u.fullName, u.username, passwordHash, u.role, u.active, u.status, u.requestedRole || null, existing.id]);
        userId = existing.id;
      } else {
        const inserted = (await client.query(`
          INSERT INTO users(organization_id, full_name, username, email, password_hash, role, active, approval_status, requested_role, email_verified_at)
          VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, CASE WHEN $8='approved' THEN now() ELSE NULL END)
          RETURNING id
        `, [org.id, u.fullName, u.username, u.email, passwordHash, u.role, u.active, u.status, u.requestedRole || null])).rows[0];
        userId = inserted.id;
      }
      if (u.status === 'approved') usersByRole[u.role] = userId;
      for (const code of u.branchCodes) {
        await client.query(
          'INSERT INTO user_branch_access(user_id, branch_id) VALUES($1, $2) ON CONFLICT DO NOTHING',
          [userId, branches[code].id]
        );
      }
    }

    // 5. Suppliers
    const sup1 = (await client.query(`
      INSERT INTO suppliers(organization_id, name, phone, email)
      VALUES($1, 'MediSupply Rwanda', '+250788100100', 'orders@medisupply.rw')
      ON CONFLICT (organization_id, name) DO UPDATE SET phone=EXCLUDED.phone RETURNING id
    `, [org.id])).rows[0];
    const sup2 = (await client.query(`
      INSERT INTO suppliers(organization_id, name, phone, email)
      VALUES($1, 'Kivu Medical Ltd', '+250788200200', 'sales@kivumedical.rw')
      ON CONFLICT (organization_id, name) DO UPDATE SET phone=EXCLUDED.phone RETURNING id
    `, [org.id])).rows[0];

    // 6. Products & Stock Batches across Kigali Central & Musanze
    const productDefs = [
      { name: 'Paracetamol', generic: 'Paracetamol', strength: '500 mg', form: 'Tablet', barcode: '616110000001', sku: 'SKU-PCM-500', rx: false, supplier: sup1.id, cost: 25, price: 60, mainQty: 420, musanzeQty: 180, expDays: 365 },
      { name: 'Amoxicillin', generic: 'Amoxicillin', strength: '500 mg', form: 'Capsule', barcode: '616110000002', sku: 'SKU-AMX-500', rx: true, supplier: sup1.id, cost: 70, price: 150, mainQty: 260, musanzeQty: 120, expDays: 300 },
      { name: 'Ibuprofen', generic: 'Ibuprofen', strength: '400 mg', form: 'Tablet', barcode: '616110000003', sku: 'SKU-IBU-400', rx: false, supplier: sup2.id, cost: 35, price: 80, mainQty: 310, musanzeQty: 95, expDays: 420 },
      { name: 'Coartem (Artemether/Lumefantrine)', generic: 'Artemether/lumefantrine', strength: '20/120 mg', form: 'Tablet', barcode: '616110000004', sku: 'SKU-ALU-20', rx: true, supplier: sup1.id, cost: 900, price: 1500, mainQty: 85, musanzeQty: 60, expDays: 240 },
      { name: 'Omeprazole', generic: 'Omeprazole', strength: '20 mg', form: 'Capsule', barcode: '616110000005', sku: 'SKU-OMP-20', rx: false, supplier: sup2.id, cost: 45, price: 100, mainQty: 190, musanzeQty: 75, expDays: 60 },
      { name: 'Cetirizine', generic: 'Cetirizine', strength: '10 mg', form: 'Tablet', barcode: '616110000006', sku: 'SKU-CET-10', rx: false, supplier: sup2.id, cost: 30, price: 75, mainQty: 240, musanzeQty: 110, expDays: 480 },
      { name: 'Oral Rehydration Salts (ORS)', generic: 'Oral rehydration salts', strength: '20.5 g', form: 'Sachet', barcode: '616110000007', sku: 'SKU-ORS-20', rx: false, supplier: sup1.id, cost: 150, price: 300, mainQty: 160, musanzeQty: 90, expDays: 500 },
      { name: 'Metformin', generic: 'Metformin', strength: '500 mg', form: 'Tablet', barcode: '616110000008', sku: 'SKU-MET-500', rx: true, supplier: sup1.id, cost: 55, price: 120, mainQty: 210, musanzeQty: 80, expDays: 330 },
      { name: 'Amlodipine', generic: 'Amlodipine', strength: '5 mg', form: 'Tablet', barcode: '616110000009', sku: 'SKU-AML-5', rx: true, supplier: sup2.id, cost: 60, price: 130, mainQty: 175, musanzeQty: 65, expDays: 290 },
      { name: 'Salbutamol Inhaler', generic: 'Salbutamol', strength: '100 mcg/dose', form: 'Inhaler', barcode: '616110000010', sku: 'SKU-SAL-100', rx: true, supplier: sup1.id, cost: 2800, price: 4500, mainQty: 40, musanzeQty: 22, expDays: 410 },
    ];

    let paracetamolId = null;
    for (const p of productDefs) {
      const prod = (await client.query(`
        INSERT INTO products(organization_id, name, generic_name, strength, dosage_form, barcode, sku, requires_prescription)
        VALUES($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (organization_id, barcode) DO UPDATE
          SET name=EXCLUDED.name, generic_name=EXCLUDED.generic_name, strength=EXCLUDED.strength, dosage_form=EXCLUDED.dosage_form, requires_prescription=EXCLUDED.requires_prescription
        RETURNING id
      `, [org.id, p.name, p.generic, p.strength, p.form, p.barcode, p.sku, p.rx])).rows[0];
      if (p.sku === 'SKU-PCM-500') paracetamolId = prod.id;

      await client.query(`
        INSERT INTO stock_batches(organization_id, branch_id, product_id, supplier_id, batch_number, expiry_date, quantity_on_hand, reorder_level, unit_cost, unit_price, status)
        VALUES($1, $2, $3, $4, $5, $6, $7, 30, $8, $9, 'available')
        ON CONFLICT (branch_id, product_id, batch_number) DO UPDATE
          SET expiry_date=EXCLUDED.expiry_date, quantity_on_hand=EXCLUDED.quantity_on_hand, unit_price=EXCLUDED.unit_price, status='available'
      `, [org.id, branches.MAIN.id, prod.id, p.supplier, `${p.sku}-KGL1`, isoOffset(p.expDays), p.mainQty, p.cost, p.price]);

      await client.query(`
        INSERT INTO stock_batches(organization_id, branch_id, product_id, supplier_id, batch_number, expiry_date, quantity_on_hand, reorder_level, unit_cost, unit_price, status)
        VALUES($1, $2, $3, $4, $5, $6, $7, 20, $8, $9, 'available')
        ON CONFLICT (branch_id, product_id, batch_number) DO UPDATE
          SET expiry_date=EXCLUDED.expiry_date, quantity_on_hand=EXCLUDED.quantity_on_hand, unit_price=EXCLUDED.unit_price, status='available'
      `, [org.id, branches.MUSANZE.id, prod.id, p.supplier, `${p.sku}-MSZ1`, isoOffset(p.expDays), p.musanzeQty, p.cost, p.price]);
    }

    // Add 1 expired batch at Kigali Central so expiry reports & expired-sale server block can be tested
    if (paracetamolId) {
      await client.query(`
        INSERT INTO stock_batches(organization_id, branch_id, product_id, supplier_id, batch_number, expiry_date, quantity_on_hand, reorder_level, unit_cost, unit_price, status)
        VALUES($1, $2, $3, $4, 'SKU-PCM-EXP01', $5, 15, 0, 25, 60, 'available')
        ON CONFLICT (branch_id, product_id, batch_number) DO UPDATE SET expiry_date=EXCLUDED.expiry_date, quantity_on_hand=15, status='available'
      `, [org.id, branches.MAIN.id, paracetamolId, sup1.id, isoOffset(-10)]);
    }

    await client.query(`
      INSERT INTO audit_logs(organization_id, branch_id, user_id, action, entity_type, details)
      VALUES($1, $2, $3, 'demo_data_seeded', 'organization', $4)
    `, [org.id, branches.MAIN.id, usersByRole.owner, JSON.stringify({ orgCode: org.access_code, products: productDefs.length, users: userDefs.length })]);

    await client.query('COMMIT');
    console.log('Seed completed successfully.');
    console.log(`Organization: ${org.name} (Code: ${org.access_code})`);
    console.log(`Demo password for all seeded users: ${DEMO_PASSWORD}`);
    console.log('Seeded accounts:');
    for (const u of userDefs) {
      console.log(`  - ${u.role.padEnd(16)} | ${u.email.padEnd(28)} | status=${u.status} | branches=${u.branchCodes.join(',')}`);
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Seed failed:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
