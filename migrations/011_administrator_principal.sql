-- A fixed principal that administrative requests act as for idempotency.
--
-- Idempotency keys are scoped by principal (migration 009), but the admin API key is a shared
-- secret, not a principal, so admin funding had nothing to scope its keys to and could not accept
-- an Idempotency-Key at all -- a retried funding call credited the account twice. This row gives
-- those keys an owner without inventing a NULL-principal special case in every query.
--
-- It is created `disabled`: it exists to own idempotency records, and must never authenticate a
-- customer request even if someone issues it an API key. It owns no accounts.
INSERT INTO principals (id, name, status)
VALUES ('00000000-0000-4000-8000-0000000000ad', 'system-administrator', 'disabled')
ON CONFLICT (id) DO NOTHING;
