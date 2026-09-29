# In-app definition and shared engine cases

These files are the contract between the backend and every SDK engine. The backend owns them. SDK repositories hold copies made by `bundle exec rake in_app_shared:copy`, and must not edit them.

| File | Purpose |
|---|---|
| `definition.schema.json` | JSON Schema, draft-06, for a format 1 campaign definition as the backend sends it |
| `cases.schema.json` | JSON Schema for `cases.json` |
| `cases.json` | Campaigns, event sequences and the outcome every engine must produce |
| `manifest.json` | In SDK copies only: the SHA-256 of each file at copy time |

## Who the schema binds

`definition.schema.json` binds the backend, which writes definitions. It is strict: it refuses any field it does not list.

An engine reads definitions and must be lenient in one way and strict in another.

| An engine | Detail |
|---|---|
| Ignores fields it does not know | At every level. A later backend may add fields. An engine must never validate incoming definitions against the strict schema |
| Refuses a definition it cannot read | See "What an engine must find". The campaign is `unsupported`. The engine never crashes on a definition |

## Reading `cases.json`

A case is written as differences from three bases, to keep the file short.

| Case key | Merged onto |
|---|---|
| each entry of `campaigns` | `base_campaign` |
| `device` | `base_device` |
| `global_caps`, `synced_at`, `not_ready` | `base_case` |

Merge rule: objects merge key by key, recursively. Arrays and scalars, including null, replace the base value.

`off_schema` lists campaign ids that deliberately break `definition.schema.json`. The backend would never send them. They test that an engine protects itself: from a format it does not know, from a definition it cannot read, from an unsafe link, and from fields it has never seen.

`unsupported_templates` and `unsupported_actions` on a device are test inputs. They stand for whatever a given build cannot do and do not describe a real platform.

## Running a case

1. Build one engine from the merged case. It starts in a new session with no views and no event counts.
2. Take the steps in order.

| Step | What the runner does |
|---|---|
| `session_start` | Starts a new session. Session counts reset; everything else is kept |
| `sync` | Applies a sync response. See "Sync steps" |
| `event` with `at` and `expect` | Tracks the event at that time and compares the result with `expect` |

Every shown message is treated as closed before the next step, so the display queue plays no part. Each SDK tests its queue separately. The host app's veto is not part of the cases either: a vetoed campaign gains no view, and no other campaign is shown for that event.

`at` is the corrected time, after the server clock offset is applied. Local time is `at` plus `device.utc_offset_minutes`, so minus 300 is five hours behind UTC. Local time decides days, hours, and day and week caps. An engine uses the device's current offset for every view, old or new; it does not look up past offsets.

### View ids

The engine gives each view it records an id. In the cases the ids are `d1`, `d2` and so on, in the order the views are recorded, so the test runner must supply that id generator. In production the id is the event id of the `in_app_viewed` event.

### Sync steps

A `sync` step holds `at`, which becomes the time of the last successful sync. It changes nothing else: every view the device has recorded is kept.

## Who counts views

The device counts every cap, from the views it has recorded itself. It needs nothing from the server to do so.

The server also remembers views, for one purpose: when a person has reached a campaign's lifetime cap, the sync leaves that campaign out. That keeps a once-only message from showing again after a reinstall or on a second device, for a person who is logged in. The engine does not take part in this; it shows what it is sent.

## What to compare

| `expect` key | Compare |
|---|---|
| `show` | The id of the campaign shown, or null |
| `reasons` | Exactly one reason for every campaign not shown. The whole object must match |
| `view` | The id of the view recorded. Compare only when the key is present |
| `title`, `message` | The text after personalization. Compare only when the key is present |
| `buttons` | Button texts in order, after personalization. Compare only when present |
| `urls` | Every `open_url` link in order, buttons first and then the tap action, after personalization. Compare only when present |
| `delay` | The campaign's `delay_seconds`. Compare only when present |

## Order of checks

An engine applies these in order for each campaign and reports the first that fails.

| Order | Reason | Fails when |
|---|---|---|
| 1 | `stale` | The last successful sync is more than 48 hours before `at` |
| 2 | `unsupported` | The engine cannot read the definition; or `format` is not 1, `delivery_mode` is not `device`; or `variants`, `control_group` or `conversion` is not null; or the device cannot draw the template or perform an action |
| 3 | `no_trigger` | No trigger matches the event |
| 4 | `not_ready` | The campaign's images are not on the device |
| 5 | `schedule` | `at` is before `start_at`, at or after `end_at`, or outside the days or hours |
| 6 | `condition` | Any device condition fails, or the campaign asks for push permission that is already granted |
| 7 | `cap_session` | Views of this campaign in this session have reached the cap |
| 8 | `cap_day` | Views of this campaign on this local calendar day have reached the cap |
| 9 | `cap_week` | Views of this campaign in this local week, Monday to Sunday, have reached the cap |
| 10 | `cap_lifetime` | Views of this campaign on this device have reached the cap |
| 11 | `cap_global_session` | Views of all counted campaigns in this session have reached the global cap |
| 12 | `cap_global_day` | Views of all counted campaigns on this device on this local calendar day have reached the global cap |
| 13 | `personalization` | A field has no value and no fallback |
| 14 | `unsafe_link` | A link has no scheme, a forbidden scheme, or a field in its scheme or host |
| 15 | `lower_priority` | Another passing campaign has a higher priority, or the same priority and an earlier `created_at`, or both the same and a smaller id |

A campaign with `caps.ignore_global` skips checks 11 and 12, and its views are not counted by them.

`created_at` values compare as instants, so `…00Z` is earlier than `…00.500Z`. Ids hold only ASCII letters, digits, `_` and `-`, and compare character by character, so `B` comes before `a`.

## What an engine must find

A campaign is `unsupported` unless all of this holds. Fields not listed here are ignored.

| Part | Must hold |
|---|---|
| Campaign | `format`, `priority` and `delay_seconds` are integers, and `delay_seconds` is 0 or more. `id` and `delivery_mode` are non-empty strings. `created_at` is a timestamp. `template` is one of the nine templates |
| Timestamp | `YYYY-MM-DDTHH:MM:SSZ`, with optional `.` and one to three digits before the `Z`. Always UTC, with an uppercase `T` and `Z`. It must be a real calendar time: the 30th of February, hour 24 and second 60 are refused |
| Integer | A JSON number with no fractional part. 1.0 is the integer 1, because JavaScript cannot tell them apart |
| Object | Where this table says object, list or string, a value of another kind makes the definition unreadable. A filter, condition, trigger, button or action that is not an object is unreadable |
| Content | `title` and `message` are each a string or null. `buttons` is a list. `tap_action` is an action or null. `dismissible`, when present, is a boolean; when it is false there is at least one button or a tap action |
| Button | `id` and `text` are non-empty strings. `action` is an action |
| Action | `type` is one of the six actions. `open_url` has a `url` string. `key_value` has a `payload` object |
| Triggers | A list with at least one entry |
| `app_open` trigger | Has no `name` and no `filters` |
| `screen_view` trigger | Has no `filters`. `name` is optional |
| `event` trigger | Has a `name`. `filters` is optional |
| Filter | Has a `field`. Its `op` and `value` follow "Operator shapes" |
| `platform`, `language` condition | `op` is `eq` or `neq`. `value` is a string |
| `app_version`, `os_version` condition | `op` is `eq`, `neq`, `gt` or `lt` with a string, or `between` with a list of two strings |
| `event_count` condition | Has a `name`. `op` is `eq`, `neq`, `gt` or `lt` with a number, or `between` with a list of two numbers |
| `user_attribute` condition | Has a `key`. Its `op` and `value` follow "Operator shapes" |
| `first_seen` condition | `op` is `before` or `after` with a timestamp, or `within_days` with an integer of at least 1 |
| Caps | `session`, `day`, `week` and `lifetime` are each null or an integer of at least 1. `ignore_global` is true or false |
| Schedule | `start_at` is a timestamp. `end_at` is a timestamp or null. `days` is null or a non-empty list of integers from 1 to 7. `from` and `to` are both null or both `HH:MM` |

### Operator shapes

| Operator | Value |
|---|---|
| `is_set`, `is_not_set` | None needed |
| `between` | A list of exactly two numbers |
| `eq`, `neq`, `gt`, `lt`, `contains`, `not_contains` | One string, number or boolean |

Any other operator, condition type, trigger type or action type is one the engine cannot read.

## What a device reports

| Value | Meaning |
|---|---|
| `platform` | `ios`, `android` or `web` |
| `language` | The primary language only, in lowercase: `en` for `en-US`, `pt` for `pt-BR` |
| `app_version` | The version users see: `CFBundleShortVersionString` on iOS, `versionName` on Android. On the web, the version the site passes when it configures the SDK, or empty |
| `os_version` | The operating system version on iOS and Android. Empty on the web |
| `first_seen_at` | From the sync response. May be null |
| `push_permission` | `granted`, `denied` or `not_asked` |
| Store address | The address of the app's page in its store, from the sync response. A device without one cannot perform `open_store`, and neither can the web |

## Rules the cases pin down

| Rule | Detail |
|---|---|
| Event names | Match exactly, including case |
| Screen names | Match without regard to case. A trigger with no name matches every screen |
| Without regard to case | Both sides are lowercased, then compared character by character. No other folding is applied, so `ß` does not equal `SS` |
| Text form | A string is itself. `true` and `false` are the words. A whole number has no decimal point, so 42.0 is `42`. Any other number is the shortest decimal that reads back as the same number, so 42.50 is `42.5`. No number is ever written with an exponent |
| Text form pitfalls | Default number printing differs by language. Swift and Kotlin print 42.0 as `42.0`. JavaScript prints 1e21 as `1e+21` and 0.0000001 as `1e-7`. Each engine needs its own formatter |
| Lists and objects | As the value of an event property or user attribute, they have no text form. They count as not present, in filters, conditions and fields |
| Present | A value is present when it is not null, not a list or object, and its text form is not empty |
| `is_set` | Passes when the value is present |
| `is_not_set` | Passes only when the value is not present. Every other operator fails on a value that is not present |
| Numbers | A value is a number when it is a JSON number or a string matching `-?digits` with an optional decimal part. Numbers are compared as 64-bit floating point values. Integers beyond 2 to the power 53 and decimals of more than 15 significant digits are outside the contract |
| `eq`, `neq` | Compare as numbers when both sides are numbers, otherwise as text forms without regard to case |
| `gt`, `lt`, `between` | Need numbers on both sides. `between` includes both ends. A range whose first end is greater than its second never matches |
| `contains`, `not_contains` | Text, without regard to case |
| Versions | Everything from the first character that is not a digit or a dot is ignored, so `2.1.0-beta` is `2.1.0` and `17.4-beta.2` is `17.4`. Split the rest on dots and compare part by part as integers. Missing and empty parts count as 0. A version `between` includes both ends. A device version that is empty fails every version condition |
| First seen | `before` and `after` compare two instants. `within_days` passes when `at` minus `first_seen_at` is at most that many times 24 hours. It is a length of time, not a count of calendar days. A device with no `first_seen_at` fails every first seen condition |
| Event counts | Count events of type `event` by name, not screen views. Counting starts when a campaign that names the event reaches the device. The event being tracked is counted before conditions are checked |
| Days | 1 is Monday and 7 is Sunday |
| Hour windows | Include `from`, exclude `to`. A window whose `from` is later than its `to` crosses midnight. A window whose `from` equals its `to` covers the whole day |
| End before start | A campaign whose `end_at` is on or before its `start_at` is never in schedule. The backend refuses to save one |
| Days with a window that crosses midnight | After midnight, the day that counts is the one the window opened on. With days `[5]` and hours 22:00 to 06:00, 02:00 on Saturday is inside and 02:00 on Friday is outside |
| Views | Only the campaign that is shown gains a view |
| Fields | `{{ user.key }}` or `{{ event.key }}`, with an optional `| default: "text"`. Spaces are optional. A present value is inserted in its text form. A value that is not present takes the fallback. A key holds letters, digits and `_`; a fallback is in double quotes. Text that opens `{{` and is not a field in this form, such as a key with a hyphen or a fallback in single quotes, fails `personalization`, so braces are never shown to a user. The backend refuses to save one |
| Where fields work | `title`, `message`, button `text` and `open_url` links. A `key_value` payload is passed to the app as written |
| Links | A field's value, or its fallback, is percent-encoded before it is placed in a link. Letters, digits, `-`, `.`, `_` and `~` are kept. Every other character becomes its UTF-8 bytes, each as `%` and two uppercase hex digits, so a space is `%20` and never `+` |
| Link pitfalls | JavaScript's `encodeURIComponent` leaves `!'()*` alone. Kotlin's `URLEncoder` turns a space into `+`. Swift's `urlQueryAllowed` leaves many characters alone. Each engine needs its own encoder |
| Forbidden schemes | `javascript`, `data`, `file`, `blob`, in any letter case |

## Delay, dismissal and the store

These are the display's work, not the engine's. The cases pin only what the engine reports.

| Rule | Detail |
|---|---|
| Delay | The engine decides at the trigger as for any campaign and reports `delay`. The display waits that many seconds and then decides again for the same event. It shows the campaign only if the same campaign still wins. The view is recorded when the message is shown, not at the trigger |
| One delayed message | A device holds at most one delayed message. A second one replaces it only with a higher priority |
| Delay and other messages | While a message waits out its delay, other events are decided as usual. If one is on screen when the delay ends, the delayed message takes the waiting place under the usual rule |
| Delay ends with the session | A delayed message is dropped when the app goes to the background or the SDK stops |
| `dismissible` false | No close button is drawn whatever `close_button` says. A tap outside the message, a swipe, the Escape key and the accessibility escape gesture do nothing. A button or the tap action closes it. The host app can still close it through the SDK |
| `open_store` | Opens the store address the sync response gave for this platform |
| Nowhere to draw | A message that could not be put on screen gains no view, reports nothing and goes to the host's error callback |
| Tap on the message | The click names no `button_id` |
| `app_open` | Raised once per SDK session on every platform, not once per page load or launch within a session |
| First screen | A screen tracked before in-app has started is remembered: it counts for excluded screens, and is decided once the first sync has answered, after `app_open` |
| Leaving the app | After a tap that opens a link or the store, a waiting message is shown when the person is back, not as they leave |
| Alert | An alert with no button always has Close, because the system alert has no tap action |
| Device state | The user's attributes and the push permission are read again before every decision, not only at a sync |

## Limits the backend enforces

These are not the engine's concern, and the cases do not test them.

| Limit | Detail |
|---|---|
| Size | A definition is at most 16 KB |
| Button ids | Unique within a campaign |
| Patterns | The backend must check that no string holds a line break before it applies the schema. Ruby's pattern matching treats `^` and `$` as the start and end of a line, so a value with a second line could pass a pattern meant for the whole string |
