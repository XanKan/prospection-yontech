-- Mode « maquettes seules » (20/10/2026) : plus de premier mail classique ni de
-- relance classique ; seules les maquettes (générées maison) partent, de 6 h 30
-- à 17 h les jours d'envoi. Remettre premiers_mails à true pour reprendre.
alter table public.yontech_prospection_settings add column if not exists premiers_mails boolean not null default true;
update public.yontech_prospection_settings
set premiers_mails = false, window_start = '06:30', window_end = '17:00', window2_start = null, window2_end = null
where id = 1;
