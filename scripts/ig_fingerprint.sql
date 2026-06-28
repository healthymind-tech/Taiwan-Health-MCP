-- Content fingerprint of the fhir.* tables, excluding serial ids and NOW()
-- timestamp columns. jsonb columns are rendered via ::text (Postgres canonical
-- form) so serialization whitespace/key-order is normalized on both sides.
\pset tuples_only on
\pset format unaligned

SELECT 'ig_packages ' || count(*) || ' ' || md5(coalesce(string_agg(r, E'\n' ORDER BY r), '')) FROM (
  SELECT package_id||'\x1f'||version||'\x1f'||coalesce(canonical,'')||'\x1f'||
         coalesce(fhir_version,'')||'\x1f'||coalesce(title,'')||'\x1f'||
         coalesce(status,'')||'\x1f'||is_default::text||'\x1f'||
         coalesce(dependencies::text,'') AS r
  FROM fhir.ig_packages
) a;

SELECT 'codesystems ' || count(*) || ' ' || md5(coalesce(string_agg(r, E'\n' ORDER BY r), '')) FROM (
  SELECT package_id||'\x1f'||package_version||'\x1f'||cs_id||'\x1f'||
         coalesce(name,'')||'\x1f'||coalesce(category,'')||'\x1f'||
         coalesce(concept_count::text,'') AS r
  FROM fhir.codesystems
) a;

SELECT 'concepts ' || count(*) || ' ' || md5(coalesce(string_agg(r, E'\n' ORDER BY r), '')) FROM (
  SELECT package_id||'\x1f'||package_version||'\x1f'||cs_id||'\x1f'||code||'\x1f'||
         coalesce(display,'')||'\x1f'||coalesce(definition,'') AS r
  FROM fhir.concepts
) a;

SELECT 'artifacts ' || count(*) || ' ' || md5(coalesce(string_agg(r, E'\n' ORDER BY r), '')) FROM (
  SELECT package_id||'\x1f'||package_version||'\x1f'||artifact_key||'\x1f'||
         resource_type||'\x1f'||coalesce(artifact_id,'')||'\x1f'||
         coalesce(canonical_url,'')||'\x1f'||coalesce(name,'')||'\x1f'||
         coalesce(title,'')||'\x1f'||coalesce(status,'')||'\x1f'||coalesce(kind,'')||'\x1f'||
         coalesce(base_type,'')||'\x1f'||coalesce(derivation,'')||'\x1f'||
         coalesce(grouping_id,'')||'\x1f'||coalesce(grouping_name,'')||'\x1f'||
         coalesce(description,'')||'\x1f'||coalesce(package_path,'')||'\x1f'||
         child_count::text||'\x1f'||concept_count::text||'\x1f'||
         coalesce(raw_json::text,'') AS r
  FROM fhir.artifacts
) a;
