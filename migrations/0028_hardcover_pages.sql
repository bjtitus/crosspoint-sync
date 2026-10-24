-- Hardcover matches never stored their print page count. Re-run the enricher on
-- matched books still missing pages: their Hardcover hit is cached in
-- catalog_cache, so this makes no Hardcover requests.
UPDATE documents SET hc_checked_at = NULL
  WHERE hc_id IS NOT NULL AND page_count IS NULL;

-- Page lookups that missed while the SearchAPI quota was spent (and Google was
-- failing) are cached as misses for a week. Forget them so the next stats view
-- looks them up again.
UPDATE documents SET cover_checked_at = NULL
  WHERE page_count IS NULL AND cover_checked_at IS NOT NULL;
