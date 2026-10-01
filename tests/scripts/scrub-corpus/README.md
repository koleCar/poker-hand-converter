# Whole-corpus scrub check

`scrub_phf()` (in `supabase/migrations/20261012090000_forum_publishing.sql`) is
the only thing between a player's library and a public page. The pgTAP tests
pin its contract on a synthetic hand; this checks it against **every real hand
history in the repo** (~8300 hands, 19 rooms), in all three modes.

It is not in CI because it needs a local Postgres with the migrations applied
and takes about a minute. **Run it whenever a parser or a PHF field changes** —
it is what found `game.straddles[].player`, a name-bearing field that nobody
had listed.

```bash
cd tests
npx tsx scripts/scrub-corpus/dump.ts /tmp/corpus.ndjson

# a local stack: `supabase start` (or `supabase db start`) from the repo root
DB=supabase_db_PokerConverter
docker exec -i $DB psql -U postgres -c "drop table if exists scrub_corpus; create table scrub_corpus (doc jsonb);"
docker exec -i $DB psql -U postgres -c "copy scrub_corpus (doc) from stdin with (format csv, quote e'\x01', delimiter e'\x02')" < /tmp/corpus.ndjson
docker exec -i $DB psql -U postgres -t -A -c "copy (select jsonb_build_object('id', (doc->>'id')::int, 'anonymization', doc->>'anonymization', 'mode', m, 'ok', public.phf_is_scrubbed(public.scrub_phf(doc->'phf', m::public.publish_mode)), 'phf', public.scrub_phf(doc->'phf', m::public.publish_mode)) from scrub_corpus, unnest(array['pseudonyms','positions','as-imported']) m) to stdout" > /tmp/scrubbed.ndjson

npx tsx scripts/scrub-corpus/check.ts /tmp/corpus.ndjson /tmp/scrubbed.ndjson
```

Exits non-zero, naming the first example of each failure class, if anything
survived. Last clean run: 2026-09-29, 8331 hands × 3 modes, zero findings.
