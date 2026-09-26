# Tandaan 2.0

Offline-first personal memory PWA built with React, TypeScript, Vite, Dexie, and Supabase.

## v15 changes
- Smart Add routes text into Task, Shopping, or Purchase.
- Terse purchase shorthand such as `Rice 40`, `Egg 1 tray 400`, and `Egg 20 pieces` is treated as purchase data, not a task.
- Purchase prices may be omitted; totals only include priced purchases.
- Purchase CRUD with automatic PHP total.
- Shopping CRUD.
- Task due-date prompt appears before saving, not inside the task card.
- Due date and optional time are edited together.
