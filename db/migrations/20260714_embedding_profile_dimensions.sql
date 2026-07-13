-- Move embedding dimensions from the global embedding settings group into each
-- embedding profile. The vector columns still share one active dimension; the
-- per-profile field is the correct owner because dimensions are model/provider
-- request metadata.

UPDATE admin.llm_profiles p
SET params = COALESCE(p.params, '{}'::jsonb)
    || jsonb_build_object(
        'dimensions',
        COALESCE(
            CASE
                WHEN COALESCE(p.params->>'dimensions', '') ~ '^[0-9]+$'
                THEN (p.params->>'dimensions')::int
                ELSE NULL
            END,
            (
                SELECT CASE
                    WHEN COALESCE(value, '') ~ '^[0-9]+$' THEN value::int
                    ELSE NULL
                END
                FROM admin.app_settings
                WHERE group_key = 'embedding' AND key = 'dimensions'
            ),
            1024
        )
    ),
    updated_at = NOW()
WHERE p.kind = 'embedding';

DELETE FROM admin.app_settings
WHERE group_key = 'embedding' AND key = 'dimensions';
