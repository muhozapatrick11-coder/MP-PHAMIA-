CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  country_code CHAR(2) NOT NULL DEFAULT 'RW',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  access_code TEXT UNIQUE
);
CREATE TABLE IF NOT EXISTS branches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  address TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code),
  UNIQUE (organization_id, id)
);
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  full_name TEXT NOT NULL,
  username TEXT,
  email TEXT NOT NULL,
  phone TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','admin','pharmacist','stock_controller','cashier','claims')),
  email_verified_at TIMESTAMPTZ,
  active BOOLEAN NOT NULL DEFAULT true,
  approval_status TEXT NOT NULL DEFAULT 'approved' CHECK (approval_status IN ('pending','approved','rejected','suspended')),
  requested_role TEXT CHECK (requested_role IN ('admin','pharmacist','stock_controller','cashier','claims')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, email)
);
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS access_code TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS approval_status TEXT NOT NULL DEFAULT 'approved';
ALTER TABLE users ADD COLUMN IF NOT EXISTS requested_role TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 1;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_global_unique ON users (lower(email));
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_global_unique ON users (lower(username)) WHERE username IS NOT NULL;

CREATE TABLE IF NOT EXISTS plans (
  code TEXT PRIMARY KEY CHECK (code IN ('trial','free','premium','business')),
  name TEXT NOT NULL,
  monthly_price NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (monthly_price >= 0),
  annual_price NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (annual_price >= 0),
  currency CHAR(3) NOT NULL DEFAULT 'RWF',
  features JSONB NOT NULL DEFAULT '{}'::jsonb,
  limits JSONB NOT NULL DEFAULT '{}'::jsonb,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO plans(code,name,monthly_price,annual_price,currency,features,limits) VALUES
('trial','30-day trial',0,0,'RWF', '{"multi_branch":true,"stock_transfers":true,"advanced_reports":true,"data_export":true}'::jsonb, '{"max_branches":3,"max_users":10,"monthly_sales":1000}'::jsonb),
('free','Free',0,0,'RWF', '{"multi_branch":false,"stock_transfers":false,"advanced_reports":false,"data_export":false}'::jsonb, '{"max_branches":1,"max_users":3,"monthly_sales":300}'::jsonb),
('premium','Premium',15000,150000,'RWF', '{"multi_branch":false,"stock_transfers":false,"advanced_reports":true,"data_export":true}'::jsonb, '{"max_branches":1,"max_users":10,"monthly_sales":5000}'::jsonb),
('business','Business',35000,350000,'RWF', '{"multi_branch":true,"stock_transfers":true,"advanced_reports":true,"data_export":true}'::jsonb, '{"max_branches":20,"max_users":100,"monthly_sales":-1}'::jsonb)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
  plan_code TEXT NOT NULL DEFAULT 'trial' REFERENCES plans(code),
  status TEXT NOT NULL DEFAULT 'trial' CHECK (status IN ('trial','active','expired','cancelled','past_due')),
  starts_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ends_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '30 days'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
ALTER TABLE subscriptions ALTER COLUMN ends_at SET DEFAULT (now() + interval '30 days');
CREATE INDEX IF NOT EXISTS idx_subscriptions_status_end ON subscriptions(status, ends_at);
-- Give pre-existing organizations a one-time trial when upgrading this schema; do not reset existing subscription dates.
INSERT INTO subscriptions(organization_id,plan_code,status,starts_at,ends_at)
SELECT id,'trial','trial',now(),now()+interval '30 days' FROM organizations
ON CONFLICT (organization_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  initiated_by UUID NOT NULL REFERENCES users(id),
  plan_code TEXT NOT NULL REFERENCES plans(code),
  billing_interval TEXT NOT NULL CHECK (billing_interval IN ('monthly','annual')),
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  currency CHAR(3) NOT NULL DEFAULT 'RWF',
  provider TEXT NOT NULL CHECK (provider IN ('flutterwave','test','momo')),
  provider_tx_ref TEXT NOT NULL UNIQUE,
  provider_transaction_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','successful','failed','cancelled')),
  checkout_url TEXT,
  paid_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Keep provider constraint compatible with existing databases as well as fresh installs.
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_provider_check;
ALTER TABLE payments ADD CONSTRAINT payments_provider_check CHECK (provider IN ('flutterwave','test','momo'));
CREATE INDEX IF NOT EXISTS idx_payments_org_created ON payments(organization_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_status_created ON payments(status,created_at DESC);
CREATE TABLE IF NOT EXISTS subscription_renewal_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  requested_by UUID NOT NULL REFERENCES users(id),
  requested_plan TEXT NOT NULL DEFAULT 'premium' CHECK (requested_plan IN ('premium','business')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','completed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS user_branch_access (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  branch_id UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, branch_id)
);
CREATE TABLE IF NOT EXISTS verification_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  generic_name TEXT,
  strength TEXT NOT NULL,
  dosage_form TEXT NOT NULL,
  barcode TEXT,
  sku TEXT,
  active_ingredient TEXT,
  requires_prescription BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, barcode),
  UNIQUE (organization_id, sku)
);
CREATE TABLE IF NOT EXISTS suppliers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);
CREATE TABLE IF NOT EXISTS stock_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  branch_id UUID NOT NULL REFERENCES branches(id),
  product_id UUID NOT NULL REFERENCES products(id),
  supplier_id UUID REFERENCES suppliers(id),
  batch_number TEXT NOT NULL,
  expiry_date DATE NOT NULL,
  quantity_on_hand INTEGER NOT NULL DEFAULT 0 CHECK (quantity_on_hand >= 0),
  reorder_level INTEGER NOT NULL DEFAULT 0 CHECK (reorder_level >= 0),
  unit_cost NUMERIC(14,2) NOT NULL CHECK (unit_cost >= 0),
  unit_price NUMERIC(14,2) NOT NULL CHECK (unit_price >= 0),
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','quarantined','recalled','damaged','disposed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (branch_id, product_id, batch_number)
);
CREATE INDEX IF NOT EXISTS idx_batches_branch_product ON stock_batches(branch_id, product_id);
CREATE INDEX IF NOT EXISTS idx_batches_expiry ON stock_batches(expiry_date);
CREATE TABLE IF NOT EXISTS stock_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  branch_id UUID NOT NULL REFERENCES branches(id),
  batch_id UUID NOT NULL REFERENCES stock_batches(id),
  user_id UUID REFERENCES users(id),
  movement_type TEXT NOT NULL CHECK (movement_type IN ('purchase_received','sale','transfer_out','transfer_in','adjustment','writeoff','return')),
  quantity_delta INTEGER NOT NULL,
  reference_type TEXT,
  reference_id UUID,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sales (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  branch_id UUID NOT NULL REFERENCES branches(id),
  cashier_id UUID NOT NULL REFERENCES users(id),
  receipt_number TEXT NOT NULL,
  payment_method TEXT NOT NULL CHECK (payment_method IN ('cash','mobile_money','card','insurance','other')),
  total NUMERIC(14,2) NOT NULL CHECK (total >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (branch_id, receipt_number)
);
CREATE TABLE IF NOT EXISTS sale_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id UUID NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  batch_id UUID NOT NULL REFERENCES stock_batches(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price NUMERIC(14,2) NOT NULL CHECK (unit_price >= 0),
  unit_cost NUMERIC(14,2) NOT NULL CHECK (unit_cost >= 0)
);
CREATE TABLE IF NOT EXISTS purchases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  branch_id UUID NOT NULL REFERENCES branches(id),
  supplier_id UUID REFERENCES suppliers(id),
  invoice_number TEXT,
  received_by UUID NOT NULL REFERENCES users(id),
  total_cost NUMERIC(14,2) NOT NULL CHECK (total_cost >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS purchase_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id UUID NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  batch_id UUID NOT NULL REFERENCES stock_batches(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_cost NUMERIC(14,2) NOT NULL CHECK (unit_cost >= 0)
);
CREATE TABLE IF NOT EXISTS stock_transfers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  source_branch_id UUID NOT NULL REFERENCES branches(id),
  destination_branch_id UUID NOT NULL REFERENCES branches(id),
  status TEXT NOT NULL DEFAULT 'in_transit' CHECK (status IN ('in_transit','received','cancelled')),
  requested_by UUID NOT NULL REFERENCES users(id),
  received_by UUID REFERENCES users(id),
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  received_at TIMESTAMPTZ,
  CHECK (source_branch_id <> destination_branch_id)
);
CREATE TABLE IF NOT EXISTS stock_transfer_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id UUID NOT NULL REFERENCES stock_transfers(id) ON DELETE CASCADE,
  source_batch_id UUID NOT NULL REFERENCES stock_batches(id),
  product_id UUID NOT NULL REFERENCES products(id),
  batch_number TEXT NOT NULL,
  expiry_date DATE NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_cost NUMERIC(14,2) NOT NULL CHECK (unit_cost >= 0),
  unit_price NUMERIC(14,2) NOT NULL CHECK (unit_price >= 0)
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  branch_id UUID REFERENCES branches(id),
  user_id UUID REFERENCES users(id),
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id UUID,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_org_time ON audit_logs(organization_id, created_at DESC);


-- Durable stock-safety and inspection records. These tables are organization/branch scoped.
CREATE TABLE IF NOT EXISTS stock_inspections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  branch_id UUID NOT NULL REFERENCES branches(id),
  inspected_by UUID NOT NULL REFERENCES users(id),
  inspected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  storage_conditions TEXT,
  packaging_condition TEXT,
  expiry_check TEXT,
  discrepancies TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_stock_inspections_branch_time ON stock_inspections(branch_id, inspected_at DESC);

CREATE TABLE IF NOT EXISTS stock_control_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  branch_id UUID NOT NULL REFERENCES branches(id),
  batch_id UUID NOT NULL REFERENCES stock_batches(id),
  actor_id UUID NOT NULL REFERENCES users(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('quarantined','return_to_supplier','disposed','released_after_review')),
  quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  reason TEXT NOT NULL,
  reference_number TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_stock_control_batch_time ON stock_control_events(batch_id, created_at DESC);

-- Curated reference data only; this is not a prescribing decision-support database.
CREATE TABLE IF NOT EXISTS medicine_reference (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  generic_name TEXT NOT NULL,
  strength_form TEXT NOT NULL DEFAULT 'See approved product label',
  therapeutic_area TEXT NOT NULL,
  common_use TEXT NOT NULL,
  prescription_status TEXT NOT NULL DEFAULT 'Verify local classification',
  safety_note TEXT NOT NULL DEFAULT 'Confirm approved indication, formulation, contraindications and local guidance before supply.',
  source_note TEXT NOT NULL DEFAULT 'General reference entry; verify against current Rwanda-approved sources.',
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (generic_name, strength_form, therapeutic_area)
);
CREATE INDEX IF NOT EXISTS idx_medicine_reference_name ON medicine_reference(generic_name);

INSERT INTO medicine_reference(generic_name,strength_form,therapeutic_area,common_use,prescription_status,safety_note) VALUES
('Paracetamol','Multiple oral/topical forms; verify strength','Pain and fever','Pain or fever symptom relief','Verify local classification','Avoid duplicate paracetamol products and check liver-risk warnings.'),
('Ibuprofen','Multiple strengths and forms','Pain and inflammation','Pain, fever and inflammatory symptoms','Verify local classification','Check pregnancy, kidney, ulcer, bleeding and interaction risks.'),
('Diclofenac','Multiple oral/topical forms','Pain and inflammation','Selected pain and inflammatory conditions','Often prescription-dependent; verify locally','NSAID class risks; assess cardiovascular, kidney and gastrointestinal risks.'),
('Amoxicillin','Multiple strengths and forms','Antibacterials','Selected susceptible bacterial infections','Prescription medicine; verify local rules','Antibiotic stewardship; assess allergy and use only for appropriate indication.'),
('Azithromycin','Multiple strengths and forms','Antibacterials','Selected susceptible bacterial infections','Prescription medicine; verify local rules','Check interactions, QT risk and antimicrobial guidance.'),
('Metronidazole','Multiple strengths and forms','Antibacterials and antiprotozoals','Selected anaerobic bacterial and protozoal infections','Prescription medicine; verify local rules','Check interactions and follow current local treatment protocols.'),
('Ceftriaxone','Injection; strength varies','Antibacterials','Selected serious bacterial infections','Prescription; trained administration','Use only under approved clinical protocols; verify allergy and preparation.'),
('Doxycycline','Multiple strengths and forms','Antibacterials','Selected bacterial infections','Prescription medicine; verify local rules','Age, pregnancy, photosensitivity and interaction considerations.'),
('Artemether/lumefantrine','Combination tablets; pack varies','Antimalarials','Treatment of uncomplicated malaria when indicated','Prescription / protocol controlled','Follow current national malaria guidance and weight-based regimen.'),
('Albendazole','Multiple strengths and forms','Antiparasitics','Selected intestinal worm infections','Verify local classification','Pregnancy and age restrictions depend on indication and guidance.'),
('Oral rehydration salts','Standard sachet for dilution','Fluids and electrolytes','Prevention/treatment of dehydration from diarrhoea','Generally non-prescription; verify locally','Mix with exactly the stated water volume; assess danger signs.'),
('Zinc sulfate','Dispersible tablet or syrup; verify strength','Nutrition and diarrhoea care','Adjunct in childhood diarrhoea according to guidelines','Verify local classification','Use age-appropriate local guideline and formulation.'),
('Omeprazole','Multiple strengths and forms','Gastrointestinal','Acid-related gastrointestinal conditions','Verify local classification','Review prolonged use and interactions; refer alarm symptoms.'),
('Oral rehydration solution','Ready-to-use solution where available','Fluids and electrolytes','Fluid replacement','Verify local classification','Check product integrity and storage instructions.'),
('Loperamide','Capsule/tablet; verify strength','Gastrointestinal','Selected acute diarrhoea symptoms in eligible patients','Verify local classification','Not suitable for some children or bloody/high-fever diarrhoea; assess red flags.'),
('Lactulose','Oral solution','Gastrointestinal','Constipation and selected specialist indications','Verify local classification','Check indication and hydration; hepatic encephalopathy requires clinical oversight.'),
('Metformin','Multiple strengths and forms','Diabetes','Type 2 diabetes management','Prescription medicine; verify local rules','Renal function and acute illness considerations; clinician-directed.'),
('Insulin human','Various concentrations and devices','Diabetes','Diabetes management','Prescription; cold-chain handling','High-alert medicine; verify product, concentration, device and storage.'),
('Gliclazide','Modified/immediate-release forms','Diabetes','Type 2 diabetes management','Prescription medicine; verify local rules','Hypoglycaemia risk; formulation and meal routine matter.'),
('Amlodipine','Multiple strengths','Cardiovascular','Hypertension and selected angina','Prescription medicine; verify local rules','Monitor clinical response and oedema; pharmacist checks interactions.'),
('Losartan','Multiple strengths','Cardiovascular','Hypertension and selected kidney/heart indications','Prescription medicine; verify local rules','Pregnancy contraindication and potassium/renal monitoring considerations.'),
('Enalapril','Multiple strengths','Cardiovascular','Hypertension and selected heart failure indications','Prescription medicine; verify local rules','Pregnancy contraindication; monitor kidney function and potassium.'),
('Hydrochlorothiazide','Multiple strengths','Cardiovascular','Hypertension and selected oedema','Prescription medicine; verify local rules','Electrolyte and kidney monitoring may be required.'),
('Furosemide','Multiple forms','Cardiovascular','Oedema and selected cardiac conditions','Prescription medicine; verify local rules','Risk of dehydration and electrolyte disturbance; clinician-directed.'),
('Atorvastatin','Multiple strengths','Cardiovascular','Cholesterol management and cardiovascular risk reduction','Prescription medicine; verify local rules','Check interactions, pregnancy considerations and muscle symptoms.'),
('Salbutamol','Inhaler/nebulizer; verify concentration','Respiratory','Relief of bronchospasm in selected conditions','Verify local classification','Check inhaler technique; worsening breathlessness needs urgent assessment.'),
('Budesonide','Inhaled/nasal forms; verify strength','Respiratory','Controller therapy for selected airway conditions','Prescription-dependent; verify locally','Not a substitute for emergency reliever treatment; teach device use.'),
('Cetirizine','Multiple strengths and forms','Allergy','Allergic rhinitis and urticaria symptoms','Verify local classification','May cause drowsiness; age and renal considerations.'),
('Loratadine','Multiple strengths and forms','Allergy','Allergic rhinitis and urticaria symptoms','Verify local classification','Check age and liver considerations.'),
('Prednisolone','Multiple strengths and forms','Inflammation and immune conditions','Selected inflammatory and immune conditions','Prescription medicine; verify local rules','Dose/duration must be prescribed; do not advise abrupt stopping after prolonged use.'),
('Hydrocortisone','Topical and systemic forms; verify strength','Dermatology / inflammation','Selected inflammatory skin conditions and other approved uses','Depends on formulation; verify locally','Potency, site, duration and infection status matter.'),
('Clotrimazole','Topical/vaginal forms; verify strength','Antifungals','Selected fungal infections','Verify local classification','Confirm body site and formulation; persistent symptoms need assessment.'),
('Fluconazole','Oral forms; verify strength','Antifungals','Selected fungal infections','Prescription-dependent; verify locally','Interactions, pregnancy and liver considerations; indication-specific.'),
('Acyclovir','Oral/topical forms; verify strength','Antivirals','Selected herpes-virus infections','Prescription-dependent; verify locally','Timing, renal function and indication affect appropriate use.'),
('Ferrous sulfate','Multiple oral forms','Haematology and nutrition','Iron deficiency when confirmed/indicated','Verify local classification','Keep away from children; separate from interacting medicines as directed.'),
('Folic acid','Multiple strengths','Nutrition and pregnancy care','Folate supplementation and prevention according to guidelines','Verify local classification','Dose depends on indication and risk; follow national guidance.'),
('Calcium + vitamin D','Multiple forms','Bone health and nutrition','Supplementation when indicated','Verify local classification','Check total intake, renal issues and interactions.'),
('Levothyroxine','Multiple tablet strengths','Endocrine','Hypothyroidism','Prescription medicine; verify local rules','Consistent administration and monitoring are important.'),
('Allopurinol','Multiple strengths','Gout and rheumatology','Prevention of recurrent gout when indicated','Prescription medicine; verify local rules','Not for immediate relief of an acute attack; serious rash needs urgent review.'),
('Colchicine','Tablet; verify strength','Gout and rheumatology','Selected gout/inflammatory indications','Prescription medicine; verify local rules','Narrow safety margin; major interactions and renal/hepatic risks.'),
('Carbamazepine','Multiple forms','Neurology','Epilepsy and selected neuralgia','Prescription medicine; verify local rules','Interactions and monitoring; do not stop abruptly without clinical advice.'),
('Levetiracetam','Multiple forms','Neurology','Epilepsy','Prescription medicine; verify local rules','Prescription monitoring; do not stop abruptly without clinical advice.'),
('Fluoxetine','Multiple strengths','Mental health','Depression and selected mental health conditions','Prescription medicine; verify local rules','Needs clinical assessment and follow-up; screen interactions.'),
('Diazepam','Multiple forms','Neurology and emergency care','Selected indications under clinical direction','Controlled/prescription rules apply; verify locally','Sedation, dependence and respiratory-depression risks; secure controlled handling.'),
('Benzoyl peroxide','Topical forms; verify strength','Dermatology','Acne','Verify local classification','Can irritate skin and bleach fabrics; follow product directions.'),
('Permethrin','Topical forms; verify strength','Dermatology and antiparasitics','Scabies or lice depending on formulation','Verify local classification','Use correct formulation and household/contact measures per guidance.'),
('Timolol','Eye drops; verify strength','Eye care','Glaucoma and raised intraocular pressure','Prescription medicine; verify local rules','Systemic effects possible; check asthma/heart conditions and technique.'),
('Artificial tears','Eye drops; product-specific','Eye care','Dry-eye symptom relief','Verify local classification','Persistent pain, vision changes or injury require urgent assessment.'),
('Levonorgestrel','Emergency contraception; product-specific','Reproductive health','Emergency contraception','Verify local classification','Time-sensitive counselling; does not protect against STIs.'),
('Oxytocin','Injection; product-specific','Obstetric care','Selected obstetric indications in clinical settings','Hospital/clinical protocol controlled','Use only by trained clinicians with appropriate monitoring.'),
('Adrenaline (epinephrine)','Injection/device; product-specific','Emergency care','Severe allergic reaction and other emergency protocols','Emergency protocol controlled','Concentration and route errors are dangerous; trained-use protocols required.'),
('Dextrose','Oral/IV forms; concentration varies','Emergency care and fluids','Hypoglycaemia treatment depending on formulation and setting','Depends on formulation; verify locally','IV use requires trained clinical oversight and concentration checks.'),
('Sodium chloride 0.9%','IV/nasal forms; product-specific','Fluids and electrolytes','Clinical fluid use or nasal care depending on formulation','Depends on formulation; verify locally','Never substitute formulations or routes; IV use is clinician-directed.'),
('Clopidogrel','Tablet; verify strength','Cardiovascular','Antiplatelet therapy for selected indications','Prescription medicine; verify local rules','Bleeding risk and interactions; clinician-directed.'),
('Warfarin','Tablet; multiple strengths','Cardiovascular / anticoagulation','Anticoagulation for selected indications','Prescription medicine; monitored therapy','High-alert medicine; INR monitoring, interactions and bleeding precautions.'),
('Mupirocin','Topical forms; verify strength','Dermatology','Selected local bacterial skin infections','Verify local classification','Use only for appropriate indication and duration.'),
('Ketoconazole','Topical forms; verify strength','Antifungals','Selected fungal skin/scalp conditions','Depends on formulation; verify locally','Oral and topical forms have very different risk profiles; verify formulation.'),
('Lidocaine','Topical/injectable forms; concentration varies','Anaesthesia','Local anaesthesia in approved settings','Depends on formulation; trained-use rules apply','Concentration, route and maximum dose require professional verification.'),
('Multivitamins','Product-specific','Nutrition','Supplementation when indicated','Verify local classification','Avoid duplicating ingredients or implying treatment of all deficiencies.')
ON CONFLICT (generic_name, strength_form, therapeutic_area) DO NOTHING;
