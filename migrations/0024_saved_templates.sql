-- 0024 Saved templates (docs/12 CAT-08, ACC-06): a signed-in customer's
-- saved-template list. Guests keep their list locally in the browser
-- (non-sensitive ids only); on sign-in the client merges it through
-- POST /me/saved-templates/merge and the server copy becomes the source
-- of truth. Availability is computed at read time from the template's
-- current status, so a saved template that stops selling stays listed
-- (ACC-06) but is flagged unavailable.
CREATE TABLE saved_templates (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  template_id uuid NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, template_id)
);
CREATE INDEX saved_templates_user_idx ON saved_templates (user_id, created_at DESC);
