'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const ai = require('../ai-chat')

function mockFetch (responses) {
  const calls = []
  const fn = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) })
    const next = responses.shift()
    if (!next) throw new Error('unexpected fetch')
    return { ok: next.ok ?? true, status: next.status ?? 200, json: async () => next.data }
  }
  return { fn, calls }
}

const savedEnv = {}
function setEnv (values) {
  for (const [key, value] of Object.entries(values)) {
    savedEnv[key] = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}
function restoreEnv () {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

test('extractQuotedContent prefers the whole quoted string and falls back to a span', () => {
  assert.equal(ai.extractQuotedContent('"nice loot today"'), 'nice loot today')
  assert.equal(ai.extractQuotedContent('Sure! "yeah thats bad" ok'), 'yeah thats bad')
  assert.equal(ai.extractQuotedContent('no quotes here'), null)
  assert.equal(ai.extractQuotedContent(''), null)
  assert.equal(ai.extractQuotedContent(null), null)
})

test('extraction takes the answer (last quoted span), not the input echoed inside reasoning', () => {
  // This shape is verbatim what the live auto model produces: reasoning that
  // quotes the player's line before answering. The first quote is the echo.
  assert.equal(
    ai.extractQuotedContent('First, the user said: "hello anyone on?". I need to respond as RedStonePro. My reply is "whos on now"'),
    'whos on now'
  )
  assert.equal(ai.extractQuotedContent('They said "gg" so the answer is "gg ez"'), 'gg ez')
})

test('verification refuses echoes of the room and persona refusals', () => {
  const echoes = ['Steve: hello anyone on?', 'Alex: trade?']
  const echo = ai.verifyChatMessage('hello anyone on?', { echoesOf: echoes })
  assert.equal(echo.ok, false)
  assert.match(echo.reason, /echo/)
  assert.equal(ai.verifyChatMessage('trade?', { echoesOf: echoes }).ok, false, 'the speaker prefix does not hide an echo')
  assert.equal(ai.verifyChatMessage('gg ez', { echoesOf: echoes }).ok, true, 'a real reply passes')

  const refusal = ai.verifyChatMessage('im not redstonepro i cant do that', {})
  assert.equal(refusal.ok, false)
  assert.match(refusal.reason, /refusal/)
  assert.equal(ai.verifyChatMessage('im just an ai, i cant pretend', {}).ok, false)
  assert.equal(ai.verifyChatMessage('as an ai i wont help', {}).ok, false)
  assert.equal(ai.verifyChatMessage('i am not a real person', {}).ok, false)
  assert.equal(ai.verifyChatMessage('im not gonna lose', {}).ok, true, 'trash talk is not a refusal')
  assert.equal(ai.verifyChatMessage('nice loot today', {}).ok, true)

  const leak = ai.verifyChatMessage('YOUR ENTIRE RESPONSE MUST BE A SINGLE DOUBLE-QUOTED STRING. Example:', {})
  assert.equal(leak.ok, false, 'quoted prompt instructions are never chat')
  assert.match(leak.reason, /prompt/)
  assert.equal(ai.verifyChatMessage('ur base is trash lol', {}).ok, true)
})

test('the two failure modes that made AI chat unusable never reach chat', async () => {
  setEnv({ FREE_LLM_API_KEY: 'k', FREE_LLM_BASE_URL: 'http://llm.test/v1' })
  try {
    // A quoted persona refusal passed every old check — now it is skipped.
    const refusal = mockFetch([
      { data: { choices: [{ message: { content: '"im not redstonepro i cant do that"' } }] } },
      { data: { choices: [{ message: { content: '"im just an ai"' } }] } },
      { data: { choices: [{ message: { content: '"as an ai i wont help"' } }] } }
    ])
    await assert.rejects(
      ai.callFreeLLMChat([], 'BotA', { fetchImpl: refusal.fn }),
      (err) => {
        assert.match(err.message, /no verifiable message/)
        assert.match(err.message, /persona refusal/)
        return true
      }
    )

    // Reasoning that only quotes the room back used to echo the player —
    // now the turn is skipped and reported instead.
    const echo = mockFetch([
      { data: { choices: [{ message: { content: 'First, the user said: "hello anyone on?". I need to respond as RedStonePro.' } }] } },
      { data: { choices: [{ message: { content: 'Thinking… the player said "hello anyone on?" so…' } }] } },
      { data: { choices: [{ message: { content: '"hello anyone on?"' } }] } }
    ])
    await assert.rejects(
      ai.callFreeLLMChat(['Steve: hello anyone on?'], 'BotA', { fetchImpl: echo.fn }),
      (err) => {
        assert.match(err.message, /no verifiable message/)
        assert.match(err.message, /echo/)
        return true
      }
    )

    // Truncated reasoning can end on a quoted instruction fragment — that is
    // prompt leakage, never a message (the live model really produced this).
    const leak = mockFetch([
      { data: { choices: [{ message: { content: 'The instructions: "YOUR ENTIRE RESPONSE MUST BE A SINGLE DOUBLE-QUOTED STRING. Example: "nice loot today"" So we need' } }] } },
      { data: { choices: [{ message: { content: 'Remember: "Respond in 15 words or less" and "NO meta-commentary"' } }] } },
      { data: { choices: [{ message: { content: 'So the reply must be "a single double-quoted string, exactly".' } }] } }
    ])
    await assert.rejects(
      ai.callFreeLLMChat([], 'BotA', { fetchImpl: leak.fn }),
      (err) => {
        assert.match(err.message, /no verifiable message/)
        assert.match(err.message, /prompt/)
        return true
      }
    )
  } finally {
    restoreEnv()
  }
})

test('verifyChatMessage gates what may reach public chat', () => {
  // Cleanup: color codes stripped, whitespace collapsed, unicode intact.
  const ok = ai.verifyChatMessage('  nice \u00a7btoday  ')
  assert.equal(ok.ok, true)
  assert.equal(ok.message, 'nice today')
  const uni = ai.verifyChatMessage('\u{1D4AE}\u{1D4FC}\u{1D4F9}\u{1D4F9}\u{1D502}')
  assert.equal(uni.ok, true)
  assert.equal(uni.message, '\u{1D4AE}\u{1D4FC}\u{1D4F9}\u{1D4F9}\u{1D502}')

  assert.equal(ai.verifyChatMessage('   ').ok, false, 'empty after cleanup')
  assert.equal(ai.verifyChatMessage(null).ok, false)
  // A message that looks like a command is the /all typo exposure — refused.
  assert.equal(ai.verifyChatMessage('/server lifesteal').ok, false)
  assert.equal(ai.verifyChatMessage('.server lifesteal').ok, false)
  assert.equal(ai.verifyChatMessage('one two three four five six', { maxWords: 5 }).ok, false, 'word limit')
  assert.equal(ai.verifyChatMessage('x'.repeat(300)).ok, false, 'length limit')
})

test('buildUserPrompt carries the last 5 chat lines, oldest first', () => {
  const prompt = ai.buildUserPrompt(['m1', 'm2', 'm3', 'm4', 'm5', 'm6'])
  assert.equal(prompt.includes('m1'), false, 'the oldest line falls out of the window')
  assert.match(prompt, /1\. m2/)
  assert.match(prompt, /5\. m6/)
  const quiet = ai.buildUserPrompt([])
  assert.match(quiet, /chat has been quiet/)
})

test('callFreeLLMChat passes the chat context, the configured model, and returns the verified quote', async () => {
  setEnv({ FREE_LLM_API_KEY: 'k', FREE_LLM_BASE_URL: 'http://llm.test/v1', AI_CHAT_MODEL: 'auto:fast' })
  try {
    const { fn, calls } = mockFetch([{ data: { choices: [{ message: { content: '"yeah thats bad"' } }] } }])
    const msg = await ai.callFreeLLMChat(['Steve: hi', 'Alex: trade?'], 'BotA', { fetchImpl: fn })
    assert.equal(msg, 'yeah thats bad')
    assert.equal(calls[0].url, 'http://llm.test/v1/chat/completions')
    assert.equal(calls[0].body.model, 'auto:fast', 'AI_CHAT_MODEL is used, not hardcoded')
    const user = calls[0].body.messages[1].content
    assert.match(user, /Steve: hi/)
    assert.match(user, /Alex: trade\?/)
  } finally {
    restoreEnv()
  }
})

test('a turn with no verifiable message is skipped, never replaced by a canned line', async () => {
  setEnv({ FREE_LLM_API_KEY: 'k', FREE_LLM_BASE_URL: 'http://llm.test/v1' })
  try {
    const { fn, calls } = mockFetch([
      { data: { choices: [{ message: { content: 'Sure! Here is text with no quotes at all' } }] } },
      { data: { choices: [{ message: { content: '"/server lifesteal"' } }] } },
      { data: { choices: [{ message: { content: '"one two three four five six"' } }] } }
    ])
    await assert.rejects(
      ai.callFreeLLMChat([], 'BotA', { fetchImpl: fn, maxWords: 5 }),
      /no verifiable message/
    )
    assert.equal(calls.length, 3, 'every attempt was a real generation')
  } finally {
    restoreEnv()
  }
})

test('the full response goes to onResponse while only the verified quote is returned for sending', async () => {
  setEnv({ FREE_LLM_API_KEY: 'k', FREE_LLM_BASE_URL: 'http://llm.test/v1' })
  try {
    const seen = []
    const { fn } = mockFetch([
      { data: { choices: [{ message: { content: 'Sure! "one two three four five six" ok' } }] } },
      { data: { choices: [{ message: { content: '"ok pal"' } }] } }
    ])
    const msg = await ai.callFreeLLMChat([], 'BotA', { fetchImpl: fn, maxWords: 5, onResponse: raw => seen.push(raw) })
    assert.equal(msg, 'ok pal', 'only the verified quote is returned for sending')
    assert.deepEqual(seen, [
      'Sure! "one two three four five six" ok',
      '"ok pal"'
    ], 'every full response is shown, including the rejected one')
  } finally {
    restoreEnv()
  }
})

test('a display hook that throws cannot fail the turn', async () => {
  setEnv({ FREE_LLM_API_KEY: 'k', FREE_LLM_BASE_URL: 'http://llm.test/v1' })
  try {
    const { fn } = mockFetch([{ data: { choices: [{ message: { content: '"ok pal"' } }] } }])
    const msg = await ai.callFreeLLMChat([], 'BotA', {
      fetchImpl: fn,
      onResponse: () => { throw new Error('display exploded') }
    })
    assert.equal(msg, 'ok pal', 'the verified message still goes out')
  } finally {
    restoreEnv()
  }
})

test('a model that fails or errors on every attempt is reported as a model failure, never silently skipped', async () => {
  setEnv({ FREE_LLM_API_KEY: 'k', FREE_LLM_BASE_URL: 'http://llm.test/v1' })
  try {
    // HTTP failures all three attempts.
    const http = mockFetch([
      { ok: false, status: 500 },
      { ok: false, status: 500 },
      { ok: false, status: 500 }
    ])
    await assert.rejects(
      ai.callFreeLLMChat([], 'BotA', { fetchImpl: http.fn }),
      (err) => {
        assert.match(err.message, /model failed/, 'the error says the model failed')
        assert.match(err.message, /HTTP 500/)
        assert.equal(err.code, 'AI_CHAT_MODEL_FAILED')
        return true
      }
    )
    assert.equal(http.calls.length, 3, 'every attempt was tried before erroring')

    // An error payload delivered with HTTP 200 is a model error too.
    const payload = mockFetch([
      { data: { error: { message: 'upstream exploded' } } },
      { data: { error: { message: 'upstream exploded' } } },
      { data: { error: { message: 'upstream exploded' } } }
    ])
    await assert.rejects(
      ai.callFreeLLMChat([], 'BotA', { fetchImpl: payload.fn }),
      (err) => {
        assert.match(err.message, /model failed/)
        assert.match(err.message, /upstream exploded/, 'the upstream error text is preserved')
        return true
      }
    )

    // An empty response every attempt is a failure, not a silent skip.
    const empty = mockFetch([
      { data: { choices: [{ message: { content: '' } }] } },
      { data: { choices: [{ message: { content: '' } }] } },
      { data: { choices: [{ message: { content: '' } }] } }
    ])
    await assert.rejects(
      ai.callFreeLLMChat([], 'BotA', { fetchImpl: empty.fn }),
      (err) => {
        assert.match(err.message, /model failed/)
        assert.match(err.message, /empty response/)
        return true
      }
    )
  } finally {
    restoreEnv()
  }
})

test('unverified and unusable attempts are retried within the same turn', async () => {
  setEnv({ FREE_LLM_API_KEY: 'k', FREE_LLM_BASE_URL: 'http://llm.test/v1' })
  try {
    const { fn, calls } = mockFetch([
      { data: { choices: [{ message: { content: '"one two three four five six"' } }] } },
      { data: { choices: [{ message: { content: '"ok pal"' } }] } }
    ])
    const msg = await ai.callFreeLLMChat([], 'BotA', { fetchImpl: fn, maxWords: 5 })
    assert.equal(msg, 'ok pal')
    assert.equal(calls.length, 2)
  } finally {
    restoreEnv()
  }
})

test('falls back to /responses when the server only speaks that dialect', async () => {
  setEnv({ FREE_LLM_API_KEY: 'k', FREE_LLM_BASE_URL: 'http://llm.test/v1' })
  try {
    const { fn, calls } = mockFetch([
      { ok: false, status: 404 },
      { data: { outputs: [{ text: '"ok pal"' }] } }
    ])
    const msg = await ai.callFreeLLMChat([], 'BotA', { fetchImpl: fn })
    assert.equal(msg, 'ok pal')
    assert.equal(calls[0].url.endsWith('/chat/completions'), true)
    assert.equal(calls[1].url.endsWith('/responses'), true)
  } finally {
    restoreEnv()
  }
})

test('without credentials the turn reports the configuration problem', async () => {
  setEnv({ FREE_LLM_API_KEY: undefined, FREE_LLM_BASE_URL: undefined })
  try {
    await assert.rejects(
      ai.callFreeLLMChat([], 'BotA', { fetchImpl: async () => { throw new Error('should not fetch') } }),
      /not configured/
    )
  } finally {
    restoreEnv()
  }
})
