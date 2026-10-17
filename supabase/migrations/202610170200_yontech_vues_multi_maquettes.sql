-- Un prospect n'a qu'une maquette : un visiteur vu sur deux maquettes différentes
-- ou plus est l'équipe (téléphone, autre navigateur sans le cookie) ou un robot.
-- Il est exclu pour toujours, ses vues passées sont retirées et les compteurs recalculés.
begin;
create table if not exists public.yontech_maquette_visiteurs_exclus(
  visitor text primary key,
  at timestamptz not null default now()
);
alter table public.yontech_maquette_visiteurs_exclus enable row level security;

create or replace function public.yontech_maquette_recount(target_id uuid) returns void
language sql security definer set search_path to 'public','pg_temp' as $$
  update public.yontech_maquettes q set
    views=(select count(distinct v.visitor||'|'||to_char(date_trunc('hour',v.at),'YYYYMMDDHH24')) from public.yontech_maquette_vues v where v.maquette_id=q.id),
    last_view_at=(select max(v.at) from public.yontech_maquette_vues v where v.maquette_id=q.id)
  where q.id=target_id;
$$;

create or replace function public.yontech_maquette_forget_visitor(target_visitor text) returns void
language plpgsql security definer set search_path to 'public','pg_temp' as $$
declare ids uuid[];
begin
  insert into public.yontech_maquette_visiteurs_exclus(visitor) values(target_visitor) on conflict do nothing;
  select array_agg(distinct maquette_id) into ids from public.yontech_maquette_vues where visitor=target_visitor;
  delete from public.yontech_maquette_vues where visitor=target_visitor;
  if ids is not null then perform public.yontech_maquette_recount(i) from unnest(ids) i; end if;
end $$;

create or replace function public.yontech_maquette_view(target_slug text, target_path text DEFAULT '/'::text, target_visitor text DEFAULT ''::text)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
declare m public.yontech_maquettes%rowtype;
begin
  select * into m from public.yontech_maquettes where slug=target_slug and status='en_ligne';
  if not found or m.review is distinct from 'envoye' or m.sent_at is null or now() < m.sent_at + interval '2 minutes' then return; end if;
  if target_visitor<>'' then
    if exists(select 1 from public.yontech_maquette_visiteurs_exclus x where x.visitor=target_visitor) then return; end if;
    -- Déjà vu sur une autre maquette : équipe ou robot.
    if exists(select 1 from public.yontech_maquette_vues v where v.visitor=target_visitor and v.maquette_id<>m.id) then
      perform public.yontech_maquette_forget_visitor(target_visitor);
      return;
    end if;
  end if;
  -- Une même personne qui parcourt plusieurs pages dans l'heure compte pour une vue.
  if target_visitor<>'' and exists(select 1 from public.yontech_maquette_vues v where v.maquette_id=m.id and v.visitor=target_visitor and v.at > now()-interval '1 hour') then
    insert into public.yontech_maquette_vues(maquette_id,path,visitor) values(m.id,left(coalesce(target_path,'/'),80),left(target_visitor,32));
    return;
  end if;
  insert into public.yontech_maquette_vues(maquette_id,path,visitor) values(m.id,left(coalesce(target_path,'/'),80),left(coalesce(target_visitor,''),32));
  update public.yontech_maquettes set views=views+1, last_view_at=now() where id=m.id;
end $function$;

-- Historique : visiteurs déjà vus sur plusieurs maquettes.
select public.yontech_maquette_forget_visitor(visitor) from (
  select visitor from public.yontech_maquette_vues where visitor<>'' group by visitor having count(distinct maquette_id)>1
) x;
commit;
