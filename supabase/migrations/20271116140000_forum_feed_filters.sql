-- Forum v2: the feed filters by post type and by "no comments yet".
--
-- `forum_feed` gains two optional arguments. Both narrow the same keyset
-- queries, so the cursor format and the indexes are unchanged; a filter only
-- drops rows. Old callers (the RSS routes) pass neither and get what they got.
--
--   p_kind        'hand'  hand posts that are not polls
--                 'poll'  "what would you do?" polls
--                 'text'  text posts
--                 null    everything
--   p_unanswered  true: only posts with no visible comments
--
-- The old four-argument function is dropped rather than overloaded: PostgREST
-- cannot pick between two functions that both accept the shorter call.

-- `post_polls` is sealed from readers (20261130090000_forum_polls.sql), so the
-- feed asks this definer whether a post is a poll. It says nothing else.
create or replace function public.forum_post_is_poll(p_post uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.post_polls pp where pp.post_id = p_post);
$$;

revoke all on function public.forum_post_is_poll(uuid) from public;
grant execute on function public.forum_post_is_poll(uuid) to anon, authenticated;

drop function if exists public.forum_feed(text, text, text, integer);

create or replace function public.forum_feed(
  p_board      text default null,
  p_sort       text default 'hot',
  p_after      text default null,
  p_limit      integer default 25,
  p_kind       text default null,
  p_unanswered boolean default false
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_board  uuid;
  v_limit  integer := least(greatest(coalesce(p_limit, 25), 1), 50);
  v_sort   text := case when p_sort in ('hot', 'new', 'top') then p_sort else 'hot' end;
  v_kind   text := case when p_kind in ('hand', 'poll', 'text') then p_kind else null end;
  v_una    boolean := coalesce(p_unanswered, false);
  v_key    text;
  v_id     uuid;
  v_page   public.posts[];
  v_rows   jsonb;
  v_next   text;
  v_last   public.posts;
  i        integer;
begin
  if p_board is not null then
    select id into v_board from public.boards where slug = lower(p_board);
    if not found then
      return null;
    end if;
  end if;

  if p_after is not null and position('~' in p_after) > 0 then
    v_key := split_part(p_after, '~', 1);
    begin
      v_id := split_part(p_after, '~', 2)::uuid;
    exception when others then
      v_key := null;
      v_id := null;
    end;
  end if;

  begin
    if v_sort = 'hot' then
      select array_agg(p order by p.hot_rank desc, p.id desc) into v_page from (
        select p.* from public.posts p
        where p.status = 'visible' and p.deleted_at is null
          and (v_board is null or p.board_id = v_board)
          and (v_kind is null
               or (v_kind = 'text' and p.kind = 'text')
               or (v_kind = 'hand' and p.kind = 'hand' and not public.forum_post_is_poll(p.id))
               or (v_kind = 'poll' and public.forum_post_is_poll(p.id)))
          and (not v_una or p.comment_count = 0)
          and (v_id is null or (p.hot_rank, p.id) < (v_key::double precision, v_id))
        order by p.hot_rank desc, p.id desc
        limit v_limit + 1
      ) p;
    elsif v_sort = 'new' then
      select array_agg(p order by p.created_at desc, p.id desc) into v_page from (
        select p.* from public.posts p
        where p.status = 'visible' and p.deleted_at is null
          and (v_board is null or p.board_id = v_board)
          and (v_kind is null
               or (v_kind = 'text' and p.kind = 'text')
               or (v_kind = 'hand' and p.kind = 'hand' and not public.forum_post_is_poll(p.id))
               or (v_kind = 'poll' and public.forum_post_is_poll(p.id)))
          and (not v_una or p.comment_count = 0)
          and (v_id is null or (p.created_at, p.id) < (v_key::timestamptz, v_id))
        order by p.created_at desc, p.id desc
        limit v_limit + 1
      ) p;
    else
      select array_agg(p order by p.score desc, p.id desc) into v_page from (
        select p.* from public.posts p
        where p.status = 'visible' and p.deleted_at is null
          and (v_board is null or p.board_id = v_board)
          and (v_kind is null
               or (v_kind = 'text' and p.kind = 'text')
               or (v_kind = 'hand' and p.kind = 'hand' and not public.forum_post_is_poll(p.id))
               or (v_kind = 'poll' and public.forum_post_is_poll(p.id)))
          and (not v_una or p.comment_count = 0)
          and (v_id is null or (p.score, p.id) < (v_key::integer, v_id))
        order by p.score desc, p.id desc
        limit v_limit + 1
      ) p;
    end if;
  exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow
                 or numeric_value_out_of_range then
    -- A mangled cursor is the first page, not an error page.
    return public.forum_feed(p_board, v_sort, null, v_limit, v_kind, v_una);
  end;

  v_page := coalesce(v_page, array[]::public.posts[]);

  v_rows := '[]'::jsonb;
  for i in 1 .. least(cardinality(v_page), v_limit) loop
    v_rows := v_rows || jsonb_build_array(public.forum_post_json(v_page[i]));
  end loop;

  if cardinality(v_page) > v_limit then
    v_last := v_page[v_limit];
    v_next := case v_sort
                when 'hot' then v_last.hot_rank::text
                when 'new' then to_char(v_last.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                else v_last.score::text
              end || '~' || v_last.id::text;
  end if;

  return jsonb_build_object('posts', v_rows, 'next', v_next, 'sort', v_sort);
end;
$$;

revoke all on function public.forum_feed(text, text, text, integer, text, boolean) from public;
grant execute on function public.forum_feed(text, text, text, integer, text, boolean) to anon, authenticated;

-- Per-board post counts for the forum sidebar: one cheap aggregate instead of
-- a count request per board.
create or replace function public.forum_board_counts()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(b.slug, coalesce(c.n, 0)), '{}'::jsonb)
  from public.boards b
  left join (
    select p.board_id, count(*) as n
    from public.posts p
    where p.status = 'visible' and p.deleted_at is null
    group by p.board_id
  ) c on c.board_id = b.id;
$$;

revoke all on function public.forum_board_counts() from public;
grant execute on function public.forum_board_counts() to anon, authenticated;
