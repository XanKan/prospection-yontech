-- Vues des maquettes : seules comptent les visites des prospects.
--  · uniquement après l'envoi du mail (avant, ce sont des visites internes) ;
--  · pas dans les 2 minutes qui suivent l'envoi (filtres de sécurité des messageries) ;
--  · jamais les visites de l'équipe (cookie posé par l'outil, ou lien « aperçu »),
--    écartées en amont par le Worker et la fonction yontech-maquette ;
--  · chaque vue est journalisée (visiteur anonymisé) pour pouvoir vérifier.
begin;

create table if not exists public.yontech_maquette_vues(
  id bigint generated always as identity primary key,
  maquette_id uuid not null references public.yontech_maquettes(id) on delete cascade,
  at timestamptz not null default now(),
  path text not null default '/',
  visitor text not null default ''
);
create index if not exists yontech_maquette_vues_maquette on public.yontech_maquette_vues(maquette_id, at);
alter table public.yontech_maquette_vues enable row level security;

-- Sauvegarde des compteurs avant remise à zéro (14 octobre 2026) : ils mêlaient
-- les visites de l'équipe, des robots et des prospects.
create table if not exists public.yontech_maquette_vues_avant_20261014 as
  select id, slug, views, last_view_at, now() as saved_at from public.yontech_maquettes;
alter table public.yontech_maquette_vues_avant_20261014 enable row level security;
update public.yontech_maquettes set views=0, last_view_at=null;

drop function if exists public.yontech_maquette_view(text);
create or replace function public.yontech_maquette_view(target_slug text, target_path text default '/', target_visitor text default '')
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare m public.yontech_maquettes%rowtype;
begin
  select * into m from public.yontech_maquettes where slug=target_slug and status='en_ligne';
  if not found or m.review is distinct from 'envoye' or m.sent_at is null or now() < m.sent_at + interval '2 minutes' then return; end if;
  -- Une même personne qui parcourt plusieurs pages dans l'heure compte pour une vue.
  if target_visitor<>'' and exists(select 1 from public.yontech_maquette_vues v where v.maquette_id=m.id and v.visitor=target_visitor and v.at > now()-interval '1 hour') then
    insert into public.yontech_maquette_vues(maquette_id,path,visitor) values(m.id,left(coalesce(target_path,'/'),80),left(target_visitor,32));
    return;
  end if;
  insert into public.yontech_maquette_vues(maquette_id,path,visitor) values(m.id,left(coalesce(target_path,'/'),80),left(coalesce(target_visitor,''),32));
  update public.yontech_maquettes set views=views+1, last_view_at=now() where id=m.id;
end $$;
revoke all on function public.yontech_maquette_view(text,text,text) from public, anon, authenticated;
grant execute on function public.yontech_maquette_view(text,text,text) to service_role;

commit;
