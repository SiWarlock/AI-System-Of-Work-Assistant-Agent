// Task 24.123 — MEASUREMENT LEG, on a SYNTHETIC corpus (Done-when bullet 1's
// population caveat).
//
// ⛔ THE GAP THIS FILE CLOSES: every false-positive measurement this entry has
// recorded so far (219/668, 254/652, 267/656…) used THIS REPO'S OWN tracked
// Markdown as the corpus. That corpus is BIASED — a repo whose subject IS a
// credential-redaction system talks about "password"/"secret"/"credential"/
// "api key" at a rate no ordinary personal or work note does (measured
// independently at the entry's own PARTITIONED-BY-PATH table: code-adjacent
// files average 24.0% refusal against 36–38% for docs, at matched length). The
// entry's own Done-when therefore forbids reporting the repo proxy as the
// answer, and — separately — forbids satisfying it with an unauthorized scan
// over real vault content (a standing lead/owner gate). The honest path it
// names is: "a synthetic note-shaped corpus (construction stated, its
// unrepresentativeness owned)". This file IS that corpus and that
// measurement.
//
// ⛔ SCOPE: this is the MEASUREMENT LEG ONLY. `contentContainsSecret` itself
// (`packages/knowledge/src/knowledge-writer/secret-scan.ts`) already landed the
// granularity split (`19802240`) and is NOT this package's territory — it is
// mirrored here by calling the SAME two production nets it imports from
// `@sow/domain` (`CREDENTIAL_PREFIX`, `URL_USERINFO_CREDENTIAL`) with the
// identical `.some(net => net.test(value))` composition, so this measurement
// is of the real production predicate's INPUTS, not a reimplementation with
// its own drift risk. The entry's remaining (a)/(b) items — updating
// `audit-signal.ts`'s stale prediction note and `contentContainsSecret`'s own
// docstring — are a different leg, left to the assignment that scoped this one.
//
// CONSTRUCTION, STATED (the entry's own requirement): 63 notes, HAND-AUTHORED
// for this measurement (not sampled, not machine-generated), spanning 15
// everyday note categories a personal/work vault plausibly contains — standup
// and meeting notes, a daily journal, recipes, travel planning, book/article
// notes, a workout log, grocery lists, budget/financial planning, home
// renovation, project brainstorming, engineering/debugging notes (several
// DELIBERATELY discuss credentials, tokens, and rotation IN PROSE — the exact
// case the keyword arm over-fired on and the granularity split was built to
// admit), gift/"secret" planning in the ordinary non-credential sense, resume
// drafting, and health notes. None contains a real credential shape.
//
// UNREPRESENTATIVENESS, OWNED: this is 63 hand-written notes from one author,
// not a statistically drawn sample of any real vault — it cannot bound a
// population false-positive rate the way a large real corpus could, and a
// different author's notes (different vocabulary, different domains, notes in
// other languages, code blocks pasted from a different ecosystem) could land
// differently. What it DOES establish, which the repo-proxy corpus structurally
// cannot: a corpus selected to be ORDINARY rather than ABOUT credential
// redaction, so the topic-bias the entry's own partitioned-by-path table
// diagnosed is controlled by construction instead of inferred from n=25.
//
// POSITIVE CONTROL (instrument discipline — an empty result needs a control
// that can fail): 7 more notes, same realistic register, each built around one
// genuine credential shape a person plausibly pastes into a note by accident —
// one per `CREDENTIAL_PREFIX` alternative family (`sk-`, `AKIA`, `-----BEGIN`,
// a JWT `eyJ…`, `xoxb-`, `ghp_`) plus one `URL_USERINFO_CREDENTIAL` case. If the
// benign bucket's flagged count were 0 because the predicate never fires at
// all, this bucket would be 0/7 too, not 7/7.
import { describe, it, expect } from "vitest";
import { CREDENTIAL_PREFIX, URL_USERINFO_CREDENTIAL } from "../../src/redaction/redaction-rules";

// Mirrors `contentContainsSecret`'s exact composition (secret-scan.ts,
// `CONTENT_CREDENTIAL_NETS.some((net) => net.test(value))`) — SENSITIVE_KEYWORD
// deliberately excluded, matching the COMMIT-granularity predicate task 24.123
// landed, not the AUDIT-granularity one.
const COMMIT_GRANULARITY_NETS: readonly RegExp[] = [CREDENTIAL_PREFIX, URL_USERINFO_CREDENTIAL];
function contentContainsSecretMirror(value: string): boolean {
  return COMMIT_GRANULARITY_NETS.some((net) => net.test(value));
}

// 15 categories, ~4 notes each. Categories named in the block comment above;
// order here is grouped by category for reviewability, not randomized.
const BENIGN_SYNTHETIC_NOTES: readonly string[] = [
  // meeting / standup
  "Standup notes, Tuesday: shipped the pagination fix, reviewed two PRs, blocked on the design handoff for the settings page. Tomorrow I'll pair with Priya on the export flow and follow up with the infra team about the staging outage from last night.",
  "1:1 with my manager: talked about the promo packet timeline, agreed to draft the impact doc by Friday. She mentioned the reorg is still a few weeks out and encouraged me to keep documenting the migration work in the wiki.",
  "Project sync recap: the vendor integration slipped a week because their sandbox environment kept timing out. Decided to descope the bulk-import feature from the v1 launch and revisit it in v1.1. Action items assigned to Marcus and Dana.",
  "Retro notes: what went well — the on-call rotation felt calmer this sprint. What didn't — we underestimated the QA pass on the checkout redesign by almost double. Proposed fix: add a buffer day to every sprint that touches payments.",
  "Kickoff meeting for the Q3 roadmap: three themes agreed — reliability, onboarding, and internal tooling. Everyone should submit their team's top three bets by end of week so we can prioritize in the planning doc.",
  // personal journal
  "Journal, Monday morning: slept badly, woke up around five and couldn't fall back asleep. Made coffee, sat on the porch for a bit before the kids got up. Feeling a little anxious about the dentist appointment this afternoon but otherwise okay.",
  "Journal: had a really good conversation with my sister last night about moving closer to family next year. It's still just an idea but it felt good to say it out loud. Need to actually look at job postings in that city instead of just talking about it.",
  "Journal: today was one of those days where nothing went wrong but nothing felt easy either. Cooked dinner, took the dog for a long walk, read for twenty minutes before bed. Trying to notice the small good things more.",
  "Journal: finally finished the closet reorganization I've been putting off for a month. Donated three bags of clothes I haven't worn in years. It's a small thing but the room feels so much bigger now.",
  "Journal: rough day at work, mostly just a lot of context switching and not enough deep focus time. Going to try blocking off mornings next week and see if that helps. Ended the day with a good run though, which helped clear my head.",
  // recipes
  "Recipe — weeknight lentil soup: saute one onion, two carrots, two celery stalks in olive oil until soft. Add three cloves garlic, a tablespoon of cumin, a cup of red lentils, and six cups of broth. Simmer twenty-five minutes, finish with lemon juice and fresh parsley.",
  "Recipe — grandma's banana bread: mash three ripe bananas, mix with a third cup melted butter, three quarters cup sugar, one egg, teaspoon vanilla. Fold in a cup and a half of flour, teaspoon baking soda, pinch of salt. Bake at 350 for about an hour.",
  "Recipe — sheet pan chicken fajitas: toss sliced chicken thighs, bell peppers, and red onion with olive oil, chili powder, cumin, and paprika. Roast at 425 for twenty minutes, stirring once halfway through. Serve with warm tortillas and lime wedges.",
  "Recipe notes: tried the sourdough starter recipe again, this time it actually rose properly. The trick seems to be keeping the kitchen warmer — I put it near the oven vent overnight and it doubled by morning.",
  // travel
  "Travel — Portugal trip planning: four nights Lisbon, two nights Porto, three nights in the Algarve. Need to book the train between Lisbon and Porto and figure out whether renting a car for the coastal drive is worth the hassle.",
  "Travel itinerary draft: fly into Denver on the 14th, drive to Rocky Mountain National Park for two nights, then down to Boulder for the weekend before flying back on the 20th. Pack layers, the forecast is all over the place.",
  "Travel notes from the Japan trip: the ramen place near the station in Kyoto was the best meal of the whole trip. Also glad we bought the rail pass in advance, saved a lot of standing in ticket lines.",
  "Trip planning: still deciding between the cabin in the mountains and the beach house for the family reunion. Cabin is cheaper and closer, beach house has more room for everyone. Going to put it to a group vote this weekend.",
  // book / article notes
  "Book notes — 'Atomic Habits': the core idea is that identity change drives behavior change more reliably than willpower does. The four laws (make it obvious, attractive, easy, satisfying) are a genuinely useful checklist for building a new habit.",
  "Book notes — 'The Warmth of Other Suns': a sprawling, deeply human account of the Great Migration told through three individual lives. Struck by how each person's decision to leave was both deeply personal and part of something much larger.",
  "Article notes: the piece on urban heat islands made a good case that tree cover is one of the cheapest, most effective interventions cities can make, and that it's consistently underfunded compared to more visible infrastructure projects.",
  "Reading list update: added two books this week — a biography of Shackleton and a novel a coworker recommended. Removed one I started months ago and never picked back up; life's too short to force it.",
  // fitness
  "Workout log, Monday: 5k easy run, felt good, kept the pace around 9:30. Legs a little tight from Saturday's long run but nothing concerning.",
  "Workout log, Wednesday: upper body — bench press 3x8 at a moderate weight, pull-ups 3x6, overhead press 3x10. Shoulders felt strong today, bumped the bench weight up slightly from last week.",
  "Workout log: took a rest day, just did some light stretching and a short walk. Sleep has been off this week so probably a good call to back off the intensity a bit.",
  "Fitness notes: hit a new personal best on the 10k this weekend, finished about ninety seconds faster than my last attempt. The interval training over the past month is clearly paying off.",
  // grocery / meal planning
  "Grocery list: milk, eggs, spinach, chicken thighs, brown rice, olive oil, black beans, canned tomatoes, garlic, onions, coffee, oat milk, bananas, yogurt, tortillas.",
  "Grocery list for the dinner party: two bottles of red wine, a wheel of brie, crackers, fresh figs, a baguette, mixed greens, salmon fillets, lemons, fresh dill, dark chocolate for dessert.",
  "Weekly meal plan: Monday tacos, Tuesday stir fry, Wednesday leftovers, Thursday pasta, Friday takeout, weekend flexible. Need to prep the taco filling Sunday night so Monday is quick.",
  // budget / financial (non-credential)
  "Budget review, this month: rent, utilities, and groceries came in about where expected. Went over on dining out again — probably worth setting a firmer weekly cap there instead of a monthly one.",
  "Financial planning notes: bumped the retirement contribution up by one percent this year, barely noticeable in the paycheck but it adds up over time. Also finally set up the automatic transfer into the emergency fund.",
  "Budget notes: the car insurance renewal came in higher than expected, going to shop around for quotes from a couple other providers before it auto-renews next month.",
  "Savings goal tracker: emergency fund is at about four months of expenses now, aiming for six by the end of the year. House down payment fund is moving slower than I'd like but steady.",
  // home renovation / DIY
  "Home reno notes: got three quotes for the kitchen backsplash, going with the contractor who could start soonest even though it wasn't the cheapest bid. Tile samples arrive next week.",
  "DIY project log: finally fixed the squeaky back door hinge, just needed a drop of oil and a quarter turn on the screws. Also patched the drywall dent in the hallway, needs a second coat of spackle before painting.",
  "Home renovation planning: repainting the living room this weekend, going with a warmer neutral than the current gray. Need to buy painter's tape, a drop cloth, and a second roller.",
  "Garden notes: transplanted the tomato seedlings outside this weekend, a little early but the forecast looks mild. Added compost to the raised beds and finally fixed the drip irrigation line that's been leaking.",
  // idea / project brainstorming
  "Brainstorm — side project ideas: a simple habit tracker with no accounts required, a browser extension that mutes autoplay videos by default, a tool that turns a grocery list into a shopping route by aisle.",
  "Idea dump: what if the onboarding flow just showed three example projects instead of an empty state? Might reduce the drop-off we're seeing in the first-run funnel. Worth a quick prototype before committing engineering time.",
  "Project planning notes: breaking the redesign into three phases — navigation first, then the dashboard, then settings. Each phase should ship independently so we're not waiting on a single big release.",
  "Notes from the whiteboarding session: landed on a simpler data model than what we started with, mostly because the original version tried to handle an edge case that turns out to affect fewer than five accounts.",
  // engineering / debugging notes that DISCUSS credentials in prose, never a shape
  "Engineering notes: our auth service issues short-lived tokens and refreshes them on a rolling basis; the incident last week was caused by a clock skew between two nodes, not anything wrong with the token logic itself.",
  "Debugging notes: the login flow was failing intermittently in staging. Turned out to be a race condition where the session cookie was set before the auth callback finished, not a credentials issue at all. Fixed by awaiting the callback first.",
  "Engineering notes: reminder to rotate the third-party API key before the vendor's quarterly rotation deadline next month — I'll do it through their dashboard rather than by hand, same as last time.",
  "Security review notes: discussed rotating the service account credentials on a quarterly cadence going forward, and agreed to store any future secrets in the team's password manager rather than in a shared doc.",
  "On-call handoff notes: nothing urgent overnight. One alert fired around 2am for elevated latency on the search service, self-resolved within ten minutes, probably a downstream dependency hiccup. Nothing needing a follow-up.",
  "Notes from the vendor call: they confirmed their API rate limit is per account, not per key, so we don't need to worry about spreading requests across multiple credentials the way we originally assumed.",
  // gift / "secret" in the ordinary, non-credential sense
  "Gift planning: thinking a nice set of hiking poles for Dad's birthday, he mentioned wanting them a few times this spring. Need to ask Mom for his boot size in case I add something else.",
  "Secret Santa notes for the office party: got assigned my coworker, she mentioned liking plants and good tea, budget cap is twenty-five dollars, exchange is the Friday before the holiday break.",
  "Surprise party planning: keeping it low-key, just close friends at the house rather than a venue. The hard part is keeping it a secret from her for the next three weeks — she's already suspicious we're planning something.",
  "Notes on a gift for my best friend's wedding: she mentioned wanting a nice set of kitchen knives on the registry, and I found one that matches the set her parents got her ages ago. Ordering this weekend before it sells out.",
  // resume / career
  "Resume bullet drafts: led the migration of the billing service to a new provider, reducing monthly infrastructure spend by eighteen percent; mentored two junior engineers through their first on-call rotations; shipped the redesigned onboarding flow that cut signup drop-off by nine points.",
  "Resume notes: should probably reframe the dashboard project bullet to lead with the outcome (faster load times, fewer support tickets) rather than the tech stack — recruiters skim for impact first.",
  "Cover letter draft notes: the role emphasizes cross-functional collaboration, so I should lead with the redesign project where I worked closely with design and support rather than the purely technical migration work.",
  // health
  "Doctor's appointment notes: blood pressure was a little high again, doctor suggested cutting back on sodium and rechecking in six weeks before considering anything else. Also due for a routine bloodwork panel next visit.",
  "Physical therapy notes: shoulder mobility is improving, up to about eighty percent of full range now. Homework is three sets of the band exercises daily and icing after any heavier upper body workouts.",
  "Health notes: started tracking sleep more closely this month, seems like anything past eleven pm consistently leaves me groggy the next day regardless of total hours. Trying to shift bedtime earlier gradually.",
  // everyday / misc
  "Notes from the school parent-teacher conference: teacher says reading is coming along well, math needs a bit more practice at home, nothing to be worried about, just some extra flashcard time a few nights a week.",
  "Weekend plans notes: farmers market in the morning, then the kids' soccer game at eleven, house is free in the afternoon so probably tackle the garage cleanup we've been putting off for weeks.",
  "Notes on choosing a new phone plan: the family plan from the second carrier works out cheaper once you factor in the multi-line discount, and coverage in our area has apparently improved a lot since we last checked a couple years ago.",
  "Car maintenance log: oil change and tire rotation done, mechanic flagged the brake pads as getting thin, probably good for another few thousand miles but worth scheduling before the road trip in the fall.",
  "Notes from the insurance call: switching to the higher deductible plan saves about forty dollars a month, worth it given we haven't filed a claim in years, but worth revisiting if that changes.",
  "Class notes — intro to statistics: covered the central limit theorem today, the professor's example with the dice rolls finally made the intuition click for me in a way the textbook explanation hadn't.",
];

// One per CREDENTIAL_PREFIX alternative family, plus URL_USERINFO_CREDENTIAL —
// realistic register (a note where someone pasted something they shouldn't
// have), never a bare fixture string.
const POSITIVE_CONTROL_NOTES: readonly string[] = [
  "Engineering notes: pasted this by mistake while debugging the deploy script, need to remember to rotate it — sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890.",
  "Copied from the vendor dashboard so I wouldn't lose it: AKIA0123456789ABCDEF is the access key id for the old staging bucket, decommission this along with the bucket.",
  "Notes from setting up the staging DB connection string: postgres://scratchuser:hunter2@staging-db.internal:5432/app — remember to move this out of the note and into the secrets manager.",
  "Debug log snippet I saved for the bug report: Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
  "Pasted the Slack webhook token here temporarily while testing the integration: xoxb-1234567890-abcdefghijklmnop, will delete this note once it's in the vault properly.",
  "Reminder note to self: the old GitHub personal access token I forgot to revoke is ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789, need to go revoke it today.",
  "Saved this snippet from the server migration for reference: -----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA1c7+9z5Pad7OejecsQ0bu3aumga\n-----END RSA PRIVATE KEY-----",
];

describe("24.123 measurement leg — false-positive rate on a SYNTHETIC realistic-note corpus", () => {
  it("non-vacuity: the corpora are the stated size", () => {
    expect(BENIGN_SYNTHETIC_NOTES.length).toBe(63);
    expect(POSITIVE_CONTROL_NOTES.length).toBe(7);
  });

  it("BENIGN — the COMMIT-granularity predicate (24.123's shape nets, no keyword arm) flags ZERO of 63 ordinary notes", () => {
    const flagged = BENIGN_SYNTHETIC_NOTES.filter((n) => contentContainsSecretMirror(n));
    console.log(
      `24.123 synthetic corpus — benign: ${BENIGN_SYNTHETIC_NOTES.length} notes, ` +
        `${flagged.length} flagged (${((flagged.length / BENIGN_SYNTHETIC_NOTES.length) * 100).toFixed(1)}%). ` +
        `Repo-proxy comparison: 20/668 = 3.0% (task 24.123, real tracked Markdown, biased toward the ` +
        `credential-redaction topic this repo is about).`,
    );
    if (flagged.length > 0) {
      console.log("FLAGGED (unexpected):", flagged);
    }
    expect(flagged).toEqual([]);
  });

  it("POSITIVE CONTROL — every genuine credential shape is still caught (7/7); an empty benign result above is not because the predicate is inert", () => {
    const flagged = POSITIVE_CONTROL_NOTES.filter((n) => contentContainsSecretMirror(n));
    expect(flagged.length).toBe(POSITIVE_CONTROL_NOTES.length);
  });

  it("DISCRIMINATION per control: each positive-control note trips because of a credential SHAPE, not incidentally via the OTHER net", () => {
    // Each note is built around exactly one CREDENTIAL_PREFIX alternative
    // family, except the URL case which is exactly the URL_USERINFO_CREDENTIAL
    // net — pinned individually so a future edit to one control that silently
    // stops exercising its intended alternative is caught here, not folded
    // into the aggregate 7/7 above.
    const byNet: ReadonlyArray<readonly [string, RegExp]> = [
      [POSITIVE_CONTROL_NOTES[0]!, CREDENTIAL_PREFIX], // sk-
      [POSITIVE_CONTROL_NOTES[1]!, CREDENTIAL_PREFIX], // AKIA
      [POSITIVE_CONTROL_NOTES[2]!, URL_USERINFO_CREDENTIAL], // //user:pass@
      [POSITIVE_CONTROL_NOTES[3]!, CREDENTIAL_PREFIX], // eyJ...
      [POSITIVE_CONTROL_NOTES[4]!, CREDENTIAL_PREFIX], // xoxb-
      [POSITIVE_CONTROL_NOTES[5]!, CREDENTIAL_PREFIX], // ghp_
      [POSITIVE_CONTROL_NOTES[6]!, CREDENTIAL_PREFIX], // -----BEGIN
    ];
    for (const [note, net] of byNet) {
      expect(net.test(note), `expected ${net} to match: ${JSON.stringify(note.slice(0, 60))}…`).toBe(
        true,
      );
    }
  });

  it("SUMMARY — the synthetic measurement corroborates 24.123's own DIRECTION finding without the repo-proxy's topic bias", () => {
    // 24.123 established (mechanism, not sample): the repo-proxy's 3.0% is
    // INFLATED by topic, because this repo's own docs are unusually likely to
    // contain the words its shape nets react to. A corpus built to be ORDINARY
    // rather than about credential redaction should therefore measure AT OR
    // BELOW the repo-proxy rate — and, being small and hand-authored, is not
    // expected to reproduce it exactly (see the unrepresentativeness note
    // above). This is the one load-bearing cross-corpus comparison; the two
    // individual assertions above already pin the actual numbers.
    const REPO_PROXY_RATE = 20 / 668; // task 24.123's own post-split measurement
    const syntheticFlagged = BENIGN_SYNTHETIC_NOTES.filter((n) =>
      contentContainsSecretMirror(n),
    ).length;
    const syntheticRate = syntheticFlagged / BENIGN_SYNTHETIC_NOTES.length;
    expect(syntheticRate).toBeLessThanOrEqual(REPO_PROXY_RATE);
  });
});
