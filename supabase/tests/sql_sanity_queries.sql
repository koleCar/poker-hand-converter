-- Run after applying migration and ingesting at least one batch.
-- Replace :batch_id with a real UUID.

select count(*) as uploads_in_batch
from public.uploads
where upload_batch_id = :'batch_id';

select count(*) as hands_in_batch
from public.hands h
join public.uploads u on u.id = h.upload_id
where u.upload_batch_id = :'batch_id';

select player_name
from public.upload_all_players
where upload_batch_id = :'batch_id'
order by player_name;

select player_name
from public.upload_known_cards_players
where upload_batch_id = :'batch_id'
order by player_name;
