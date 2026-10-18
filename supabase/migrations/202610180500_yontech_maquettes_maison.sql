-- Maquettes « générées maison » (bibliothèque de modèles, sans IA de dessin) :
-- onglet à part dans Prospection maquette, envoi automatique séparé (coupé par défaut).
alter table public.yontech_maquettes add column if not exists maison boolean not null default false;
alter table public.yontech_prospection_settings add column if not exists maquette_auto_maison boolean not null default false;
