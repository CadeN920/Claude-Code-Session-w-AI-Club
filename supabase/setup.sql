-- Wanderlog database setup. Run once in Supabase: SQL Editor -> New query -> paste -> Run.
--
-- trips:        one row per trip; the person who creates it is the owner
-- trip_editors: emails of travel partners who can also edit a trip
-- Family view-only links go through get_shared_trip(), which returns a trip
-- only to someone holding its secret share token.

create table if not exists public.trips (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  share_token text unique
);

create table if not exists public.trip_editors (
  trip_id uuid not null references public.trips (id) on delete cascade,
  email text not null check (email = lower(email)),
  primary key (trip_id, email)
);

alter table public.trips enable row level security;
alter table public.trip_editors enable row level security;

-- Signed-in people may only touch the trip contents directly; ownership and
-- share links change only through the functions below.
revoke all on public.trips, public.trip_editors from anon, authenticated;
grant select, delete on public.trips to authenticated;
grant insert (data, updated_at), update (data, updated_at) on public.trips to authenticated;
grant select, insert, delete on public.trip_editors to authenticated;

-- Helpers (security definer so the policies don't loop into each other).
create or replace function public.owns_trip(t uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from trips where id = t and owner_id = auth.uid());
$$;

create or replace function public.is_trip_editor(t uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from trip_editors where trip_id = t and email = lower(auth.jwt() ->> 'email'));
$$;

create policy "See trips you own or edit" on public.trips for select to authenticated
  using (owner_id = auth.uid() or public.is_trip_editor(id));
create policy "Create your own trips" on public.trips for insert to authenticated
  with check (owner_id = auth.uid());
create policy "Edit trips you own or edit" on public.trips for update to authenticated
  using (owner_id = auth.uid() or public.is_trip_editor(id))
  with check (owner_id = auth.uid() or public.is_trip_editor(id));
create policy "Delete trips you own" on public.trips for delete to authenticated
  using (owner_id = auth.uid());

create policy "See your trips' editors, or trips shared with you" on public.trip_editors
  for select to authenticated
  using (public.owns_trip(trip_id) or email = lower(auth.jwt() ->> 'email'));
create policy "Owners add editors" on public.trip_editors for insert to authenticated
  with check (public.owns_trip(trip_id));
create policy "Owners remove editors" on public.trip_editors for delete to authenticated
  using (public.owns_trip(trip_id));

-- Family view-only link: anyone holding the token can read that one trip.
create or replace function public.get_shared_trip(token text) returns jsonb
language sql stable security definer set search_path = public as $$
  select data from trips where token is not null and share_token = token;
$$;

-- Owner makes a new link (the old one stops working) or turns it off.
create or replace function public.new_share_link(trip uuid) returns text
language plpgsql security definer set search_path = public as $$
declare
  t text := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
begin
  update trips set share_token = t where id = trip and owner_id = auth.uid();
  if not found then raise exception 'Only the trip owner can share it'; end if;
  return t;
end $$;

create or replace function public.stop_share_link(trip uuid) returns void
language sql security definer set search_path = public as $$
  update trips set share_token = null where id = trip and owner_id = auth.uid();
$$;

revoke execute on function public.new_share_link(uuid), public.stop_share_link(uuid) from public, anon;
grant execute on function public.new_share_link(uuid), public.stop_share_link(uuid) to authenticated;
grant execute on function public.get_shared_trip(text) to anon, authenticated;
