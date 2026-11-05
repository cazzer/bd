---
question: "Drop omni_search v5–v8 on or after 2026-11-12 if the 7-day delta shows zero calls?"
options:
  - id: A
    label: "Track function calls, then drop"
    what: "Turn on `track_functions=all` now. Drop on or after max(11-12 16:00, tracking on + 7 days) if the verify query returns `go=true`."
    risk: "Lowest: both REST and GraphQL are checked. The drop slips about 1 day."
  - id: B
    label: "Drop on 11-12 on current evidence"
    what: "Drop on 11-12 using `pgss_delta` and the code audit only."
    risk: "GraphQL callers go unseen. A ≤2.3.3 install not opened since about June fails one search."
  - id: C
    label: "Don't drop"
    what: "Don't drop. Ship only the mobile/depot cleanup."
    risk: "Keeps 4 slow functions anyone with the anon key can call (v7 ~12 s cold)."
recommend: A
on_accept:
  - "`supabase db push` the tracking migration only, from a clean main."
  - 'On the window date, run `q.sh shoplocal "$(cat scripts/perf/verify-omni-v5-v8-unused.sql)"`.'
  - "If `go=true`: merge the mobile branch, push the drop migration, regenerate web-app types, re-measure. If not: no drop, and I report the caller."
attachments:
  - kind: diff
    caption: "Migrations on branch retire-omni-v5-v8 at 7aa2657 (not on main)"
    source: |-
      diff --git a/supabase/migrations/20261105190000_track_functions_authenticator.sql b/supabase/migrations/20261105190000_track_functions_authenticator.sql
      new file mode 100644
      index 0000000..2eb489a
      --- /dev/null
      +++ b/supabase/migrations/20261105190000_track_functions_authenticator.sql
      @@ -0,0 +1,20 @@
      +-- Count function calls made through PostgREST and pg_graphql
      +-- (shloco/supa-backend#23, epic shloco/infra#116).
      +--
      +-- pg_graphql runs every GraphQL request as one graphql.graphql() statement,
      +-- so pg_stat_statements (track = top) can't tell which SQL function a query
      +-- hit. With track_functions = 'all', pg_stat_user_functions counts each call
      +-- to a plpgsql or (non-inlined) SQL function, including omni_search_v5–v8
      +-- reached through GraphQL (checked on a scratch copy: one call each).
      +-- That makes the 7-day zero-call check before dropping v5–v8 cover GraphQL,
      +-- not just /rest/v1/rpc.
      +--
      +-- track_functions is listed in supautils.privileged_role_allowed_configs, so
      +-- postgres can set it per role (same mechanism as track_io_timing in
      +-- 20261105130000_perf_observability.sql). Applies to new connections;
      +-- PostgREST recycles its pool within about an hour. Overhead is two clock
      +-- reads and a hash lookup per function call.
      +--
      +-- Revert: alter role authenticator reset track_functions;
      +
      +alter role authenticator set track_functions = 'all';
      diff --git a/supabase/migrations/20261112160000_retire_omni_search_v5_v8.sql b/supabase/migrations/20261112160000_retire_omni_search_v5_v8.sql
      new file mode 100644
      index 0000000..8923527
      --- /dev/null
      +++ b/supabase/migrations/20261112160000_retire_omni_search_v5_v8.sql
      @@ -0,0 +1,111 @@
      +-- Retire omni_search_v5–v8 and the unused omni_search_v*_result tables
      +-- (shloco/supa-backend#23, epic shloco/infra#116).
      +--
      +-- Every shipped client moved to omni_search_v9: web-app 2026-05-30 (66b5150),
      +-- mobile-v2 production 2026-05-31 (c9cce60, binary 2.3.4 bumped 2026-06-01),
      +-- canary 2026-11-05 (#20), omni-eval harness 2026-05-28. Drop only after the
      +-- 7-day zero-call window (2026-11-05 16:00 → 2026-11-12 16:00 UTC) and an
      +-- approved review.
      +--
      +-- Why: pg_graphql builds a per-backend, per-role schema cache from every
      +-- exposed function and table on first use (~210 ms / ~40k buffer hits on prod).
      +-- Each *_result table is exposed as a collection, with FK relationships onto
      +-- store/product/brand/inventory, so empty legacy tables still cost catalog work.
      +--
      +-- Kept on purpose:
      +--   omni_search_v4_result      returned by brand_product_list_v2,
      +--                              brand_product_search_v2, inventory_search_v2
      +--   omni_search_v9_result      returned by omni_search_v9
      +--   omni_search_v1_result_type enum used by v9_result and store_search_v*_result
      +--
      +-- No CASCADE: if anything unexpected depends on these objects, the drop fails
      +-- and `supabase db push` rolls the whole migration back.
      +
      +-- Guard: the result tables must be empty and the kept dependents must still
      +-- reference the kept types, so a drift since review fails loudly.
      +do $$
      +declare
      +  t text;
      +  n bigint;
      +begin
      +  foreach t in array array['omni_search_v1_result', 'omni_search_v2_result',
      +                           'omni_search_v3_result', 'omni_search_v5_result',
      +                           'omni_search_v6_result'] loop
      +    execute format('select count(*) from public.%I', t) into n;
      +    if n > 0 then
      +      raise exception 'public.% has % rows; expected an empty result-type table', t, n;
      +    end if;
      +  end loop;
      +
      +  if exists (
      +    select 1
      +    from pg_proc p
      +    where p.pronamespace = 'public'::regnamespace
      +      and p.prorettype in ('public.omni_search_v5_result'::regtype,
      +                           'public.omni_search_v6_result'::regtype)
      +      and p.proname not in ('omni_search_v5', 'omni_search_v6',
      +                            'omni_search_v7', 'omni_search_v8')
      +  ) then
      +    raise exception 'an unexpected function returns omni_search_v5/v6_result';
      +  end if;
      +
      +  if exists (
      +    select 1
      +    from pg_proc p
      +    where p.pronamespace = 'public'::regnamespace
      +      and p.proname not in ('omni_search_v5', 'omni_search_v6',
      +                            'omni_search_v7', 'omni_search_v8')
      +      and p.prosrc ~* '\momni_search_v[5-8]\s*\('
      +  ) then
      +    raise exception 'a remaining function body calls omni_search_v5–v8';
      +  end if;
      +end
      +$$;
      +
      +drop function public.omni_search_v5(
      +  search_term text, min_longitude double precision, min_latitude double precision,
      +  max_longitude double precision, max_latitude double precision,
      +  result_limit integer, result_offset integer,
      +  store_category_boost double precision, store_headline_boost double precision,
      +  brand_description_boost double precision, brand_name_boost double precision,
      +  no_inventory_boost double precision, similarity_weight_ratio double precision,
      +  max_rank double precision);
      +
      +drop function public.omni_search_v6(
      +  search_term text, min_longitude double precision, min_latitude double precision,
      +  max_longitude double precision, max_latitude double precision,
      +  result_limit integer, result_offset integer, locally_owned_only boolean,
      +  store_category_boost double precision, store_headline_boost double precision,
      +  brand_description_boost double precision, brand_name_boost double precision,
      +  product_category_boost double precision, products_per_store integer,
      +  similarity_weight_ratio double precision, max_rank double precision);
      +
      +drop function public.omni_search_v7(
      +  search_term text, min_longitude double precision, min_latitude double precision,
      +  max_longitude double precision, max_latitude double precision,
      +  result_limit integer, result_offset integer, locally_owned_only boolean,
      +  store_category_boost double precision, store_headline_boost double precision,
      +  brand_description_boost double precision, brand_name_boost double precision,
      +  product_category_boost double precision, products_per_store integer,
      +  similarity_weight_ratio double precision, max_rank double precision,
      +  distance_decay_weight double precision);
      +
      +drop function public.omni_search_v8(
      +  search_term text, min_longitude double precision, min_latitude double precision,
      +  max_longitude double precision, max_latitude double precision,
      +  result_limit integer, result_offset integer, locally_owned_only boolean,
      +  store_category_boost double precision, store_headline_boost double precision,
      +  brand_description_boost double precision, brand_name_boost double precision,
      +  product_category_boost double precision, products_per_store integer,
      +  similarity_weight_ratio double precision, max_rank double precision,
      +  distance_decay_weight double precision, local_brands_only boolean,
      +  local_brand_radius_km numeric, brand_origin_decay_radius_km numeric,
      +  brand_distance_decay_weight double precision);
      +
      +-- Result-type tables: empty, never written. Their RLS policies, PKs and FKs
      +-- go with them.
      +drop table public.omni_search_v1_result;
      +drop table public.omni_search_v2_result;
      +drop table public.omni_search_v3_result;
      +drop table public.omni_search_v5_result;
      +drop table public.omni_search_v6_result;
---
**shlo-k54.4.1** · supa-backend#23 · epic infra#116

## Caller audit: nothing shipped calls v5–v8

| Caller | Uses | Since |
| --- | --- | --- |
| web-app | v9 | 2026-05-30 (`66b5150`) |
| mobile-v2 `production` OTA | v9 | 2026-05-31 (`c9cce60`); binary 2.3.4 bumped 2026-06-01 |
| canary / omni-eval harness | v9 | today (#20) / 2026-05-28 |
| depot admin (local-only) | **was v5**, fixed on main today (`32cd23e`) | |
| DB views, cron jobs, other functions | none | |

`perf.pgss_delta` since 2026-11-05 16:00 UTC: **0 calls**. **Gap:** stats only record top-level statements (`track=top`), so every GraphQL request is one opaque `graphql.graphql()` statement, and a GraphQL `omniSearchV7` call never appears. `track_functions='all'` on `authenticator` counts them; on scratch it caught 1 call to each of v5–v8.

## Baseline first-call latency (prod, anon, `{ __typename }`)

| | n | median | p90 | max |
| --- | --- | --- | --- | --- |
| New PostgREST connection | 43 | **374 ms** | 468 | 1188 |
| Reused connection | 37 | **110 ms** | 159 | 579 |

- 14 of the 15 requests over 400 ms were on new connections. 54% of requests got a new connection, even back-to-back.
- In the database, the pg_graphql schema cache is built per backend **per role**. A cold build takes 210–264 ms and ~41k buffer hits; warm, it takes <1 ms.
- **What the drop buys (scratch, same schema):** cold build 67.4 → 64.5 ms median, 38,315 → 37,341 hits, about **–4%**, or roughly –9 ms on prod. It removes 9 query fields and 50 GraphQL types.
- The real cost is connection churn plus pg_graphql's fixed cost, not schema size. That belongs in a separate ticket.

## Migration (branch `retire-omni-v5-v8`, not on main)

Both migration files are attached as a diff.

- Validated on a scratch copy of the prod schema: applies cleanly, v9 and the v4 consumers still resolve, and an old `omniSearchV5` query now returns `Unknown field`.
- mobile-v2 branch `retire-omni-v5-v8` (`84b7330`): removes the v5/v7/v8 `.graphql` files and types the cards as `OmniSearchV9Result`.
