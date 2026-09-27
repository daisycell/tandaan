alter table public.profiles
  add column if not exists theme text not null default 'cat';

alter table public.profiles
  drop constraint if exists profiles_theme_check;

alter table public.profiles
  add constraint profiles_theme_check
  check (theme in ('cat', 'dog', 'capybara'));
