# Mema integration

The Mema PWA uses dedicated routes under `/api/v1/integrations/mema/` for feedback, optional attachments and Web Push subscriptions.

Authentication is a Mema Supabase access token validated live against `/auth/v1/user` using the publishable project key. The platform does not use a Mema `service_role` key and does not query Mema business tables. User IDs are transformed with an app-scoped HMAC before storage.

Required runtime variables: `MEMA_SUPABASE_URL`, `MEMA_SUPABASE_PUBLISHABLE_KEY`, `INTEGRATION_HASH_SECRET`, `MEMA_VAPID_SUBJECT`, `MEMA_VAPID_PUBLIC_KEY`, `MEMA_VAPID_PRIVATE_KEY`. Add the production Mema origin to `CORS_ALLOWED_ORIGINS`.

Migration `005_mema_integrations.sql` is additive. Feedback import is idempotent on `(source_app, source_feedback_id)`. Attachments require `x-attachment-consent: true`, accept only signature-verified JPEG/PNG/WebP up to 5 MiB, remain on the private attachment volume, and use the existing retention and admin-only access controls.
