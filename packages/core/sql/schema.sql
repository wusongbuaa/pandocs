-- Principals are opaque text, so identity can come from any provider and this schema has no foreign keys outside itself.
CREATE SCHEMA IF NOT EXISTS pandocs;

CREATE TABLE IF NOT EXISTS pandocs.spaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  description text NOT NULL DEFAULT '',
  default_role text NOT NULL DEFAULT 'none' CHECK (default_role IN ('none', 'viewer', 'commenter', 'editor', 'admin')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pandocs.space_members (
  space_id uuid NOT NULL REFERENCES pandocs.spaces(id) ON DELETE CASCADE,
  subject text NOT NULL CHECK (subject ~ '^(user:.+|group:.+|everyone)$'),
  role text NOT NULL CHECK (role IN ('viewer', 'commenter', 'editor', 'admin')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (space_id, subject)
);

-- Readable by anyone, with or without a login. Off unless someone turns it on, for one space at a time.
ALTER TABLE pandocs.spaces ADD COLUMN IF NOT EXISTS public_read boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS pandocs.documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id uuid NOT NULL REFERENCES pandocs.spaces(id) ON DELETE CASCADE,
  parent_id uuid REFERENCES pandocs.documents(id) ON DELETE SET NULL,
  -- Paths become file names when documents are published, so a segment can never be `..` or hidden.
  slug text NOT NULL CHECK (slug !~ '[/\s\\]' AND slug !~ '^\.' AND char_length(slug) BETWEEN 1 AND 120 AND octet_length(slug) <= 240),
  path text NOT NULL,
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  sort_order integer NOT NULL DEFAULT 0,
  restricted boolean NOT NULL DEFAULT false,
  current_revision_no integer NOT NULL DEFAULT 0,
  -- False for a page that only holds its children. Kept here so listing a space does not read every page's text.
  has_content boolean NOT NULL DEFAULT false,
  -- What listing a site needs from the current revision, so it does not have to read or parse any of them.
  outline jsonb NOT NULL DEFAULT '[]',
  visible_chars integer NOT NULL DEFAULT 0,
  sha256 text,
  size_bytes integer NOT NULL DEFAULT 0,
  -- The uploads its current revision uses, so a copy of a space for others carries no image from a page they cannot read.
  asset_refs text[] NOT NULL DEFAULT '{}',
  editing_by text,
  editing_name text,
  editing_until timestamptz,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS documents_space_path_unique ON pandocs.documents (space_id, path) WHERE deleted_at IS NULL;
-- Files on Windows and macOS do not tell `Guide` from `guide`, so neither can pages.
CREATE UNIQUE INDEX IF NOT EXISTS documents_space_folded_path_unique ON pandocs.documents (space_id, lower(path)) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS documents_space_parent_idx ON pandocs.documents (space_id, parent_id, sort_order) WHERE deleted_at IS NULL;

-- The current revision's words, apart from the documents table so that reading a document's row stays cheap.
CREATE TABLE IF NOT EXISTS pandocs.document_search (
  document_id uuid PRIMARY KEY REFERENCES pandocs.documents(id) ON DELETE CASCADE,
  vector tsvector NOT NULL
);
CREATE INDEX IF NOT EXISTS document_search_vector_idx ON pandocs.document_search USING gin (vector);

CREATE TABLE IF NOT EXISTS pandocs.document_members (
  document_id uuid NOT NULL REFERENCES pandocs.documents(id) ON DELETE CASCADE,
  subject text NOT NULL CHECK (subject ~ '^(user:.+|group:.+|everyone)$'),
  role text NOT NULL CHECK (role IN ('viewer', 'commenter', 'editor', 'admin')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, subject)
);

CREATE TABLE IF NOT EXISTS pandocs.revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES pandocs.documents(id) ON DELETE CASCADE,
  no integer NOT NULL CHECK (no >= 1),
  markdown text NOT NULL,
  sha256 text NOT NULL CHECK (char_length(sha256) = 64),
  visible_text text NOT NULL,
  actor_id text NOT NULL,
  actor_name text NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('user', 'agent')),
  channel text NOT NULL,
  on_behalf_of text,
  proposal_id uuid,
  ingest_job_id uuid,
  message text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, no)
);

-- What an editor has typed but not published. One per person, page and language ('' is the page itself); a version only comes from saving.
CREATE TABLE IF NOT EXISTS pandocs.drafts (
  document_id uuid NOT NULL REFERENCES pandocs.documents(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  lang text NOT NULL DEFAULT '',
  title text,
  markdown text NOT NULL,
  base_revision_no integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, user_id, lang)
);

CREATE TABLE IF NOT EXISTS pandocs.threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES pandocs.documents(id) ON DELETE CASCADE,
  anchor jsonb NOT NULL CHECK (jsonb_typeof(anchor) = 'object'),
  anchor_state text NOT NULL CHECK (anchor_state IN ('exact', 'fuzzy', 'orphaned')),
  anchored_revision_no integer NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  summary text,
  summary_at timestamptz,
  created_by text NOT NULL,
  created_name text NOT NULL,
  created_kind text NOT NULL CHECK (created_kind IN ('user', 'agent')),
  resolved_by text,
  resolved_name text,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS threads_document_status_idx ON pandocs.threads (document_id, status, created_at);

CREATE TABLE IF NOT EXISTS pandocs.comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL REFERENCES pandocs.threads(id) ON DELETE CASCADE,
  author_id text NOT NULL,
  author_name text NOT NULL,
  author_kind text NOT NULL CHECK (author_kind IN ('user', 'agent')),
  channel text NOT NULL,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 20000),
  mentions jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(mentions) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS comments_thread_idx ON pandocs.comments (thread_id, created_at);
ALTER TABLE pandocs.comments ADD COLUMN IF NOT EXISTS edited_at timestamptz;

CREATE TABLE IF NOT EXISTS pandocs.comment_reactions (
  comment_id uuid NOT NULL REFERENCES pandocs.comments(id) ON DELETE CASCADE,
  emoji text NOT NULL CHECK (char_length(emoji) BETWEEN 1 AND 16),
  user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (comment_id, emoji, user_id)
);

CREATE TABLE IF NOT EXISTS pandocs.proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES pandocs.documents(id) ON DELETE CASCADE,
  base_revision_no integer NOT NULL,
  ops jsonb NOT NULL CHECK (jsonb_typeof(ops) = 'array'),
  rationale text NOT NULL DEFAULT '',
  thread_ids jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(thread_ids) = 'array'),
  author_id text NOT NULL,
  author_name text NOT NULL,
  author_kind text NOT NULL CHECK (author_kind IN ('user', 'agent')),
  on_behalf_of text,
  channel text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
  decided_by text,
  decided_name text,
  decided_at timestamptz,
  decision_note text,
  accepted_ops jsonb,
  applied_revision_no integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS proposals_document_status_idx ON pandocs.proposals (document_id, status, created_at);

CREATE TABLE IF NOT EXISTS pandocs.assets (
  space_id uuid NOT NULL REFERENCES pandocs.spaces(id) ON DELETE CASCADE,
  sha256 text NOT NULL CHECK (char_length(sha256) = 64),
  mime text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  filename text NOT NULL DEFAULT '',
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (space_id, sha256)
);

CREATE TABLE IF NOT EXISTS pandocs.ingest_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id uuid NOT NULL REFERENCES pandocs.spaces(id) ON DELETE CASCADE,
  target jsonb NOT NULL CHECK (jsonb_typeof(target) = 'object'),
  channel text NOT NULL,
  content_type text NOT NULL,
  filename text NOT NULL DEFAULT '',
  source_asset_sha text,
  source_text text,
  metadata jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object'),
  route text NOT NULL,
  processors jsonb NOT NULL CHECK (jsonb_typeof(processors) = 'array'),
  persist text NOT NULL CHECK (persist IN ('publish', 'draft', 'proposal')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'retry_wait', 'succeeded', 'failed', 'discarded')),
  attempts integer NOT NULL DEFAULT 0,
  next_run_at timestamptz NOT NULL DEFAULT now(),
  lease_owner uuid,
  lease_until timestamptz,
  error_code text,
  error_message text,
  report jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(report) = 'object'),
  draft_markdown text,
  draft_title text,
  document_id uuid,
  revision_no integer,
  proposal_id uuid,
  created_by text NOT NULL,
  created_name text NOT NULL,
  created_kind text NOT NULL CHECK (created_kind IN ('user', 'agent')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE pandocs.ingest_jobs ADD COLUMN IF NOT EXISTS language text NOT NULL DEFAULT 'en';
CREATE INDEX IF NOT EXISTS ingest_jobs_due_idx ON pandocs.ingest_jobs (next_run_at) WHERE status IN ('queued', 'retry_wait');
CREATE INDEX IF NOT EXISTS ingest_jobs_space_idx ON pandocs.ingest_jobs (space_id, created_at DESC);

CREATE TABLE IF NOT EXISTS pandocs.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('mention', 'reply', 'proposal_decided')),
  document_id uuid NOT NULL REFERENCES pandocs.documents(id) ON DELETE CASCADE,
  thread_id uuid,
  proposal_id uuid,
  actor_name text NOT NULL,
  summary text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz
);
CREATE INDEX IF NOT EXISTS notifications_recipient_idx ON pandocs.notifications (recipient_id, created_at DESC);

CREATE TABLE IF NOT EXISTS pandocs.idempotency_keys (
  principal_id text NOT NULL,
  key text NOT NULL CHECK (char_length(key) BETWEEN 8 AND 200),
  request_hash text NOT NULL,
  status integer NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (principal_id, key)
);

CREATE TABLE IF NOT EXISTS pandocs.audit_events (
  id bigserial PRIMARY KEY,
  actor_id text NOT NULL,
  actor_kind text NOT NULL,
  channel text NOT NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_events_target_idx ON pandocs.audit_events (target_type, target_id, created_at DESC);

CREATE TABLE IF NOT EXISTS pandocs.site_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  settings jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(settings) = 'object'),
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- A deleted page stays until someone empties it from the trash. Pages deleted together share a batch and come back together.
ALTER TABLE pandocs.documents ADD COLUMN IF NOT EXISTS deleted_by text;
ALTER TABLE pandocs.documents ADD COLUMN IF NOT EXISTS deleted_name text;
ALTER TABLE pandocs.documents ADD COLUMN IF NOT EXISTS deleted_batch uuid;
CREATE INDEX IF NOT EXISTS documents_space_deleted_idx ON pandocs.documents (space_id, deleted_at DESC) WHERE deleted_at IS NOT NULL;

-- Where a page used to live, so links keep working after it moves or changes its address.
CREATE TABLE IF NOT EXISTS pandocs.document_redirects (
  space_id uuid NOT NULL REFERENCES pandocs.spaces(id) ON DELETE CASCADE,
  old_path text NOT NULL,
  document_id uuid NOT NULL REFERENCES pandocs.documents(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (space_id, old_path)
);

ALTER TABLE pandocs.spaces ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE pandocs.spaces ADD COLUMN IF NOT EXISTS deleted_name text;
ALTER TABLE pandocs.spaces DROP CONSTRAINT IF EXISTS spaces_slug_key;
CREATE UNIQUE INDEX IF NOT EXISTS spaces_slug_unique ON pandocs.spaces (slug) WHERE deleted_at IS NULL;

ALTER TABLE pandocs.audit_events ADD COLUMN IF NOT EXISTS actor_name text;
CREATE INDEX IF NOT EXISTS audit_events_created_idx ON pandocs.audit_events (id DESC);

-- Terms a space explains wherever they first appear on a page.
ALTER TABLE pandocs.spaces ADD COLUMN IF NOT EXISTS glossary jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(glossary) = 'array');

-- A page in another language: a copy kept in step by hand or by AI, with no history or discussions of its own.
CREATE TABLE IF NOT EXISTS pandocs.document_translations (
  document_id uuid NOT NULL REFERENCES pandocs.documents(id) ON DELETE CASCADE,
  lang text NOT NULL,
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  markdown text NOT NULL,
  visible_text text NOT NULL,
  source_revision_no integer NOT NULL,
  machine boolean NOT NULL DEFAULT false,
  updated_by text NOT NULL,
  updated_name text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, lang)
);

-- Every change anyone can make, recorded by triggers so no write path can forget it. Rows say what changed, not
-- what it became: readers fetch the current state, which makes replaying an event harmless. `xid` is what makes
-- the feed safe to read: a lower seq can commit after a higher one, so readers stop short of any transaction still open.
CREATE TABLE IF NOT EXISTS pandocs.change_log (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
  space_id uuid NOT NULL,
  document_id uuid,
  kind text NOT NULL CHECK (kind IN ('document', 'discussion', 'space')),
  revision_no integer,
  path text,
  restricted boolean NOT NULL DEFAULT false,
  deleted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Read in this order, not by seq alone. A transaction can take a lower seq and commit after a higher one, but nothing
-- new can appear below the oldest transaction still open, so a reader that stops there never skips a row.
CREATE INDEX IF NOT EXISTS change_log_order_idx ON pandocs.change_log (xid, seq);
CREATE INDEX IF NOT EXISTS change_log_created_idx ON pandocs.change_log (created_at);

CREATE OR REPLACE FUNCTION pandocs.log_document_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target pandocs.documents;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target := OLD;
  ELSE
    target := NEW;
  END IF;
  -- The soft editing lock and similar bookkeeping change nothing a reader of the documents can see.
  IF TG_OP = 'UPDATE' AND NEW.current_revision_no = OLD.current_revision_no AND NEW.path = OLD.path AND NEW.title = OLD.title
     AND NEW.restricted = OLD.restricted AND NEW.sort_order = OLD.sort_order AND NEW.deleted_at IS NOT DISTINCT FROM OLD.deleted_at THEN
    RETURN NULL;
  END IF;
  -- A page with no version yet is about to get one in the same transaction.
  IF target.current_revision_no = 0 AND TG_OP <> 'DELETE' THEN
    RETURN NULL;
  END IF;
  -- Everyone who could read the page can no longer, and should hear that it has gone for them, with nothing about it
  -- they did not know. This goes first, so that someone who still can read it ends on the row after, which says it is there.
  IF TG_OP = 'UPDATE' AND NEW.restricted AND NOT OLD.restricted AND NEW.deleted_at IS NULL THEN
    INSERT INTO pandocs.change_log (space_id, document_id, kind, revision_no, path, restricted, deleted)
    VALUES (target.space_id, target.id, 'document', NULL, NULL, false, true);
  END IF;
  INSERT INTO pandocs.change_log (space_id, document_id, kind, revision_no, path, restricted, deleted)
  VALUES (target.space_id, target.id, 'document', target.current_revision_no, target.path, target.restricted, TG_OP = 'DELETE' OR target.deleted_at IS NOT NULL);
  PERFORM pg_notify('pandocs_changes', target.space_id::text);
  RETURN NULL;
END $$;

CREATE OR REPLACE TRIGGER documents_log_change AFTER INSERT OR UPDATE OR DELETE ON pandocs.documents
  FOR EACH ROW EXECUTE FUNCTION pandocs.log_document_change();

CREATE OR REPLACE FUNCTION pandocs.log_space_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target pandocs.spaces;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target := OLD;
  ELSE
    target := NEW;
  END IF;
  INSERT INTO pandocs.change_log (space_id, kind, deleted) VALUES (target.id, 'space', TG_OP = 'DELETE' OR target.deleted_at IS NOT NULL);
  PERFORM pg_notify('pandocs_changes', target.id::text);
  RETURN NULL;
END $$;

CREATE OR REPLACE TRIGGER spaces_log_change AFTER INSERT OR UPDATE OR DELETE ON pandocs.spaces
  FOR EACH ROW EXECUTE FUNCTION pandocs.log_space_change();

-- A comment from an agent should reach the person reading that page. Moving anchors along with a new revision is not news.
CREATE OR REPLACE FUNCTION pandocs.log_discussion_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_id uuid;
  target pandocs.documents;
BEGIN
  IF TG_TABLE_NAME = 'comments' THEN
    IF TG_OP = 'UPDATE' AND NEW.body = OLD.body AND NEW.deleted_at IS NOT DISTINCT FROM OLD.deleted_at THEN
      RETURN NULL;
    END IF;
    IF TG_OP = 'DELETE' THEN
      SELECT document_id INTO target_id FROM pandocs.threads WHERE id = OLD.thread_id;
    ELSE
      SELECT document_id INTO target_id FROM pandocs.threads WHERE id = NEW.thread_id;
    END IF;
  ELSE
    IF TG_OP = 'UPDATE' THEN
      -- Separate tests: naming a column the other table lacks is an error even after an AND has already failed.
      IF TG_TABLE_NAME = 'threads' THEN
        IF NEW.status = OLD.status AND NEW.summary IS NOT DISTINCT FROM OLD.summary THEN
          RETURN NULL;
        END IF;
      ELSIF NEW.status = OLD.status THEN
        RETURN NULL;
      END IF;
    END IF;
    IF TG_OP = 'DELETE' THEN
      target_id := OLD.document_id;
    ELSE
      target_id := NEW.document_id;
    END IF;
  END IF;
  SELECT * INTO target FROM pandocs.documents WHERE id = target_id AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  INSERT INTO pandocs.change_log (space_id, document_id, kind, revision_no, path, restricted)
  VALUES (target.space_id, target.id, 'discussion', target.current_revision_no, target.path, target.restricted);
  PERFORM pg_notify('pandocs_changes', target.space_id::text);
  RETURN NULL;
END $$;

CREATE OR REPLACE TRIGGER threads_log_change AFTER INSERT OR UPDATE OR DELETE ON pandocs.threads
  FOR EACH ROW EXECUTE FUNCTION pandocs.log_discussion_change();
CREATE OR REPLACE TRIGGER comments_log_change AFTER INSERT OR UPDATE OR DELETE ON pandocs.comments
  FOR EACH ROW EXECUTE FUNCTION pandocs.log_discussion_change();
CREATE OR REPLACE TRIGGER proposals_log_change AFTER INSERT OR UPDATE OR DELETE ON pandocs.proposals
  FOR EACH ROW EXECUTE FUNCTION pandocs.log_discussion_change();

-- How much pages are read, by day. Counts only: nothing here says who.
CREATE TABLE IF NOT EXISTS pandocs.page_views (
  day date NOT NULL,
  document_id uuid NOT NULL REFERENCES pandocs.documents(id) ON DELETE CASCADE,
  audience text NOT NULL CHECK (audience IN ('person', 'agent')),
  views bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (day, document_id, audience)
);
CREATE INDEX IF NOT EXISTS page_views_document_idx ON pandocs.page_views (document_id, day);

-- What was searched for, and how often it found nothing. `space` is where someone was at the time, or '' for nowhere in particular.
CREATE TABLE IF NOT EXISTS pandocs.search_terms (
  day date NOT NULL,
  space text NOT NULL,
  term text NOT NULL,
  audience text NOT NULL CHECK (audience IN ('person', 'agent')),
  searches bigint NOT NULL DEFAULT 0,
  empty bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (day, space, term, audience)
);

-- Questions put to the site's AI, without who asked. `answered` is whether the answer could point at a page.
CREATE TABLE IF NOT EXISTS pandocs.questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space text NOT NULL,
  question text NOT NULL,
  answer text NOT NULL,
  citations jsonb NOT NULL DEFAULT '[]',
  answered boolean NOT NULL,
  helpful boolean,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS questions_created_idx ON pandocs.questions (created_at DESC);
CREATE INDEX IF NOT EXISTS questions_space_idx ON pandocs.questions (space, created_at DESC);

-- What readers and agents say about a page. Someone with no login has no name here.
CREATE TABLE IF NOT EXISTS pandocs.page_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES pandocs.documents(id) ON DELETE CASCADE,
  revision_no integer NOT NULL,
  kind text NOT NULL CHECK (kind IN ('helpful', 'unhelpful', 'report')),
  audience text NOT NULL CHECK (audience IN ('person', 'agent')),
  reporter text,
  body text NOT NULL DEFAULT '',
  quote text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by text
);
CREATE INDEX IF NOT EXISTS page_feedback_document_idx ON pandocs.page_feedback (document_id, created_at DESC);

ALTER TABLE pandocs.notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;
ALTER TABLE pandocs.notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN ('mention', 'reply', 'proposal_decided', 'feedback', 'page_updated'));
-- Mail for what someone follows goes out from the background, once the change that caused it has really happened.
ALTER TABLE pandocs.notifications ADD COLUMN IF NOT EXISTS mail_due boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS notifications_mail_due_idx ON pandocs.notifications (created_at) WHERE mail_due;

CREATE TABLE IF NOT EXISTS pandocs.document_labels (
  document_id uuid NOT NULL REFERENCES pandocs.documents(id) ON DELETE CASCADE,
  label text NOT NULL,
  PRIMARY KEY (document_id, label)
);
CREATE UNIQUE INDEX IF NOT EXISTS document_labels_once_idx ON pandocs.document_labels (document_id, lower(label));
CREATE INDEX IF NOT EXISTS document_labels_label_idx ON pandocs.document_labels (lower(label));

CREATE TABLE IF NOT EXISTS pandocs.page_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id uuid NOT NULL REFERENCES pandocs.spaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  markdown text NOT NULL,
  created_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS page_templates_space_idx ON pandocs.page_templates (space_id, name);

-- Someone following a page or a whole space, one or the other.
CREATE TABLE IF NOT EXISTS pandocs.subscriptions (
  user_id text NOT NULL,
  document_id uuid REFERENCES pandocs.documents(id) ON DELETE CASCADE,
  space_id uuid REFERENCES pandocs.spaces(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((document_id IS NULL) <> (space_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_document_idx ON pandocs.subscriptions (document_id, user_id) WHERE document_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_space_idx ON pandocs.subscriptions (space_id, user_id) WHERE space_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS subscriptions_user_idx ON pandocs.subscriptions (user_id, created_at DESC);

-- For a whole site when there is no space. Addresses and secrets are what other systems gave out: they are never shown again, and not needed in the clear by anything but the sender.
CREATE TABLE IF NOT EXISTS pandocs.webhooks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id uuid REFERENCES pandocs.spaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('generic', 'slack', 'feishu', 'wecom', 'dingtalk', 'teams')),
  url text NOT NULL,
  secret text NOT NULL DEFAULT '',
  events text[] NOT NULL,
  include_restricted boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT true,
  consecutive_failures integer NOT NULL DEFAULT 0,
  last_status text,
  last_delivered_at timestamptz,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS webhooks_space_idx ON pandocs.webhooks (space_id);

CREATE TABLE IF NOT EXISTS pandocs.webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id uuid NOT NULL REFERENCES pandocs.webhooks(id) ON DELETE CASCADE,
  event text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  response_status integer,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz
);
CREATE INDEX IF NOT EXISTS webhook_deliveries_due_idx ON pandocs.webhook_deliveries (next_attempt_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS webhook_deliveries_hook_idx ON pandocs.webhook_deliveries (webhook_id, created_at DESC);

-- Reading without an account. The token is kept as it is so that those who can edit the page can copy it again.
CREATE TABLE IF NOT EXISTS pandocs.share_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token text NOT NULL UNIQUE,
  document_id uuid NOT NULL REFERENCES pandocs.documents(id) ON DELETE CASCADE,
  include_children boolean NOT NULL DEFAULT false,
  created_by text NOT NULL,
  created_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz
);
CREATE INDEX IF NOT EXISTS share_links_document_idx ON pandocs.share_links (document_id, created_at DESC);

-- A whole set of pages from another tool. Unlike ingest_jobs, which make one draft each, these write pages as they go, as whoever asked.
CREATE TABLE IF NOT EXISTS pandocs.bulk_imports (
  id uuid PRIMARY KEY,
  space_id uuid NOT NULL REFERENCES pandocs.spaces(id) ON DELETE CASCADE,
  source text NOT NULL,
  input jsonb NOT NULL DEFAULT '{}',
  filename text NOT NULL DEFAULT '',
  parent_path text,
  principal jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  attempts integer NOT NULL DEFAULT 0,
  next_run_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_until timestamptz,
  progress jsonb NOT NULL DEFAULT '{"done": 0, "total": null}',
  report jsonb,
  error text,
  created_by text NOT NULL,
  created_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS bulk_imports_due_idx ON pandocs.bulk_imports (next_run_at) WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS bulk_imports_space_idx ON pandocs.bulk_imports (space_id, created_at DESC);

-- What it takes for changes to land in a space: `requiredApprovals` and `requireChangeSets`.
ALTER TABLE pandocs.spaces ADD COLUMN IF NOT EXISTS merge_rules jsonb NOT NULL DEFAULT '{}';

-- Changes to several pages, decided together, that land together or not at all.
CREATE TABLE IF NOT EXISTS pandocs.change_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id uuid NOT NULL REFERENCES pandocs.spaces(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'merged', 'closed')),
  author_id text NOT NULL,
  author_name text NOT NULL,
  author_kind text NOT NULL CHECK (author_kind IN ('user', 'agent')),
  on_behalf_of text,
  channel text NOT NULL,
  decided_by text,
  decided_name text,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS change_sets_space_idx ON pandocs.change_sets (space_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS pandocs.change_set_pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  change_set_id uuid NOT NULL REFERENCES pandocs.change_sets(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('edit', 'create', 'delete')),
  document_id uuid REFERENCES pandocs.documents(id) ON DELETE SET NULL,
  path text NOT NULL,
  title text,
  base_revision_no integer,
  markdown text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS change_set_pages_path_idx ON pandocs.change_set_pages (change_set_id, lower(path));
-- Bringing a page back from the trash changes what readers see, so where everything goes through review, so does that.
ALTER TABLE pandocs.change_set_pages DROP CONSTRAINT IF EXISTS change_set_pages_kind_check;
ALTER TABLE pandocs.change_set_pages ADD CONSTRAINT change_set_pages_kind_check CHECK (kind IN ('edit', 'create', 'delete', 'restore'));

CREATE TABLE IF NOT EXISTS pandocs.change_set_reviews (
  change_set_id uuid NOT NULL REFERENCES pandocs.change_sets(id) ON DELETE CASCADE,
  reviewer_id text NOT NULL,
  reviewer_name text NOT NULL,
  verdict text NOT NULL CHECK (verdict IN ('approved', 'changes_requested')),
  note text NOT NULL DEFAULT '',
  -- What they looked at has changed since.
  stale boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (change_set_id, reviewer_id)
);

ALTER TABLE pandocs.revisions ADD COLUMN IF NOT EXISTS change_set_id uuid;

-- A change set is about no page in particular, so its notices belong to it instead.
ALTER TABLE pandocs.notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;
ALTER TABLE pandocs.notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN ('mention', 'reply', 'proposal_decided', 'feedback', 'page_updated', 'change_set'));
ALTER TABLE pandocs.notifications ALTER COLUMN document_id DROP NOT NULL;
ALTER TABLE pandocs.notifications ADD COLUMN IF NOT EXISTS change_set_id uuid REFERENCES pandocs.change_sets(id) ON DELETE CASCADE;
-- A notice about a comment goes when the comment is taken back.
ALTER TABLE pandocs.notifications ADD COLUMN IF NOT EXISTS comment_id uuid REFERENCES pandocs.comments(id) ON DELETE CASCADE;

-- A space kept the same as a folder of a Git repository. The token is what the host gave out: it is never shown again.
CREATE TABLE IF NOT EXISTS pandocs.git_syncs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id uuid NOT NULL UNIQUE REFERENCES pandocs.spaces(id) ON DELETE CASCADE,
  repository text NOT NULL,
  branch text NOT NULL,
  folder text NOT NULL DEFAULT '',
  token text NOT NULL DEFAULT '',
  hook_token text NOT NULL UNIQUE,
  first_source text NOT NULL DEFAULT 'space' CHECK (first_source IN ('space', 'repository')),
  include_restricted boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT true,
  last_commit text,
  meta_blob text,
  last_run_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  consecutive_failures integer NOT NULL DEFAULT 0,
  due_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_until timestamptz,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS git_syncs_due_idx ON pandocs.git_syncs (due_at) WHERE enabled;

-- What each page and file were when they were last the same, which is what makes merging both ways possible.
CREATE TABLE IF NOT EXISTS pandocs.git_sync_files (
  sync_id uuid NOT NULL REFERENCES pandocs.git_syncs(id) ON DELETE CASCADE,
  path text NOT NULL,
  document_id uuid REFERENCES pandocs.documents(id) ON DELETE SET NULL,
  revision_no integer NOT NULL,
  blob_id text NOT NULL,
  -- What came from the repository is waiting in a change set.
  pending boolean NOT NULL DEFAULT false,
  PRIMARY KEY (sync_id, path)
);

CREATE TABLE IF NOT EXISTS pandocs.git_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sync_id uuid NOT NULL REFERENCES pandocs.git_syncs(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL,
  head text,
  pulled integer NOT NULL DEFAULT 0,
  pushed integer NOT NULL DEFAULT 0,
  notes jsonb NOT NULL DEFAULT '[]',
  error text
);
CREATE INDEX IF NOT EXISTS git_sync_runs_sync_idx ON pandocs.git_sync_runs (sync_id, started_at DESC);

-- The one draft of a page that everyone editing it shares, as shared state rather than text, so that what several people type at once can merge.
CREATE TABLE IF NOT EXISTS pandocs.live_drafts (
  document_id uuid PRIMARY KEY REFERENCES pandocs.documents(id) ON DELETE CASCADE,
  -- A draft started afresh is a different one, and a tab left open from before must not merge into it: that would be everything twice.
  generation text NOT NULL,
  state bytea NOT NULL,
  -- The version of the page this draft has taken in, which is what a save is compared with.
  base_revision_no integer NOT NULL,
  -- Goes up with every write, for replicas to tell they have missed one.
  version integer NOT NULL DEFAULT 1,
  has_changes boolean NOT NULL DEFAULT false,
  -- Who has typed in it since it last said what the page says, by id.
  contributors jsonb NOT NULL DEFAULT '{}',
  -- Nothing has happened since it was last looked at to see whether it is worth keeping.
  settled boolean NOT NULL DEFAULT false,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS live_drafts_unsettled_idx ON pandocs.live_drafts (last_seen_at) WHERE NOT settled;
CREATE INDEX IF NOT EXISTS live_drafts_unsaved_idx ON pandocs.live_drafts USING gin (contributors) WHERE has_changes;

-- Addresses from before they were refused, which the site cannot open as the page they name: a percent sign or a hash,
-- read as an escape or as a part of a page; a name ending in .html, opened as the page without it; and index anywhere
-- but a space's front page, opened as the page above. Each such page takes the nearest address it can have, with what
-- is under it, and its old address leads there, as when someone renames a page. Afterwards nothing matches again.
DO $$
DECLARE
  unreachable record;
  current_path text;
  current_slug text;
  above text;
  wanted text;
  candidate text;
  attempt integer;
BEGIN
  FOR unreachable IN
    SELECT id, space_id FROM pandocs.documents
    WHERE deleted_at IS NULL AND (slug ~ '[%#]' OR slug ~* '\.html$' OR (lower(slug) = 'index' AND path <> 'index'))
    ORDER BY length(path)
  LOOP
    -- Read again: renaming a page above this one has changed its path.
    SELECT path, slug INTO current_path, current_slug FROM pandocs.documents WHERE id = unreachable.id;
    above := substr(current_path, 1, length(current_path) - length(current_slug));
    wanted := btrim(regexp_replace(regexp_replace(regexp_replace(current_slug, '\.html$', '-html', 'i'), '[%#]+', '-', 'g'), '-{2,}', '-', 'g'), '-');
    IF wanted = '' THEN
      wanted := 'page';
    ELSIF lower(wanted) = 'index' THEN
      wanted := wanted || '-page';
    END IF;
    candidate := wanted;
    attempt := 1;
    WHILE EXISTS (SELECT 1 FROM pandocs.documents WHERE space_id = unreachable.space_id AND deleted_at IS NULL AND id <> unreachable.id AND lower(path) = lower(above || candidate)) LOOP
      attempt := attempt + 1;
      candidate := wanted || '-' || attempt;
    END LOOP;
    INSERT INTO pandocs.document_redirects (space_id, old_path, document_id)
      SELECT space_id, path, id FROM pandocs.documents
      WHERE space_id = unreachable.space_id AND deleted_at IS NULL AND (id = unreachable.id OR starts_with(path, current_path || '/'))
      ON CONFLICT (space_id, old_path) DO UPDATE SET document_id = EXCLUDED.document_id;
    UPDATE pandocs.documents SET path = above || candidate || substr(path, length(current_path) + 1)
      WHERE space_id = unreachable.space_id AND deleted_at IS NULL AND (id = unreachable.id OR starts_with(path, current_path || '/'));
    UPDATE pandocs.documents SET slug = candidate, updated_at = now() WHERE id = unreachable.id;
    DELETE FROM pandocs.document_redirects WHERE space_id = unreachable.space_id
      AND old_path IN (SELECT path FROM pandocs.documents WHERE space_id = unreachable.space_id AND deleted_at IS NULL);
  END LOOP;
END $$;
