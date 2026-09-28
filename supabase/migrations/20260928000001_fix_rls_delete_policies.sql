-- Tandaan RLS fix: remove unused delete policies and enforce using-only on deletes.
-- Postgres rejects WITH CHECK on DELETE policies, so all delete policies must use only the USING clause.

-- Remove delete policy from notes (the app never deletes notes)
drop policy if exists notes_delete_own on public.notes;

-- Re-affirm delete policies use ONLY the USING clause (no WITH CHECK), in case deployed state differs
drop policy if exists tasks_delete_own on public.tasks;
create policy tasks_delete_own on public.tasks for delete to authenticated using (auth.uid() = user_id);

drop policy if exists shopping_delete_own on public.shopping_items;
create policy shopping_delete_own on public.shopping_items for delete to authenticated using (auth.uid() = user_id);

drop policy if exists purchases_delete_own on public.purchases;
create policy purchases_delete_own on public.purchases for delete to authenticated using (auth.uid() = user_id);

drop policy if exists push_delete_own on public.push_subscriptions;
create policy push_delete_own on public.push_subscriptions for delete to authenticated using (auth.uid() = user_id);

-- Profiles has no delete policy (the app never deletes profiles)
drop policy if exists profiles_delete_own on public.profiles;
