-- Délivrabilité : premier mail sobre (sans pixel d'ouverture), donc relances
-- pour tous les contactés sans réponse ; boîtes d'envoi supplémentaires
-- (mot de passe dans YONTECH_SMTP_PASSWORD_2 … _5).
begin;
alter table public.yontech_prospection_settings
  add column if not exists sender_email_2 text, add column if not exists sender_email_3 text,
  add column if not exists sender_email_4 text, add column if not exists sender_email_5 text;
-- Relances activées pour les mails de la dernière semaine (pas de rattrapage massif).
update public.yontech_prospection_settings set followup_enabled=true, followup_opened_only=false,
  followup_since=coalesce(followup_since, now()-interval '7 days') where id=1;
commit;
