alter table public.leaderboard
  add column if not exists average_fps double precision,
  add column if not exists time_of_completion bigint,
  add column if not exists completion_data jsonb not null default '{}'::jsonb,
  add column if not exists has_replay_data boolean not null default true,
  add column if not exists replay_revision text,
  add column if not exists replay_digest text,
  add column if not exists submission_id text,
  add column if not exists updated_at timestamptz not null default now();

create index if not exists leaderboard_obby_updated_idx
  on public.leaderboard (obby_id, updated_at desc);

comment on column public.leaderboard.time_of_completion is
  'Unix completion timestamp in seconds, supplied by the validated Roblox server.';
comment on column public.leaderboard.completion_data is
  'Display and verification summary metadata; never contains the replay body.';
comment on column public.leaderboard.has_replay_data is
  'Whether the canonical replay object currently contains playable replay data.';

update public.leaderboard
set time_of_completion = floor(extract(epoch from created_at))::bigint,
    updated_at = now()
where time_of_completion is null;
