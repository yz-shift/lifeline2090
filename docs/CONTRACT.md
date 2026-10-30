# LifeLine 2090 (人生长河 2000–2090) — architecture contract

An original Chinese life-simulation web game. One life, born 2000–2070 anywhere on Earth. 2000–2026 is real history
(real UN/World Bank data + verified events); 2026–2090 is a projection ("世界线") built from today's trends.
Inspired by the feature set of 1in8b.life but with original code, text, name and design. Do not copy its text or UI.

Everything in this file is binding for all modules. If you must change an interface, keep the old one working and
write the change into `docs/CHANGES.md` (append-only) so the integrator sees it.

## 0. Ground rules
- Plain modern JavaScript ES modules (no TypeScript, no framework). Bundled by esbuild into `dist/app.js` (IIFE).
- `src/core/**` and `src/ai/prompts.js`, `src/ai/validate.js` are **pure**: no DOM, no `window`, no `fetch`, no
  `Math.random`, no `Date.now()` inside simulation logic (pass time in). They must run under Node 24 for tests.
- All randomness through `Rng` (`src/core/rng.js`). Store `rng.state()` in the LifeState so a saved life resumes exactly.
- Shared constants from `src/core/constants.js`; DOM helpers from `src/ui/dom.js` (`h`, `s`, `$`, `clear`, `fmt`,
  `storage`, `bus`, `reducedMotion`). Do not re-implement them.
- All player-facing text is Simplified Chinese. Neutral, humane tone; no graphic violence; sensitive history stated
  neutrally. Personal story text is fiction and must be framed as such where it touches real events
  ("你" experienced the event; never invent statements by real people).
- Untrusted text (AI output, shared db rows, user input) is only ever inserted with `textContent` (use `h()`).
- Money is stored in **2021 international dollars (PPP, real)**. Display converts to local currency with
  `ppp_factor` (local currency per intl $) and the currency symbol from `lifePaths`, labelled "按2021年物价".
- The game must be fully playable with no AI (sample capability absent/declined/rate-limited) and no db.

## 1. Files and data
```
data/countries.json   built by tools/build_data.py (do not hand-edit)
  meta.years: [2000..2026, 2030, 2035, ..., 2090, 2100]          (41 grid points; interpolate linearly between)
  meta.wb_indicators[key] = {label, unit, rule, projection}
  countries[ISO3] = { name (zh), en, iso2, region (EAS..OCE), subregion, wbRegion, income_now, consumption_share,
     wpp: { pop, births (thousands/yr), le, le_m, le_f, tfr, med_age, imr, q5, srb, cnmr, mac, cdr, q1560_m, q1560_f } (arrays on the grid),
     wb:  { gdp_pc_ppp, gdp_growth, gini, poverty, unemployment, youth_unemp, internet, mobile, electricity, water, urban,
            sec_enroll, ter_enroll, literacy, health_exp_pc, physicians, homicide, suicide, road_deaths, inflation,
            ppp_factor, fx_rate, female_lfp, adol_fert, maternal_mort, ncd_mort, smoking } (arrays on the grid, may contain null),
     lastObs: {key: lastObservedYear|null}, imputed: [keys filled from regional medians] }
data/mortality.json   { meta:{years, ages:[0,1,5,...,100], sexes, countries:[ISO3 sorted], encoding}, b64 }
  Uint16 LE; mx = exp(1 - v/4000); index = ((countryIdx*nYears + yearIdx)*2 + sexIdx)*22 + ageIdx; annual q = 1 - exp(-mx)
data/content.json     built by tools/build_content.py from research/*.json:
  { history: [Event...],                       // research/SCHEMAS.md §1, all history files concatenated
    future: { baseline_assumptions, dimensions, milestones, random_shocks },   // §2, parts a+b merged
    econ: { asset_returns, causes_of_death },  // §3
    lifePaths: { countries: {ISO3: {...}}, defaults_by_income_group },         // §4
    names: { countries: {ISO3: {...}} } }      // §5
```
Read `research/SCHEMAS.md` for the exact event / scenario / reference shapes.

**Mortality and history do not double count.** WPP mx for years <= 2024 already contains real crisis mortality
(COVID, wars). History events' `mortality` fields are used only for cause-of-death attribution and narrative.
For years >= 2027 the engine multiplies hazard by future scenario multipliers, sampled shocks and future events.

## 2. Module map and exports
```
src/core/rng.js          (given)  Rng, hashString, newSeed
src/core/constants.js    (given)
src/core/data.js         loadData(fetchJson) -> Promise<DataStore>; makeDataStore({countries, mortality, content}) (for Node tests)
src/core/world.js        createWorld(data, worldSeed, forcedBranches?) -> World
src/core/person.js       randomBirth(data, world, rng, opts) -> BirthSpec; customBirth(data, world, rng, input) -> BirthSpec;
                         makeName(data, iso3, sex, birthYear, rng) -> {name, latin}
src/core/economy.js      incomeFor(...), portfolio helpers, assetReturn(world, assetKey, year, rng), formatMoney(data, iso3, amountIntl)
src/core/engine.js       newLife(data, world, birthSpec, settings, seed) -> LifeState
                         stepYear(data, world, state) -> YearResult            (advances exactly one year; mutates state)
                         applyResolution(data, world, state, decision, choice, resolution) -> LogEntry[]
                         survivalCurve(data, world, state) -> {ages:[], personal:[], baseline:[]}
                         countryContext(data, world, iso3, year) -> Context
src/core/death.js        hazardFor(data, world, state) -> {q, mult, parts}; sampleCause(data, world, state, rng) -> Cause; deathRecord(...)
src/core/events.js       EVENT_LIBRARY (array of templates); pickPersonalEvents(data, world, state, ctx, rng) -> EventInstance[]
src/core/decisions.js    nextDecisionAge(state, frequency); buildDecisionOffline(data, world, state, ctx, rng) -> Decision;
                         resolveOffline(data, world, state, decision, choice, rng) -> Resolution;
                         classifyIntent(text) -> {intents:[...], targetCountry?, ...}; autoChoose(state, decision, rng) -> choice
src/core/cohort.js       makeCohort(data, world, birthSpec, rng, n?) -> Peer[]; peerStatusAt(peer, year) -> PeerYear
src/ai/claude.js         initAI() -> Promise<{available}>; aiCall(kind, prompt, {tier, signal, onText}) -> Promise<{text, json}>; aiStatus()
src/ai/prompts.js        buildDecisionPrompt(...), buildResolutionPrompt(...), buildCustomActionPrompt(...), buildBirthStoryPrompt(...),
                         buildCustomBirthPrompt(text, data), buildBiographyPrompt(...)   (pure: return strings)
src/ai/validate.js       validateDecision(raw, fallback), validateResolution(raw, state), validateBirthParse(raw, data), validateBiography(raw)
src/ai/director.js       the glue: getDecision(state) (AI with prefetch, falls back to offline), resolveChoice(...), customAction(...),
                         birthStory(...), biography(...)  — every function returns usable output even when AI fails
src/social/store.js      initSocial() -> {mode:'shared'|'local'}; shareLife(record); listShared({limit, filter}); lightCandle(lifeId);
                         candleCount(lifeId); addMessage(lifeId, text); listMessages(lifeId); sendFeedback(text, page)
src/social/saves.js      autosave(state); loadCurrent(); clearCurrent(); pastLives(); addPastLife(record); deletePastLife(id);
                         exportLives() -> string; importLives(jsonString) -> {added, skipped}
src/ui/app.js            screen router: showScreen(name, params); header/nav; settings; hot-reload snapshot
src/ui/screens/*.js      home, birth (registration card + custom birth form), game, decision (overlay), death (certificate),
                         memorial, shared, past, about (data & sources), settings, feedback
src/ui/charts.js         sparkline(values,opts), lineChart(series,opts), survivalChart(curve,opts)  -> SVG elements
src/ui/lifemap.js        lifeMap(history, opts) -> element (one cell per lived year, coloured by tag; future years hollow)
src/ui/cards.js          birthCard(state, data) / deathCard(state, data) -> Promise<Blob> (canvas PNG 1080x1350)
src/ui/styles.css        all CSS (inlined into index.html at build)
src/main.js              boot: load data -> init AI/social -> app
```

## 3. Core types (JSDoc shapes; field names are binding)
```js
DataStore = {
  years: number[], countries: {ISO3: Country}, isoList: string[], content,
  country(iso3) -> Country|undefined,
  series(iso3, key, year) -> number|null,          // looks in wb then wpp; linear interpolation on the grid; year clamped to [2000,2100]
  mx(iso3, year, sex /*'male'|'female'*/, age) -> number,   // central death rate, interpolated across grid years
  qx(iso3, year, sex, age) -> number,             // 1-exp(-mx)
  birthsWeights(year) -> {isos:string[], weights:number[], total:number},  // thousands of births that year
  incomeGroup(iso3, year) -> 'LIC'|'LMC'|'UMC'|'HIC'                       // from gdp_pc_ppp and INCOME_THRESHOLDS
  lifePath(iso3) -> {...country entry merged over defaults_by_income_group[incomeGroup(iso3, 2025)]}
  currency(iso3) -> {code, name, symbol}
}

World = {
  seed, branches: {dimensionId: branchId}, label (zh one line), description (zh paragraph), dims: [{id,title,branch:{id,title,description,prob}}],
  modifiers(iso3, year) -> {gdp_growth_add, unemployment_add, mortality_mult, inequality_add, internet_ceiling, heat_risk,
                            sea_level_risk, conflict_risk_add, migration_push_add, retirement_age_add, education_years_add, happiness_add},
  indicator(iso3, key, year) -> number|null,      // data series + scenario modifiers for year > 2026 (gdp compounds gdp_growth_add)
  lifeExpectancy(iso3, year, sex) -> number,
  mortalityMult(iso3, year, age) -> number,        // 1 for year <= 2026; scenario + active future events/shocks after
  events(iso3, year) -> WorldEvent[],              // active events affecting iso3 that year (history, future milestones, shocks)
  headlines(year, iso3, n=6) -> WorldEvent[],      // most important global + local events for the news ticker
  isProjection(year) -> boolean                    // year > 2026 (2026 itself is shown as "截至 2026-10")
}
WorldEvent = { id, source:'history'|'future'|'shock', year, endYear, title, summary, category, importance, scope,
               countries, regions, effects:{economy,health,happiness,safety,education,tech}, mortality?, migration_push,
               personal_hooks:[], sources:[], projection:boolean }

BirthSpec = { mode:'random'|'custom', year, date:'YYYY-MM-DD', time:'HH:MM:SS', country:ISO3, sex:'male'|'female',
              urban:boolean, familyPct:0..1, parentsEdu:'none'|'primary'|'secondary'|'tertiary', siblings:int,
              motherAge:int, fatherAge:int, name, nameLatin?, notes:[zh strings], customText? }

Context = { iso3, year, country (name zh), region, incomeGroup, gdp, gdpGrowth, unemployment, youthUnemp, gini, poverty,
            internet, urban, secEnroll, terEnroll, lifeExp, tfr, medAge, conflict:0..3, events:WorldEvent[], projection:boolean }

LifeState = {
  v: 1, id, seed, rng: [4 numbers], createdAt (ISO, passed in by UI), mode,
  worldSeed, worldLabel,
  settings: { lifeMinutes, aiMode:'off'|'quick'|'default'|'complex', decisionFreq:'sparse'|'standard'|'frequent', autoChoose:boolean },
  birth: BirthSpec,
  year, age,                      // current year and completed age (age 0 in birth year)
  person: {
    name, sex, country /*current residence ISO3*/, urban, familyPct,
    education: { level, inSchool, field|null, years, exams:[{age,name,result}] },
    career:    { status, title|null, sector|null, incomePct /*0..1 within country*/, years, employer|null },
    relationship: { status, partner|null /*{name, sinceYear}*/ },
    children: [{ name, sex, birthYear, alive }],
    parents: { mother:{age, alive}, father:{age, alive} },
    siblings: int,
    money: { cash, debt, income /*annual, intl $*/, portfolio: { stocks, bonds, gold, property, crypto } },
    conditions: [{ id, name, sinceYear, severity:1..3 }],
    flags: { [key:string]: string|number|boolean },     // free tags e.g. smoker:true, migrant:'DEU', veteran:true
  },
  stats: { health, happiness, knowledge, relationships, wealth },   // 0..100
  history: [{ year, age, stats, tag /*YEAR_TAGS*/, mood /*-2..2*/, country, headline /*zh short*/ }],
  log: [LogEntry],
  decisions: [{ id, year, age, title, choice /*label or custom text*/, custom:boolean, source:'ai'|'local' }],
  threads: [Thread],              // pending storylines (from AI or offline resolution)
  hazardMods: [{ mult, untilYear, reason }],
  pending: Decision|null,
  dead: DeathRecord|null,
  cohort: Peer[],
  aiNotes: { birthStory|null, lastSummary|null },   // AI narrative memory (short)
}

LogEntry = { year, age, kind:'birth'|'event'|'news'|'milestone'|'decision'|'choice'|'thread'|'death'|'system',
             text (zh), tone:-2..2, tags:[], effects?: {health,happiness,knowledge,relationships,wealth}, source:'engine'|'ai'|'history'|'future' }

YearResult = { year, age, entries: LogEntry[], news: WorldEvent[], decision: Decision|null, died: DeathRecord|null, stats }

Decision = { id, year, age, kind:'milestone'|'triggered'|'custom', title, situation (zh 1-3 sentences),
             options: [{ id:'a'|'b'|'c'|'d', label (<=16 chars), detail (zh 1 sentence), risk:'low'|'mid'|'high' }],
             allowCustom: true, source:'ai'|'local', context?: object }
Choice = { optionId } | { customText }
Resolution = { narrative (zh 2-5 sentences), effects: {health,happiness,knowledge,relationships: -15..15 ints, wealthDelta: intl $ (bounded)},
               set: { education?, career?, relationship?, country?, urban?, flags?: {}, addCondition?, removeCondition? },
               threads: [Thread], hazard?: {mult 0.5..2, years 1..30, reason}, feasible: boolean, note? }
Thread = { id, title, text (zh), trigger: { year? , age?, afterYears? }, conditions?: { alive?:true, country?:ISO3, ... },
           effects: {...same as Resolution.effects}, set?: {...}, decision?: { title, situation, options[] }, source:'ai'|'local' }
DeathRecord = { year, age, date, cause:{id, name, detail}, place:ISO3, summary (zh), stats, lifeExpAtBirth, percentile }
Peer = { name, sex, country, familyPct, birthYear, deathYear|null, deathCause|null, timeline: [{year, status (zh short)}], fate (zh 1 line) }
```

## 4. Simulation rules (engine.js / death.js / economy.js)
- **Time**: one `stepYear` = one calendar year. Age 0 at birth year. The UI animates months inside a year.
- **Mortality**: annual q = data.qx(country, year, sex, age) × personal multiplier × world.mortalityMult × hazardMods.
  Personal multiplier is built from health stat, family/income percentile, conditions and flags and is **normalised so
  the population mean is ≈ 1** (validate with tests: simulated mean age at death ≈ cohort life expectancy computed
  from the same mx, within ±1.5 years). Cap the total multiplier to [0.25, 6].
- **Cause of death**: content.econ.causes_of_death by age band × incomeGroup(country, year), reweighted by context
  (active war events -> violence; epidemics -> infections; smoker -> cvd/cancer/respiratory; conditions -> their cause).
- **Education**: enrolment and progression probabilities from sec_enroll/ter_enroll, family percentile, knowledge,
  urban/rural, sex × female_lfp era context; key exams from lifePaths at their ages; decisions can override within feasibility.
- **Work and money**: income = country mean consumption (consumption_share × gdp) × 1.5 for earners × lognormal(gini)
  factor at the person's incomePct; unemployment risk from unemployment / youthUnemp; retirement at lifePath age
  (+ world retirement_age_add after 2026). Savings rate depends on income percentile; portfolio returns use
  content.econ.asset_returns for 2000–2025 and world-line-dependent simulated returns after.
- **Family**: marriage hazard calibrated so ~50% are married by lifePath median_first_marriage_age (country-specific),
  children from TFR and MAC (mean age at childbearing) shape; parents age and die using the same mx tables (grief events).
- **Migration**: only through decisions/threads/events (wars raise push); feasibility depends on money, education,
  destination income group and lifePath.common_destinations.
- **World events** each year: world.events(country, year) -> personal effects scaled by vulnerability (age, poverty,
  urban). Always add the year's top headlines as `news` (not every one to the log).
- **Personal events**: 0–3 per year from EVENT_LIBRARY, conditions on age, stage, flags, era (tech availability by
  year and internet rate), incomeGroup, region, sex, world events. Text uses variables like {name},{city},{country}.
- **Decisions**: at nextDecisionAge (per settings.decisionFreq) and when triggered (war, layoff, illness, offer,
  thread). The engine sets `state.pending` and stops advancing until the UI resolves it.
- **Threads**: fire when trigger matches; apply effects; may spawn a decision.
- **Stats**: clamp 0..100 every year; natural drifts (health declines with age after 30 with country-specific slope,
  knowledge grows with schooling/work, relationships follow family/partner/friends, wealth is derived from net worth
  vs country median income on a log scale).
- **History record**: one `history` row per year with the dominant tag for the life map.

## 5. AI layer (claude.js / prompts.js / validate.js / director.js)
- Capability: `const sample = await window.claude?.use?.('sample')` — may be null. Always `sample.json(prompt, {modelTier, signal})`
  or streaming `sample(prompt, {onText})`. Handle every error code: `not_granted`/`sampling_disabled`/... -> switch to
  offline for the session and tell the player once; `rate_limited` -> offline for this call, keep AI on; `invalid_json`,
  `upstream_error`, `refused` -> offline fallback for this call. Never retry in a loop; no timers around calls.
- Tier from settings.aiMode ('off' => never call). Prefetch the next milestone decision one in-game year early.
- Prompts include: compact person summary, last 12 log lines, choices made so far, current Context (real numbers),
  the year's real/projected world events, world-line label, and the exact JSON shape required. Prompts instruct:
  stay consistent with real history for years <= 2026 and with the world line after; no real people's invented
  statements; probabilities must respect the country context (a poor rural child cannot simply move to Silicon Valley);
  output Chinese.
- `validate.js` clamps every number, drops unknown fields, enforces option count 2–4, label lengths, ISO3 codes that exist,
  and returns null when unusable (director then uses offline).
- AI is what makes later life depend on earlier choices: the resolution returns `threads` (future storylines) and
  `set` changes; the next decision prompt includes them. Offline mode does the same with templated threads.
- Calls per life target: birth story (1), decisions (~10–20, prefetched), resolutions (one per choice), custom actions
  (player-initiated), biography + epitaph at death (1).

## 6. UI and design
- Screens: home (hero, world births counter, start buttons), birth (registration card; random vs custom form with
  year 2000–2070, country search, sex, urban/rural, family wealth, parents' education, free-text "特殊出身" for AI),
  game (top: name/age/year/country; stats with sparklines; life map; scrolling life log; world news ticker with
  "真实历史"/"推演" badges; controls: pause/resume, speed 0.5×–8×, "跳到下一个抉择", auto-choose toggle,
  "主动选择" free-text action; side panels: country indicators now vs world, survival curve, same-second cohort,
  world line), decision overlay (options + custom text + auto), death (certificate, cause, life map, stats chart,
  biography/epitaph, share card, save, share to memorial), memorial (shared lives, candles, messages),
  shared lives feed (filters by country/era), past lives (last 10, export/import/delete), about (what is real /
  projected / fiction, data sources with links, method notes), settings (life length 10/30/60/90 min, AI mode,
  decision frequency, auto-choose), feedback form.
- Design direction: a civil-registry archive of one human life. Paper-and-ink registry documents (出生登记/户籍/
  死亡证明), archival numbering, a red registry seal used sparingly, a strict year grid. Real-history years and
  projected years must be visually distinct everywhere (e.g. solid ink vs a cool "projection" hue with dashed
  outlines). Light and dark themes via tokens per the artifact rules. Fonts from Google Fonts with CJK fallbacks.
  Phone width 400px must work; no horizontal page scroll.
- Artifact platform: the page is published as a claude.ai artifact. `window.claude.use('sample'|'db'|'user'|'downloads')`
  may resolve null. `alert/confirm/prompt` do nothing (build in-page confirms). Downloads only via the `downloads`
  capability (`downloads.save({filename, data: blob})`), falling back to an `<a download>` when `window.claude` is absent
  (local run). Hot reload: `window.claude?.hot?.snapshot(() => state)`.

## 7. More binding shapes
```js
EventInstance = { id, text (zh, variables already filled), tone:-2..2, tags:[YEAR_TAGS or free], tag?:YEAR_TAG (life-map hint),
                  effects:{health,happiness,knowledge,relationships: ints -15..15, wealthDelta?: intl $},
                  set?: {...same as Resolution.set}, hazard?: {mult, years, reason}, decision?: Decision /*triggered*/ }
```
`events.js` templates: `{ id, when:(state, ctx, data, world) => boolean | weight number, weight, text: string|string[] with
{name} {partner} {child} {country} {city} {year} {age} variables, tone, tags, effects, set?, hazard?, decision? , once?:boolean,
cooldown?: years }`. Aim for 400+ templates across life stages, sexes, income groups, regions, eras and world events.

## 8. UI contracts
- **App object** (created in `src/ui/app.js`, passed to every screen):
  `{ data, ai /* {available, mode} */, social /* {mode} */, settings, getLife() -> LifeState|null, go(screen, params),
     back(), toast(text, kind?), confirm({title, body, ok, cancel}) -> Promise<boolean>, saveSettings(patch),
     startLife(birthSpec, opts) -> starts a GameController and goes to 'game', resumeLife(state), endLife(state) }`
- **Screen modules** `src/ui/screens/<name>.js` each `export function mount(root, params, app)` returning an optional
  cleanup function. Names: home, birth, game, death, memorial, shared, past, about, settings, feedback.
  The decision overlay is `src/ui/screens/decision.js` exporting `openDecision(app, decision, {onChoose, onAuto}) -> close()`.
- **GameController** `src/ui/controller.js`: `new GameController(app, state)` with `start()`, `pause()`, `resume()`,
  `setSpeed(x)`, `skipToDecision()`, `customAction(text)`, `on(evt, fn)` events: 'year' (YearResult), 'decision',
  'resolved', 'death', 'ai' (status text), 'tick' (fraction of current year, for month animation). Uses engine.stepYear,
  ai/director, social/saves.autosave every year. Seconds per year = lifeMinutes*60 / lifeExpectancyAtBirth.
  Pauses automatically when a decision is pending or the tab is hidden.
- **CSS**: build concatenates `src/ui/styles.css` first, then every other `src/ui/**/*.css` alphabetically into the
  page's single `<style>`. Only `styles.css` defines tokens; other CSS files use them. Token names (binding):
  `--bg --paper --paper-2 --ink --ink-2 --ink-3 --line --seal --accent --proj --proj-2 --good --warn --bad
   --st-health --st-happiness --st-knowledge --st-relationships --st-wealth
   --tag-birth --tag-childhood --tag-study --tag-work --tag-love --tag-family --tag-loss --tag-illness --tag-crisis
   --tag-war --tag-migration --tag-success --tag-calm --tag-retire --tag-death
   --font-display --font-body --font-mono --radius --shadow --gutter`.
  Class prefix per owner to avoid collisions: shell/home/birth/settings `.ll-`, game/decision/death `.g-`,
  charts/lifemap/cards/about `.c-`, social screens `.s-`.
- **index.html** template (`src/index.html`): `<title>人生长河</title>`, the viewport-fit-sides meta, Google Fonts link,
  `<style>/*__STYLES__*/</style>`, `<div id="app"></div>`, `<script src="app.js"></script>`.

## 9. Birth options
`randomBirth(data, world, rng, opts)` with `opts.yearMode`: `'2000'` (default: born in 2000, lives through all real
history), `'history'` (2000–2026 weighted by world births), `'now'` (2026), `'future'` (2027–2070 weighted by births),
`'any'` (2000–2070 weighted), or `opts.year` to force a year. Country by births that year, sex by SRB.
`customBirth(data, world, rng, input)` accepts any subset of BirthSpec fields (+ `customText`); missing fields random.
Each new life gets a fresh world seed (`newSeed()` in the UI) unless the player picks "沿用上一条世界线" (keep `worldSeed`).

## 10. Interactivity layer (v2) — binding
Goal: the player takes part in almost every year, not only at milestone decisions (feedback: "交互性不如原来那个").
New pure modules: `src/core/focus.js`, `src/core/smallchoices.js`, `src/core/rare.js`; additions to `engine.js`/`economy.js`.

State additions (all optional on old saves; engine must default them):
```js
state.focus = { current: FocusId|null /* chosen by player for this and following years until changed */, auto: boolean }
history row += { focus: FocusId|null }                 // what the year was spent on (player or auto)
state.habits = { dining: 0|1|2, parents: 0|1|2, travel: 0|1|2, learning: 0|1|2, health: 0|1|2, charity: 0|1|2 }
                                                        // spending habits: 0 none, 1 some, 2 a lot (聚餐·送礼, 孝亲费, 旅行, 学习投入, 健康投入, 捐助)
state.person.money.allocation = { bank, balanced, stocks, crypto } | null   // weights for new savings, null = auto
LogEntry += { id: string }                              // unique within a life, e.g. `${year}-${seq}`, assigned by the engine
state.stars = [entryId, ...]                            // max 12 "值得记住的时刻"
state.notes = [{ year, age, kind: 'reflection'|'thought'|'final', prompt|null, text }]
state.smallPending = SmallChoice|null                   // a quick non-blocking choice
state.namingPending = { childIndex, sex, suggestions: [names] }|null
state.reflectPending = { age, prompt }|null             // at ages 5, 15, 30, 50, 70
state.rare = [{ id, year, age, title }]                 // hidden easter eggs found
settings += { autoTexture: 'normal'|'steady'|'adventure'|'family'|'career'|'free'|'comfort'|'giving', gentle: boolean,
              music: boolean, reflections: boolean, compareIso: ISO3|null, compareYear: number|null }
```
`SmallChoice = { id, year, age, kind: 'small'|'family', title (zh ≤ 14), text (zh 1–2 sentences), options: [{ id, label ≤ 10, hint ≤ 16 }] (2–3), expiresYear }`

Engine API (exports of `src/core/engine.js`; pure, mutate state, return LogEntry[] where relevant):
```js
focusOptions(data, world, state) -> [{ id, label, hint /* e.g. '知识↑ 快乐略↓' */, available: boolean, why?: string }]
setFocus(state, focusId|null)                 // null = let auto decide each year
setHabit(state, key, level)                   // clamps level
setAllocation(state, alloc|null)
resolveSmall(data, world, state, optionId) -> LogEntry[]     // also called with null by the engine to auto-resolve on expiry
nameChild(state, childIndex, name) -> LogEntry[]
addNote(state, text, kind, prompt?) -> LogEntry[]            // text is trimmed to 200 chars; never interpreted
toggleStar(state, entryId) -> { starred: boolean, moved?: entryId }   // max 12: starring a 13th returns {starred:false, full:true}
familyView(data, world, state) -> { members: [{ role, name, sex, age, alive, status, closeness: 'close'|'ok'|'distant', note }],
                                     friends: number, pets: [{ name, kind, age }], habits: [...], conditions: [...] }
incomeBreakdown(data, world, state) -> { income, items: [{ key, label, amount, share }] }   // 一年收入的去向（估算）
investOptions(data, world, state) -> [{ id: 'bank'|'balanced'|'stocks'|'crypto', label, hint }]
lifeSummary(data, world, state) -> { lines: [zh], happiestAge, richestAge, focusYears: { [FocusId]: n } }
childrenFates(data, world, state) -> [{ name, sex, birthYear, line /* zh: what became of them */ }]   // headless, deterministic
```
Rules:
- Focus from age 6 (younger: none). Options depend on stage (child/teen/young adult/adult/old) and situation (in school, working,
  single, parents alive and old, has children). Effects are modest (+1..+4 primary, -1..-2 secondary per year) and also shift
  probabilities (exam success, promotion, finding a partner, health risks). If the player never chooses, auto picks by
  texture/stage; auto-chosen focus over a population must keep the life-expectancy calibration (tests/sim.test.mjs).
- Habits cost money every year (scaled to income and country) and give small stat effects; shown in incomeBreakdown.
- Small choices: about one every 1–2 years from age 6, never in a year that already has a pending milestone decision.
  They do not pause the clock; if unanswered when the next year starts, the engine auto-resolves them (texture-biased).
  Library ≥ 150 in `smallchoices.js`, covering stages, regions, eras, family situations; some set habits/flags (pet, hobby,
  smoking) that later events use. Kind 'family' = decided together with family (和家人一起决定).
- Child naming: when the player's child is born, `namingPending` is set with 3–5 culturally fitting suggestions; the engine
  keeps the first suggestion if the player does not name the child before the next year.
- Reflection moments at 5, 15, 30, 50, 70 (if settings.reflections !== false): `reflectPending` with a gentle question
  fitting the life so far; the clock pauses only in the UI; notes are optional.
- Rare events (`rare.js`): real-world-frequency easter eggs (Nobel prize, Olympic medal, naming a new species, lottery jackpot,
  meeting an astronaut, saving a life…) gated by plausibility (education, career, country); ~1–3% of lives find one.
- Gentle mode: entries about violence, abuse, suicide or child death keep their statistics but use softened wording, and
  suicide-related entries add one line pointing to help (generic: 当地心理援助热线/信任的人; no phone numbers).
