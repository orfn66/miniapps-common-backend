-- Additive registry entry for the authenticated Velocoon feedback connector.
-- Velocoon Supabase remains the source of truth; no business table is exposed.

INSERT INTO games(slug, name, app_type, platforms, current_version, status, active)
VALUES ('velocoon', 'Velocoon', 'pwa', ARRAY['web']::text[], '1.0.0-pilot.1', 'active', true)
ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  app_type = EXCLUDED.app_type,
  platforms = EXCLUDED.platforms,
  current_version = EXCLUDED.current_version,
  updated_at = now();
