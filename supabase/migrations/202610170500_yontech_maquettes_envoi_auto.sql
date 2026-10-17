-- Envoi automatique des maquettes : une maquette au site sur mesure prêt part
-- deux heures après, pendant les créneaux d'envoi, dans le quota du jour.
begin;
alter table public.yontech_maquettes drop constraint if exists yontech_maquettes_review_check;
alter table public.yontech_maquettes add constraint yontech_maquettes_review_check check (review in ('a_valider','envoi','envoye','rejete'));
alter table public.yontech_prospection_settings add column if not exists maquette_auto boolean not null default false;
update public.yontech_prospection_settings set maquette_auto=true, maquette_daily=50, maquette_daily_creation=50 where id=1;
commit;
