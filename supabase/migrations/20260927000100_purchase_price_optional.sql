alter table public.purchases alter column price drop not null;
alter table public.purchases drop constraint if exists purchases_price_nonnegative;
alter table public.purchases add constraint purchases_price_nonnegative check (price is null or price >= 0);
