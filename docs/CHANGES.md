# Interface changes and additions (append-only)

## src/core/data.js, src/core/world.js
All additions are backwards compatible with CONTRACT §3.

**DataStore additions**
- `periodLifeExpectancy(iso3, year, sex, multFn?, fromAge = 0)`, `cohortLifeExpectancy(iso3, birthYear, sex, multFn?, fromAge = 0)`
  (cohort follows year = birthYear + age, rates beyond 2100 held at 2100; with `fromAge` it returns the remaining years),
  `cohortSurvival(iso3, birthYear, sex, fromAge = 0, multFn?)` -> array indexed by **exact age 0..115** (length 116),
  `out[a]` = P(alive at age a | alive at fromAge), 1 for a <= fromAge.
- `multFn(year, age)` returns a multiplier on the **hazard mx** (not on q), so q stays below 1.
- Extra fields: `meta` (countries.json meta, for the About page), `mortalityMeta`, `regionName(iso3)`.
  Named exports `decodeBase64(str)` and `decodeUint16LE(bytes)` are available too.
- `mx()`/`qx()` for an ISO3 with no life table fall back to a births-weighted world reference schedule, so they never
  return NaN. `country()` returns undefined and `series()` returns null for unknown codes.
- `lifePath(iso3)` also includes `incomeGroup` (2025), `researched` (true when research/life_paths has the country) and
  `currency` (resolved through `currency()`). Built-in defaults include region-based `common_destinations`.
  The object is cached and shared, so treat it as read-only.
- `currency(iso3)` checks the researched life path first, then a built-in table of about 150 currencies, then
  `{code:'', name:'本地货币', symbol:''}`.

**World additions**
- `code` (archival world-line number such as "ZNN-2SU", also shown in `label`), `assumptions`
  (content.future.baseline_assumptions), `incomeGroup(iso3, year)` (uses scenario GDP),
  `cohortLifeExpectancy(iso3, birthYear, sex, fromAge?)`, `cohortSurvival(iso3, birthYear, sex, fromAge?)`,
  `timeline()` (all resolved future items, sorted), `toJSON()` -> `{seed, branches}`.
- `modifiers()` also returns `life_exp_add`, the phased life-expectancy gain in years.
- WorldEvent extra fields: `date` (history start string), `basis` (projection rationale), `refId` (the source
  milestone or shock id; generic conflicts use `'regional_conflict'`), and `prob` on milestones.

**Modelling choices (deviations from the task brief)**
- `heat_risk` and `sea_level_risk` phase in linearly from 2027 to 2090, because climate change accumulates, instead of
  reaching full strength by 2031. `retirement_age_add` phases in to 2060, as SCHEMAS defines it ("years by 2060").
  Every other knob ramps in over 2027–2031; `mortality_mult` ramps geometrically. `sea_level_risk` is 0 for
  landlocked countries.
- `conflict_risk_add` is treated as an annual probability per game region of a generic shock titled
  "局部武装冲突（region）". It affects one country, chosen by sqrt(population) × an income weight. Its mortality
  multiplier (up to 1.25) is diluted in countries above 20 million people. Two picked countries are never named
  together, so the text cannot imply a war between them.
- Localised content shocks: a war, conflict or disaster shock with scope 'countries' and more than 3 listed countries
  picks 1–2 of them (wars pick 1). A war or conflict shock with scope 'regions' picks one region and one country in
  it. The title then gets a suffix naming the place. Optional shock fields are honoured: `pick` (number of countries),
  `year_range`, `max_occurrences`. The same shock never overlaps itself.
- Scenario effects in `indicator()` after 2026:
  - `gdp_pc_ppp` and `health_exp_pc` are multiplied by the compounded `gdp_growth_add`.
  - `gdp_growth` gets the added growth.
  - `unemployment` gets +add and `youth_unemp` gets +2×add.
  - `gini` gets +100×`inequality_add`.
  - `internet` is capped at `internet_ceiling`.
  - `poverty` is recomputed with a lognormal model that keeps the baseline's implied poverty line.
  - `le`, `le_m` and `le_f` get + `life_exp_add` − ln(`mortality_mult`)/0.09.
  - `imr`, `q5` and `maternal_mort` are multiplied by the scenario mortality factor.
  - `sec_enroll` gets +3× and `ter_enroll` gets +6× `education_years_add`.


## src/social/store.js, src/social/saves.js, social screens (memorial, shared, past, lifeDetail)
All additions are backwards compatible with CONTRACT §2 / §8.

**Return shapes (the contract left them open)**
- Write calls never throw. `shareLife`, `lightCandle`, `addMessage`, `deleteMessage`, `deleteShared`, `sendFeedback`
  resolve `{ok: true, ...}` or `{ok: false, error, message}`. `error` is one of
  `readonly | quota | busy | network | degraded | invalid | empty | notfound`, and `message` is Chinese text ready for a
  toast. Extra fields: `shareLife` -> `{ok, lifeId, local?}`, `lightCandle` -> `{ok, already?, count?}`,
  `addMessage` -> `{ok, message:{id,text,at,mine}}`, `sendFeedback` -> `{ok, mode:'local'|'shared', local?}`.
- Read calls never throw. `listShared` and `listMessages` resolve arrays, `candleCount` resolves a number, `'1000+'`
  or null, and `getShared` resolves a life or null.
- `initSocial(opts?)` resolves `{mode}`. It runs once and is memoised. Its optional `opts.data` (a DataStore) is used to
  resolve country names and regions. Screens also call `setDataSource(app.data)`.
- `listShared({limit, region, country, era})` also accepts the contract form `{limit, filter:{region,country,era}}`.
  `era` is an `ERAS` id such as `'2030s'`, or `{from, to}`.

**shareLife(input)** accepts a past-life record from `saves.addPastLife`, a LifeState, or an already shaped record.
It writes `lives/<lifeId>` = `{v, lifeId, createdAt, authorId, name, sex, country, countryName, region, birthYear,
deathYear, age, cause, stats, lifemap, highlights<=6x60, epitaph<=30, bio<=1200, worldLabel, mode, candles}`.
- `lifemap` has one character per year: b c s w l f x i k z m u q r d = birth childhood study work love family loss
  illness crisis war migration success calm retire death, and `.` = unknown. Use `encodeLifemap(history)` and
  `decodeLifemap(str)` to convert.
- `candles` is a cached count for sorting. It is recounted from `lives/<id>/candles` after each candle.
- Re-sharing the same life keeps its date and its candle count.
- Rows that screens receive are sanitized. `authorId` is replaced by a boolean `mine` and is never shown.

**Extra store exports:** `setDataSource`, `socialStatus()` -> `{mode, ready, canWrite, owner, readOnly, degraded}`,
`onSocialStatus(fn)`, `subscribeShared(cb)` (one ref-counted live query for all callers; `cb(lives, meta)`),
`subscribeCandles(lifeId, cb)`, `subscribeMessages(lifeId, cb)`, `getShared`, `hasLitCandle`, `deleteShared`,
`deleteMessage`, `listFeedback`, `filterLives`, `buildShareRecord`, `sanitizeLife`, `encodeLifemap`,
`decodeLifemap`, `cleanLine`, `cleanText`, `ERAS`, `SHARE_LIMITS`, `SOCIAL_MESSAGES`.
- Bus events: `social:status`, `social:lives` (local mode), `social:candles`, `social:messages`.
- localStorage keys: `ll2090.social.{lives,candles,messages,feedback,anon,filters,memorialSort}`.

**saves.js**
- `addPastLife(state, extras?)` replaces the contract's `addPastLife(record)`. An already built record is still
  accepted. `extras` = `{epitaph, title, bio, highlights, biography:{title,epitaph,bio,highlights}, countryName, data,
  savedAt, sharedId}`.
- Saving the same `state.id` again replaces the record, so the death screen can call
  `addPastLife(state, {epitaph, bio, ...})` after app.js has already archived the bare state. It can also call
  `updatePastLife(id, {epitaph, title, bio, highlights, sharedId})`.
- Record = `{v, id, savedAt, name, sex, mode, country, countryName, place, birthYear, deathYear, age, alive, cause,
  causeDetail, deathSummary, lifeExpAtBirth, percentile, epitaph, title, bio, highlights, history, decisions, stats,
  worldLabel, sharedId, state}`.
  - `state` drops `pending`. Its log is trimmed to about 200k characters per record.
  - When there is no data store, `countryName` falls back to the ISO3 code. The screens resolve it for display.
- Extra exports: `getPastLife(id)`, `updatePastLife(id, patch)`, `fitState(state, maxChars)`, `sanitizeRecord(raw)`,
  `SAVE_LIMITS`, `EXPORT_FORMAT`, `EXPORT_VERSION`.
- `importLives` resolves `{added, skipped, error?}`. It accepts the export object, a bare array, or a single record.

**Screens**
- `shared` and `memorial` open a life's detail in place, and accept `params.lifeId` (or `params.id`) to open one
  directly. Example: `app.go('shared', {lifeId})` after sharing.
- `past` accepts `params.id` to open one record.
- `lifeDetail.js` also exports `mount(root, {lifeId, from})`, which is usable as an extra route. It also exports UI
  helpers (`lifeStrip`, `candleIcon`, `lifeCard`, `statBars`, `ask`, `archiveNo`, `relTime`, `liveBanner`).


## src/ai/claude.js, src/ai/prompts.js, src/ai/validate.js, src/ai/director.js
All additions are backwards compatible with CONTRACT §2 / §5.

**director.js uses a factory with injected dependencies (the chosen form)**
`createDirector({data, world?, ai?, decisions?, engine?})`. `ai` defaults to `./claude.js`. `decisions` is the
`core/decisions.js` namespace (`buildDecisionOffline`, `resolveOffline`, `nextDecisionAge`). `engine` is the
`core/engine.js` namespace (only `countryContext` is used). Without `decisions` the director still works, using
generic stage-based decisions and outcomes, and without `engine` it uses `prompts.basicContext`. One instance can
serve many lives: per-life caches reset when `state.id` changes. Methods:
- `getDecision(state, ctx?, {decision?})` -> `{decision, upgrade: Promise<Decision|null>}`. `decision` is ready at
  once: `opts.decision` (the engine's `state.pending`), then a valid `state.pending`, then `buildDecisionOffline`.
  `upgrade` resolves to the AI version, which keeps the offline decision's `id/year/age/kind/context`, or to null.
  The upgrade never rejects.
- `prefetch(state)` -> boolean. Call it after each `stepYear`. When next year's age is a decision age for
  `settings.decisionFreq`, it asks for that milestone decision in the background (`fast:false`). `getDecision`
  reuses the answer when the year, the age and the life's key facts (country, relationship, career, children,
  conditions) still match. Otherwise it asks again. A triggered decision never uses the prefetch.
- `resolveChoice(state, decision, choice, {onText, signal} | onText)` -> `{resolution, source:'ai'|'local',
  streamText?, error?}`. `choice` may also be a bare option id or custom text. Calls use `cache:false`.
- `customAction(state, text, onText?, {signal}?)` -> `{resolution, source, streamText?, decision, choice, error?}`.
  `decision` is a synthetic `{kind:'custom', title:'主动选择', options:[]}` and `choice` is `{customText}`, ready
  for `engine.applyResolution` and `state.decisions`. Empty text returns a calm no-op outcome.
- `birthStory(state, {signal}?)` -> `{text, tagline, source}`. The caller stores `text` in
  `state.aiNotes.birthStory`, and later prompts include it.
- `biography(state, onText?, {signal}?)` -> `{title, bio, epitaph, highlights[], source}`.
- `parseCustomBirth(text, {signal, aiMode}?)` -> partial BirthSpec (with `mode:'custom'`, `customText`) or null.
  `parseCustomBirthDetailed` returns `{spec, source}` instead.
- `setWorld(world)`, `getWorld()`, `resetLife()`, `status()` (the `aiStatus()` passthrough), `usable(state)`.
- Streaming: `onText({text, delta})` only ever receives the visible narrative, which is the text before
  `===JSON===`. Partial marker and JSON text never reach the screen.
- Module-level exports for screens without an instance: `parseCustomBirth(text, data, opts?)` and
  `parseCustomBirthDetailed(text, data, opts?)`. Offline helpers are exported too: `genericDecision`,
  `genericResolution`, `offlineBirthParse(text, data)` (a conservative Chinese parser of the free "特殊出身"
  text), `templateBirthStory(state, data, world, ctx)` and `templateBiography(state, data)`.
- Model tier: a life's `settings.aiMode` picks the tier, and `'off'` never calls. The custom-birth parse uses
  `quick` (or `default` when the mode is `complex`), and the birth story caps at `default`. claude.js's global
  tier (`setTier`) is only a master switch: `'off'` there blocks every call. The shell does not have to call it.

**claude.js**
- Exports `initAI({waitMs=10000}?)`, `aiStatus()`, `isUsable()`, `setTier(mode)`, `getTier()`,
  `aiJSON(prompt, opts)`, `aiStream(prompt, opts)`, `aiCall(kind, prompt, opts)` (the contract form;
  `{json:true}` uses `sample.json`, otherwise it streams and splits the narrative from the trailing JSON),
  `setSampleForTests(fn|null|undefined)` and `AI_TIERS`.
- `opts` = `{tier, signal, onText, cache, kind, background}`. `kind` labels the call counter. `background:true`
  sends `fast:false` and is skipped after a `rate_limited` until the next successful call.
- `initAI` waits up to about 10 s for `window.claude.use('sample')`. A capability that arrives later still turns AI
  on, and the shell is told on the bus.
- `aiStatus()` -> `{available, usable, mode, pending, disabled, reason, code, message, rateLimited,
  calls:{calls, ok, failed, skipped, byKind, byCode}}`.
- Bus: `ai:status` and `ai:changed`, each with `{code, message (zh), permanent, available, usable, mode}`.
  - `not_granted`, `sampling_disabled`, `not_declared` and `capability_*` switch AI off for the session and are
    announced once.
  - `rate_limited` and `session_expired` are announced once and keep AI on.
  - Other codes fail only that call.
- Rejections are always plain `{code, message, text?}` objects. Two extra local codes exist that never come from
  the platform: `off` (the tier is off) and `unavailable` (no capability).

**validate.js**
- `validateResolution(raw, state, data)` takes a third `data` argument, which it needs to check ISO3 codes and to
  compute the wealth cap.
- `wealthDelta` is capped at ±5 × max(annual income, 1,500, 0.4 × GDP per head), and never beyond ±2,000,000
  intl $.
- A thread `trigger` is always normalised to an absolute `{year}` 1–30 years ahead, whatever the model sent
  (`afterYears`, `year` or `age`). A thread gets `conditions:{alive:true, country?}`, at most 3 per resolution, and
  only 1 when the life already has 10 or more pending threads.
- `set.education`, `set.career` and `set.relationship` are partial patches to merge into `person.*`.
  - Education may only rise, by at most 2 levels.
  - `incomePct` may move by at most 0.35.
  - Married or partnered requires the life path's legal marriage age.
  - `relationship.partner` becomes `{name, sinceYear}`, or `null` when single, divorced or widowed.
  - `addCondition` gets `sinceYear`.
  - `set.country` is dropped when `feasible` is false.
- Extra exports: `validateBirthStory`, `validateEffects`, `validateSet`, `validateThreads`, `validateHazard`,
  `validateFlags`, `cleanText` (strips markup, control and bidi characters), `parseLooseJSON`,
  `splitNarrativeJSON`, `visibleNarrative`, `wealthCap`, `hasIso`, `resolveIso`, `JSON_MARKER` ('===JSON==='),
  `LIMITS`.

**prompts.js**
- Signatures:
  - `summarizeLife(state, data, world, ctx)`
  - `buildDecisionPrompt(state, data, world, ctx, {seed?: Decision, kind?, year?, age?})`
  - `buildResolutionPrompt(state, data, world, ctx, decision, choice)`
  - `buildCustomActionPrompt(state, data, world, ctx, text)`
  - `buildBirthStoryPrompt(state, data, world, ctx)` (ctx is replaced by a birth-year context when it is for
    another year)
  - `buildCustomBirthPrompt(text, data)`
  - `buildBiographyPrompt(state, data, world)`
- Extra exports: `basicContext(data, world, iso3, year)` (a Context built from the data store and world when
  engine.countryContext is missing), `historyEvents`, `localMoney`, `countryName`, `quotePlayerText`,
  `SUMMARY_BUDGET`.
- Projected events coming up on the world line are listed only from 2015 on (12 years before the projection
  starts). The world-line label and branches are always given.


## src/ui/charts.js, src/ui/lifemap.js, src/ui/cards.js, src/ui/screens/about.js, src/ui/charts.css
All additions are backwards compatible with CONTRACT §2 / §8.

**charts.js** (every chart returns an `<svg class="c-chart ...">`, width 100%, re-laid out at the container's
pixel width with a ResizeObserver)
- `sparkline(values, {width, height, color, min, max, label?, unit?, dashedFrom?, ref?, area?})`. `dashedFrom` is an
  index; `ref` draws a faint reference line (for example 50 for stats).
- `lineChart(series, {years, height, yMin, yMax, projectionFrom, unit?, format?(v, seriesIndex), xFormat?(year),
  title?, legend?, endLabels?, zero?, width?})`. A series may set `area` (default: only the first series gets an area
  fill). `dashedFrom` is a year (>= 1000) or an index; without it, a series is dashed from `projectionFrom`.
- `survivalChart(curve, {currentAge, highlightAges, height?, labels?: {personal, baseline}, color?, title?})` accepts
  probabilities as 0..1 or 0..100.
- Line and survival charts take focus (tabindex 0) and show a crosshair tooltip on pointer, touch and arrow keys.
- Extra exports: `textWidth(str, size, mono)`, `formatValue(v, unit)`.

**lifemap.js**
- `lifeMap(history, {birthYear, expectedYears, projectionFrom = 2027, onSelect(row), decisions?, data?,
  countryName?(iso3), selected?: year, legend = true, detail = true, compact = false, dead?})`.
  `decisions` marks the years with a choice. `dead` defaults to "the last row's tag is 'death'".
- The returned element has `.update(history, patchOpts?)` (re-render in place, keeps the selection) and
  `.select(year)`.

**cards.js**
- `saveBlob(blob, filename)` never throws and resolves `{ok, status, code?, message}`. `status` is `'saved'`,
  `'downloaded'` (local `<a download>` fallback), `'declined'` or `'error'`. `code` is one of the downloads error codes
  (`declined`, `rate_limited`, `too_large`, `rejected_extension`, `extension_not_enabled`, `bad_request`,
  `unavailable`), and `message` is Chinese text ready for a toast. Callers that test `r === false` never see false;
  test `r.ok` instead.
- The `<a download>` fallback is used only when `window.claude` is absent (local run). Inside the host, a missing
  `downloads` capability returns `{ok:false, code:'unavailable'}`.
- Extra exports: `cardFileName(state, 'birth'|'death')`, `archiveNumber(state)` (`LL-<year>-<ISO3>-<6 hex>`, stable
  per life), `CARD_WIDTH`, `CARD_HEIGHT`, `CARD_FOOTER`, `CARD_PALETTE`.

**screens/about.js**
- `mount(root, params, app)` accepts optional `params.section` (`what|real|proj|fiction|method|sources|library|
  disclaimer|origin`, scrolls to it) and `params.country`, `params.year`, `params.q` (preset the history library).


## src/ui/app.js, src/main.js, src/ui/styles.css, screens home / birth / settings / feedback
All additions are backwards compatible with CONTRACT §8.

**App object (extra members beyond the contract)**
- `controller` (the live GameController or null), `world` (the World of the life being played; the controller's
  `worldFor` reuses it when the seed matches), `lastLife` (the last finished life), `screen` (current screen name),
  `canGoBack()`, `destroy()`.
- `toast(text, kind = 'info', {duration}?)`: kind is `info | good | warn | bad`. Returns a dismiss function.
- `confirm({title, body, ok, cancel, danger?})` -> Promise<boolean>. `body` is a string (newlines become paragraphs),
  a node or an array. `modal({title, body, actions, onDismiss, initialFocus, wide, eyebrow})` -> close() is the
  generic in-page dialog (focus trap, Escape, the shell is made inert behind it).
- `prepareLife(birthSpec, {world?, worldSeed?, seed?})` -> `{state, world}` builds a LifeState with engine.newLife
  without starting it (the birth card uses it to show the archive number and the same-second cohort).
  `startLife(birthSpec, {state?, world?, worldSeed?, seed?})` starts that prepared state when given.
  `abandonLife()` stops the controller and clears the autosave. `lifeSettings()` returns the four life settings.
- `archiveNo(stateOrBirthSpec)` delegates to `cards.archiveNumber`, so screens and PNG cards show the same number
  (`LL-<year>-<ISO3>-<6 hex>`, not the 7-digit example in the brief).
- `isProjection(year)`, `setAI(result)`, `setSocial(result)`, and `ui` helpers shared by screens:
  `ui.yearBadge(year, {short})` (真实历史 / 推演 badge), `ui.yearRuler({from, to, range, span, marker, ticks, label,
  size})` (the strict year grid; `.setRange/.setSpan/.setMarker`), `ui.boxGroup({...})` (paper-form radio group,
  `.setValue/.getValue`), `ui.switchField({...})`.
- `settings` also holds `theme: 'system'|'light'|'dark'` (sets `data-theme` on `<html>`) and
  `lastWorld: {seed, label}|null` (for 沿用上一条世界线). `saveSettings(patch)` merges life settings into the live
  life (`state.settings` and `controller.applySettings`) and calls claude.js `setTier(aiMode)` as the master switch.
- The game screen owns the controller's clock (attach/start on mount, detach on cleanup); app.js never calls
  start/pause/resume on navigation. On the controller's `death` event app.js archives the life with
  `saves.addPastLife(state, {data})` and clears the autosave; `endLife(state)` then opens the death screen.
- `go(name, params, {replace?, reset?})`. Bare anchors `#home #birth #custom #game #death #memorial #shared #past
  #about #settings #feedback` deep-link; `#custom` (or `go('custom')`) opens the custom birth form. `#game` resumes
  the autosaved life when there is one.
- Bus events emitted: `screen` (name), `settings` (copy), `ai:status` (from setAI), `social:status`. app.js listens
  to `ai:changed` to keep `app.ai.available` current and shows one toast when AI switches off for the session.

**Hot reload (main.js)**: the snapshot registered with `window.claude.hot.snapshot()` is
`{screen, params (plain values only), life}`. Boot accepts a snapshot handed to the `hot.ready(cb)` callback, returned
by `hot.ready()` (value or promise) or left on `hot.data`, and waits for it at most 1.5 s, in parallel with the data
download. A snapshot life that is dead reopens the death screen; a living one is re-adopted.

**Screens**
- `birth` params: `{mode: 'random'|'custom', yearMode: '2000'|'history'|'now'|'future'|'any', prefill?: {...form}}`.
  The custom free text goes through `director.parseCustomBirthDetailed(text, data, {aiMode})`; fields it fills are
  tagged "AI" (or "解析" when the director fell back to its offline parser), the player can override them, and the
  text is always kept as `customText` + `notes`. A parsed exact date/time is passed to `customBirth` while the form's
  year still matches it.
- `settings` params: `{focus: 'ai'}` scrolls to the AI section. "清除本机数据" removes every `ll2090.*` key.
- `feedback` params: `{from}` (page name sent with the feedback). Text is limited to 980 characters so the
  "[类别] " prefix fits the store's 1000-character limit.
- localStorage keys used by these screens: `ll2090.era`, `ll2090.customDraft`, `ll2090.feedbackDraft`,
  `ll2090.feedbackOutbox` (only when the store could not keep the feedback).


## src/ui/controller.js, screens game / decision / death, src/ui/game.css
All additions are backwards compatible with CONTRACT §8.

**GameController**
- `new GameController(app, state, deps?)`. `deps` is optional and only for tests or special hosts:
  `{engine, director (an instance), saves, decisions, openDecision, world, deathDelayMs}`. Without it the controller
  uses the real modules, `worldFor(app, state)` (reuses `app.world` when the seed matches, else
  `createWorld(data, state.worldSeed)`), and `app.director` or one shared `createDirector({data, world, decisions,
  engine})` per DataStore, switched to the life's world with `setWorld`.
- Contract methods: `start()`, `pause(reason = 'user')`, `resume(reason = 'user')`, `setSpeed(x)` (snapped to
  0.5/1/2/4/8 and remembered in `ll2090.speed`), `skipToDecision()` -> boolean, `customAction(text, hooks?)` ->
  Promise<`{decision, choice, resolution, entries, custom, source}` | null>, `on(evt, fn)` -> unsubscribe.
- Extra methods: `toggle()`, `faster()`, `slower()`, `setAutoChoose(on)` (also `app.saveSettings({autoChoose})`),
  `applySettings(patch)`, `openCustomAction()` (the 主动选择 dialog), `autoChoice(decision)` (deterministic per life
  and decision; `decisions.autoChoose`, else a risk-weighted pick), `attach()` / `detach()` (the game screen
  mounts / unmounts; detach stops the clock and closes the overlay, a pending decision re-opens on attach),
  `destroy()` (alias `stop()`), `snapshot()`, `isRunning()`, `canAct()`, getters `paused` and `autoChoose`.
  `GameController.current` is the live instance; constructing a new one destroys the previous one.
- Pause reasons are independent: `user`, `hidden` (visibilitychange), `away` (game screen not mounted), `death`,
  `error` (stepYear threw; a toast says so and the play button resumes).
- Events beyond the contract: `state` (control snapshot for the control bar), `skip` (boolean), `log` (LogEntry[]
  added outside a year step). `resolved` carries `{decision, choice, resolution, entries, custom, source}`;
  `ai` carries the status text ('' = idle).
- Seconds per year = `lifeMinutes * 60 / lifeExpAtBirth` (world.lifeExpectancy of the birth country/year/sex,
  else WPP le_m/le_f, else 72), minimum 0.4 s, divided by the speed. Autosave and `director.prefetch` run after
  every real-time year; a fast-forward saves every 5 years and when it stops.
- Decision flow: `director.getDecision(state, undefined, {decision: state.pending})` -> the overlay opens at once
  with the offline decision and swaps the options in place when `upgrade` resolves first. After
  `engine.applyResolution` the answered decision is cleared from `state.pending` if the engine left it there (a new
  pending decision raised by the resolution is kept and asked next).
- The controller asks `director.birthStory(state)` once per new life when AI is usable. Only an AI story is used: it
  is stored in `state.aiNotes.birthStory` and pushed to `state.log` as `{kind:'birth', source:'ai', tags:['story']}`
  for the birth year (event `log`).
- Death: on `state.dead` the controller saves, emits `death`, starts the biography, and calls `app.endLife(state)`
  after a 2.8 s curtain (0.9 s with reduced motion), always asynchronously. If the game screen is not mounted, it
  finishes on the next attach.
- Named exports shared by the screens: `SPEEDS`, `normSpeed`, `countryName(data, iso3)`, `archiveNumber(state)`
  (same format as `cards.archiveNumber`), `worldFor(app, state)`, `directorFor(app, world)`,
  `lifeExpAtBirth(app, state, world)`, `streamField(text, field)`, `makeStreamAccumulator()`,
  `biographyFor(app, state, world?, director?)` -> one job per life `{promise -> {biography, epitaph, title,
  highlights, source}, text, done, result, subscribe(fn) -> unsubscribe}`, with a templated offline fallback.

**decision.js**
- `openDecision(app, decision, opts)` -> `close()`. `opts` = `{onChoose(choice, shownDecision, {onText}) ->
  Promise<{resolution, source}>, onAuto(decision) -> choice, onContinue(), onCancel(), onUpgrade(decision), state,
  data, world, custom, auto, speed, autoDelay}`. `close` also has `setAuto(bool)`, `setSpeed(x)` and `isOpen()`.
  The overlay is appended to `document.body`; `#app` is made inert while it is open and `<html>` gets `g-lock`.
- Custom mode (`opts.custom` or a decision without options) is the 主动选择 dialog: free text, suggestions, 算了.
- Auto choose counts down visibly (about 3.2 s at 1×, never under 1.2 s), highlights the pick, then shows the result
  and continues after a few seconds unless the player stops it. Countdowns never complete while the tab is hidden.
- Keys: A–D or 1–4 pick an option, Ctrl/Cmd+Enter submits the text, Escape continues (result), cancels (custom) or
  stops the auto countdown.
- Extra exports used by game/death: `money(data, iso3, amount)` (economy.formatMoney with a 国际元 fallback),
  `signedMoney`, `effectChips(effects, {data, iso3, min})`, `describeSet(set, data)`, `threadWhen(thread, state)`.

**game.js / death.js**
- `game` params: `{controller, state}` (both optional; it falls back to `app.controller` and `app.getLife()`).
- `death` params: `{state}` or `{record}` (a past-life record with `.state`); falls back to `app.getLife()`. It reuses
  the record's saved bio/epitaph, otherwise writes them with `saves.updatePastLife(id, {epitaph, bio, title,
  highlights})` once the biography is done, and `updatePastLife(id, {sharedId})` after sharing. 沿用这条世界线 goes to
  `app.go('birth', {mode: 'custom', prefill: {keepWorld: true}})` after `saveSettings({lastWorld})`.
- localStorage keys: `ll2090.speed`, `ll2090.gameTabs` (selected tabs), `ll2090.gameHint` (first-run hint
  dismissed), `ll2090.sharedLives` (life id -> shared id).

**game.css** uses the §8 tokens plus styles.css's `--overlay` scrim (with a literal fallback) for the dialog and
the death curtain. Layout: three columns from 1181 px (side columns sticky with their own scroll), two columns from
861 px, one column with a tab bar below that. The control bar is sticky at the bottom with the safe-area inset.


## src/core/events.js, src/core/decisions.js
All additions are backwards compatible with CONTRACT §2 / §3 / §7.

**events.js**
- `EVENT_LIBRARY` has 524 templates. Each template has the §7 fields (`id, when, weight, text, tone, tags, effects,
  set?, hazard?, once, cooldown`) plus `tag` (life-map tag), `cond(facts)`, `textFn(facts)` (used instead of `text`
  when the wording depends on the life; then `text` is null), `wealthMonths`, `world`, `soft`, `groups`, `prep`, `dyn`.
  `when(state, ctx, data, world)` returns `false`, `true` or a positive weight.
- `pickPersonalEvents(data, world, state, ctx, rng)` **writes** `state.person.flags['ev:'+id] = year` itself for every
  event it returns (and the bookkeeping flags `hook:<eventId>` / `kidwed:<name>`), so once/cooldown hold even if the
  engine ignores `set.flags`. It never throws and returns `[]` for a dead or malformed state.
- EventInstance: `effects.wealthDelta` (intl $) is present only when non-zero and never for ages < 16. `tags` may
  contain the free tag `'world'` for reactions to world events. `set` is a partial patch (merge it): e.g.
  `{career:{incomePct}}`, `{relationship:{status:'dating', partner:{name, sinceYear}}}`, `{flags:{...}}`,
  `{addCondition:{id,name,severity}}`, `{removeCondition:'cancer'}`, `{country, urban}`.
- Condition ids used: hypertension, diabetes, cancer, stroke, arthritis, dementia, depression, long_covid, asthma.
- Extra exports: `fillText(template, state, ctx, rng, extraVars?, facts?)` (vars {name} {partner} {child} {sibling}
  {oldsib} {country} {city} {bigcity} {year} {age} {birthyear} {festival} {homefood} {crop} {sport} {lang} {storm}
  {exam} {origin} {granny} {grandpa} {inflation} {youthUnemp} {unemp}; unknown vars fall back, braces never leak),
  `lifeFacts(data, world, state, ctx)` (flat per-year view of a life, shared with decisions.js), `personName`,
  `conscriptionFor(lifePath, iso3, year, sex)`, `keyExams(lifePath, iso3)` (exam names with parentheses stripped),
  `CITIES` (Chinese city names for ~80 countries), `GULF`, `eventTemplate(id)`.
- "War at home" (`facts.war`) means this country is the first-listed party of an armed event with safety ≤ -2, or
  `ctx.conflict >= 3` with a serious armed event (or `>= 2` with a region-wide one). Other listed countries are
  `warNear` (mobilisation, refugees). Chronic world-line risks (heat_risk, sea_level_risk, AI branch) become
  occasional bad years via a deterministic hash of (country, year, world seed), not a permanent state.

**decisions.js**
- `nextDecisionAge(state, frequency)` returns the next milestone age **strictly greater** than `state.age`
  (999 when none is left); `frequency` falls back to `state.settings.decisionFreq`. 'frequent' = a deterministic
  2-3 year rhythm from age 5 seeded by the life.
- `classifyIntent(text, data)` (the contract has `classifyIntent(text)`; `data` is optional and enables destination
  detection) returns `{intents, targetCountry, targetCity, keywords, negated}`. 72 intents; negation such as
  「不想结婚」 maps to the opposite intent.
- New export `triggeredDecision(data, world, state, ctx, rng)` -> Decision|null (kind 'triggered'). It returns null on
  milestone ages, when a decision was recorded in the last year, or too soon after the previous trigger; when it
  returns a decision it writes `state.person.flags['trig:last']` and `['trig:<kind>']`.
- Decisions carry `context: {key, acts:{a:{act,p}}, auto:{a:weight}, vars?}`. Keep it when storing/prefetching;
  `resolveOffline` uses it, and falls back to classifying the option text when it is missing (AI decisions).
  Decision ids are `d-<templateKey>-<year>-<age>-<hash>`; the template key is read back from `state.decisions[].id`
  to avoid repeating a dilemma within 4 years.
- Threads use an absolute trigger `{year}` and `conditions: {alive:true, country?}` (country = must still live
  there). Thread `decision` objects are full Decisions (with `context`) built for the future year; thread `set` may
  include `education.level`, `career.*`, `relationship`, `country`, `flags`.
- Hints for the engine's family model (flags, not births): `flags.wantChild` (year or false), `flags.childfree`,
  `flags.noMoreKids`, `flags.childLater`. Adoption threads also put `set.addChild = {name, sex, birthYear, adopted:true}`
  in the thread's `set` (extension; ignore it if the engine does not support adding children).
- Other flags written by resolutions: migrant (ISO3), origin, migrantSince, citizen, settled, returnee, displaced,
  served, veteran, deferred, altService, homeowner, mortgage, business, investor, crypto, landlord, smoker/exSmoker,
  track, field, droppedOut, examFail, declined:<topic>, city (Chinese city name or null).
- Resolution `effects.wealthDelta` is capped at ±60 months of the person's income; `effects` are integers in -15..15;
  hazard is clamped to mult 0.5..2 and 1..30 years. `feasible:false` comes with a short Chinese `note`.
- Extra exports: `ACTION_KEYS`, `INTENT_IDS`.

## Review round (2026-10-24 evening)
- world.js: longevity knobs are centred on the probability-weighted mean across branches, so the average world line equals
  WPP medium. Regional disaster/epidemic shocks hit 2-3 countries of a region, not the whole region. headlines() prefers
  this year's events, the player's own country, and category variety. New export eventMortality(ev, iso3).
- death.js: R_VALS age normalisation measured by probe (tests/_calib_probe.mjs) plus IG_NORM per income group.
- events.js picker: world-linked templates have a minimum 5-year cooldown, at most one per year, and fire less often in
  projected years. events.js keyExams(lp, iso, year?) is era-aware; engine passes the year.
- engine.js: news entries weigh only 30% when choosing a year's life-map tag. countryContext.conflict 3 = nationwide war.
  New state fields person.pastPartners, flags.retiredYear/retiredFrom, career.since, relationship.partner.surname.
- economy.js: debt repayments may take up to 20% of income; debt cap = max(2 x median income, 3 x income) + 70% property.
- decisions.js: triggered decision gaps raised (disaster 8y/p0.12, longevity 12y, automation 8y/p0.18); k_generic weight 0.15.
- AI (validate/prompts/claude/director): engine-managed flags cannot be set by the model; 'widowed' is engine-only;
  player text is neutralised and quoted in every prompt; prompts over 256 KiB are refused locally; streamed text is cleaned.
- store.js: one in-flight write per document (single()), 20 s feedback cooldown, future-dated rows ignored for ordering,
  player-written custom choices are shared only as "（自己写下的选择）".
- app.js: resumeLife merges current global life settings into the resumed state; decision overlay listens on document.
- Known limitation: with default db rules any Contributor-level viewer can technically overwrite or delete shared rows
  (page-side checks only). Fine for a private artifact; real enforcement would need author subtrees.
- tools/serve.py: local server with explicit UTF-8 charsets (Windows browsers otherwise decode as GBK).

## v2 interactivity: app.js, screens family / money / death / home / settings, panels.css (CONTRACT §10)
All additions are backwards compatible with CONTRACT §8.

**App object**
- `openPanel(name, params?)` with `name` `'family'` (家人与生活) or `'money'` (花钱·投资) returns `close()` (not a promise),
  or null when there is no life. It opens one modal sheet with a tab for each panel: a side sheet from 641 px, a bottom
  sheet below that. The sheet traps focus, closes on Escape, the scrim or ×, and makes the shell inert. While it is
  open it pauses `params.controller || app.controller` with reason `'panel'`, and resumes on close. On close it also
  emits bus `panel:closed` `{panel}`. Calling it while the sheet is open switches the tab. Other members:
  `closePanel()`, getter `panel` (open panel name or null), `defaults` (DEFAULT_SETTINGS), `textures`
  (AUTO_TEXTURES), and `ui.texturePicker` / `ui.compareFields`.
- Panels emit bus `life:changed` `{source:'panel', panel, what, kind, state, year}` after each write. The controller
  saves on this event. The sheet re-renders on any other `life:changed` and on the controller's `year` / `death`.
- Panel module interface (`screens/family.js`, `screens/money.js`): `meta = {tab, title, eyebrow}`, and
  `mount(root, params, app)` with `params = {state, world, changed(kind), switchTo(name), close, deps?: {engine}}`.
- Named exports from app.js: `AUTO_TEXTURES` (the 8 contract ids, with the same labels as controller.js AUTO_TEXTURES),
  `COMPARE_YEAR_MIN/MAX` (1920 / 2026), `PANEL_NAMES`, `UI`, `openSheet(name, deps)` (the sheet without an App, used
  in tests), and `upgradeLife(state)`. `upgradeLife` adds the empty `stars/notes/rare` arrays and the null
  `smallPending/namingPending/reflectPending` fields to old saves, and runs in adoptLife.

**Settings** (DEFAULT_SETTINGS + sanitizeSettings)
- New keys: `autoTexture:'normal'`, `gentle:false`, `music:true`, `reflections:true`, `compareIso:null` (ISO3) and
  `compareYear:null` (1920–2026).
- Life settings (copied into `state.settings` by start / resume / saveSettings) are now `lifeMinutes, aiMode,
  decisionFreq, autoChoose, autoTexture, gentle, reflections`. `music` and `compare*` are app-only and stay in this
  browser's settings.
- `settings` params: `focus` is `'ai' | 'compare' | 'play' | 'tone'`.

**Engine calls (all feature-detected; each has a fallback that reads or writes the §10 state shape)**
- money.js: `incomeBreakdown`, `investOptions`, `setHabit`, `setAllocation`. Fallback writes: `state.habits[key]` and
  `person.money.allocation`. The cost of a habit at each level comes from `incomeBreakdown` on a shallow copy of the
  state with only that habit changed. It looks for an item whose `key` is the habit key, `habit:<key>`,
  `habit_<key>` or `item.habit === key`. When no such item exists, the panel shows an estimate as a share of income,
  marked 约.
- Optional `HABITS` export on engine.js or economy.js (`[{key, label?, hint?, effects?:[3 strings]}]` or an object
  keyed by habit) overrides the panel's effect text.
- family.js: `familyView`, `nameChild` (naming slip in the panel when `state.namingPending`), `setHabit` (孝亲费 and
  聚餐·送礼). Recognised member roles: mother, father, parent, step*, grand*, partner, spouse, husband, wife,
  boyfriend, girlfriend, child, son, daughter, grandchild, sibling, brother, sister, or any Chinese role text.
  `m.label` wins. `m.older` (boolean) gives 哥哥 / 姐姐 / 弟弟 / 妹妹.
- death.js: `lifeSummary`, `childrenFates` and `addNote(state, text, 'final', '最后，你想对这个人说一句话')`. A life has
  at most one final note, and saving again replaces it. After that the record is re-archived with
  `saves.addPastLife(state, {bio, epitaph, savedAt, sharedId ...})`. A final sentence of 40 characters or fewer goes
  first in the death card's bio text. Helpers are exported: `summaryOf`, `starredMoments`, `lifeNotes`, `finalNote`,
  `setFinalNote`, `childrenLines`, `compareBirthplace`.
- Birthplace comparison: WPP `le` (both sexes) at birth for compareIso and compareYear. A year before 2000 uses 2000
  and says so; with no year, the life's birth year is used. The life's side uses the birth country and year, through
  `world.indicator` for projected years.

**CSS**: `src/ui/panels.css`. styles.css adds the categorical chart tokens `--cat-1..7` for both themes. They are the
validated reference palette, used only next to a text legend.

## v2 interactivity: controller.js, screens game / decision / moments, music.js, game.css (CONTRACT §10)
All additions are backwards compatible with CONTRACT §8 and the earlier controller notes above. Every engine v2 call
is feature-detected (`controller.has(name)`); without it the matching UI stays hidden or falls back.

**GameController**
- `SPEEDS` = `[0.5, 1, 2, 4, 8, 12, 16]`. `normSpeed` snaps to them.
- Extra `deps.moments = {openNaming, openReflection, openThought}` (defaults to screens/moments.js).
- New methods:
  - `has(name)`, `hasFocus()`.
  - Focus: `focusOptions()` (engine passthrough, `[]` before 6), getter `focus` (the chosen id or null = auto),
    `yearFocus()` (the current year's history row `focus`), `setFocus(id | null | 'auto')`.
  - `setHabit(key, level)` and `setAllocation(alloc | null)` (optional; the panels call the engine themselves).
  - Texture: getter `texture`, `setTexture(id)`. It writes `state.settings.autoTexture` and
    `app.saveSettings({autoTexture})`.
  - `setReflections(on)`.
  - Stars: `toggleStar(entryId)` returns the engine result, or null without the API. A `{full:true}` refusal is
    not saved. Also `isStarred(id)`, `starCount()`, `starMax()` (12).
  - Small choices: `answerSmall(optionId)` returns `{type:'answered', small, optionId, entries}` or null.
  - Notes: `addNote(text, kind = 'thought', prompt?)` (cleaned, at most 200 characters) and `openThought()`. When
    the engine has no `addNote`, the note goes into `state.notes` plus a `system` log line.
  - Decisions: `dismissDecision()` and `reopenDecision()`.
- Pause reasons added: `naming`, `reflect`, `note` (moments) and `panel` (set by the shell's side sheet).
  `canAct()` is false while a moment is open.
- Small choice lifecycle:
  - After each `stepYear`, a new `state.smallPending` is announced as `small {type:'new'}`.
  - Just before the next `stepYear`, the controller resolves an unanswered choice whose `expiresYear <= year + 1`
    with `engine.resolveSmall(…, null)`. Its entries therefore land in the choice's own year.
  - The controller then emits `small {type:'auto', entries}`.
  - The clock never stops for a small choice.
- Moments:
  - After a year (or a resolution), `state.namingPending` opens the naming dialog first, then `state.reflectPending`
    opens the reflection dialog. Both come before that year's decision.
  - A moment interrupts a fast-forward. The skip carries on afterwards unless a decision is waiting.
  - Naming calls `engine.nameChild(state, idx, name)`. Closing the dialog keeps the first suggestion: `nameChild` is
    called only when the child still has no name, and `namingPending` is cleared either way.
  - A reflection saves its note with `addNote(text, 'reflection', prompt)`. "以后不再这样暂停" calls
    `setReflections(false)`.
  - A `reflectPending` is dropped silently when `settings.reflections === false` (global or life).
  - Leaving the game screen closes a moment, and it re-opens on attach.
- Decisions:
  - The overlay gets `onDismiss`. A dismissed decision keeps the flow in `choosing` with `minimized: true` and the
    clock stopped.
  - `snapshot().waiting` is true while a decision is set aside; it is not re-opened on attach.
  - `reopenDecision()` re-opens it with `auto: false`.
  - A thought note can be written while a decision waits.
- `snapshot()` adds `waiting`, `moment`, `small` (id), `texture` and `focus`.
- Events added: `small`, `moment` `{kind, open}`, `waiting` (boolean), and `changed` `{what, ...}`. `what` is one of
  focus, habits, allocation, texture, settings, stars, small, notes, naming, or a panel's `what`/`kind` with
  `external:true`.
- Bus `life:changed` `{what, state, year, source:'controller', ...}` is emitted after every interaction, every year
  (`what:'year'`), every resolution (`decision` / `custom`) and at death.
- The controller listens to bus `life:changed` from other sources for the same life (`state` or `id`). It refreshes
  the game screen at once and saves once, 350 ms after the last event.
- Bus `settings`: `autoTexture, gentle, music, reflections, compareIso, compareYear` are copied into
  `state.settings`. `applySettings` accepts them too.
- The AI birth-story log entry gets `id: '<year>-story'` so it can be starred.
- Named exports added: `AUTO_TEXTURES` (`[{id, label, hint}]`, same labels as app.js) and `textureLabel(id)`.

**decision.js**: a `先看看再选` button (only with `opts.onDismiss`, never in custom mode). Escape stops a running auto
countdown first, then sets the decision aside.

**screens/moments.js** (new): `openNaming`, `openReflection` and `openThought`, each `(app, opts) -> close()` with
`close.isOpen()`.
- Each is a focus-trapped `.g-ov.g-ov--mom > .g-dlg.g-mom.g-mom--{naming|reflect|thought}` dialog. The page shell is
  inert while it is open.
- Naming: suggestion chips plus a text field of at most 12 characters (`NAME_MAX`). Escape keeps the suggestion.
- Reflection: an optional note of at most 200 characters (`NOTE_MAX`) and the "以后不再这样暂停" checkbox.
- With `opts.auto` (自动抉择 on), naming and reflection run a soft countdown that the player can stop. The countdown
  never finishes while the tab is hidden.
- Callbacks: naming `onName(name)` / `onKeep()`; reflection `onSave(text, {never})` / `onSkip({never})`; thought
  `onSave(text)` / `onCancel()`.
- Export `cleanText(text, max)` strips control and bidi characters and counts characters, not UTF-16 units.

**music.js** (new): `createMusic({volume?})` returns `{start, stop, setPlaying, setMood, isOn, isAvailable, destroy}`.
- WebAudio only: detuned sine and triangle pads on pentatonic chords, sparse bell notes through a filtered echo, and
  a compressor, at a very low level.
- The AudioContext is created only in `start()`. With `settings.music` on, the game calls it on the first pointer or
  key gesture.
- `setPlaying(false)` fades out and suspends the context. `setMood(-2..2 | 'sad'|'low'|'calm'|'warm'|'bright')`
  changes the key, brightness and pace from the next chord.

**game.js**
- 今年的重心 bar at the top of the centre column:
  - An 自动 chip comes first, then the engine's options with ↑/↓ hints coloured by direction.
  - Unavailable options are `aria-disabled` and show `why`.
  - Arrow, Home and End keys move between chips; Enter or Space picks one.
  - The status line explains auto (`自动：今年把心思放在「…」上（按「性子」的性子）`) or the chosen focus.
  - On phones it is one sideways-scrolling row inside its own box.
  - Each year header shows `重心 · …`.
- Small choices:
  - The pending choice is an inline `.g-sm` card at the top of its year in the log, with a soft draining countdown
    (`年底前没选的话，会按「性子」的性子自动决定 · 约 N 秒`).
  - The answer, or the year-end auto decision, is shown inside the card. Its log lines are not repeated below it.
  - No card is shown during a fast-forward.
- Every log line with an `id` gets a ☆ toggle (SVG; `aria-pressed`). A header counter shows `★ n/12`. A toast explains
  the 12-star limit.
- Control bar:
  - Row items: 0.5×–16×, 自动抉择 with the 性子 button next to it, then 家人与生活 / 花钱·投资 (only when
    `app.openPanel` exists), 写下想法 and 音乐 (`aria-pressed`).
  - The 性子 button opens an `app.modal` list of the 8 textures (or goes to settings).
  - The pill row shows `有一个抉择正在等你 · 回到抉择` while a decision is set aside.
  - At 861–1439 px the bar stays on one line: the speed is a single cycle button, tools use short labels and the
    status shrinks with an ellipsis.
  - On phones the tools and the 性子 button form a second row. Every target is at least 40 px.
- The keyboard shortcuts (Space, +, -) are ignored while a `.g-ov`, `.ll-modal` or `.ll-sheet-wrap` is open.

**For the engine owner** (what the UI assumes about §10):
- `resolveSmall`, `nameChild` and `addNote` push their entries into `state.log`. If they do not, the controller adds
  them; it de-duplicates by object identity and `id`.
- Log entries carry `id`.
- `history[i].focus` is set every year.
- `smallPending.expiresYear` is the year at whose start the choice expires (normally `year + 1`).

## 2026-10-27 · Achievement cards (成就卡片)
- New pure module `src/core/achievements.js`:
  - `ACHIEVEMENTS` catalog of life, rare-encounter, player and collection cards;
  - `lifeFacts(state)`, `evaluateLife(state)`, `evaluateMeta(meta)`, `tierFor(rate)`, `achievementDef(id)`.
  - Life-card tiers follow the rates measured by `node tests/_ach_rates.mjs 8000 --write`, which rewrites the
    RATES block.
- New `src/social/collection.js` keeps the collection in this browser under `STORAGE_KEYS.stats` (`ll2090.lifetime`).
  - `recordLife(state, {regionOf})` counts each life once (by `state.id`). Looking at the same life again can still
    earn the cards it had not earned yet, such as the final sentence written after death.
  - `exportLives()` adds a `collection` field to the backup. `importLives()` merges it and returns `cards` only when
    new cards arrived, so the old result shape is unchanged.
- UI:
  - new screen `album` (anchors `#album` and `#cards`), first in the nav, with an entry on home;
  - the death screen shows "这一生收集到的卡片" right below the actions, with new cards flipping in;
  - `cards.achievementCard(def, got, extra)` draws a 1080×1350 PNG of one card.
- Known engine quirk, found while doing this: key exams are skipped in milestone years. At 18 that means a Chinese
  life never records 高考 in `education.exams`. The 高考 card therefore looks at the 高考志愿 decision instead.

## 2026-10-27 · Free-text choices read against the decision (built-in engine)
- Feedback: "自己写的选择，游戏不太能理解我想干什么".
  - Cause: `resolveOffline` sent custom text straight to keyword intents. It ignored the decision's own options, so
    contextual replies fell to the generic outcome. Examples: 「好」「算了」「选第二个」「听爸妈的」「先谈谈工资」.
- `decisions.interpretCustom(text, decision, data, home)` (pure) reads a free-text choice in this order:
  1. an option reference (选第二个 / B / 前者);
  2. an option label quoted in the text;
  3. a keyword intent whose action equals an option's action (that option is taken, keeping its details);
  4. any other keyword intent;
  5. a short yes or no answer mapped onto the matching option;
  6. 「听爸妈的」;
  7. the closest wording (bigram similarity).
- `interpretLine(it)` gives the one-line hint the decision overlay shows while the player types (only when the AI is
  not in use). Examples: 「会理解为：创业开店 + 辞职（大理）」, 「会按选项「留在本地」来推演」, and a warning when unclear.
- Changes in `resolveCustom` and the intent lists:
  - A second, lighter plan in the same sentence now counts at half strength, e.g. 「去深圳找工作，顺便每天跑步」.
  - About 130 everyday phrasings were added (`EXTRA_KW`), e.g. 体制内/考编/开滴滴/进厂/北漂/接爸妈/寄钱回家/冥想/驾照.
  - Vague 「好好过日子」-type words yield to anything more specific.
  - 「男/女朋友」 no longer reads as making friends; 「开民宿」 is recognised.
- Measured with `tests/_intent_probe.mjs`:
  - 131 common phrasings: 108 → 124 understood correctly;
  - 20 contextual replies: 0 → 20.
- Tests: `tests/intent_context.test.mjs`.

## 2026-10-27 · Concrete money plans in free text; a projected-returns fix
- Feedback: "定投美股、利用 AI 赚钱（说具体措施）能懂吗". Before this change they could not:
  - 「定投美股」 was not understood;
  - 「利用AI赚钱」 was read as paying for an AI course.
- New intent `ai_money`, which runs the action `A.ai_hustle`.
  - `aiKindOf(text)` picks the kind of work: content, copy, art, app, shop, teach, freelance or mixed.
  - The opening text describes the concrete plan.
  - After 1–2 years a thread decides the outcome. A success sets `flags.sideIncome` (multiples of the median
    income) until `flags.sideIncomeUntil`; a failure gets a realistic ending (prices pushed down, too many
    competitors, and so on).
  - The chance of success is about 15–50%, depending on knowledge, AI or coding skill, education, and being early
    (2023–2028).
- `invest_stocks` free text now runs `A.invest_plan` with `investPlanOf(text)`:
  - market: us_stocks / cn_stocks / jp_stocks / in_stocks / eu_stocks / em_stocks / world_stocks;
  - style: dca 定投 / all_in 梭哈 / trader 短线 / gold / bonds.
  - Flags `investMarket`, `investStyle` and `investSince` are set.
- economy.js:
  - `assetReturn(..., {market})` uses the named market's real 2000–2025 series, or its own simulated draw after that.
  - `INVEST_STYLES` sets the share of spare cash invested and the asset weights.
  - Trading costs about 4 points a year, with wider swings.
  - A big year in the chosen market adds a named note, e.g. 「这一年美股（标普500）跌了约 37%」.
  - `incomeFor` adds `sideIncomeOf(flags, year, median)`.
- Only player-typed text sets these flags, so headless lives and the calibration do not depend on them.
- Fix (pre-existing): projected stock returns averaged about −1.8% real a year, below bonds, in every world line.
  - Cause: the base mean (5%) already included crises, and −25% crash shocks hit in every year a crisis event was
    active (about 15% of years).
  - Now crashes hit only in a crisis's first year, and the normal-year mean is 8% (sd 0.16).
  - Result: about +4.2% arithmetic and +2.5% geometric real, ranging from −3.6% to +10% across world lines.
  - Lives got slightly richer, and CHN drifted to −2.6 years against cohort LE, already close to the ±2.5 limit
    before this change. `IG_NORM.HIC` was moved 0.83 → 0.86; CHN is now −2.2 and USA +1.4.
- Probes: `tests/_money_plan_probe.mjs` (the same lives with and without a typed plan), `tests/_intent_try.mjs`,
  `tests/_calib_quick.mjs`.

## 2026-10-27 · 人生长卷 share poster, 高考 scores

- **人生长卷** (`cards.lifePoster`): one tall share image (1080 × 1920 or taller) for WeChat / 小红书:
  - name, dates, birthplace and family;
  - three numbers: longevity percentile, the 高考 score or the number of choices, and the rarest card of this life;
  - up to six key choices, with the player's own written choices marked "自己写的";
  - 高光 and 低谷, taken from the person's own entries of that year (not world news);
  - the life map, the cards of this life, and a QR code back to the game.
  On the death screen it is the primary button. It opens in a preview where phones can long-press the image to save it, since WeChat cannot download files; desktop gets a download button.
- `src/ui/qr.js`: a dependency-free QR encoder (byte mode, level M, versions 1–10). It was checked module for module against python-qrcode, and the posters were decoded with zxing-cpp.
- **高考 scores:** the school-leaving exam (age 17+) used to be skipped in years with a milestone decision, so the 高考 never appeared in Chinese lives.
  - It is now sat before the decision is built, and 高考 gets a score out of 750: median about 470, 600+ about 10%, 650+ about 2%.
  - The 高考志愿 decision says the score ("高考 612 分", "你考了 612 分，过了一本线").
  - The result nudges the university odds; the shift has mean zero, and the calibration tests pass.
- RATES re-measured over 8000 lives: top_exam R → N, exam_fail N → R.
