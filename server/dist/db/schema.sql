-- Leak Quote App schema
-- Run via: npm run db:migrate --workspace server

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The quotation letterhead is addressed in one of two shapes, matching the
-- historical quotations in samples/:
--   direct to a property   A5 site_address, A6 postal_code
--   via a company          A5 company_name, A6 site_address, A7 postal_code
-- so company_name is optional and drives which layout is used.
CREATE TABLE IF NOT EXISTS inspections (
  id              SERIAL PRIMARY KEY,
  created_by      INTEGER NOT NULL REFERENCES users(id),
  company_name    TEXT,
  site_address    TEXT NOT NULL,
  postal_code     TEXT,
  -- The "Attn:" contact person on the quotation letterhead.
  contact_name    TEXT,
  inspection_date DATE NOT NULL DEFAULT CURRENT_DATE,
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'quoted', 'approved')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE inspections ADD COLUMN IF NOT EXISTS contact_name TEXT;

-- client_name became company_name: under the letterhead layout above, the
-- first line is either the company or the address, never a person's name
-- (the person goes on the "Attn:" line). Renamed rather than added so the
-- existing rows keep their values.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'inspections' AND column_name = 'client_name')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name = 'inspections' AND column_name = 'company_name')
  THEN
    ALTER TABLE inspections RENAME COLUMN client_name TO company_name;
  END IF;
END $$;
ALTER TABLE inspections ADD COLUMN IF NOT EXISTS company_name TEXT;
ALTER TABLE inspections ALTER COLUMN company_name DROP NOT NULL;
ALTER TABLE inspections ADD COLUMN IF NOT EXISTS postal_code TEXT;

CREATE TABLE IF NOT EXISTS photos (
  id            SERIAL PRIMARY KEY,
  inspection_id INTEGER NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
  file_path     TEXT NOT NULL,
  original_name TEXT,
  mime_type     TEXT,
  size_bytes    INTEGER,
  uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- ai_analysis shape: { leak_type, severity, cause, location_notes,
  --   suggested_repair_approach, confidence (0-1), raw_model_response }
  ai_analysis   JSONB
);

-- The "learning" set: past photo + quotation pairs used as retrieval
-- reference for both pricing and phrasing on future quotations.
CREATE TABLE IF NOT EXISTS quotation_library (
  id               SERIAL PRIMARY KEY,
  -- Nullable: imported historical entries (from old Excel quotes) may have
  -- no linked inspection photo, only app-generated entries will.
  photo_id         INTEGER REFERENCES photos(id) ON DELETE SET NULL,
  -- FK to quotations added below via ALTER TABLE, since quotations is
  -- created after this table.
  quotation_id     INTEGER,
  -- Primary/most-relevant leak type for this quotation as a whole (used for
  -- coarse filtering). Individual line_items carry their own leak_type_tag
  -- for finer-grained retrieval, since one quotation can mix leak-specific
  -- items with generic ones (PPE/protection, paint touch-up).
  leak_type        TEXT NOT NULL,
  severity         TEXT,
  region           TEXT,
  site_type        TEXT,
  -- Each item: { description, quantity, unit, unit_price, total, leak_type_tag }
  -- description is the raw original wording, kept alongside price so
  -- wording and pricing can be reused independently.
  line_items       JSONB NOT NULL,
  final_price      NUMERIC(12, 2) NOT NULL,
  is_style_favorite BOOLEAN NOT NULL DEFAULT false,
  source_type      TEXT NOT NULL DEFAULT 'generated' CHECK (source_type IN ('generated', 'imported')),
  -- Set on imported rows only: the historical quote's own ref number and
  -- source filename (traceability), plus its schedule/warranty text, which
  -- are job-specific values worth reusing as phrasing reference too.
  ref_no           TEXT,
  source_file      TEXT,
  schedule_of_work TEXT,
  warranty_text    TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE quotation_library ADD COLUMN IF NOT EXISTS ref_no TEXT;
ALTER TABLE quotation_library ADD COLUMN IF NOT EXISTS source_file TEXT;
ALTER TABLE quotation_library ADD COLUMN IF NOT EXISTS schedule_of_work TEXT;
ALTER TABLE quotation_library ADD COLUMN IF NOT EXISTS warranty_text TEXT;

CREATE TABLE IF NOT EXISTS quotations (
  id            SERIAL PRIMARY KEY,
  inspection_id INTEGER NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
  -- Each item: { description, quantity, unit, unit_price, total,
  --   leak_type_tag, source_library_id (nullable) }
  line_items    JSONB NOT NULL DEFAULT '[]',
  currency      TEXT NOT NULL DEFAULT 'SGD',
  subtotal      NUMERIC(12, 2) NOT NULL DEFAULT 0,
  tax_rate      NUMERIC(5, 2) NOT NULL DEFAULT 0,
  tax_amount    NUMERIC(12, 2) NOT NULL DEFAULT 0,
  total         NUMERIC(12, 2) NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'approved')),
  excel_path    TEXT,
  -- Auto-generated as SWC{2-digit year}{3-digit sequence}SS on first save,
  -- editable afterward. Unique so two quotations never collide.
  ref_no        TEXT UNIQUE,
  schedule_of_work TEXT,
  warranty_text TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at   TIMESTAMPTZ
);

-- PDF export was dropped in favor of Excel-only exports.
ALTER TABLE quotations DROP COLUMN IF EXISTS pdf_path;
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS ref_no TEXT UNIQUE;
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS schedule_of_work TEXT;
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS warranty_text TEXT;

-- Tracks the last-used sequence number per 2-digit year for ref_no
-- generation (SWC{year}{seq}SS), seeded from imported historical ref
-- numbers so newly generated ones never collide with past quotes that
-- aren't in this database (gaps are expected — some historical ref numbers
-- belong to quotations outside the imported sample set).
CREATE TABLE IF NOT EXISTS ref_number_counters (
  year          INTEGER PRIMARY KEY,
  last_sequence INTEGER NOT NULL DEFAULT 0
);

-- quotation_library.quotation_id references quotations, added after both
-- tables exist to avoid a forward-reference ordering issue.
ALTER TABLE quotation_library
  DROP CONSTRAINT IF EXISTS quotation_library_quotation_id_fkey;
ALTER TABLE quotation_library
  ADD CONSTRAINT quotation_library_quotation_id_fkey
  FOREIGN KEY (quotation_id) REFERENCES quotations(id) ON DELETE SET NULL;

-- Recommended standard line items, kept so Claude suggests from/near a
-- known catalog rather than inventing arbitrary prices.
CREATE TABLE IF NOT EXISTS line_item_catalog (
  id                  SERIAL PRIMARY KEY,
  name                TEXT NOT NULL,
  leak_type           TEXT NOT NULL,
  description_template TEXT,
  unit                TEXT NOT NULL DEFAULT 'lot',
  price_min           NUMERIC(12, 2),
  price_max           NUMERIC(12, 2),
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Recurring standard terms / scope exclusions / closing notes extracted
-- from historical quotations, offered as auto-include boilerplate.
CREATE TABLE IF NOT EXISTS boilerplate_snippets (
  id          SERIAL PRIMARY KEY,
  category    TEXT NOT NULL CHECK (category IN ('terms', 'exclusions', 'closing_note')),
  -- Short label as it appears on the quotation (e.g. "Payment", "Validity").
  -- Nullable: not every snippet has/needs one.
  label       TEXT,
  text        TEXT NOT NULL,
  usage_count INTEGER NOT NULL DEFAULT 1,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE boilerplate_snippets ADD COLUMN IF NOT EXISTS label TEXT;

CREATE INDEX IF NOT EXISTS idx_photos_inspection_id ON photos(inspection_id);
CREATE INDEX IF NOT EXISTS idx_quotations_inspection_id ON quotations(inspection_id);
CREATE INDEX IF NOT EXISTS idx_quotation_library_leak_type ON quotation_library(leak_type);
CREATE INDEX IF NOT EXISTS idx_quotation_library_style_favorite ON quotation_library(is_style_favorite);
CREATE INDEX IF NOT EXISTS idx_line_item_catalog_leak_type ON line_item_catalog(leak_type);

-- ---------------------------------------------------------------------------
-- Photo analysis: controlled vocabulary and teaching set
-- ---------------------------------------------------------------------------

-- The closed set of leak types the vision model may answer with.
--
-- Retrieval matches a photo's leak_type against quotation_library.leak_type
-- exactly (WHERE leak_type ILIKE $1), so a free-text answer that happens not
-- to appear in the library finds nothing, no pricing reference reaches the
-- drafter, and every line item comes out at $0. Constraining the vocabulary
-- is what keeps that path connected; the descriptions double as the model's
-- definition of each type, so it classifies the way the team does.
CREATE TABLE IF NOT EXISTS leak_types (
  id             SERIAL PRIMARY KEY,
  name           TEXT NOT NULL UNIQUE,
  -- What this looks like in a photo — the main classification signal.
  description    TEXT,
  typical_cause  TEXT,
  typical_repair TEXT,
  is_active      BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- What the customer actually reported. A photo often shows only the location
-- (a doorway, a ceiling) with no visible damage, and no amount of model
-- capability recovers a diagnosis from that — the reported symptom is what
-- makes it inferable.
ALTER TABLE inspections ADD COLUMN IF NOT EXISTS reported_issue TEXT;

-- A salesperson's correction (or confirmation) of one photo's AI analysis.
-- Same shape as ai_analysis. Kept alongside rather than overwriting it so
-- the model's original answer stays visible for comparison.
ALTER TABLE photos ADD COLUMN IF NOT EXISTS corrected_analysis JSONB;
ALTER TABLE photos ADD COLUMN IF NOT EXISTS corrected_at TIMESTAMPTZ;
ALTER TABLE photos ADD COLUMN IF NOT EXISTS corrected_by INTEGER REFERENCES users(id);

-- The teaching set: photos with known-correct labels, shown to the model as
-- worked examples. Fed either from corrections made during real inspections
-- or seeded directly from past cases.
CREATE TABLE IF NOT EXISTS leak_case_examples (
  id              SERIAL PRIMARY KEY,
  image_path      TEXT NOT NULL,
  leak_type       TEXT NOT NULL,
  severity        TEXT CHECK (severity IN ('minor', 'moderate', 'severe')),
  cause           TEXT,
  location_notes  TEXT,
  repair_approach TEXT,
  -- Free-text teaching note: what makes this case distinctive, or what an
  -- earlier analysis got wrong about it.
  notes           TEXT,
  source_photo_id INTEGER REFERENCES photos(id) ON DELETE SET NULL,
  -- Whether to send the image itself (not just its labels) in the prompt.
  -- Images teach visual discrimination far better than text, but cost
  -- tokens on every analysis, so the set actually sent is capped.
  use_image       BOOLEAN NOT NULL DEFAULT true,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_by      INTEGER REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_leak_case_examples_leak_type ON leak_case_examples(leak_type);
CREATE INDEX IF NOT EXISTS idx_leak_case_examples_active ON leak_case_examples(is_active);

-- ---------------------------------------------------------------------------
-- Inspection areas
-- ---------------------------------------------------------------------------

-- One job commonly covers several distinct places — a master bathroom, a
-- balcony, a carpark soffit — each needing its own diagnosis, its own photos
-- and its own line item on the quotation. Grouping photos by area is what
-- lets the analysis read each place's photos together without conflating
-- two unrelated defects, and what gives the draft one S/N per area.
CREATE TABLE IF NOT EXISTS inspection_areas (
  id            SERIAL PRIMARY KEY,
  inspection_id INTEGER NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
  -- Where on site this is, in the salesperson's own words. Printed into the
  -- line item description, so it should read the way it would on a quote.
  name          TEXT NOT NULL,
  position      INTEGER NOT NULL DEFAULT 1,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Nullable: photos uploaded before areas existed have none, and are treated
-- as a single unnamed area.
ALTER TABLE photos ADD COLUMN IF NOT EXISTS area_id INTEGER REFERENCES inspection_areas(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_inspection_areas_inspection ON inspection_areas(inspection_id);
CREATE INDEX IF NOT EXISTS idx_photos_area ON photos(area_id);

-- ---------------------------------------------------------------------------
-- Per-salesperson sign-off
-- ---------------------------------------------------------------------------

-- Each salesperson signs their own quotations: their name prints above the
-- "NAME" line, their signature image above the "SIGNATURE" line, and their
-- initials are the last two letters of the quotation's ref number
-- (SWC26031SS for Stanley Seow, SWC26031JT for Jonathan Tan).
ALTER TABLE users ADD COLUMN IF NOT EXISTS signature_path TEXT;
-- Derived from the name when not set, but overridable: initials are not
-- always the first letters of the first and last name.
ALTER TABLE users ADD COLUMN IF NOT EXISTS initials TEXT;

-- Who prepared this quotation. Recorded at creation rather than read from
-- the session at export time, so re-exporting an old quotation still carries
-- the name, signature and ref number of whoever actually wrote it.
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS prepared_by INTEGER REFERENCES users(id);

-- ---------------------------------------------------------------------------
-- Access levels
-- ---------------------------------------------------------------------------

-- 'admin' manages accounts and everything the model learns from — the leak
-- type vocabulary, the teaching set, the case study import, and what gets
-- written into the reference library on approval. 'user' can run inspections
-- and produce quotations but cannot change what the model is taught, so a
-- new salesperson cannot feed it inaccurate history.
ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user';
-- The full set of roles is defined once, further down, where superadmin is
-- introduced. Re-adding a narrower constraint here would fail on any row
-- already holding the wider role — which is exactly what happened.


-- The first account created is the administrator: on an existing install
-- there is nobody else who could grant it, and a system with no admin can
-- never create one.
UPDATE users SET role = 'admin'
WHERE id = (SELECT id FROM users ORDER BY id LIMIT 1)
  AND NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin');

-- ---------------------------------------------------------------------------
-- Admin review of quotations before they train the model
-- ---------------------------------------------------------------------------

-- A quotation written by a salesperson is a commercial document; what the
-- model learns from it is a separate question. This table holds the
-- administrator's training-only version, so wording or prices can be
-- corrected for the library WITHOUT touching the quotation the customer was
-- actually sent. The quotations row is never modified by review.
--
-- A NULL column means "use the quotation's own value" — only what the
-- administrator actually changed is stored.
CREATE TABLE IF NOT EXISTS quotation_reviews (
  id               SERIAL PRIMARY KEY,
  quotation_id     INTEGER NOT NULL UNIQUE REFERENCES quotations(id) ON DELETE CASCADE,
  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'approved', 'rejected')),
  -- Training-only overrides.
  line_items       JSONB,
  leak_type        TEXT,
  schedule_of_work TEXT,
  warranty_text    TEXT,
  final_price      NUMERIC(12, 2),
  -- Why it was amended, or why it was rejected.
  notes            TEXT,
  reviewed_by      INTEGER REFERENCES users(id),
  reviewed_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_quotation_reviews_status ON quotation_reviews(status);

-- Which library rows came from an admin-reviewed quotation, so a review can
-- be withdrawn without guessing what it added.
ALTER TABLE quotation_library ADD COLUMN IF NOT EXISTS review_id INTEGER REFERENCES quotation_reviews(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- Super administrator
-- ---------------------------------------------------------------------------

-- Three levels now:
--   user        own inspections and quotations; approvals go to review
--   admin       own inspections and quotations, approved straight into the
--               library; plus the Review tab for users' work
--   superadmin  as admin, plus visibility of everyone's work
--
-- Everyone, including a superadmin, sees only their own jobs in the normal
-- Inspections list. Other people's work is reached through Review (admins,
-- users' quotations only) or All Quotations (superadmin, everything).
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('superadmin', 'admin', 'user'));

-- The founding account becomes superadmin: there is nobody else who could
-- grant it, and a system with no superadmin can never create one.
UPDATE users SET role = 'superadmin'
WHERE id = (SELECT id FROM users ORDER BY id LIMIT 1)
  AND NOT EXISTS (SELECT 1 FROM users WHERE role = 'superadmin');

CREATE INDEX IF NOT EXISTS idx_inspections_created_by ON inspections(created_by);

-- ---------------------------------------------------------------------------
-- Per-salesperson reference numbering
-- ---------------------------------------------------------------------------

-- The sequence runs per salesperson, not per company: the initials at the end
-- of SWC26001SS exist precisely to keep each person's numbering independent,
-- so Stanley reaching SWC26001SS says nothing about what Jonathan's next
-- number is. The counter is therefore keyed by (year, initials).
ALTER TABLE ref_number_counters ADD COLUMN IF NOT EXISTS initials TEXT;

-- Existing rows predate per-person numbering and belong to the founding
-- account's series.
UPDATE ref_number_counters SET initials = 'SS' WHERE initials IS NULL;
ALTER TABLE ref_number_counters ALTER COLUMN initials SET NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'ref_number_counters' AND constraint_type = 'PRIMARY KEY'
      AND constraint_name = 'ref_number_counters_pkey'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.key_column_usage
    WHERE table_name = 'ref_number_counters' AND column_name = 'initials'
  ) THEN
    ALTER TABLE ref_number_counters DROP CONSTRAINT ref_number_counters_pkey;
    ALTER TABLE ref_number_counters ADD PRIMARY KEY (year, initials);
  END IF;
END $$;

-- Seed each person's floor from the highest number their own series has
-- already used, across both live quotations and imported history, so
-- switching to per-person counters cannot re-issue a number.
INSERT INTO ref_number_counters (year, initials, last_sequence)
SELECT year, initials, MAX(sequence)
FROM (
  SELECT substring(ref_no from 4 for 2)::int AS year,
         right(ref_no, 2)                    AS initials,
         substring(ref_no from 6 for 3)::int  AS sequence
  FROM quotations WHERE ref_no ~ '^SWC[0-9]{5}[A-Za-z]{2}$'
  UNION ALL
  SELECT substring(ref_no from 4 for 2)::int,
         right(ref_no, 2),
         substring(ref_no from 6 for 3)::int
  FROM quotation_library WHERE ref_no ~ '^SWC[0-9]{5}[A-Za-z]{2}$'
) issued
GROUP BY year, initials
ON CONFLICT (year, initials) DO UPDATE
  SET last_sequence = GREATEST(ref_number_counters.last_sequence, EXCLUDED.last_sequence);

-- ---------------------------------------------------------------------------
-- Teaching set curation
-- ---------------------------------------------------------------------------

-- Only a couple of examples per leak type reach the prompt, so WHICH ones
-- matters far more than how many exist. Selection used to be "most recently
-- added", which is not a quality signal at all.
--
--   is_pinned   this case represents its leak type; always chosen first
--   is_verified its cause/location/repair text was written by a person
--
-- The distinction matters because most cases arrived from the case study
-- import, where the leak type came from the real quotation but the prose was
-- generated by the vision model. Preferring those back into the prompt
-- teaches the model its own earlier wording rather than the team's.
ALTER TABLE leak_case_examples ADD COLUMN IF NOT EXISTS is_pinned BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE leak_case_examples ADD COLUMN IF NOT EXISTS is_verified BOOLEAN NOT NULL DEFAULT false;

-- Backfill: a case is verified only where the photo it came from carries a
-- human correction. Everything else — including review approvals that used
-- the model's own reading — stays unverified until someone confirms it.
UPDATE leak_case_examples e
SET is_verified = true
FROM photos p
WHERE p.id = e.source_photo_id
  AND p.corrected_analysis IS NOT NULL
  AND e.is_verified = false;

CREATE INDEX IF NOT EXISTS idx_leak_case_examples_pinned ON leak_case_examples(is_pinned);

-- ---------------------------------------------------------------------------
-- Archiving, library exclusion, and the audit trail
-- ---------------------------------------------------------------------------

-- Two independent decisions that were previously conflated:
--
--   archived_at            hide it from the owner's own lists. Says nothing
--                          about the shared reference library — an archived
--                          job goes on informing pricing, which is usually
--                          what you want for finished work.
--   excluded_from_library  stop it being used as a retrieval example. Says
--                          nothing about visibility — the owner still sees it
--                          in their lists.
--
-- Neither ever sets the other. A test job is typically both; a completed job
-- is usually only archived; a mispriced but real job is usually only excluded.
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS archived_by INTEGER REFERENCES users(id);
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS excluded_from_library BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE inspections ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE inspections ADD COLUMN IF NOT EXISTS archived_by INTEGER REFERENCES users(id);
ALTER TABLE inspections ADD COLUMN IF NOT EXISTS excluded_from_library BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_inspections_archived ON inspections(archived_at);
CREATE INDEX IF NOT EXISTS idx_quotations_archived ON quotations(archived_at);

-- Every archive, restore, exclusion change and deletion, with who and when.
--
-- actor_name and entity_label are copied in rather than joined: the whole
-- point of an audit trail is that it still reads after the record it
-- describes — or the account that acted — has been deleted.
CREATE TABLE IF NOT EXISTS audit_log (
  id           BIGSERIAL PRIMARY KEY,
  actor_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_name   TEXT NOT NULL,
  action       TEXT NOT NULL CHECK (action IN
                 ('archive', 'restore', 'exclude_from_library', 'include_in_library', 'delete')),
  entity_type  TEXT NOT NULL CHECK (entity_type IN ('quotation', 'inspection')),
  entity_id    INTEGER NOT NULL,
  entity_label TEXT NOT NULL,
  -- Anything worth keeping about what was removed, e.g. the deletion counts.
  detail       JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log(entity_type, entity_id);

-- ---------------------------------------------------------------------------
-- Knowing when a quotation last changed
-- ---------------------------------------------------------------------------

-- Approving copies the quotation into the reference library as it stands at
-- that moment; later edits do not propagate on their own. Without a
-- last-changed stamp there was no way to tell that the library had gone
-- stale, and the approve button stayed disabled forever, so nothing could
-- refresh it. This is what lets the button come back as "update the library"
-- once the quotation has moved on from what was approved.
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- ---------------------------------------------------------------------------
-- Deleting a departed staff member
-- ---------------------------------------------------------------------------

-- Columns that merely record who did something must not keep an account
-- alive. Without this, deleting anyone who had ever reviewed, archived or
-- corrected anything failed with a raw foreign key error from the database.
--
-- created_by on inspections and prepared_by on quotations are deliberately
-- NOT included: those establish ownership and authorship, and the users
-- route refuses to delete an account that still has work under it rather
-- than quietly orphaning a customer's quotation.
DO $$
DECLARE
  fk RECORD;
BEGIN
  FOR fk IN
    SELECT 'quotation_reviews' AS tbl, 'reviewed_by' AS col
    UNION ALL SELECT 'quotations', 'archived_by'
    UNION ALL SELECT 'inspections', 'archived_by'
    UNION ALL SELECT 'photos', 'corrected_by'
    UNION ALL SELECT 'leak_case_examples', 'created_by'
  LOOP
    EXECUTE format(
      'ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I',
      fk.tbl, fk.tbl || '_' || fk.col || '_fkey');
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES users(id) ON DELETE SET NULL',
      fk.tbl, fk.tbl || '_' || fk.col || '_fkey', fk.col);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Preferential pricing by property type
-- ---------------------------------------------------------------------------

-- The same scope of work is quoted differently for a HDB flat, a private
-- property and a commercial site. Recorded on the inspection because it is a
-- fact about the site, known before anyone looks at a photo.
--
-- Nullable on purpose: jobs entered before this existed have no answer, and
-- guessing one from the address would put a wrong figure on a real
-- quotation. Retrieval treats "unknown" as "no preference" rather than
-- excluding those jobs, so they go on informing scope and wording.
ALTER TABLE inspections ADD COLUMN IF NOT EXISTS property_type TEXT;
DO $$
BEGIN
  ALTER TABLE inspections DROP CONSTRAINT IF EXISTS inspections_property_type_check;
  ALTER TABLE inspections ADD CONSTRAINT inspections_property_type_check
    CHECK (property_type IS NULL OR property_type IN ('hdb', 'private', 'commercial'));
END $$;

-- The library's site_type column has existed since the first schema but was
-- never written to. It now carries the property type of the job each row
-- came from, which is what lets retrieval prefer like-for-like references.
CREATE INDEX IF NOT EXISTS quotation_library_site_type_idx ON quotation_library (site_type);

-- How much a property type's prices differ, as a percentage.
--
-- Deliberately a rule the company sets rather than something inferred from
-- history: with a library this size the model would be guessing a rate from
-- one or two examples, and a mispriced quotation goes to a customer. A
-- NULL leak_type is the default for that property type; a row naming one
-- overrides it for that work only.
CREATE TABLE IF NOT EXISTS pricing_adjustments (
  id             SERIAL PRIMARY KEY,
  property_type  TEXT NOT NULL CHECK (property_type IN ('hdb', 'private', 'commercial')),
  leak_type      TEXT,
  adjustment_pct NUMERIC(6,2) NOT NULL DEFAULT 0,
  updated_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- One row per property type, plus at most one per leak type within it.
CREATE UNIQUE INDEX IF NOT EXISTS pricing_adjustments_unique_idx
  ON pricing_adjustments (property_type, COALESCE(leak_type, ''));

-- Seed the three defaults at 0% so the screen opens on something meaningful
-- and no quotation changes price until somebody sets a figure.
INSERT INTO pricing_adjustments (property_type, leak_type, adjustment_pct)
SELECT t, NULL, 0 FROM unnest(ARRAY['hdb', 'private', 'commercial']) AS t
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Repair methods: what is WRONG vs how it is FIXED
-- ---------------------------------------------------------------------------

-- A photo determines the diagnosis. It does not determine the remedy.
--
-- Toilet seepage can be PU grouted or hacked and re-waterproofed; a concealed
-- pipe leak can be hacked open and repaired or bypassed with exposed piping.
-- Both are technically right — which one is quoted is a commercial choice made
-- with the customer, usually on how invasive they are willing to be.
--
-- Before this, the model proposed one method and the only way to change it was
-- to "correct" the analysis. That taught the teaching set something false: that
-- the model had misread the photo, when it had read it correctly and simply
-- offered the method this customer did not want. Method is therefore recorded
-- as a CHOICE, kept away from the correction channel entirely.
CREATE TABLE IF NOT EXISTS repair_methods (
  id                SERIAL PRIMARY KEY,
  name              TEXT NOT NULL UNIQUE,
  description       TEXT,
  -- The axis customers actually decide on: do we break the finishes or not.
  is_invasive       BOOLEAN NOT NULL DEFAULT false,
  suitable_when     TEXT,
  not_suitable_when TEXT,
  is_active         BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Which methods are genuinely workable for which diagnosis. This is the
-- knowledge that lets the model offer alternatives instead of one answer.
CREATE TABLE IF NOT EXISTS leak_type_methods (
  leak_type TEXT NOT NULL REFERENCES leak_types(name) ON UPDATE CASCADE ON DELETE CASCADE,
  method    TEXT NOT NULL REFERENCES repair_methods(name) ON UPDATE CASCADE ON DELETE CASCADE,
  -- Lower sorts first: the method the company reaches for by default.
  position  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (leak_type, method)
);

-- The method chosen for this photo's repair. Deliberately NOT part of
-- corrected_analysis: choosing a method says nothing about whether the
-- model read the photo correctly.
ALTER TABLE photos ADD COLUMN IF NOT EXISTS selected_repair_method TEXT;
ALTER TABLE photos ADD COLUMN IF NOT EXISTS selected_method_at TIMESTAMPTZ;
ALTER TABLE photos ADD COLUMN IF NOT EXISTS selected_method_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

-- Pricing references have to match on method, not just diagnosis: hacking and
-- re-waterproofing a toilet and PU grouting the same toilet are different jobs
-- at different prices, and averaging them produces a figure that is right for
-- neither.
ALTER TABLE quotation_library ADD COLUMN IF NOT EXISTS repair_method TEXT;
CREATE INDEX IF NOT EXISTS quotation_library_repair_method_idx ON quotation_library (repair_method);

-- What the model was told was possible, and what was actually taken. Teaching
-- from this says "both were valid, this customer chose that one" rather than
-- "the other answer was wrong".
ALTER TABLE leak_case_examples ADD COLUMN IF NOT EXISTS chosen_method TEXT;

-- The exported PDF, beside the .xlsx it was converted from. Kept as its own
-- column rather than derived from excel_path: the two are written at
-- different moments, and a PDF that exists for an older version of the
-- quotation must not be presented as if it were current.
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS pdf_path TEXT;

-- ---------------------------------------------------------------------------
-- Invoices
-- ---------------------------------------------------------------------------

-- One invoice per job, carrying the whole contract sum and accounting for the
-- deposit inside itself:
--
--     Total          the full amount, from the quotation
--     Downpayment    what was already received, and when
--     Others         a discount, if any
--     Balance        what is still owed
--
-- That is how the company actually bills. There is no separate deposit
-- invoice: the 50% is collected against the quotation's P/O.
--
-- Everything the customer was billed is stored ON the invoice rather than
-- read back from the quotation. A quotation regenerates from live data every
-- time it is exported; an invoice is a record of what was sent, and must not
-- change when the job it came from is edited afterwards.
CREATE TABLE IF NOT EXISTS invoices (
  id                SERIAL PRIMARY KEY,
  invoice_no        TEXT UNIQUE,
  -- Both nullable: an invoice may outlive the job it came from, and one
  -- raised from an uploaded workbook has no quotation in the database at all.
  quotation_id      INTEGER REFERENCES quotations(id) ON DELETE SET NULL,
  inspection_id     INTEGER REFERENCES inspections(id) ON DELETE SET NULL,

  -- The billing address exactly as printed, three lines like the letterhead.
  bill_to_line1     TEXT,
  bill_to_line2     TEXT,
  bill_to_line3     TEXT,
  contact_name      TEXT,

  line_items        JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- The numbered "Note:" block some invoices carry under the last item.
  notes             TEXT,
  warranty_text     TEXT,
  terms             TEXT NOT NULL DEFAULT 'Cash',
  invoice_date      DATE NOT NULL DEFAULT CURRENT_DATE,

  total             NUMERIC(12,2) NOT NULL DEFAULT 0,
  downpayment       NUMERIC(12,2) NOT NULL DEFAULT 0,
  -- Printed beside the figure as "Downpayment: 14/8", so it is kept as the
  -- text that appears rather than a date: it is a label, not a calculation.
  downpayment_label TEXT,
  -- Discounts only. Additional work is added to the descriptions instead, so
  -- a positive value here would mean somebody has misunderstood the field.
  others            NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (others <= 0),

  status            TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'issued', 'paid')),
  payment_note      TEXT,
  source            TEXT NOT NULL DEFAULT 'quotation' CHECK (source IN ('quotation', 'upload')),

  created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  issued_at         TIMESTAMPTZ,
  excel_path        TEXT,
  pdf_path          TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS invoices_quotation_idx ON invoices (quotation_id);
CREATE INDEX IF NOT EXISTS invoices_status_idx ON invoices (status);

-- Invoices number in their own company-wide series — SWC2026111 — with the
-- full year and no salesperson initials. They come from the company, not
-- from whoever quoted the job, which is why this is not the per-person
-- counter the quotations use.
CREATE TABLE IF NOT EXISTS invoice_number_counters (
  year          INTEGER PRIMARY KEY,
  last_sequence INTEGER NOT NULL DEFAULT 0
);

-- Sales flag a job as ready to bill; accounts pick it up from there. This is
-- the only thing that crosses between the two, and it is deliberately the
-- only thing: sales never touch invoices, accounts never touch quotations.
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS ready_to_invoice_at TIMESTAMPTZ;
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS ready_to_invoice_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

-- Accounts is a role alongside sales, not above it: they see every job
-- awaiting billing but none of the sales workspace — no photographs, no
-- assessments, no pricing library.
DO $$
BEGIN
  ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
  ALTER TABLE users ADD CONSTRAINT users_role_check
    CHECK (role IN ('user', 'accounts', 'admin', 'superadmin'));
END $$;
