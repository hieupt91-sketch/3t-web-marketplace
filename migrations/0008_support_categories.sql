-- M3 close (A26): support tickets. Replies are plain stored text: reading or
-- replying to a ticket never triggers an external action (no email, webhook,
-- refund, or site change). First-response SLA target is 24h from creation.
CREATE TABLE support_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id uuid NOT NULL REFERENCES users(id),
  subject text NOT NULL CHECK (length(subject) BETWEEN 3 AND 200),
  body text NOT NULL CHECK (length(body) BETWEEN 3 AND 10000),
  locale text NOT NULL CHECK (locale IN ('vi', 'en')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'assigned', 'waiting', 'resolved', 'closed')),
  assigned_to uuid REFERENCES users(id),
  order_id uuid REFERENCES orders(id),
  site_label text CHECK (site_label IS NULL OR length(site_label) BETWEEN 1 AND 200),
  sla_due_at timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER support_tickets_touch BEFORE UPDATE ON support_tickets FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE INDEX support_tickets_status_idx ON support_tickets (status, created_at DESC);
CREATE INDEX support_tickets_requester_idx ON support_tickets (requester_id, created_at DESC);
CREATE INDEX support_tickets_assignee_idx ON support_tickets (assigned_to, created_at DESC);

CREATE TABLE support_ticket_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES support_tickets(id),
  sender_type text NOT NULL CHECK (sender_type IN ('customer', 'staff')),
  sender_id uuid NOT NULL REFERENCES users(id),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 10000),
  locale text NOT NULL CHECK (locale IN ('vi', 'en')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX support_ticket_messages_ticket_idx ON support_ticket_messages (ticket_id, created_at);

-- Category tree seed (M3 filter): codes are stable identifiers; UI labels come
-- from i18n ui.category.<code>. Admins assign templates via PATCH /templates/:id.
INSERT INTO template_categories (code, parent_id) VALUES ('website', NULL) ON CONFLICT (code) DO NOTHING;
INSERT INTO template_categories (code, parent_id)
SELECT code, (SELECT id FROM template_categories WHERE code = 'website')
FROM (VALUES ('landing'), ('store'), ('blog'), ('portfolio')) AS v(code)
ON CONFLICT (code) DO NOTHING;
