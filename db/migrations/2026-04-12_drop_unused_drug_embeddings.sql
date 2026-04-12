-- Drop embedding tables that were never queried by the server.
-- drug.license_embeddings: embedded name+indication per license — dominated by
--   indication text, indistinguishable across same-ingredient licenses, and unused.
-- drug.atc_embeddings: embedded ATC names — unused.
-- drug.ingredient_name_embeddings is kept (used by ingredient-mode hybrid search).

DROP TABLE IF EXISTS drug.license_embeddings;
DROP TABLE IF EXISTS drug.atc_embeddings;
