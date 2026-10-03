import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  MAX_CUSTOM_REMINDER_MINUTES,
  REMINDER_OPTIONS,
  calculateReminderAt,
  clampDueDate,
  defaultReminderOption,
  isDueDateAllowed,
  minDueDateForPreset,
  resolveReminder,
  toMinutes,
  validateCustomReminder,
} from '../src/reminders.ts'

let passed = 0
function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.error(`  FAIL  ${name}`)
    throw error
  }
}

const TODAY = '2026-10-02'
const TOMORROW = '2026-10-03'
const YESTERDAY = '2026-10-01'
const LATER = '2026-10-09'

/* --- 1-3. date preset floors ------------------------------------------- */

test('Today selected: yesterday is not an allowed date', () => {
  const min = minDueDateForPreset('today', TODAY, TOMORROW)
  assert.equal(min, TODAY)
  assert.equal(isDueDateAllowed(YESTERDAY, min), false)
  assert.equal(isDueDateAllowed(TODAY, min), true)
  assert.equal(isDueDateAllowed(TOMORROW, min), true)
})

test('Tomorrow selected: today and yesterday are both rejected', () => {
  const min = minDueDateForPreset('tomorrow', TODAY, TOMORROW)
  assert.equal(min, TOMORROW)
  assert.equal(isDueDateAllowed(YESTERDAY, min), false)
  assert.equal(isDueDateAllowed(TODAY, min), false)
  assert.equal(isDueDateAllowed(TOMORROW, min), true)
  assert.equal(isDueDateAllowed(LATER, min), true)
})

test('Choose date: floor is today, so yesterday is rejected but later dates are free', () => {
  const min = minDueDateForPreset('custom', TODAY, TOMORROW)
  assert.equal(min, TODAY)
  assert.equal(isDueDateAllowed(YESTERDAY, min), false)
  assert.equal(isDueDateAllowed(TODAY, min), true)
  assert.equal(isDueDateAllowed(LATER, min), true)
})

test('malformed dates are rejected rather than compared as text', () => {
  assert.equal(isDueDateAllowed('', TODAY), false)
  assert.equal(isDueDateAllowed('not-a-date', TODAY), false)
  assert.equal(isDueDateAllowed('2026-13-45', TODAY), false)
})

test('changing preset snaps an illegal date up to the new floor', () => {
  // Tomorrow -> Today leaves the stored date illegal; it must be clamped.
  assert.equal(clampDueDate(TOMORROW, TODAY), TOMORROW)
  assert.equal(clampDueDate(TODAY, TOMORROW), TOMORROW)
  assert.equal(clampDueDate(YESTERDAY, TODAY), TODAY)
  assert.equal(clampDueDate('', TODAY), TODAY)
})

/* --- 4-7, 11. preset lead times ---------------------------------------- */

test('At due time means zero minutes before', () => {
  assert.equal(resolveReminder(TODAY, '18:00', 'due').minutesBefore, 0)
  // A zero lead must not be confused with "no reminder".
  const due = resolveReminder(TODAY, '18:00', 'due')
  assert.equal(due.enabled, true)
  assert.equal(due.reminderAt, calculateReminderAt(TODAY, '18:00', 0))
})

test('30 min before is 30', () => {
  assert.equal(resolveReminder(TODAY, '18:00', '30m').minutesBefore, 30)
  assert.equal(REMINDER_OPTIONS.find(o => o.id === '30m').minutes, 30)
})

test('1 hour before is 60', () => {
  assert.equal(resolveReminder(TODAY, '18:00', '1h').minutesBefore, 60)
})

test('1 day before is 1440', () => {
  assert.equal(resolveReminder(TODAY, '18:00', '1d').minutesBefore, 1440)
})

test('every option the UI offers exists and keeps At due time', () => {
  assert.deepEqual(
    REMINDER_OPTIONS.map(o => o.id),
    ['none', 'due', '30m', '1h', '1d', 'custom'],
  )
})

test('No reminder produces no reminderAt and is disabled', () => {
  const none = resolveReminder(TODAY, '18:00', 'none')
  assert.equal(none.enabled, false)
  assert.equal(none.reminderAt, null)
})

test('no due date means no reminder regardless of option', () => {
  const result = resolveReminder(null, null, '1d')
  assert.equal(result.enabled, false)
  assert.equal(result.reminderAt, null)
})

/* --- 6. unit conversion ------------------------------------------------- */

test('unit conversion: 2 hours is 120 minutes', () => {
  assert.equal(toMinutes(2, 'hours'), 120)
})

test('unit conversion: 1 day is 1440 minutes', () => {
  assert.equal(toMinutes(1, 'days'), 1440)
})

test('unit conversion: 30 minutes stays 30', () => {
  assert.equal(toMinutes(30, 'minutes'), 30)
})

/* --- 8. custom validation ---------------------------------------------- */

test('custom rejects zero because At due time already means that', () => {
  assert.match(validateCustomReminder(0, 'minutes'), /greater than zero/)
})

test('custom rejects negative amounts', () => {
  assert.match(validateCustomReminder(-5, 'minutes'), /greater than zero/)
})

test('custom rejects NaN and decimals', () => {
  assert.match(validateCustomReminder(NaN, 'minutes'), /whole number/)
  assert.match(validateCustomReminder(1.5, 'minutes'), /whole number/)
})

test('custom caps at 30 days', () => {
  assert.equal(validateCustomReminder(30, 'days'), null)
  assert.match(validateCustomReminder(31, 'days'), /at most 30 days/)
  assert.equal(toMinutes(31, 'days') > MAX_CUSTOM_REMINDER_MINUTES, true)
})

test('custom rejects an unknown unit', () => {
  assert.match(validateCustomReminder(5, 'fortnights'), /minutes, hours or days/)
})

test('custom accepts the examples from the brief', () => {
  for (const minutes of [5, 15, 30, 45, 90]) {
    assert.equal(validateCustomReminder(minutes, 'minutes'), null)
    assert.equal(resolveReminder(TODAY, '18:00', 'custom', toMinutes(minutes, 'minutes')).minutesBefore, minutes)
  }
})

/* --- 9. custom reminderAt lands where expected -------------------------- */

test('today 18:00 with 30 minutes custom fires at 17:30 local', () => {
  const result = resolveReminder(TODAY, '18:00', 'custom', toMinutes(30, 'minutes'))
  assert.equal(result.minutesBefore, 30)
  const expected = new Date(`${TODAY}T18:00:00`).getTime() - 30 * 60_000
  assert.equal(result.reminderAt, new Date(expected).toISOString())
})

test('2 hours custom is stored as 120 minutes', () => {
  assert.equal(resolveReminder(TOMORROW, '08:00', 'custom', toMinutes(2, 'hours')).minutesBefore, 120)
})

test('resolveReminder floors and clamps a custom value it is handed directly', () => {
  assert.equal(resolveReminder(TODAY, '09:00', 'custom', 999_999).minutesBefore, MAX_CUSTOM_REMINDER_MINUTES)
  assert.equal(resolveReminder(TODAY, '09:00', 'custom', -1).minutesBefore, 1440)
})

/* --- existing behaviour must not regress -------------------------------- */

test('date-only default stays 1 day before, timed default stays 1 hour', () => {
  assert.equal(defaultReminderOption(null), '1d')
  assert.equal(defaultReminderOption(''), '1d')
  assert.equal(defaultReminderOption('18:00'), '1h')
})

test('date-only task still anchors to the 09:00 fallback', () => {
  assert.equal(
    calculateReminderAt(TODAY, null, 1440),
    new Date(new Date(`${TODAY}T09:00:00`).getTime() - 1440 * 60_000).toISOString(),
  )
})

test('invalid due date yields no reminderAt', () => {
  assert.equal(calculateReminderAt('garbage', '09:00', 60), null)
  assert.equal(calculateReminderAt('', '09:00', 60), null)
})

/* --- 12-15. phone auth invariants, asserted against the source ----------- */

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const notifications = readFileSync(new URL('../src/notifications.ts', import.meta.url), 'utf8')
const sync = readFileSync(new URL('../src/sync.ts', import.meta.url), 'utf8')
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const envExample = readFileSync(new URL('../.env.example', import.meta.url), 'utf8')

/** Body of the region between two source markers, so assertions cannot leak into neighbouring functions or comments. */
function slice(source, from, to) {
  const start = source.indexOf(from)
  assert.ok(start >= 0, `marker not found: ${from}`)
  const end = source.indexOf(to, start)
  assert.ok(end > start, `marker not found after ${from}: ${to}`)
  return source.slice(start, end)
}

test('12. an existing session short-circuits before sign-in', () => {
  const body = slice(notifications, 'async function resolveUserId', 'export async function getPushSubscription')
  const sessionRead = body.indexOf('existingSessionUserId()')
  const getUser = body.indexOf('await getUserId()')
  const verify = body.indexOf('existingSessionUserId()', getUser)
  assert.ok(sessionRead > 0, 'resolveUserId reads the session')
  assert.ok(sessionRead < getUser, 'session is read before getUserId')
  assert.ok(getUser < verify, 'session is verified after getUserId')
  // The early return sits between the first read and getUserId.
  assert.ok(body.slice(sessionRead, getUser).includes('return existing'), 'existing session returns immediately')
  assert.equal((body.match(/await getUserId\(\)/g) || []).length, 1, 'getUserId is called exactly once')
})

test('12b. getUserId is reached only when no session was found', () => {
  const body = slice(notifications, 'async function resolveUserId', 'export async function getPushSubscription')
  const guard = body.indexOf('const existing = await existingSessionUserId()')
  const early = body.indexOf('return existing')
  assert.ok(guard >= 0 && early > guard, 'the existing-session return precedes the getUserId branch')
})

test('12c. only one authoritative auth timeout, and it is not nested around getUserId', () => {
  const body = slice(notifications, 'async function resolveUserId', 'export async function getPushSubscription')
  // A competing stage timer here would preempt the auth timer that owns this
  // call, and would replace the real reason with a generic timeout.
  // Match the call form so the explanatory comment is not mistaken for code.
  assert.ok(!body.includes(`await withTimeout(`), 'getUserId is not wrapped in a competing stage timer')
  assert.equal((notifications.match(/withTimeout\('/g) || []).length, 6, 'the other push stages keep their own timeouts')
})

test('10. a Custom choice survives a time change or a cleared time', () => {
  // Re-seeding the default lead time is correct for an untouched form, but it
  // must not overwrite a reminder the user picked by hand.
  assert.ok(
    /if \(!dueReminderTouched\) setDueReminderOption\(defaultReminderOption\(e\.target\.value\)\)/.test(app),
    'time change only re-seeds while the choice is untouched',
  )
  assert.ok(
    /if \(!dueReminderTouched\) setDueReminderOption\(defaultReminderOption\(''\)\)/.test(app),
    'clearing the time only re-seeds while the choice is untouched',
  )
  assert.ok(
    /setDueReminderTouched\(true\); setDueReminderOption\(option\.id\)/.test(app),
    'picking a chip marks the choice as the user\'s',
  )
  // Touched state is reset when the form opens so a later modal starts clean.
  const reset = slice(app, 'function resetDueForm()', 'async function addShoppingDirect')
  assert.match(reset, /setDueReminderTouched\(false\)/)
  assert.match(reset, /setDueReminderOption\(defaultReminderOption\(''\)\)/, 'opening seeds the existing default')
  assert.match(reset, /setDueCustomError\(null\)/)
})

test('6. opening the due modal seeds the date-only default and clears prior state', () => {
  const reset = slice(app, 'function resetDueForm()', 'async function addShoppingDirect')
  assert.match(reset, /setDueDate\(''\)/)
  assert.match(reset, /setDueTime\(''\)/)
  assert.match(reset, /setDueDatePreset\('custom'\)/, 'picker floors at today until a preset is chosen')
  // Both entry points that open the modal must seed it.
  assert.match(app, /function addTaskDirect\(\)[\s\S]*?resetDueForm\(\)\s*\n\s*setDuePrompt/)
  assert.match(app, /setDuePrompt\(\{ title \}\)\s*\n\s*resetDueForm\(\)/)
})

test('7. a bad custom value blocks the save and keeps the modal open', () => {
  const save = slice(app, 'async function saveDueChoice', 'function startEditTask')
  const guard = save.indexOf('const problem = validateCustomReminder')
  const write = save.indexOf('await persistTask')
  assert.ok(guard > 0, 'custom is validated on save')
  assert.ok(guard < write, 'validation runs before anything is persisted')
  assert.match(save, /if \(problem\) \{\s*\n\s*setDueCustomError\(problem\)\s*\n\s*return\s*\n\s*\}/, 'rejects by returning early')
  // The early return must not clear the title, so the typed task is recoverable.
  const clearing = save.indexOf('setDirectTaskTitle(\'\')')
  assert.ok(clearing > save.indexOf('await persistTask'), 'title is cleared only after a successful write')
})

test('13. a failed sign-in rejects instead of hanging', () => {
  // The sign-in is still bounded by exactly one timer, so a dead call surfaces an
  // error instead of pinning the toggle in its busy state.
  assert.match(sync, /const SIGN_IN_TIMEOUT_MS = 15_000/, 'the sign-in budget is unchanged')
  assert.match(
    sync,
    /withSignInTimeout\(sb\.auth\.signInAnonymously\(\)\)/,
    'the sign-in call is the one bounded by that timer',
  )
  assert.match(sync, /reject\(new Error\(`Anonymous sign-in timed out after \$\{SIGN_IN_TIMEOUT_MS \/ 1000\}s\.`\)\)/)
  // The budget must not have been inflated to hide the hang.
  assert.match(notifications, /const STEP_TIMEOUT_MS = 15_000/)
})

test('13b. a rejected sign-in is never cached for later callers', () => {
  const body = slice(sync, 'export async function getUserId()', 'async function performAnonymousSignIn')
  const join = body.indexOf('if (pendingSignInPromise)')
  const assign = body.indexOf('pendingSignInPromise = performAnonymousSignIn()')
  const clear = body.indexOf('pendingSignInPromise = null', assign)
  assert.ok(join > 0, 'an in-flight sign-in is joined rather than started twice')
  assert.ok(assign > join, 'the pending promise is created only after the join check')
  assert.ok(clear > assign, 'the pending promise is cleared after the attempt')
  assert.match(body, /finally \{[\s\S]*?pendingSignInPromise = null/, 'cleared in finally, so a failure is not cached')
})

test('14. anonymous sign-in requests no CAPTCHA token', () => {
  const body = slice(sync, 'async function performAnonymousSignIn', 'export async function syncProfile')
  // signInAnonymously() must be called with no arguments: passing
  // { options: { captchaToken } } is what required the widget in the first place.
  assert.match(body, /sb\.auth\.signInAnonymously\(\)/, 'signInAnonymously() takes no arguments')
  assert.doesNotMatch(body, /captchaToken/, 'no captchaToken option is sent')
  assert.doesNotMatch(body, /options:\s*\{/, 'no options object is passed at all')
  // Nothing on this path may still reach for the removed widget module.
  assert.doesNotMatch(body, /requestCaptchaToken|TurnstileWidget/, 'no CAPTCHA request in the sign-in path')
  assert.match(body, /const userId = data\?\.user\?\.id \?\? null/, 'the user id is still read defensively')
})

test('14b. no CAPTCHA or Turnstile reference survives in production code', () => {
  assert.doesNotMatch(sync, /captcha|Turnstile|marsidev/i, 'sync.ts is free of CAPTCHA code')
  assert.doesNotMatch(notifications, /captcha|Turnstile|marsidev/i, 'notifications.ts is free of CAPTCHA code')
  assert.doesNotMatch(notifications, /getSignInError/, 'the CAPTCHA error channel is gone')
  assert.doesNotMatch(app, /TurnstileWidget|getSignInError/, 'App.tsx neither imports nor renders the widget')
  assert.equal(
    Object.keys(pkg.dependencies || {}).includes('@marsidev/react-turnstile'),
    false,
    'the dependency is gone from package.json',
  )
  assert.ok(!envExample.includes('VITE_TURNSTILE_SITE_KEY'), 'the site key is gone from .env.example')
  // Unrelated environment variables must survive untouched.
  for (const key of [
    'VITE_SUPABASE_URL',
    'VITE_SUPABASE_PUBLISHABLE_KEY',
    'VITE_VAPID_PUBLIC_KEY',
    'SUPABASE_SECRET_KEY',
    'WEB_PUSH_VAPID_PRIVATE_KEY',
    'REMINDER_CRON_SECRET',
  ]) {
    assert.ok(envExample.includes(key), `${key} is still documented`)
  }
})



test('15. saving a task never subscribes the phone', () => {
  assert.equal((app.match(/enablePushNotifications\(\)/g) || []).length, 1, 'exactly one call site')
  const callSite = app.indexOf('await enablePushNotifications()')
  const taskSave = app.indexOf('async function saveDueChoice')
  const taskSaveEnd = app.indexOf('function startEditTask')
  assert.ok(callSite < taskSave, 'the only subscriber is the settings toggle, not a save path')
  assert.ok(!app.slice(taskSave, taskSaveEnd).includes('enablePushNotifications'), 'saveDueChoice does not subscribe')
  assert.ok(!app.slice(taskSave, taskSaveEnd).includes('requestPermission'), 'saveDueChoice asks for no notification permission')
  // Push deletion must stay scoped to the caller's own row.
  const del = notifications.slice(notifications.indexOf('export async function disablePushNotifications'))
  assert.match(del, /\.eq\('user_id', userId\)/)
  assert.match(del, /\.eq\('endpoint', endpoint\)/)
})

console.log(`reminder tests passed: ${passed}`)