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
    caption: "Migrations on branch retire-omni-v5-v8 (not on main)"
    source: |-
      diff --git a/supabase/migrations/20261105190000_track_functions_authenticator.sql b/supabase/migrations/20261105190000_track_functions_authenticator.sql
      new file mode 100644
      --- /dev/null
      +++ b/supabase/migrations/20261105190000_track_functions_authenticator.sql
      @@ -0,0 +1,3 @@
      +-- Count function calls reached through GraphQL too: pg_stat_statements
      +-- records only the top-level graphql.graphql() statement (track=top).
      +alter role authenticator set track_functions = 'all';
      diff --git a/supabase/migrations/20261112160000_retire_omni_search_v5_v8.sql b/supabase/migrations/20261112160000_retire_omni_search_v5_v8.sql
      new file mode 100644
      --- /dev/null
      +++ b/supabase/migrations/20261112160000_retire_omni_search_v5_v8.sql
      @@ -0,0 +1,34 @@
      +-- Retire omni_search v5-v8. Guard first: refuse unless the result tables
      +-- are empty and no remaining function calls v5-v8.
      +do $$
      +begin
      +  if exists (select 1 from public.omni_search_v1_result)
      +     or exists (select 1 from public.omni_search_v2_result)
      +     or exists (select 1 from public.omni_search_v3_result)
      +     or exists (select 1 from public.omni_search_v5_result)
      +     or exists (select 1 from public.omni_search_v6_result) then
      +    raise exception 'omni_search result tables are not empty';
      +  end if;
      +  if exists (
      +    select 1 from pg_proc p
      +    where p.prosrc ~ 'omni_search_v[5-8]\M'
      +      and p.proname !~ '^omni_search_v[5-8]$'
      +  ) then
      +    raise exception 'a remaining function still calls omni_search v5-v8';
      +  end if;
      +end
      +$$;
      +
      +drop function public.omni_search_v5(text, integer);
      +drop function public.omni_search_v6(text, integer);
      +drop function public.omni_search_v7(text, integer, jsonb);
      +drop function public.omni_search_v8(text, integer, jsonb);
      +
      +drop table public.omni_search_v1_result;
      +drop table public.omni_search_v2_result;
      +drop table public.omni_search_v3_result;
      +drop table public.omni_search_v5_result;
      +drop table public.omni_search_v6_result;
      +
      +-- Kept: omni_search_v4_result (brand_product_*_v2, inventory_search_v2),
      +-- omni_search_v9_result, and the OmniSearchV1ResultType enum.
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
