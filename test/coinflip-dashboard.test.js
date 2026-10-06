'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const dash = require('../coinflip-dashboard-static')

test('the coinflip panel script parses and talks to the endpoints the bot serves', () => {
  const js = dash.getCoinflipDashboardJs()
  assert.doesNotThrow(() => new Function(js), 'the emitted client script must be valid JS')
  for (const id of ['cfkpi', 'cfbotlist', 'cftabs', 'cfcontent', 'cfclose', 'coinflipbtn', 'coinflippanel']) {
    assert.ok(js.includes(id), `panel element #${id}`)
  }
  for (const ep of ['/api/coinflip/summary', '/api/coinflip/bots', '/api/coinflip/fairness', '/api/coinflip/deep', '/api/coinflip/bot?bot=']) {
    assert.ok(js.includes(ep), `endpoint ${ep}`)
  }
})

test('the overview reads the stats the store actually returns', () => {
  const js = dash.getCoinflipDashboardJs()
  // The old panel asked for stats.total / stats.trackedBots / stats.bestStreak —
  // none of which computeStats returns — and printed [object Object] for the
  // streak because it is {kind, length}.
  assert.ok(js.includes('stats.flips'), 'flips')
  assert.ok(js.includes('stats.winRate'), 'winRate')
  assert.ok(js.includes('stats.bots'), 'per-bot rows')
  assert.ok(js.includes('longestWinStreak'), 'best streak comes from longestWinStreak')
  assert.ok(js.includes('streakText'), 'the streak object is formatted, not stringified')
  assert.equal(js.includes('stats?.total'), false, 'stats.total does not exist')
  assert.equal(js.includes('trackedBots'), false, 'stats.trackedBots does not exist')
  assert.equal(js.includes('bestStreak'), false, 'stats.bestStreak does not exist')
})

test('the fairness tab renders the fleet analysis and the per-bot tests', () => {
  const js = dash.getCoinflipDashboardJs()
  // The old code walked Object.entries(fairness) treating every value as a
  // p-number and crashed on the CI object. The endpoint serves one analysis
  // plus a perBot map now.
  assert.ok(js.includes('fair.perBot'), 'per-bot fairness comes from the API')
  assert.ok(js.includes('fair.winRate'), 'win rate')
  assert.ok(js.includes('fair.ci'), 'confidence interval')
  assert.ok(js.includes('Runs test'), 'runs test')
})

test('the deep tab renders the sections the dissection really returns', () => {
  const js = dash.getCoinflipDashboardJs()
  assert.ok(js.includes('deep.sections'), 'sections')
  assert.ok(js.includes('deep.takeaways'), 'takeaways')
  assert.ok(js.includes('deep.markov'), 'markov')
  // The old tab read twelve hardcoded keys (winStreakAfterLoss, benfordsLaw, …)
  // that analysis.deepAnalysis never produced — every one rendered "n/a".
  assert.equal(js.includes('winStreakAfterLoss'), false)
  assert.equal(js.includes('benfordsLaw'), false)
  assert.equal(js.includes('hiddenMarkovModel'), false)
})

test('the charts hover at a point and say the exact number', () => {
  const js = dash.getCoinflipDashboardJs()
  assert.ok(js.includes("mode: 'nearest'"), 'hover finds the nearest point')
  assert.ok(js.includes('exact('), 'tooltip values are full precision')
  assert.ok(js.includes('pointRadius'), 'each flip is a point on the curve')
})
