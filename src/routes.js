const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const { z } = require('zod');

const roles = ['owner','admin','pharmacist','stock_controller','cashier','claims'];
const ROLE_PERMISSIONS = {
  owner: ['users:read','users:approve','users:manage','branches:read','branches:manage','billing:read','billing:manage','products:read','products:write','stock:read','stock:receive','stock:transfer','stock:safety','sales:read','sales:create','inspections:read','inspections:write','reports:expiry','audit:read'],
  admin: ['users:read','branches:read','branches:manage','billing:read','billing:manage','products:read','products:write','stock:read','stock:receive','stock:transfer','stock:safety','sales:read','sales:create','inspections:read','inspections:write','reports:expiry','audit:read'],
  pharmacist: ['branches:read','products:read','products:write','stock:read','stock:receive','stock:transfer','stock:safety','sales:read','sales:create','inspections:read','inspections:write','reports:expiry'],
  stock_controller: ['branches:read','products:read','products:write','stock:read','stock:receive','stock:transfer','stock:safety','inspections:read','inspections:write','reports:expiry'],
  cashier: ['branches:read','products:read','stock:read','sales:read','sales:create'],
  claims: ['branches:read','products:read','stock:read','sales:read'],
};
const platformOwnerEmails = () => (process.env.PLATFORM_OWNER_EMAILS || '').split(',').map(v => v.trim().toLowerCase()).filter(Boolean);
const paymentMode = () => process.env.PAYMENT_PROVIDER_MODE || 'disabled';
const isDevTestPayments = () => paymentMode() === 'test' && process.env.NODE_ENV !== 'production';
const isPlatformOwner = user => Boolean(user && platformOwnerEmails().includes(String(user.email || '').toLowerCase()));
const money2 = n => Math.round(Number(n) * 100) / 100;
const tokenHash = v => crypto.createHash('sha256').update(v).digest('hex');
const safeEqual = (a, b) => {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return ba.length > 0 && ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
};
const asyncRoute = fn => (req,res,next) => Promise.resolve(fn(req,res,next)).catch(next);
function mailer() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}
module.exports = ({ pool }) => {
  const r = express.Router();
  // Public customer catalogue: intentionally exposes only product display fields and an in-stock indicator.
  // Never return batch IDs, lot numbers, exact stock counts, costs, suppliers, or internal organization data.
  r.get('/public/availability', asyncRoute(async(req,res)=>{
    const search=String(req.query.search||'').trim().slice(0,100);
    const location=String(req.query.location||'').trim().slice(0,100);
    const like=`%${search.replace(/[\\%_]/g,'\\$&')}%`;
    const locationLike=`%${location.replace(/[\\%_]/g,'\\$&')}%`;
    const q=await pool.query(`SELECT p.name, COALESCE(p.generic_name,'') AS generic_name, p.strength,
        p.dosage_form, p.requires_prescription, b.name AS branch_name, COALESCE(b.address,'') AS branch_address,
        MIN(sb.unit_price) AS starting_price
      FROM products p
      JOIN stock_batches sb ON sb.product_id=p.id AND sb.organization_id=p.organization_id
      JOIN branches b ON b.id=sb.branch_id AND b.organization_id=sb.organization_id
      WHERE b.active=true AND sb.status='available' AND sb.quantity_on_hand>0 AND sb.expiry_date>=CURRENT_DATE
        AND ($1='' OR p.name ILIKE $2 OR COALESCE(p.generic_name,'') ILIKE $2 OR p.strength ILIKE $2 OR p.dosage_form ILIKE $2)
        AND ($3='' OR b.name ILIKE $4 OR COALESCE(b.address,'') ILIKE $4)
      GROUP BY p.id,p.name,p.generic_name,p.strength,p.dosage_form,p.requires_prescription,b.id,b.name,b.address
      ORDER BY p.name,b.name LIMIT 300`,[search,like,location,locationLike]);
    res.set('Cache-Control','no-store');
    res.json({medicines:q.rows.map(x=>({...x,starting_price:Number(x.starting_price),availability:'In stock'})),
      notice:'Availability and prices may change. This listing is not a reservation or a prescription. Prescription medicines require a valid prescription and pharmacist review. Contact the pharmacy to confirm current stock before travelling.'});
  }));

  const auth = asyncRoute(async (req,res,next) => {
    const h = req.headers.authorization || '';
    if (!h.startsWith('Bearer ')) return res.status(401).json({error:'Authentication required.'});
    try {
      const p = jwt.verify(h.slice(7), process.env.JWT_SECRET, { algorithms:['HS256'], issuer:'trix-pharmacy' });
      const q = await pool.query(`SELECT id, organization_id, full_name, email, username, role, active, email_verified_at, approval_status, token_version
        FROM users WHERE id=$1`, [p.sub]);
      const u = q.rows[0];
      if (!u || !u.active || u.approval_status !== 'approved' || !u.email_verified_at) return res.status(403).json({error:'Account is not approved or is inactive.'});
      if (p.tv !== undefined && Number(p.tv) !== Number(u.token_version)) return res.status(401).json({error:'Session has been revoked. Please sign in again.'});
      req.user = { ...u, permissions: ROLE_PERMISSIONS[u.role] || [] }; next();
    } catch { return res.status(401).json({error:'Invalid or expired session.'}); }
  });
  const allow = (...permitted) => (req,res,next) => permitted.includes(req.user.role) ? next() : res.status(403).json({error:'Insufficient permissions.'});
  const branchAccess = asyncRoute(async (req,res,next) => {
    const branchId = req.params.branchId || req.body.branchId || req.query.branchId;
    if (!branchId) return res.status(400).json({error:'branchId is required.'});
    const q = await pool.query(`SELECT b.id FROM branches b
      JOIN user_branch_access uba ON uba.branch_id=b.id
      WHERE b.id=$1 AND b.organization_id=$2 AND b.active=true AND uba.user_id=$3`,
      [branchId,req.user.organization_id,req.user.id]);
    if (!q.rowCount) return res.status(403).json({error:'You do not have access to this branch.'});
    req.branchId = branchId; next();
  });

  // One-time owner bootstrap. The email is fixed by deployment configuration and
  // the secret must be set privately in the server environment, never in frontend code.
  r.post('/auth/bootstrap-admin', asyncRoute(async (req,res) => {
    const schema=z.object({fullName:z.string().trim().min(2).max(120),email:z.string().email().transform(v=>v.toLowerCase()),username:z.string().trim().min(3).max(40).regex(/^[a-zA-Z0-9_.-]+$/),phone:z.string().max(40).optional(),organizationName:z.string().trim().min(2).max(120),branchName:z.string().trim().min(2).max(120),password:z.string().min(12).max(128),bootstrapSecret:z.string().min(20)});
    const d=schema.parse(req.body);
    const ownerEmail=String(process.env.ADMIN_EMAIL||'').toLowerCase();
    if(!ownerEmail || d.email!==ownerEmail || !process.env.ADMIN_BOOTSTRAP_SECRET || !safeEqual(d.bootstrapSecret, process.env.ADMIN_BOOTSTRAP_SECRET)) return res.status(403).json({error:'Administrator setup details are not valid.'});
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      const existing=await client.query("SELECT id FROM users WHERE role IN ('owner','admin') LIMIT 1");
      if(existing.rowCount) { await client.query('ROLLBACK'); return res.status(409).json({error:'An administrator already exists. Ask the current administrator to approve your account.'}); }
      const accessCode=crypto.randomBytes(6).toString('hex').toUpperCase();
      const org=(await client.query('INSERT INTO organizations(name,access_code) VALUES($1,$2) RETURNING id',[d.organizationName,accessCode])).rows[0];
      const br=(await client.query("INSERT INTO branches(organization_id,code,name) VALUES($1,'MAIN',$2) RETURNING id",[org.id,d.branchName])).rows[0];
      await client.query("INSERT INTO subscriptions(organization_id,plan_code,status,starts_at,ends_at) VALUES($1,'trial','trial',now(),now()+interval '30 days')",[org.id]);
      const hash=await bcrypt.hash(d.password,12);
      const u=(await client.query(`INSERT INTO users(organization_id,full_name,username,email,phone,password_hash,role,email_verified_at,active,approval_status)
        VALUES($1,$2,$3,$4,$5,$6,'owner',now(),true,'approved') RETURNING id`,[org.id,d.fullName,d.username,d.email,d.phone||null,hash])).rows[0];
      await client.query('INSERT INTO user_branch_access(user_id,branch_id) VALUES($1,$2)',[u.id,br.id]);
      await client.query("INSERT INTO audit_logs(organization_id,branch_id,user_id,action,entity_type,entity_id) VALUES($1,$2,$3,'initial_admin_created','user',$3)",[org.id,br.id,u.id]);
      await client.query('COMMIT');
      res.status(201).json({message:'Main administrator account created. You can now log in.',organizationCode:accessCode});
    } catch(e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  }));

  // Staff registration never grants access. A valid organization code links the request
  // to the owner's pharmacy and the account remains pending until an owner approves it.
  r.post('/auth/register', asyncRoute(async (req,res) => {
    const schema=z.object({organizationCode:z.string().trim().min(6).max(30),fullName:z.string().trim().min(2).max(120),username:z.string().trim().min(3).max(40).regex(/^[a-zA-Z0-9_.-]+$/),email:z.string().email().transform(v=>v.toLowerCase()),phone:z.string().max(40).optional(),requestedRole:z.enum(['pharmacist','stock_controller','cashier','claims']),password:z.string().min(12).max(128)});
    const d=schema.parse(req.body);
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      const org=(await client.query('SELECT id FROM organizations WHERE access_code=$1',[d.organizationCode.toUpperCase()])).rows[0];
      if(!org){await client.query('ROLLBACK');return res.status(404).json({error:'Pharmacy organization code not found.'});}
      const br=(await client.query('SELECT id FROM branches WHERE organization_id=$1 AND active=true ORDER BY created_at LIMIT 1',[org.id])).rows[0];
      if(!br){await client.query('ROLLBACK');return res.status(409).json({error:'No active branch is configured for this pharmacy.'});}
      const hash=await bcrypt.hash(d.password,12);
      const u=(await client.query(`INSERT INTO users(organization_id,full_name,username,email,phone,password_hash,role,active,approval_status,requested_role)
        VALUES($1,$2,$3,$4,$5,$6,$7,false,'pending',$7) RETURNING id`,[org.id,d.fullName,d.username,d.email,d.phone||null,hash,d.requestedRole])).rows[0];
      await client.query('INSERT INTO user_branch_access(user_id,branch_id) VALUES($1,$2)',[u.id,br.id]);
      await client.query("INSERT INTO audit_logs(organization_id,branch_id,user_id,action,entity_type,entity_id) VALUES($1,$2,$3,'staff_registration_pending','user',$3)",[org.id,br.id,u.id]);
      await client.query('COMMIT');
      res.status(202).json({message:'Registration received. Your account is pending administrator approval. You cannot log in until approved.'});
    } catch(e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  }));

  r.post('/auth/login', asyncRoute(async (req,res) => {
    const d=z.object({email:z.string().min(3).max(254),password:z.string().min(1).max(128)}).parse(req.body);
    const identifier=d.email.trim().toLowerCase();
    const q=await pool.query('SELECT * FROM users WHERE (lower(email)=$1 OR lower(username)=$1) ORDER BY created_at LIMIT 1',[identifier]);
    const u=q.rows[0];
    if (!u || !(await bcrypt.compare(d.password,u.password_hash))) return res.status(401).json({error:'Email/username or password is incorrect.'});
    if (u.approval_status==='pending' || !u.active) return res.status(403).json({error:'Your account is awaiting administrator approval.'});
    if (u.approval_status!=='approved') return res.status(403).json({error:'Your account has not been approved. Contact the administrator.'});
    if (!u.email_verified_at) return res.status(403).json({error:'Account verification is incomplete. Contact the administrator.'});
    const accessToken=jwt.sign({sub:u.id,org:u.organization_id,role:u.role,tv:u.token_version||1},process.env.JWT_SECRET,{algorithm:'HS256',expiresIn:'30m',issuer:'trix-pharmacy'});
    res.json({accessToken,tokenType:'Bearer',expiresIn:1800,user:{id:u.id,name:u.full_name,email:u.email,username:u.username,role:u.role,organizationId:u.organization_id,permissions:ROLE_PERMISSIONS[u.role]||[]}});
  }));

  r.post('/auth/logout', auth, asyncRoute(async (req,res) => {
    await pool.query('UPDATE users SET token_version=token_version+1 WHERE id=$1', [req.user.id]);
    res.json({ message: 'Signed out and session token revoked.' });
  }));

  r.post('/auth/change-password', auth, asyncRoute(async (req,res) => {
    const d=z.object({currentPassword:z.string().min(1).max(128),newPassword:z.string().min(12).max(128)}).parse(req.body);
    const q=await pool.query('SELECT password_hash FROM users WHERE id=$1',[req.user.id]);
    if(!q.rowCount || !(await bcrypt.compare(d.currentPassword, q.rows[0].password_hash))) return res.status(401).json({error:'Current password is incorrect.'});
    const hash=await bcrypt.hash(d.newPassword,12);
    await pool.query('UPDATE users SET password_hash=$1, token_version=token_version+1 WHERE id=$2',[hash,req.user.id]);
    await pool.query("INSERT INTO audit_logs(organization_id,user_id,action,entity_type,entity_id) VALUES($1,$2,'password_changed','user',$2)",[req.user.organization_id,req.user.id]);
    res.json({message:'Password changed and all previous sessions revoked. Please sign in again.'});
  }));

  r.post('/auth/forgot-password', asyncRoute(async (req,res) => {
    const d=z.object({email:z.string().email().transform(v=>v.toLowerCase())}).parse(req.body);
    const u=(await pool.query('SELECT id,email FROM users WHERE lower(email)=lower($1) AND active=true',[d.email])).rows[0];
    // Always return the same message to avoid account enumeration.
    if (u && mailer()) {
      const raw=crypto.randomBytes(32).toString('hex');
      await pool.query('INSERT INTO password_reset_tokens(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval \'20 minutes\')',[u.id,tokenHash(raw)]);
      const link=`${process.env.PUBLIC_APP_URL || 'http://localhost:3000'}/reset-password.html?token=${raw}`;
      await mailer().sendMail({from:process.env.MAIL_FROM,to:u.email,subject:'Reset your MP PHARMAI password',text:`Use this link within 20 minutes: ${link}\nIf you did not request this, ignore this message.`});
    }
    res.status(202).json({message:'If that account exists and email is configured, recovery instructions will be sent.'});
  }));
  r.post('/auth/reset-password', asyncRoute(async (req,res) => {
    const d=z.object({token:z.string().min(40).max(200),newPassword:z.string().min(12).max(128)}).parse(req.body);
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      const q=await client.query('SELECT id,user_id FROM password_reset_tokens WHERE token_hash=$1 AND used_at IS NULL AND expires_at>now() FOR UPDATE',[tokenHash(d.token)]);
      if(!q.rowCount){await client.query('ROLLBACK');return res.status(400).json({error:'Reset token is invalid or expired.'})}
      const hash=await bcrypt.hash(d.newPassword,12);
      await client.query('UPDATE users SET password_hash=$1, token_version=token_version+1 WHERE id=$2',[hash,q.rows[0].user_id]);
      await client.query('UPDATE password_reset_tokens SET used_at=now() WHERE user_id=$1 AND used_at IS NULL',[q.rows[0].user_id]);
      await client.query('COMMIT');res.json({message:'Password updated. Sign in again.'});
    } catch(e){await client.query('ROLLBACK');throw e} finally{client.release()}
  }));

  // Public, database-backed plan catalogue.
  r.get('/plans',asyncRoute(async(req,res)=>{
    try {
      const q=await pool.query(`SELECT code,name,monthly_price,annual_price,currency,features,limits
        FROM plans WHERE active=true ORDER BY CASE code WHEN 'free' THEN 1 WHEN 'premium' THEN 2 WHEN 'business' THEN 3 ELSE 0 END`);
      res.json({plans:q.rows});
    } catch (error) {
      if (error.code === '42P01') return res.status(503).json({error:'The billing database has not been initialized. Run the project migration (npm run migrate) for this Render service, then reload Plans & Billing.'});
      throw error;
    }
  }));

  r.get('/admin/users',auth,allow('owner','admin'),asyncRoute(async(req,res)=>{
    const q=await pool.query(`SELECT u.id,u.full_name,u.username,u.email,u.phone,u.role,u.active,u.approval_status,u.requested_role,u.created_at,
      COALESCE(json_agg(json_build_object('id',b.id,'code',b.code,'name',b.name)) FILTER (WHERE b.id IS NOT NULL),'[]') AS branches
      FROM users u LEFT JOIN user_branch_access uba ON uba.user_id=u.id LEFT JOIN branches b ON b.id=uba.branch_id AND b.active=true
      WHERE u.organization_id=$1 GROUP BY u.id ORDER BY u.created_at`,[req.user.organization_id]);
    res.json({users:q.rows});
  }));
  r.patch('/admin/users/:userId',auth,allow('owner'),asyncRoute(async(req,res)=>{
    const d=z.object({role:z.enum(roles).optional(),active:z.boolean().optional(),approvalStatus:z.enum(['approved','suspended','rejected']).optional()}).refine(v=>v.role!==undefined||v.active!==undefined||v.approvalStatus!==undefined,{message:'Provide at least one field to update.'}).parse(req.body);
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      const target=(await client.query('SELECT id,role,active,approval_status FROM users WHERE id=$1 AND organization_id=$2 FOR UPDATE',[req.params.userId,req.user.organization_id])).rows[0];
      if(!target){await client.query('ROLLBACK');return res.status(404).json({error:'User not found in this organization.'});}
      const nextRole=d.role??target.role;
      const nextActive=d.active??target.active;
      const nextStatus=d.approvalStatus??target.approval_status;
      if(target.role==='owner'&&(nextRole!=='owner'||!nextActive||nextStatus!=='approved')){
        const owners=await client.query("SELECT COUNT(*)::int AS n FROM users WHERE organization_id=$1 AND role='owner' AND active=true AND approval_status='approved'",[req.user.organization_id]);
        if(owners.rows[0].n<=1){await client.query('ROLLBACK');return res.status(409).json({error:'Cannot demote or deactivate the last active owner.'});}
      }
      const updated=(await client.query('UPDATE users SET role=$1,active=$2,approval_status=$3,token_version=token_version+1 WHERE id=$4 RETURNING id,full_name,email,username,role,active,approval_status',[nextRole,nextActive,nextStatus,target.id])).rows[0];
      await client.query("INSERT INTO audit_logs(organization_id,user_id,action,entity_type,entity_id,details) VALUES($1,$2,'staff_account_updated','user',$3,$4)",[req.user.organization_id,req.user.id,target.id,JSON.stringify({role:nextRole,active:nextActive,approvalStatus:nextStatus})]);
      await client.query('COMMIT');
      res.json({message:'Staff account updated and active sessions refreshed.',user:updated});
    }catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
  }));
  r.get('/admin/users/pending',auth,allow('owner','admin'),asyncRoute(async(req,res)=>{
    const q=await pool.query("SELECT id,full_name,username,email,phone,requested_role,created_at FROM users WHERE organization_id=$1 AND approval_status='pending' ORDER BY created_at",[req.user.organization_id]);
    res.json({users:q.rows});
  }));
  r.post('/admin/users/:userId/approve',auth,allow('owner'),asyncRoute(async(req,res)=>{
    const d=z.object({role:z.enum(['admin','pharmacist','stock_controller','cashier','claims'])}).parse(req.body);
    const subLimits=(await pool.query('SELECT p.limits FROM subscriptions s JOIN plans p ON p.code=s.plan_code WHERE s.organization_id=$1',[req.user.organization_id])).rows[0]?.limits||{};
    const maxUsers=Number(subLimits.max_users);
    if(Number.isFinite(maxUsers)&&maxUsers>=0){
      const activeUsers=await pool.query("SELECT COUNT(*)::int AS n FROM users WHERE organization_id=$1 AND active=true AND approval_status='approved'",[req.user.organization_id]);
      if(activeUsers.rows[0].n>=maxUsers)return res.status(403).json({code:'PLAN_LIMIT_REACHED',limit:'max_users',max:maxUsers,error:`Your current plan allows ${maxUsers} active user account(s). Upgrade to approve more staff.`});
    }
    const q=await pool.query("UPDATE users SET role=$1,active=true,approval_status='approved',email_verified_at=COALESCE(email_verified_at,now()) WHERE id=$2 AND organization_id=$3 AND approval_status='pending' RETURNING id,full_name,email,role",[d.role,req.params.userId,req.user.organization_id]);
    if(!q.rowCount)return res.status(404).json({error:'Pending user not found.'});
    await pool.query("INSERT INTO audit_logs(organization_id,user_id,action,entity_type,entity_id,details) VALUES($1,$2,'staff_account_approved','user',$3,$4)",[req.user.organization_id,req.user.id,q.rows[0].id,JSON.stringify({role:d.role})]);
    res.json({message:'Staff account approved.',user:q.rows[0]});
  }));
  r.post('/admin/users/:userId/reject',auth,allow('owner'),asyncRoute(async(req,res)=>{
    const q=await pool.query("UPDATE users SET active=false,approval_status='rejected' WHERE id=$1 AND organization_id=$2 AND approval_status='pending' RETURNING id",[req.params.userId,req.user.organization_id]);
    if(!q.rowCount)return res.status(404).json({error:'Pending user not found.'});
    await pool.query("INSERT INTO audit_logs(organization_id,user_id,action,entity_type,entity_id) VALUES($1,$2,'staff_account_rejected','user',$3)",[req.user.organization_id,req.user.id,q.rows[0].id]);
    res.json({message:'Registration rejected.'});
  }));

  r.get('/me',auth,(req,res)=>res.json({user:req.user}));
  r.get('/owner/me',auth,(req,res)=>res.json({isPlatformOwner:isPlatformOwner(req.user)}));

  async function getSubscription(orgId) {
    const q=await pool.query(`SELECT s.id,s.organization_id,s.plan_code,s.status,s.starts_at,s.ends_at,s.updated_at,
      (s.ends_at > now() AND s.status IN ('trial','active')) AS access_allowed,
      CASE WHEN s.plan_code='free' THEN NULL ELSE GREATEST(0,CEIL(EXTRACT(EPOCH FROM (s.ends_at-now()))/86400))::int END AS days_remaining,
      p.name AS plan_name,p.monthly_price,p.annual_price,p.currency,p.features,p.limits
      FROM subscriptions s JOIN plans p ON p.code=s.plan_code WHERE s.organization_id=$1`,[orgId]);
    return q.rows[0] || null;
  }
  r.get('/subscription',auth,asyncRoute(async(req,res)=>{
    let sub=await getSubscription(req.user.organization_id);
    if(!sub) return res.json({subscription:{plan_code:'trial',status:'expired',access_allowed:false,days_remaining:0,ends_at:null},message:'No subscription exists. Choose Free or renew a paid plan.'});
    if(!sub.access_allowed && ['trial','active'].includes(sub.status)){
      await pool.query("UPDATE subscriptions SET status='expired',updated_at=now() WHERE organization_id=$1 AND ends_at<=now() AND status IN ('trial','active')",[req.user.organization_id]);
      sub.status='expired';
    }
    res.json({subscription:sub,message:sub.access_allowed?'Subscription is active.':'Subscription has expired. Choose the limited Free plan or pay to renew.'});
  }));

  r.get('/billing/summary',auth,allow('owner','admin'),asyncRoute(async(req,res)=>{
    const sub=await getSubscription(req.user.organization_id);
    const payments=await pool.query(`SELECT id,plan_code,billing_interval,amount,currency,provider,status,provider_tx_ref,metadata,paid_at,created_at
      FROM payments WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 20`,[req.user.organization_id]);
    res.json({subscription:sub,payments:payments.rows,paymentMode:paymentMode()==='flutterwave'?'flutterwave':isDevTestPayments()?'test':'disabled',momoPaymentNumber:process.env.MOMO_PAYMENT_NUMBER||'+25079829779'});
  }));

  r.post('/billing/select-free',auth,allow('owner','admin'),asyncRoute(async(req,res)=>{
    const free=(await pool.query("SELECT code FROM plans WHERE code='free' AND active=true")).rows[0];
    if(!free) return res.status(503).json({error:'Free plan is unavailable.'});
    await pool.query(`INSERT INTO subscriptions(organization_id,plan_code,status,starts_at,ends_at,updated_at)
      VALUES($1,'free','active',now(),TIMESTAMPTZ '9999-12-31 23:59:59+00',now())
      ON CONFLICT(organization_id) DO UPDATE SET plan_code='free',status='active',starts_at=now(),ends_at=TIMESTAMPTZ '9999-12-31 23:59:59+00',updated_at=now()`,[req.user.organization_id]);
    res.json({message:'Free plan activated with limits.',subscription:await getSubscription(req.user.organization_id)});
  }));

  r.post('/billing/checkout',auth,allow('owner','admin'),asyncRoute(async(req,res)=>{
    const d=z.object({plan:z.enum(['premium','business']),interval:z.enum(['monthly','annual']).default('monthly')}).parse(req.body||{});
    const p=(await pool.query('SELECT * FROM plans WHERE code=$1 AND active=true',[d.plan])).rows[0];
    if(!p) return res.status(404).json({error:'Selected plan is unavailable.'});
    const amount=money2(d.interval==='annual'?p.annual_price:p.monthly_price);
    if(amount<=0) return res.status(400).json({error:'This plan does not require checkout.'});
    const mode=paymentMode();
    if(mode==='flutterwave'&&!process.env.FLW_SECRET_KEY) return res.status(503).json({error:'Flutterwave is selected but FLW_SECRET_KEY is not configured on the server.'});
    if(mode!=='flutterwave'&&!isDevTestPayments()) return res.status(503).json({error:'Payments are not configured. Use test mode only in local development, or configure Flutterwave on the server.'});
    const txRef=`TRIX-${Date.now()}-${crypto.randomBytes(12).toString('hex')}`;
    const provider=mode==='flutterwave'?'flutterwave':'test';
    const payment=(await pool.query(`INSERT INTO payments(organization_id,initiated_by,plan_code,billing_interval,amount,currency,provider,provider_tx_ref,status)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'pending') RETURNING id,provider_tx_ref,amount,currency`,[req.user.organization_id,req.user.id,d.plan,d.interval,amount,p.currency,provider,txRef])).rows[0];
    if(provider==='test') {
      const checkoutUrl=`${process.env.PUBLIC_APP_URL||'http://localhost:3000'}/api/billing/test-checkout?tx_ref=${encodeURIComponent(txRef)}`;
      await pool.query('UPDATE payments SET checkout_url=$1,updated_at=now() WHERE id=$2',[checkoutUrl,payment.id]);
      return res.status(201).json({checkoutUrl,mode:'test',message:'Local test checkout only. It cannot activate subscriptions in production.'});
    }
    const appUrl=String(process.env.PUBLIC_APP_URL||'').replace(/\/$/,'');
    if(!appUrl.startsWith('https://')) return res.status(503).json({error:'Set PUBLIC_APP_URL to your public HTTPS Render URL before enabling Flutterwave checkout.'});
    try {
      const response=await fetch('https://api.flutterwave.com/v3/payments',{method:'POST',headers:{Authorization:`Bearer ${process.env.FLW_SECRET_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({tx_ref:txRef,amount,currency:p.currency,redirect_url:`${appUrl}/api/billing/flutterwave/callback`,customer:{email:req.user.email,name:req.user.full_name},customizations:{title:'MP PHARMAI',description:`${p.name} ${d.interval} subscription`},meta:{organization_id:req.user.organization_id,plan_code:d.plan,billing_interval:d.interval}})});
      const payload=await response.json().catch(()=>({}));
      if(!response.ok||payload.status!=='success'||!payload.data?.link) throw new Error('Flutterwave did not return a checkout link. Check provider settings and test/live keys.');
      await pool.query('UPDATE payments SET checkout_url=$1,metadata=metadata||$2::jsonb,updated_at=now() WHERE id=$3',[payload.data.link,JSON.stringify({provider_response_status:payload.status}),payment.id]);
      res.status(201).json({checkoutUrl:payload.data.link,mode:'flutterwave',paymentReference:txRef});
    } catch(e) {
      await pool.query("UPDATE payments SET status='failed',metadata=metadata||$1::jsonb,updated_at=now() WHERE id=$2",[JSON.stringify({checkout_error:String(e.message).slice(0,250)}),payment.id]);
      throw Object.assign(new Error('Could not create Flutterwave checkout. Verify your server credentials and provider account.'),{status:502});
    }
  }));

  // Manual MoMo flow: payment remains pending until the platform owner checks the actual
  // incoming transaction in the MoMo merchant/account statement and approves it.
  const momoPaymentNumber = process.env.MOMO_PAYMENT_NUMBER || '+25079829779';
  r.post('/billing/momo/request',auth,allow('owner','admin'),asyncRoute(async(req,res)=>{
    const d=z.object({plan:z.enum(['premium','business']),interval:z.enum(['monthly','annual']).default('monthly')}).parse(req.body||{});
    const p=(await pool.query('SELECT * FROM plans WHERE code=$1 AND active=true',[d.plan])).rows[0];
    if(!p) return res.status(404).json({error:'Selected plan is unavailable.'});
    const amount=money2(d.interval==='annual'?p.annual_price:p.monthly_price);
    if(amount<=0) return res.status(400).json({error:'This plan does not require payment.'});
    const txRef=`TRIX-MOMO-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
    const payment=(await pool.query(`INSERT INTO payments(organization_id,initiated_by,plan_code,billing_interval,amount,currency,provider,provider_tx_ref,status,metadata)
      VALUES($1,$2,$3,$4,$5,$6,'momo',$7,'pending',$8::jsonb) RETURNING id,provider_tx_ref,amount,currency,created_at`,
      [req.user.organization_id,req.user.id,d.plan,d.interval,amount,p.currency,txRef,JSON.stringify({payment_method:'manual_momo',recipient_number:momoPaymentNumber})])).rows[0];
    res.status(201).json({payment,provider:'momo',recipientNumber:momoPaymentNumber,instructions:'Send the exact amount shown using Mobile Money. Keep the official MoMo transaction ID. Enter that ID in the next step. Your subscription will remain pending until the platform owner confirms receipt in the MoMo account statement.',manualVerificationRequired:true});
  }));
  r.post('/billing/momo/submit-reference',auth,allow('owner','admin'),asyncRoute(async(req,res)=>{
    const d=z.object({txRef:z.string().min(15).max(200),momoTransactionReference:z.string().trim().min(4).max(100)}).parse(req.body||{});
    const q=await pool.query(`UPDATE payments SET metadata=metadata||$1::jsonb,updated_at=now()
      WHERE provider_tx_ref=$2 AND organization_id=$3 AND provider='momo' AND status='pending'
      RETURNING provider_tx_ref,plan_code,billing_interval,amount,currency,status`,
      [JSON.stringify({momo_transaction_reference:d.momoTransactionReference,reference_submitted_at:new Date().toISOString()}),d.txRef,req.user.organization_id]);
    if(!q.rowCount) return res.status(404).json({error:'Pending MoMo payment not found for this pharmacy.'});
    res.json({payment:q.rows[0],message:'MoMo transaction reference saved. Subscription is NOT active yet; the platform owner must confirm the money was received.'});
  }));

  async function activateVerifiedPayment(txRef, verified, providerTransactionId) {
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      const q=await client.query('SELECT * FROM payments WHERE provider_tx_ref=$1 FOR UPDATE',[txRef]);
      if(!q.rowCount) throw Object.assign(new Error('Payment reference not found.'),{status:404});
      const pay=q.rows[0];
      if(pay.status==='successful') { await client.query('COMMIT'); return {alreadyProcessed:true,organizationId:pay.organization_id,plan:pay.plan_code}; }
      if(pay.status!=='pending') throw Object.assign(new Error('This payment is not pending.'),{status:409});
      if(verified.status!=='successful'||verified.tx_ref!==pay.provider_tx_ref||String(verified.currency).toUpperCase()!==pay.currency.trim()||Number(verified.amount)<Number(pay.amount)) {
        await client.query("UPDATE payments SET status='failed',provider_transaction_id=COALESCE($1,provider_transaction_id),updated_at=now() WHERE id=$2",[providerTransactionId?String(providerTransactionId):null,pay.id]);
        await client.query('COMMIT');
        throw Object.assign(new Error('Payment verification did not match the expected reference, amount, currency and successful status.'),{status:400});
      }
      if(providerTransactionId) {
        const duplicate=await client.query('SELECT id FROM payments WHERE provider_transaction_id=$1 AND id<>$2',[String(providerTransactionId),pay.id]);
        if(duplicate.rowCount) throw Object.assign(new Error('Provider transaction has already been applied.'),{status:409});
      }
      const days=pay.billing_interval==='annual'?365:30;
      await client.query(`UPDATE payments SET status='successful',provider_transaction_id=$1,paid_at=now(),updated_at=now(),metadata=metadata||$2::jsonb WHERE id=$3`,[providerTransactionId?String(providerTransactionId):null,JSON.stringify({verified:true}),pay.id]);
      await client.query(`INSERT INTO subscriptions(organization_id,plan_code,status,starts_at,ends_at,updated_at)
        VALUES($1,$2,'active',now(),now()+make_interval(days=>$3),now())
        ON CONFLICT(organization_id) DO UPDATE SET
          plan_code=EXCLUDED.plan_code,status='active',
          starts_at=CASE WHEN subscriptions.status='active' AND subscriptions.ends_at>now() THEN subscriptions.starts_at ELSE now() END,
          ends_at=(CASE WHEN subscriptions.status='active' AND subscriptions.ends_at>now() THEN subscriptions.ends_at ELSE now() END)+make_interval(days=>$3),updated_at=now()`,[pay.organization_id,pay.plan_code,days]);
      await client.query(`INSERT INTO audit_logs(organization_id,user_id,action,entity_type,entity_id,details)
        VALUES($1,$2,'subscription_payment_verified','payment',$3,$4)`,[pay.organization_id,pay.initiated_by,pay.id,JSON.stringify({plan:pay.plan_code,amount:pay.amount,currency:pay.currency,provider:pay.provider,txRef:pay.provider_tx_ref})]);
      await client.query('COMMIT');
      return {alreadyProcessed:false,organizationId:pay.organization_id,plan:pay.plan_code};
    } catch(e) { try { await client.query('ROLLBACK'); } catch {} throw e; }
    finally { client.release(); }
  }
  async function verifyFlutterwaveTransaction(transactionId, txRef) {
    if(!process.env.FLW_SECRET_KEY) throw Object.assign(new Error('Flutterwave is not configured.'),{status:503});
    if(!/^\d{1,30}$/.test(String(transactionId||''))) throw Object.assign(new Error('Invalid provider transaction ID.'),{status:400});
    const response=await fetch(`https://api.flutterwave.com/v3/transactions/${encodeURIComponent(transactionId)}/verify`,{headers:{Authorization:`Bearer ${process.env.FLW_SECRET_KEY}`}});
    const payload=await response.json().catch(()=>({}));
    if(!response.ok||payload.status!=='success'||!payload.data) throw Object.assign(new Error('Flutterwave could not verify this transaction.'),{status:502});
    if(txRef && payload.data.tx_ref!==txRef) throw Object.assign(new Error('Flutterwave transaction reference mismatch.'),{status:400});
    return payload.data;
  }

  r.get('/billing/flutterwave/callback',asyncRoute(async(req,res)=>{
    const txRef=String(req.query.tx_ref||'');
    const transactionId=String(req.query.transaction_id||'');
    if(req.query.status!=='successful'||!txRef||!transactionId) { return res.redirect('/?payment=failed'); }
    const payment=(await pool.query('SELECT provider,provider_tx_ref FROM payments WHERE provider_tx_ref=$1',[txRef])).rows[0];
    if(!payment||payment.provider!=='flutterwave') return res.redirect('/?payment=failed');
    try { const verified=await verifyFlutterwaveTransaction(transactionId,txRef); await activateVerifiedPayment(txRef,verified,transactionId); return res.redirect('/?payment=success'); }
    catch(e) { console.error('Flutterwave callback verification failed:',e.message); return res.redirect('/?payment=failed'); }
  }));

  r.post('/billing/flutterwave/webhook',asyncRoute(async(req,res)=>{
    const secret=process.env.FLW_WEBHOOK_SECRET_HASH||'';
    const received=String(req.headers['verif-hash']||'');
    if(!secret||!received||received.length!==secret.length||!crypto.timingSafeEqual(Buffer.from(received),Buffer.from(secret))) return res.status(401).json({error:'Invalid webhook signature.'});
    const txId=req.body?.data?.id;
    if(!txId) return res.status(200).json({received:true,ignored:true});
    try {
      const verified=await verifyFlutterwaveTransaction(String(txId));
      if(verified.status==='successful'&&verified.tx_ref) {
        const payment=(await pool.query('SELECT provider FROM payments WHERE provider_tx_ref=$1',[verified.tx_ref])).rows[0];
        if(payment?.provider==='flutterwave') await activateVerifiedPayment(verified.tx_ref,verified,String(txId));
      }
      res.json({received:true});
    } catch(e) { console.error('Flutterwave webhook processing failed:',e.message); res.status(202).json({received:true,processed:false}); }
  }));

  // A visibly labelled local test checkout. It is impossible to enable in production.
  r.get('/billing/test-checkout',asyncRoute(async(req,res)=>{
    if(!isDevTestPayments()) return res.status(404).send('Not found.');
    const txRef=String(req.query.tx_ref||'');
    const p=(await pool.query(`SELECT provider_tx_ref,plan_code,billing_interval,amount,currency,status FROM payments WHERE provider_tx_ref=$1 AND provider='test'`,[txRef])).rows[0];
    if(!p||p.status!=='pending') return res.status(404).send('Test payment not found or already processed.');
    res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>TRIX Test Checkout</title><style>body{font:16px system-ui;background:#f4f8f7;color:#18343a;display:grid;place-items:center;min-height:100vh;margin:0}.card{background:white;border:1px solid #dbe6e5;border-radius:16px;padding:28px;max-width:480px;margin:20px}.tag{color:#8a4b00;background:#fff1cc;padding:5px 9px;border-radius:99px;font-size:12px;font-weight:bold}button{background:#087f78;color:white;border:0;border-radius:9px;padding:12px 16px;font-weight:bold;cursor:pointer}</style></head><body><main class="card"><span class="tag">DEVELOPMENT TEST ONLY</span><h1>MP PHARMAI checkout</h1><p>Plan: <strong>${p.plan_code.toUpperCase()}</strong> · ${p.billing_interval}</p><p>Amount: <strong>${Number(p.amount).toLocaleString()} ${p.currency.trim()}</strong></p><p>No real money will be charged. Use this screen only to test the server-side payment and subscription flow.</p><button id="pay">Simulate successful test payment</button><p id="status" role="status"></p><script>document.getElementById('pay').onclick=async()=>{const b=document.getElementById('pay');b.disabled=true;document.getElementById('status').textContent='Processing test event…';try{const r=await fetch('/api/billing/test/complete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tx_ref:${JSON.stringify(txRef)}})});const d=await r.json();if(!r.ok)throw Error(d.error||'Test payment failed');location.href='/?payment=success&mode=test'}catch(e){document.getElementById('status').textContent=e.message;b.disabled=false}}</script></main></body></html>`);
  }));
  r.post('/billing/test/complete',asyncRoute(async(req,res)=>{
    if(!isDevTestPayments()) return res.status(404).json({error:'Not found.'});
    const d=z.object({tx_ref:z.string().min(20).max(200)}).parse(req.body||{});
    const pay=(await pool.query("SELECT * FROM payments WHERE provider_tx_ref=$1 AND provider='test'",[d.tx_ref])).rows[0];
    if(!pay||pay.status!=='pending') return res.status(409).json({error:'Test payment is not pending.'});
    const result=await activateVerifiedPayment(d.tx_ref,{status:'successful',tx_ref:d.tx_ref,amount:Number(pay.amount),currency:pay.currency.trim()},`TEST-${crypto.randomBytes(8).toString('hex')}`);
    res.json({message:'Test payment recorded by the development adapter. No real money was charged.',result});
  }));

  r.post('/owner/payments/:txRef/confirm-momo',auth,asyncRoute(async(req,res)=>{
    if(!isPlatformOwner(req.user)) return res.status(403).json({error:'Platform-owner access required.'});
    const confirmation=z.object({confirmReceived:z.literal(true)}).parse(req.body||{});
    const pay=(await pool.query(`SELECT * FROM payments WHERE provider_tx_ref=$1 AND provider='momo'`,[req.params.txRef])).rows[0];
    if(!pay) return res.status(404).json({error:'MoMo payment was not found.'});
    if(pay.status==='successful') return res.status(409).json({error:'This payment has already been applied.'});
    if(pay.status!=='pending') return res.status(409).json({error:'This MoMo payment is not pending.'});
    const momoRef=String(pay.metadata?.momo_transaction_reference||'').trim();
    if(momoRef.length<4) return res.status(400).json({error:'Customer must submit the official MoMo transaction ID first.'});
    // This is a manual approval, not a live MoMo API verification. The owner must inspect
    // the receiving account's transaction history before sending confirmReceived=true.
    const result=await activateVerifiedPayment(pay.provider_tx_ref,{status:'successful',tx_ref:pay.provider_tx_ref,amount:Number(pay.amount),currency:pay.currency.trim()},momoRef);
    await pool.query(`UPDATE payments SET metadata=metadata||$1::jsonb,updated_at=now() WHERE provider_tx_ref=$2`,
      [JSON.stringify({manual_momo_approved_by:req.user.email,manual_momo_approved_at:new Date().toISOString(),manual_momo_confirmation:true}),pay.provider_tx_ref]);
    res.json({message:'MoMo payment manually approved and subscription activated.',result});
  }));

  r.get('/owner/revenue',auth,asyncRoute(async(req,res)=>{
    if(!isPlatformOwner(req.user)) return res.status(403).json({error:'Platform-owner access required.'});
    const summary=(await pool.query(`SELECT
      COALESCE(SUM(amount) FILTER (WHERE status='successful' AND paid_at>=date_trunc('month',now())),0)::numeric(14,2) AS revenue_this_month,
      COALESCE(SUM(amount) FILTER (WHERE status='successful'),0)::numeric(14,2) AS lifetime_revenue,
      COUNT(*) FILTER (WHERE status='successful')::int AS successful_payments,
      COUNT(*) FILTER (WHERE status='pending')::int AS pending_payments,
      COUNT(DISTINCT organization_id) FILTER (WHERE status='successful')::int AS paying_pharmacies
      FROM payments`)).rows[0];
    const subs=(await pool.query(`SELECT plan_code,status,COUNT(*)::int AS count FROM subscriptions GROUP BY plan_code,status ORDER BY plan_code,status`)).rows;
    const recent=(await pool.query(`SELECT p.id,p.plan_code,p.billing_interval,p.amount,p.currency,p.status,p.provider,p.provider_tx_ref,p.metadata,p.paid_at,p.created_at,o.name AS organization_name,u.email AS initiated_by_email
      FROM payments p JOIN organizations o ON o.id=p.organization_id JOIN users u ON u.id=p.initiated_by ORDER BY p.created_at DESC LIMIT 100`)).rows;
    res.json({summary,subscriptions:subs,recentPayments:recent});
  }));

  r.post('/subscription/renew-request',auth,allow('owner','admin'),asyncRoute(async(req,res)=>{
    const d=z.object({plan:z.enum(['premium','business']).default('premium')}).parse(req.body||{});
    const q=await pool.query(`INSERT INTO subscription_renewal_requests(organization_id,requested_by,requested_plan)
      VALUES($1,$2,$3) RETURNING id,requested_plan,status,created_at`,[req.user.organization_id,req.user.id,d.plan]);
    res.status(201).json({request:q.rows[0],message:'Renewal request submitted. Use Plans & Billing to complete payment; requests alone never activate a plan.'});
  }));

  // Server-side subscription and plan-feature enforcement for all operational API routes below.
  r.use(auth,asyncRoute(async(req,res,next)=>{
    const sub=await getSubscription(req.user.organization_id);
    if(!sub||!sub.access_allowed) {
      if(sub&&['trial','active'].includes(sub.status)) await pool.query("UPDATE subscriptions SET status='expired',updated_at=now() WHERE organization_id=$1 AND ends_at<=now() AND status IN ('trial','active')",[req.user.organization_id]);
      return res.status(402).json({code:'SUBSCRIPTION_EXPIRED',error:'Your trial or subscription has expired. Choose the limited Free plan or renew a paid subscription.',subscription:sub?{plan:sub.plan_code,status:'expired',ends_at:sub.ends_at}:{plan:'trial',status:'expired',ends_at:null}});
    }
    req.subscription=sub;
    const features=sub.features||{}; const limits=sub.limits||{};
    const isTransfer=req.path==='/transfers'||/^\/transfers\/[^/]+\/receive$/.test(req.path);
    if(isTransfer&&!features.stock_transfers) return res.status(403).json({code:'PLAN_FEATURE_REQUIRED',feature:'stock_transfers',error:'Stock transfers require the Business plan.'});
    if(req.method==='POST'&&req.path==='/branches'&&Number.isFinite(Number(limits.max_branches))){
      const count=await pool.query('SELECT COUNT(*)::int AS n FROM branches WHERE organization_id=$1 AND active=true',[req.user.organization_id]);
      if(count.rows[0].n>=Number(limits.max_branches)) return res.status(403).json({code:'PLAN_LIMIT_REACHED',limit:'max_branches',max:Number(limits.max_branches),error:`Your ${sub.plan_code} plan allows ${limits.max_branches} active branch(es). Upgrade to add more.`});
    }
    next();
  }));
  r.get('/branches',auth,asyncRoute(async(req,res)=>{
    const q=await pool.query(`SELECT b.id,b.code,b.name,b.address FROM branches b
      JOIN user_branch_access a ON a.branch_id=b.id
      WHERE b.organization_id=$1 AND a.user_id=$2 AND b.active=true ORDER BY b.name`,[req.user.organization_id,req.user.id]);
    res.json({branches:q.rows});
  }));
  r.post('/branches',auth,allow('owner','admin'),asyncRoute(async(req,res)=>{
    const d=z.object({code:z.string().trim().min(2).max(20),name:z.string().trim().min(2).max(120),address:z.string().max(250).optional()}).parse(req.body);
    const client=await pool.connect();
    try{await client.query('BEGIN');
      await client.query('SELECT id FROM subscriptions WHERE organization_id=$1 FOR UPDATE',[req.user.organization_id]);
      const limits=(await client.query('SELECT p.limits FROM subscriptions s JOIN plans p ON p.code=s.plan_code WHERE s.organization_id=$1',[req.user.organization_id])).rows[0]?.limits||{};
      if(Number.isFinite(Number(limits.max_branches))){const count=await client.query('SELECT COUNT(*)::int AS n FROM branches WHERE organization_id=$1 AND active=true',[req.user.organization_id]);if(count.rows[0].n>=Number(limits.max_branches))throw Object.assign(new Error(`Your current plan allows ${limits.max_branches} active branch(es). Upgrade to add more.`),{status:403,code:'PLAN_LIMIT_REACHED'});}
      const b=(await client.query('INSERT INTO branches(organization_id,code,name,address) VALUES($1,$2,$3,$4) RETURNING *',[req.user.organization_id,d.code,d.name,d.address||null])).rows[0];
      await client.query('INSERT INTO user_branch_access(user_id,branch_id) VALUES($1,$2)',[req.user.id,b.id]);
      await client.query('INSERT INTO audit_logs(organization_id,branch_id,user_id,action,entity_type,entity_id,details) VALUES($1,$2,$3,$4,$5,$6,$7)',[req.user.organization_id,b.id,req.user.id,'branch_created','branch',b.id,JSON.stringify({code:b.code,name:b.name})]);
      await client.query('COMMIT');res.status(201).json({branch:b});
    }catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
  }));
  r.post('/branches/:branchId/access',auth,allow('owner','admin'),asyncRoute(async(req,res)=>{
    const d=z.object({userId:z.string().uuid()}).parse(req.body);
    const check=await pool.query('SELECT id FROM branches WHERE id=$1 AND organization_id=$2',[req.params.branchId,req.user.organization_id]);
    const user=await pool.query('SELECT id FROM users WHERE id=$1 AND organization_id=$2',[d.userId,req.user.organization_id]);
    if(!check.rowCount||!user.rowCount)return res.status(404).json({error:'Branch or user not found in this organization.'});
    await pool.query('INSERT INTO user_branch_access(user_id,branch_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[d.userId,req.params.branchId]);
    res.status(201).json({message:'Branch access assigned.'});
  }));
  r.delete('/branches/:branchId/access/:userId',auth,allow('owner','admin'),asyncRoute(async(req,res)=>{
    const check=await pool.query('SELECT id FROM branches WHERE id=$1 AND organization_id=$2',[req.params.branchId,req.user.organization_id]);
    const user=await pool.query('SELECT id FROM users WHERE id=$1 AND organization_id=$2',[req.params.userId,req.user.organization_id]);
    if(!check.rowCount||!user.rowCount)return res.status(404).json({error:'Branch or user not found in this organization.'});
    await pool.query('DELETE FROM user_branch_access WHERE user_id=$1 AND branch_id=$2',[req.params.userId,req.params.branchId]);
    res.json({message:'Branch access revoked.'});
  }));
  r.get('/audit-logs',auth,allow('owner','admin'),asyncRoute(async(req,res)=>{
    const q=await pool.query(`SELECT a.id,a.action,a.entity_type,a.entity_id,a.details,a.created_at,u.full_name AS actor_name,u.role AS actor_role,b.name AS branch_name
      FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id LEFT JOIN branches b ON b.id=a.branch_id
      WHERE a.organization_id=$1 ORDER BY a.created_at DESC LIMIT 150`,[req.user.organization_id]);
    res.json({logs:q.rows});
  }));

  r.get('/products/lookup',auth,asyncRoute(async(req,res)=>{
    const code=String(req.query.barcode||'').trim();
    if(!code||code.length>100)return res.status(400).json({error:'A valid barcode is required.'});
    const q=await pool.query(`SELECT p.id,p.name,p.generic_name,p.strength,p.dosage_form,p.barcode,p.sku,
      COALESCE(json_agg(json_build_object('batchId',sb.id,'branchId',sb.branch_id,'batchNumber',sb.batch_number,'expiryDate',sb.expiry_date,'quantity',sb.quantity_on_hand,'status',sb.status)) FILTER (WHERE sb.id IS NOT NULL),'[]') AS batches
      FROM products p LEFT JOIN user_branch_access uba ON uba.user_id=$3 LEFT JOIN stock_batches sb ON sb.product_id=p.id AND sb.organization_id=p.organization_id AND sb.branch_id=uba.branch_id
      WHERE p.organization_id=$1 AND (p.barcode=$2 OR p.sku=$2) GROUP BY p.id`,[req.user.organization_id,code,req.user.id]);
    if(!q.rowCount)return res.status(404).json({error:'Barcode not found in the verified product catalogue.'});
    res.json({product:q.rows[0]});
  }));
  r.post('/products',auth,allow('owner','admin','pharmacist','stock_controller'),asyncRoute(async(req,res)=>{
    const d=z.object({name:z.string().trim().min(1).max(180),genericName:z.string().max(180).optional(),strength:z.string().trim().min(1).max(100),dosageForm:z.string().trim().min(1).max(80),barcode:z.string().max(100).optional(),sku:z.string().max(100).optional(),activeIngredient:z.string().max(180).optional(),requiresPrescription:z.boolean().optional()}).parse(req.body);
    const q=await pool.query(`INSERT INTO products(organization_id,name,generic_name,strength,dosage_form,barcode,sku,active_ingredient,requires_prescription)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[req.user.organization_id,d.name,d.genericName||null,d.strength,d.dosageForm,d.barcode||null,d.sku||null,d.activeIngredient||null,d.requiresPrescription||false]);
    res.status(201).json({product:q.rows[0]});
  }));
  r.get('/stock',auth,branchAccess,asyncRoute(async(req,res)=>{
    const q=await pool.query(`SELECT sb.*,p.name,p.strength,p.dosage_form,p.barcode,s.name AS supplier_name,
      (sb.expiry_date < CURRENT_DATE) AS expired,
      (sb.expiry_date >= CURRENT_DATE AND sb.expiry_date <= CURRENT_DATE + 90) AS near_expiry
      FROM stock_batches sb JOIN products p ON p.id=sb.product_id LEFT JOIN suppliers s ON s.id=sb.supplier_id
      WHERE sb.organization_id=$1 AND sb.branch_id=$2 ORDER BY sb.expiry_date`,[req.user.organization_id,req.branchId]);
    res.json({batches:q.rows});
  }));
  r.post('/purchases/receive',auth,allow('owner','admin','pharmacist','stock_controller'),asyncRoute(async(req,res)=>{
    const d=z.object({
      branchId:z.string().uuid(),invoiceNumber:z.string().trim().max(100).optional(),
      supplierName:z.string().trim().min(1).max(180),
      items:z.array(z.object({productId:z.string().uuid(),batchNumber:z.string().trim().min(1).max(100),expiryDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),quantity:z.number().int().positive(),reorderLevel:z.number().int().nonnegative().default(0),unitCost:z.number().nonnegative(),unitPrice:z.number().nonnegative()})).min(1).max(100)
    }).parse(req.body);
    const access=await pool.query('SELECT 1 FROM user_branch_access WHERE user_id=$1 AND branch_id=$2',[req.user.id,d.branchId]);
    if(!access.rowCount)return res.status(403).json({error:'No access to this branch.'});
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      const branch=await client.query('SELECT id FROM branches WHERE id=$1 AND organization_id=$2 AND active=true',[d.branchId,req.user.organization_id]);
      if(!branch.rowCount)throw Object.assign(new Error('Branch not found.'),{status:404});
      const supplier=(await client.query(`INSERT INTO suppliers(organization_id,name) VALUES($1,$2)
        ON CONFLICT(organization_id,name) DO UPDATE SET name=EXCLUDED.name RETURNING id`,[req.user.organization_id,d.supplierName])).rows[0];
      let total=0;const received=[];
      for(const item of d.items){
        const product=await client.query('SELECT id,name FROM products WHERE id=$1 AND organization_id=$2',[item.productId,req.user.organization_id]);
        if(!product.rowCount)throw Object.assign(new Error('A product was not found in this pharmacy catalogue.'),{status:404});
        const expiry=await client.query('SELECT $1::date >= CURRENT_DATE AS valid',[item.expiryDate]);
        if(!expiry.rows[0].valid)throw Object.assign(new Error(`Expired stock cannot be received as saleable stock (${item.batchNumber}).`),{status:409});
        const existing=await client.query(`SELECT id FROM stock_batches WHERE branch_id=$1 AND product_id=$2 AND batch_number=$3 FOR UPDATE`,[d.branchId,item.productId,item.batchNumber]);
        let batchId;
        if(existing.rowCount){
          const updated=await client.query(`UPDATE stock_batches SET quantity_on_hand=quantity_on_hand+$1,expiry_date=$2,reorder_level=$3,unit_cost=$4,unit_price=$5,supplier_id=$6
            WHERE id=$7 AND status='available' RETURNING id`,[item.quantity,item.expiryDate,item.reorderLevel,item.unitCost,item.unitPrice,supplier.id,existing.rows[0].id]);
          if(!updated.rowCount)throw Object.assign(new Error('Existing batch is not available for receiving.'),{status:409});
          batchId=updated.rows[0].id;
        }else{
          const created=await client.query(`INSERT INTO stock_batches(organization_id,branch_id,product_id,supplier_id,batch_number,expiry_date,quantity_on_hand,reorder_level,unit_cost,unit_price,status)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'available') RETURNING id`,[req.user.organization_id,d.branchId,item.productId,supplier.id,item.batchNumber,item.expiryDate,item.quantity,item.reorderLevel,item.unitCost,item.unitPrice]);
          batchId=created.rows[0].id;
        }
        await client.query(`INSERT INTO stock_movements(organization_id,branch_id,batch_id,user_id,movement_type,quantity_delta,reference_type,note)
          VALUES($1,$2,$3,$4,'purchase_received',$5,'purchase',$6)`,[req.user.organization_id,d.branchId,batchId,req.user.id,item.quantity,d.invoiceNumber||null]);
        total+=item.quantity*item.unitCost;received.push({product:product.rows[0].name,batchNumber:item.batchNumber,quantity:item.quantity,batchId});
      }
      const purchase=(await client.query(`INSERT INTO purchases(organization_id,branch_id,supplier_id,invoice_number,received_by,total_cost)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[req.user.organization_id,d.branchId,supplier.id,d.invoiceNumber||null,req.user.id,total])).rows[0];
      for(const item of d.items){
        const batch=await client.query('SELECT id FROM stock_batches WHERE branch_id=$1 AND product_id=$2 AND batch_number=$3',[d.branchId,item.productId,item.batchNumber]);
        await client.query('INSERT INTO purchase_items(purchase_id,batch_id,quantity,unit_cost) VALUES($1,$2,$3,$4)',[purchase.id,batch.rows[0].id,item.quantity,item.unitCost]);
      }
      await client.query(`INSERT INTO audit_logs(organization_id,branch_id,user_id,action,entity_type,entity_id,details)
        VALUES($1,$2,$3,'purchase_received','purchase',$4,$5)`,[req.user.organization_id,d.branchId,req.user.id,purchase.id,JSON.stringify({supplier:d.supplierName,invoiceNumber:d.invoiceNumber||null,total,items:received.length})]);
      await client.query('COMMIT');res.status(201).json({purchase,received});
    }catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
  }));

  r.get('/sales',auth,allow('owner','admin','pharmacist','cashier','claims'),asyncRoute(async(req,res)=>{
    const branchId=String(req.query.branchId||'');
    if(!z.string().uuid().safeParse(branchId).success)return res.status(400).json({error:'A valid branchId is required.'});
    const access=await pool.query('SELECT 1 FROM user_branch_access WHERE user_id=$1 AND branch_id=$2',[req.user.id,branchId]);
    if(!access.rowCount)return res.status(403).json({error:'No access to this branch.'});
    const q=await pool.query(`SELECT s.id AS sale_id,s.receipt_number,s.payment_method,s.total AS sale_total,s.created_at,
        p.name,p.strength,sb.batch_number,si.quantity,si.unit_price,si.unit_cost
      FROM sales s JOIN sale_items si ON si.sale_id=s.id
      JOIN stock_batches sb ON sb.id=si.batch_id JOIN products p ON p.id=sb.product_id
      WHERE s.organization_id=$1 AND s.branch_id=$2
      ORDER BY s.created_at DESC,si.id`,[req.user.organization_id,branchId]);
    res.json({items:q.rows});
  }));

  r.post('/sales',auth,allow('owner','admin','pharmacist','cashier'),asyncRoute(async(req,res)=>{
    const d=z.object({branchId:z.string().uuid(),receiptNumber:z.string().trim().min(1).max(80),paymentMethod:z.enum(['cash','mobile_money','card','insurance','other']),items:z.array(z.object({batchId:z.string().uuid(),quantity:z.number().int().positive()})).min(1).max(100)}).parse(req.body);
    const access=await pool.query('SELECT 1 FROM user_branch_access WHERE user_id=$1 AND branch_id=$2',[req.user.id,d.branchId]);
    if(!access.rowCount)return res.status(403).json({error:'No access to this branch.'});
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      await client.query('SELECT id FROM subscriptions WHERE organization_id=$1 FOR UPDATE',[req.user.organization_id]);
      const salesLimit=Number((req.subscription.limits||{}).monthly_sales);
      if(Number.isFinite(salesLimit)&&salesLimit>=0){
        const count=await client.query("SELECT COUNT(*)::int AS n FROM sales WHERE organization_id=$1 AND created_at>=date_trunc('month',now())",[req.user.organization_id]);
        if(count.rows[0].n>=salesLimit) throw Object.assign(new Error(`Your ${req.subscription.plan_code} plan has reached its monthly sales limit. Upgrade to continue.`),{status:403,code:'PLAN_LIMIT_REACHED'});
      }
      let total=0,locked=[];
      for(const item of d.items){
        const q=await client.query(`SELECT sb.*,p.name,(sb.expiry_date < CURRENT_DATE) AS is_expired FROM stock_batches sb JOIN products p ON p.id=sb.product_id
          WHERE sb.id=$1 AND sb.branch_id=$2 AND sb.organization_id=$3 FOR UPDATE`,[item.batchId,d.branchId,req.user.organization_id]);
        if(!q.rowCount)throw Object.assign(new Error('Batch not found at this branch.'),{status:404});
        const b=q.rows[0];
        if(b.status!=='available')throw Object.assign(new Error('Batch is not available for sale.'),{status:409});
        if(b.is_expired)throw Object.assign(new Error('Expired batch blocked.'),{status:409});
        if(b.quantity_on_hand<item.quantity)throw Object.assign(new Error(`Insufficient stock for ${b.name}.`),{status:409});
        await client.query('UPDATE stock_batches SET quantity_on_hand=quantity_on_hand-$1 WHERE id=$2',[item.quantity,b.id]);
        total+=Number(b.unit_price)*item.quantity;locked.push({batch:b,item});
      }
      const sale=(await client.query(`INSERT INTO sales(organization_id,branch_id,cashier_id,receipt_number,payment_method,total)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[req.user.organization_id,d.branchId,req.user.id,d.receiptNumber,d.paymentMethod,total])).rows[0];
      for(const {batch:b,item} of locked){
        await client.query('INSERT INTO sale_items(sale_id,batch_id,quantity,unit_price,unit_cost) VALUES($1,$2,$3,$4,$5)',[sale.id,b.id,item.quantity,b.unit_price,b.unit_cost]);
        await client.query(`INSERT INTO stock_movements(organization_id,branch_id,batch_id,user_id,movement_type,quantity_delta,reference_type,reference_id)
          VALUES($1,$2,$3,$4,'sale',$5,'sale',$6)`,[req.user.organization_id,d.branchId,b.id,req.user.id,-item.quantity,sale.id]);
      }
      await client.query(`INSERT INTO audit_logs(organization_id,branch_id,user_id,action,entity_type,entity_id,details)
        VALUES($1,$2,$3,'sale_created','sale',$4,$5)`,[req.user.organization_id,d.branchId,req.user.id,sale.id,JSON.stringify({total,items:d.items.length})]);
      await client.query('COMMIT');res.status(201).json({sale});
    }catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
  }));
  r.post('/transfers',auth,allow('owner','admin','pharmacist','stock_controller'),asyncRoute(async(req,res)=>{
    const d=z.object({sourceBranchId:z.string().uuid(),destinationBranchId:z.string().uuid(),note:z.string().max(500).optional(),items:z.array(z.object({batchId:z.string().uuid(),quantity:z.number().int().positive()})).min(1).max(100)}).parse(req.body);
    if(d.sourceBranchId===d.destinationBranchId)return res.status(400).json({error:'Source and destination must differ.'});
    const ids=[d.sourceBranchId,d.destinationBranchId];
    const access=await pool.query(`SELECT branch_id FROM user_branch_access WHERE user_id=$1 AND branch_id=ANY($2::uuid[])`,[req.user.id,ids]);
    if(access.rowCount!==2)return res.status(403).json({error:'You need access to both branches to initiate this transfer.'});
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      const transfer=(await client.query(`INSERT INTO stock_transfers(organization_id,source_branch_id,destination_branch_id,requested_by,note)
        VALUES($1,$2,$3,$4,$5) RETURNING *`,[req.user.organization_id,...ids,req.user.id,d.note||null])).rows[0];
      for(const item of d.items){
        const q=await client.query(`SELECT *,(expiry_date < CURRENT_DATE) AS is_expired FROM stock_batches WHERE id=$1 AND branch_id=$2 AND organization_id=$3 FOR UPDATE`,[item.batchId,d.sourceBranchId,req.user.organization_id]);
        if(!q.rowCount)throw Object.assign(new Error('Source batch not found.'),{status:404});
        const b=q.rows[0];
        if(b.status!=='available'||b.is_expired)throw Object.assign(new Error('Unavailable or expired stock cannot be transferred.'),{status:409});
        if(b.quantity_on_hand<item.quantity)throw Object.assign(new Error('Insufficient source stock.'),{status:409});
        await client.query('UPDATE stock_batches SET quantity_on_hand=quantity_on_hand-$1 WHERE id=$2',[item.quantity,b.id]);
        await client.query(`INSERT INTO stock_transfer_items(transfer_id,source_batch_id,product_id,batch_number,expiry_date,quantity,unit_cost,unit_price)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[transfer.id,b.id,b.product_id,b.batch_number,b.expiry_date,item.quantity,b.unit_cost,b.unit_price]);
        await client.query(`INSERT INTO stock_movements(organization_id,branch_id,batch_id,user_id,movement_type,quantity_delta,reference_type,reference_id)
          VALUES($1,$2,$3,$4,'transfer_out',$5,'transfer',$6)`,[req.user.organization_id,d.sourceBranchId,b.id,req.user.id,-item.quantity,transfer.id]);
      }
      await client.query(`INSERT INTO audit_logs(organization_id,branch_id,user_id,action,entity_type,entity_id,details)
        VALUES($1,$2,$3,'transfer_created','transfer',$4,$5)`,[req.user.organization_id,d.sourceBranchId,req.user.id,transfer.id,JSON.stringify({destination:d.destinationBranchId,items:d.items})]);
      await client.query('COMMIT');res.status(201).json({transfer});
    }catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
  }));
  r.post('/transfers/:id/receive',auth,allow('owner','admin','pharmacist','stock_controller'),asyncRoute(async(req,res)=>{
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      const q=await client.query(`SELECT * FROM stock_transfers WHERE id=$1 AND organization_id=$2 FOR UPDATE`,[req.params.id,req.user.organization_id]);
      if(!q.rowCount)throw Object.assign(new Error('Transfer not found.'),{status:404});
      const t=q.rows[0];
      const access=await client.query('SELECT 1 FROM user_branch_access WHERE user_id=$1 AND branch_id=$2',[req.user.id,t.destination_branch_id]);
      if(!access.rowCount)throw Object.assign(new Error('No access to destination branch.'),{status:403});
      if(t.status!=='in_transit')throw Object.assign(new Error('Transfer is not awaiting receipt.'),{status:409});
      const items=(await client.query('SELECT * FROM stock_transfer_items WHERE transfer_id=$1',[t.id])).rows;
      for(const item of items){
        let dest=await client.query(`SELECT id FROM stock_batches WHERE branch_id=$1 AND product_id=$2 AND batch_number=$3 FOR UPDATE`,[t.destination_branch_id,item.product_id,item.batch_number]);
        let batchId;
        if(dest.rowCount){
          batchId=dest.rows[0].id;
          await client.query('UPDATE stock_batches SET quantity_on_hand=quantity_on_hand+$1 WHERE id=$2',[item.quantity,batchId]);
        }else{
          const ins=await client.query(`INSERT INTO stock_batches(organization_id,branch_id,product_id,batch_number,expiry_date,quantity_on_hand,unit_cost,unit_price,status)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,'available') RETURNING id`,[req.user.organization_id,t.destination_branch_id,item.product_id,item.batch_number,item.expiry_date,item.quantity,item.unit_cost,item.unit_price]);
          batchId=ins.rows[0].id;
        }
        await client.query(`INSERT INTO stock_movements(organization_id,branch_id,batch_id,user_id,movement_type,quantity_delta,reference_type,reference_id)
          VALUES($1,$2,$3,$4,'transfer_in',$5,'transfer',$6)`,[req.user.organization_id,t.destination_branch_id,batchId,req.user.id,item.quantity,t.id]);
      }
      await client.query(`UPDATE stock_transfers SET status='received',received_by=$1,received_at=now() WHERE id=$2`,[req.user.id,t.id]);
      await client.query(`INSERT INTO audit_logs(organization_id,branch_id,user_id,action,entity_type,entity_id)
        VALUES($1,$2,$3,'transfer_received','transfer',$4)`,[req.user.organization_id,t.destination_branch_id,req.user.id,t.id]);
      await client.query('COMMIT');res.json({message:'Transfer received.',transferId:t.id});
    }catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
  }));
  r.get('/reports/expiry',auth,allow('owner','admin','pharmacist','stock_controller'),asyncRoute(async(req,res)=>{
    const q=await pool.query(`SELECT b.id,b.branch_id,p.name,p.strength,b.batch_number,b.quantity_on_hand,b.expiry_date,
      (b.expiry_date-CURRENT_DATE) AS days_left,b.status FROM stock_batches b JOIN products p ON p.id=b.product_id
      JOIN user_branch_access uba ON uba.branch_id=b.branch_id AND uba.user_id=$2
      WHERE b.organization_id=$1 AND (b.expiry_date<=CURRENT_DATE+90 OR b.status<>'available') ORDER BY b.expiry_date`,[req.user.organization_id,req.user.id]);
    res.json({batches:q.rows});
  }));


  // Persistent stock-safety workflows: all changes are transactional and auditable.
  r.post('/stock/:batchId/quarantine',auth,allow('owner','admin','pharmacist','stock_controller'),asyncRoute(async(req,res)=>{
    const d=z.object({branchId:z.string().uuid(),reason:z.string().trim().min(3).max(500),notes:z.string().max(1000).optional()}).parse(req.body);
    const access=await pool.query('SELECT 1 FROM user_branch_access WHERE user_id=$1 AND branch_id=$2',[req.user.id,d.branchId]);
    if(!access.rowCount)return res.status(403).json({error:'No access to this branch.'});
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      const q=await client.query(`SELECT sb.*,p.name,p.strength FROM stock_batches sb JOIN products p ON p.id=sb.product_id
        WHERE sb.id=$1 AND sb.branch_id=$2 AND sb.organization_id=$3 FOR UPDATE`,[req.params.batchId,d.branchId,req.user.organization_id]);
      if(!q.rowCount)throw Object.assign(new Error('Stock batch not found.'),{status:404});
      const b=q.rows[0];
      if(b.status==='disposed')throw Object.assign(new Error('Disposed stock cannot be quarantined again.'),{status:409});
      if(b.status!=='quarantined')await client.query(`UPDATE stock_batches SET status='quarantined' WHERE id=$1`,[b.id]);
      const event=(await client.query(`INSERT INTO stock_control_events(organization_id,branch_id,batch_id,actor_id,event_type,quantity,reason,notes)
        VALUES($1,$2,$3,$4,'quarantined',$5,$6,$7) RETURNING *`,[req.user.organization_id,d.branchId,b.id,req.user.id,b.quantity_on_hand,d.reason,d.notes||null])).rows[0];
      await client.query(`INSERT INTO audit_logs(organization_id,branch_id,user_id,action,entity_type,entity_id,details)
        VALUES($1,$2,$3,'stock_quarantined','stock_batch',$4,$5)`,[req.user.organization_id,d.branchId,req.user.id,b.id,JSON.stringify({reason:d.reason,quantity:b.quantity_on_hand,eventId:event.id})]);
      await client.query('COMMIT');res.status(201).json({message:'Batch quarantined. Server-side sale checks will block it.',event});
    }catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
  }));

  r.post('/stock/:batchId/dispositions',auth,allow('owner','admin','pharmacist','stock_controller'),asyncRoute(async(req,res)=>{
    const d=z.object({branchId:z.string().uuid(),type:z.enum(['return_to_supplier','disposal']),quantity:z.number().int().positive(),reason:z.string().trim().min(3).max(500),referenceNumber:z.string().max(120).optional(),notes:z.string().max(1000).optional()}).parse(req.body);
    const access=await pool.query('SELECT 1 FROM user_branch_access WHERE user_id=$1 AND branch_id=$2',[req.user.id,d.branchId]);
    if(!access.rowCount)return res.status(403).json({error:'No access to this branch.'});
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      const q=await client.query(`SELECT sb.*,p.name,p.strength FROM stock_batches sb JOIN products p ON p.id=sb.product_id
        WHERE sb.id=$1 AND sb.branch_id=$2 AND sb.organization_id=$3 FOR UPDATE`,[req.params.batchId,d.branchId,req.user.organization_id]);
      if(!q.rowCount)throw Object.assign(new Error('Stock batch not found.'),{status:404});
      const b=q.rows[0];
      if(!['quarantined','damaged','recalled'].includes(b.status))throw Object.assign(new Error('Quarantine the batch and document the reason before return or disposal.'),{status:409});
      if(d.quantity>b.quantity_on_hand)throw Object.assign(new Error('Disposition quantity exceeds remaining stock.'),{status:409});
      const nextQty=b.quantity_on_hand-d.quantity;
      const nextStatus=nextQty===0 && d.type==='disposal' ? 'disposed' : b.status;
      await client.query('UPDATE stock_batches SET quantity_on_hand=$1,status=$2 WHERE id=$3',[nextQty,nextStatus,b.id]);
      const movementType=d.type==='disposal'?'writeoff':'return';
      await client.query(`INSERT INTO stock_movements(organization_id,branch_id,batch_id,user_id,movement_type,quantity_delta,reference_type,note)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[req.user.organization_id,d.branchId,b.id,req.user.id,movementType,-d.quantity,d.type,d.reason]);
      const event=(await client.query(`INSERT INTO stock_control_events(organization_id,branch_id,batch_id,actor_id,event_type,quantity,reason,reference_number,notes)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[req.user.organization_id,d.branchId,b.id,req.user.id,d.type==='disposal'?'disposed':'return_to_supplier',d.quantity,d.reason,d.referenceNumber||null,d.notes||null])).rows[0];
      await client.query(`INSERT INTO audit_logs(organization_id,branch_id,user_id,action,entity_type,entity_id,details)
        VALUES($1,$2,$3,$4,'stock_batch',$5,$6)`,[req.user.organization_id,d.branchId,req.user.id,d.type==='disposal'?'stock_disposed':'stock_returned',b.id,JSON.stringify({quantity:d.quantity,remaining:nextQty,reason:d.reason,referenceNumber:d.referenceNumber||null,eventId:event.id})]);
      await client.query('COMMIT');res.status(201).json({message:'Disposition recorded in the database.',remainingQuantity:nextQty,status:nextStatus,event});
    }catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
  }));

  r.post('/inspections',auth,allow('owner','admin','pharmacist','stock_controller'),asyncRoute(async(req,res)=>{
    const d=z.object({branchId:z.string().uuid(),storageConditions:z.string().max(1000).optional(),packagingCondition:z.string().max(1000).optional(),expiryCheck:z.string().max(1000).optional(),discrepancies:z.string().max(1000).optional(),notes:z.string().trim().min(2).max(2000)}).parse(req.body);
    const access=await pool.query('SELECT 1 FROM user_branch_access WHERE user_id=$1 AND branch_id=$2',[req.user.id,d.branchId]);
    if(!access.rowCount)return res.status(403).json({error:'No access to this branch.'});
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      const row=(await client.query(`INSERT INTO stock_inspections(organization_id,branch_id,inspected_by,storage_conditions,packaging_condition,expiry_check,discrepancies,notes)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[req.user.organization_id,d.branchId,req.user.id,d.storageConditions||null,d.packagingCondition||null,d.expiryCheck||null,d.discrepancies||null,d.notes])).rows[0];
      await client.query(`INSERT INTO audit_logs(organization_id,branch_id,user_id,action,entity_type,entity_id,details)
        VALUES($1,$2,$3,'stock_inspection_recorded','stock_inspection',$4,$5)`,[req.user.organization_id,d.branchId,req.user.id,row.id,JSON.stringify({inspectionId:row.id})]);
      await client.query('COMMIT');res.status(201).json({inspection:row});
    }catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
  }));
  r.get('/inspections',auth,allow('owner','admin','pharmacist','stock_controller'),asyncRoute(async(req,res)=>{
    const branchId=String(req.query.branchId||'');
    if(!branchId)return res.status(400).json({error:'branchId is required.'});
    const access=await pool.query('SELECT 1 FROM user_branch_access WHERE user_id=$1 AND branch_id=$2',[req.user.id,branchId]);
    if(!access.rowCount)return res.status(403).json({error:'No access to this branch.'});
    const q=await pool.query(`SELECT i.*,u.full_name AS inspector_name FROM stock_inspections i JOIN users u ON u.id=i.inspected_by
      WHERE i.organization_id=$1 AND i.branch_id=$2 ORDER BY i.inspected_at DESC LIMIT 50`,[req.user.organization_id,branchId]);
    res.json({inspections:q.rows});
  }));

  r.get('/catalog',auth,asyncRoute(async(req,res)=>{
    const search=String(req.query.search||'').trim().slice(0,100);
    const like=`%${search.replace(/[\\%_]/g,'\\$&')}%`;
    const reference=await pool.query(`SELECT id,generic_name,strength_form,therapeutic_area,common_use,prescription_status,safety_note,source_note
      FROM medicine_reference WHERE active=true AND ($1='' OR generic_name ILIKE $2 OR strength_form ILIKE $2 OR therapeutic_area ILIKE $2 OR common_use ILIKE $2)
      ORDER BY generic_name LIMIT 250`,[search,like]);
    const products=await pool.query(`SELECT p.id,p.name,p.generic_name,p.strength,p.dosage_form,p.barcode,p.sku,p.requires_prescription,
      COALESCE(json_agg(json_build_object('batchId',sb.id,'branchId',sb.branch_id,'batchNumber',sb.batch_number,'expiryDate',sb.expiry_date,'quantity',sb.quantity_on_hand,'status',sb.status)) FILTER (WHERE sb.id IS NOT NULL),'[]') AS batches
      FROM products p LEFT JOIN user_branch_access uba ON uba.user_id=$4 LEFT JOIN stock_batches sb ON sb.product_id=p.id AND sb.organization_id=p.organization_id AND sb.branch_id=uba.branch_id
      WHERE p.organization_id=$1 AND ($2='' OR p.name ILIKE $3 OR COALESCE(p.generic_name,'') ILIKE $3 OR p.strength ILIKE $3 OR p.dosage_form ILIKE $3)
      GROUP BY p.id ORDER BY p.name LIMIT 250`,[req.user.organization_id,search,like,req.user.id]);
    res.json({reference:reference.rows,products:products.rows,referenceNotice:'Reference only. Confirm Rwanda registration, current clinical guidance, approved formulation and prescription status with a qualified pharmacist. This is not a diagnosis or prescribing tool.'});
  }));

  return r;
};
