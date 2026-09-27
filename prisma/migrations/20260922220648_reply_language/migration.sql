-- Collapse the three language columns into two settings with distinct jobs:
--   ui_locale      "en" | "it"          — the interface language (dashboard + widget chrome)
--   reply_language "en" | "it" | "auto" — what the agent replies in; "auto" mirrors the customer
--
-- `languages` (the multi-select of permitted customer languages) and
-- `default_locale` are both subsumed by `reply_language`: a single choice is
-- what the product actually needs, and "auto" covers the case the multi-select
-- was standing in for.
ALTER TABLE "agent_configs" DROP COLUMN "default_locale",
DROP COLUMN "languages",
ADD COLUMN     "reply_language" TEXT NOT NULL DEFAULT 'auto';
