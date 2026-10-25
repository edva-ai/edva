// context-floor — estimate a supervisor's CURRENT context floor from the
// per-session-start prefix sizes measured by edva-cost-report.
//
// Extracted from edva-cost-report (a CLI entrypoint, not importable) so the
// rule can be unit-tested, same reason context-guard.mjs was split out of the
// supervisor's index.mjs on 2026-08-06.
//
// The floor is a CURRENT-STATE property, not an average over the window. Every
// decision made from it — did it grow, is the working window too small — is
// about the floor right now, so the estimator must be recent.
//
// A median over the whole window is straddle-biased: when a config change lands
// mid-window the reported floor is neither the old value nor the new one, and
// it can report NO CHANGE when the floor actually moved 23k. Not hypothetical —
// see the regression repro in tests/context-floor.test.mjs.
//
// FLOORS ARE ONLY COMPARABLE WITHIN A MODEL FAMILY (measured 2026-08-08).
// A floor is a token count reported by the model that produced it, so two
// supervisors running different models report different numbers for the SAME
// prefix. Measured factor Haiku:Sonnet = 0.73. Both independent measurements
// agree: the identical symlinked text removed by the 2026-08-06 extraction cost
// 22.6k tokens on each Sonnet tier but only 16.6k on ops-haiku (ratio 0.732),
// and the standing ops-haiku:ops-light floor ratio is 0.725 both before and
// after that cut. So ops-haiku's floor looking ~35k "smaller" than ops-light's
// on identical config is arithmetic, not 35k of recoverable content — scaled to
// Sonnet-equivalent tokens the real gap is ~1.2k. Do not read a cross-model
// floor difference as a cut waiting to be made; compare a tier only to itself.

const RECENT_N = 8;      // enough to shrug off one odd start, short enough to track a change same-day
const SAME_FLOOR = 8000; // wider than per-job payload spread (~5k), far under a real shift (17-23k)

function median(a) {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
}

// floors: prefix sizes in CHRONOLOGICAL order (one per session start).
function estimateFloor(floors, { recentN = RECENT_N, sameFloor = SAME_FLOOR } = {}) {
  if (!floors || !floors.length) {
    return { floor: 0, samples: 0, samplesUsed: 0, windowMedian: 0, firstHalf: 0, secondHalf: 0, shift: 0 };
  }
  // Take the most recent CONTIGUOUS RUN of starts that agree with the latest
  // one, then median that. Straddle-proof at any sample count, which neither a
  // fixed last-N nor a most-recent-half rule is: a supervisor yielding only ~9
  // starts/day gives a last-8 spanning 4 pre-change and 4 post-change, and the
  // even-length median breaks toward the stale half. Walking back until the
  // value disagrees stops exactly at the change instead of guessing how many
  // samples to trust. With no change in the window every sample agrees and this
  // degrades to "median of the last recentN" — the stable-system case.
  const latest = floors[floors.length - 1];
  let run = 0;
  while (run < floors.length && run < recentN
         && Math.abs(floors[floors.length - 1 - run] - latest) < sameFloor) run++;
  const recent = floors.slice(-Math.max(run, 1));

  // Half-medians make a mid-window shift legible instead of averaging it away.
  const half = Math.floor(floors.length / 2);
  const firstHalf = half ? median(floors.slice(0, half)) : 0;
  const secondHalf = half ? median(floors.slice(half)) : 0;

  return {
    floor: median(recent),
    samples: floors.length,
    samplesUsed: recent.length,
    windowMedian: median(floors),
    firstHalf,
    secondHalf,
    shift: half ? secondHalf - firstHalf : 0,
  };
}

module.exports = { estimateFloor, median, RECENT_N, SAME_FLOOR };
