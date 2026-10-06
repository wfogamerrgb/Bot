'use strict'

/**
 * FreeLLM chat generation for /ai-chat.
 *
 * Three rules drive this file:
 *
 *   1. NO prerecorded fallback. A canned line dropped into the middle of a
 *      live conversation is worse than silence — it is what makes a bot look
 *      like a bot. If the LLM cannot produce a message, the turn is skipped
 *      and reported; the loop keeps its cadence and tries again next turn.
 *   2. The last few chat messages the bot saw are passed to the model every
 *      turn, so the reply answers what was actually said instead of blurting
 *      a non sequitur.
 *   3. Whatever the model returns is extracted from its double quotes and
 *      VERIFIED before anything is sent to the server — the verified message
 *      is the only thing that ever reaches public chat. Display is separate
 *      from sending: the model's FULL response is handed to opts.onResponse
 *      so the operator sees everything it wrote, while chat gets the quote.
 *
 * Configuration (FREE_LLM_API_KEY, FREE_LLM_BASE_URL, AI_CHAT_MODEL) is read
 * on every call from process.env: /env set and the dashboard .ENV tab write
 * process.env in memory, so a corrected key or model applies to the very next
 * turn instead of needing a restart.
 */

// How many completions one turn may burn before giving up on saying anything.
const AI_CHAT_MAX_ATTEMPTS = 3
// One request may never hang the loop forever.
const AI_CHAT_TIMEOUT_MS = 30000
// How many recent chat lines are passed to the model.
const AI_CHAT_CONTEXT_MESSAGES = 5

function aiChatConfig () {
  return {
    apiKey: (process.env.FREE_LLM_API_KEY || '').trim(),
    baseUrl: (process.env.FREE_LLM_BASE_URL || '').trim().replace(/\/+$/, ''),
    model: (process.env.AI_CHAT_MODEL || '').trim() || 'auto'
  }
}

function requireConfigured (config) {
  if (!config.apiKey || !config.baseUrl) {
    const err = new Error('AI chat is not configured: set FREE_LLM_API_KEY and FREE_LLM_BASE_URL in .env (or /env set them for this run)')
    err.code = 'AI_CHAT_NOT_CONFIGURED'
    throw err
  }
}

// System prompt template - filled in with actual bot name
function getRedstoneProSystemPrompt (botName, maxWords = 15) {
  return `You are RedStonePro, but you are playing as "${botName}" right now.
You are a hyper-aggressive Minecraft player who speaks casually with occasional grammar mistakes.

CRITICAL RULES:
- IMMEDIATELY start talking as RedStonePro. NO "Yes I understand", NO "I am now...", NO explanation. JUST speak.
- Use Minecraft slang and casual language
- Respond in ${maxWords} words or less
- Do NOT use names of players in your responses
- NO thinking, NO meta-commentary
- Be aggressive and casual
- YOUR ENTIRE RESPONSE MUST BE A SINGLE DOUBLE-QUOTED STRING. Example: "nice loot today"
- NO punctuation outside the quotes. NO extra text. NOTHING but the quoted message.
- Never begin the message with / or . — those look like commands and are rejected.

You are given the last few chat messages from the server. Answer the most recent one naturally, as if you heard it in Minecraft chat.`;
}

/** The recent-chat window, cleaned: the newest AI_CHAT_CONTEXT_MESSAGES lines. */
function chatWindow (recentChat) {
  return (Array.isArray(recentChat) ? recentChat : recentChat ? [recentChat] : [])
    .map(line => String(line ?? '').trim())
    .filter(Boolean)
    .slice(-AI_CHAT_CONTEXT_MESSAGES)
}

/** The user turn: the recent chat, verbatim, oldest first. */
function buildUserPrompt (recentChat) {
  const lines = chatWindow(recentChat)
  if (!lines.length) {
    return 'The chat has been quiet. Generate a casual Minecraft message to say in chat. Remember: ONLY output a single double-quoted string.'
  }
  return `The last ${lines.length} chat message(s) on the server, oldest first:\n` +
    lines.map((line, i) => `${i + 1}. ${line}`).join('\n') +
    '\n\nRespond naturally to the most recent message as RedStonePro. Remember: ONLY output a single double-quoted string.'
}

/**
 * Extract the quoted message from a response. A response that is exactly one
 * quoted string is the ideal; for anything messier take the LAST quoted span
 * — a reasoning model writes its deliberation first and quotes the room while
 * doing it, so the first quote is usually the echoed input and the answer is
 * the last one. (Grabbing the first span is how the bot repeated players'
 * own lines back at them.)
 */
function extractQuotedContent (text) {
  if (!text) return null;
  const whole = String(text).trim().match(/^"([^\"]*)"$/)
  if (whole) return whole[1]
  const spans = [...String(text).matchAll(/"([^\"]+)"/g)]
  return spans.length ? spans[spans.length - 1][1] : null
}

// Identity/AI refusals a model produces when it will not play the persona —
// e.g. "im not redstonepro", "I'm just an AI", "as a language model". Narrow
// on purpose: ordinary trash talk ("im not gonna lose", "im not a real
// threat") must never be caught.
const PERSONA_REFUSAL_RE = /\b(i'?(m| am)\s+(not\s+(redstone\w*|a\s+real\s+(person|human|player|one)|an?\s+(ai|assistant|language|model|bot|machine|robot|real|person|human))|(just\s+)?an?\s+(ai|assistant|language|model|bot|machine|robot|real\s+(person|human)))|as\s+an?\s+(ai|assistant|language|model|bot|machine|robot)|i\s+(can'?t|cannot|won'?t|don'?t)\s+(pretend|roleplay|impersonate|be\s+redstone\w*))/i

// A reasoning model quotes the prompt's own instructions while thinking — if
// the extracted "message" is really prompt leakage ("YOUR ENTIRE RESPONSE
// MUST BE A SINGLE DOUBLE-QUOTED STRING…"), sending it babbles the setup in
// chat. Match unmistakable prompt language only.
const PROMPT_LEAK_RE = /(entire response|double-quoted|single double|quoted string|example:|words or less|meta-commentary|punctuation outside|respond (naturally|as)|as redstonepro|your response|the (response|instructions?|rules?)\b)/i

// Echo detection compares skeletons (lowercased, punctuation stripped) and
// also the line's message part with a "Steve: " speaker prefix cut off, so a
// model quoting the room back cannot masquerade as a reply.
function normalizeForEcho (text) {
  return String(text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '')
}
function echoesSome (message, lines) {
  const needle = normalizeForEcho(message)
  if (!needle) return false
  return (Array.isArray(lines) ? lines : [lines]).some(line => {
    const bare = String(line ?? '').replace(/^\s*[^:]{1,24}:\s*/, '')
    return needle === normalizeForEcho(line) || needle === normalizeForEcho(bare)
  })
}

/**
 * Verification is the gate between the LLM and public chat: whatever survives
 * this is what every player on the server sees under the bot's name. Color
 * codes and control characters are stripped, whitespace is collapsed, and a
 * message that looks like a command (/ or .) is refused outright — the same
 * exposure a mistyped broadcast has. Two content checks close the two bugs
 * that made AI chat unusable: an ECHO of a recent chat line (reasoning models
 * quote the room mid-thought, and extracting that quote made the bot repeat
 * players verbatim) and a PERSONA REFUSAL wrapped in quotes (a model that
 * will not be RedStonePro answering "im not redstonepro" — format-perfect,
 * so format checks alone would pass it).
 */
function verifyChatMessage (raw, { maxWords = 15, maxLength = 256, echoesOf = [] } = {}) {
  if (raw == null) return { ok: false, reason: 'nothing quoted' }
  const message = String(raw)
    .replace(/\u00a7./g, '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!message) return { ok: false, reason: 'empty after cleanup' }
  if (message.length > maxLength) return { ok: false, reason: `longer than ${maxLength} characters` }
  const words = message.split(' ').filter(Boolean).length
  if (words > maxWords) return { ok: false, reason: `more than ${maxWords} words` }
  if (/^[/.]/.test(message)) return { ok: false, reason: 'starts with a command character' }
  if (echoesOf.length && echoesSome(message, echoesOf)) return { ok: false, reason: 'echoes a recent chat line' }
  if (PERSONA_REFUSAL_RE.test(message)) return { ok: false, reason: 'looks like a persona refusal' }
  if (PROMPT_LEAK_RE.test(message)) return { ok: false, reason: 'looks like leaked prompt text' }
  return { ok: true, message }
}

/** Pull the completion text out of whatever shape the endpoint answered with. */
function extractResponseText (endpoint, data) {
  if (!data) return ''
  if (endpoint === '/responses') {
    return String(data.outputs?.[0]?.text ?? data.output_text ?? '').trim()
  }
  return String(data.choices?.[0]?.message?.content ?? data.choices?.[0]?.text ?? '').trim()
}

async function postCompletion (fetchImpl, config, endpoint, body) {
  const response = await fetchImpl(config.baseUrl + endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(AI_CHAT_TIMEOUT_MS)
  })
  if (!response.ok) {
    const err = new Error(`FreeLLM ${endpoint} answered HTTP ${response.status}`)
    err.httpStatus = response.status
    throw err
  }
  return response.json()
}

/**
 * Call FreeLLM for one chat turn and return ONLY a verified quoted message.
 *
 * @param {string[]|string} recentChat - the last few chat lines the bot saw
 * @param {string} botName - the name to speak as
 * @param {{model?: string, maxWords?: number, attempts?: number, fetchImpl?: Function,
 *   onResponse?: (raw: string) => void}} [opts] `onResponse` receives the
 *   model's FULL response text for every attempt so the caller can show it;
 *   only the verified quote is returned
 * @returns {Promise<string>} the verified message, ready to send
 * @throws when unconfigured, the model fails or errors on every attempt
 *   (AI_CHAT_MODEL_FAILED), or no attempt produced a message that passes
 *   verification (AI_CHAT_NO_MESSAGE) — never a prerecorded fallback.
 */
async function callFreeLLMChat (recentChat = [], botName = 'the bot', opts = {}) {
  const config = aiChatConfig()
  requireConfigured(config)
  const { model, maxWords = 15, attempts = AI_CHAT_MAX_ATTEMPTS, fetchImpl, onResponse } = opts
  const doFetch = fetchImpl || fetch
  const window = chatWindow(recentChat)

  const body = {
    model: model || config.model,
    messages: [
      { role: 'system', content: getRedstoneProSystemPrompt(botName, maxWords) },
      { role: 'user', content: buildUserPrompt(recentChat) }
    ],
    // Reasoning models deliberate for hundreds of tokens before the quoted
    // answer; a small budget truncates the reply mid-thought and extraction
    // is left gambling on quoted fragments inside the reasoning. Give the
    // turn room to reach its actual answer — verification caps the words.
    max_tokens: 1200,
    temperature: 0.8
  }

  // /chat/completions is the OpenAI shape; /responses is accepted when the
  // server only speaks that dialect (404/405 on the first).
  let endpoint = '/chat/completions'
  let lastProblem = 'no response'
  let sawResponse = false // did the model answer with any text at all?
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let content = ''
    try {
      const data = await postCompletion(doFetch, config, endpoint, body)
      // Some endpoints report failure as an error payload with HTTP 200 —
      // that is a model error and must surface as one, not as an empty reply
      // that gets retried away in silence.
      if (data && data.error) {
        const detail = typeof data.error === 'string' ? data.error : (data.error.message || JSON.stringify(data.error))
        throw new Error(`FreeLLM ${endpoint} returned an error: ${detail}`)
      }
      content = extractResponseText(endpoint, data)
    } catch (error) {
      if (error.httpStatus === 404 || error.httpStatus === 405) {
        if (endpoint === '/chat/completions') {
          endpoint = '/responses'
          attempt-- // the dialect probe does not cost a real attempt
          continue
        }
      }
      lastProblem = error.message
      continue
    }
    if (!content) {
      lastProblem = 'the model returned an empty response'
      continue
    }
    sawResponse = true
    // Display is decoupled from sending: the hook sees the model's full
    // response, whatever it is, while only the verified quote below is ever
    // returned for sending. A display hook must not be able to fail a turn.
    if (onResponse) {
      try { onResponse(content) } catch (displayErr) { /* display only */ }
    }
    const quoted = extractQuotedContent(content)
    if (!quoted) {
      lastProblem = `no quoted message in: ${content.slice(0, 120)}`
      continue
    }
    const verified = verifyChatMessage(quoted, { maxWords, echoesOf: window })
    if (!verified.ok) {
      lastProblem = `quoted message rejected (${verified.reason})`
      continue
    }
    return verified.message
  }
  // A model that failed or errored is a different problem from a model that
  // answered with nothing sendable — say which one happened, and always as
  // an error so a broken model is never silently skipped.
  const err = new Error(sawResponse
    ? `AI chat produced no verifiable message after ${attempts} attempt(s) — ${lastProblem}`
    : `AI chat model failed after ${attempts} attempt(s) — ${lastProblem}`)
  err.code = sawResponse ? 'AI_CHAT_NO_MESSAGE' : 'AI_CHAT_MODEL_FAILED'
  throw err
}

// Get available models from FreeLLM API
async function getAvailableModels (opts = {}) {
  const config = aiChatConfig()
  if (!config.apiKey || !config.baseUrl) return []
  try {
    const doFetch = opts.fetchImpl || fetch
    const response = await doFetch(config.baseUrl + '/models', {
      headers: { 'Authorization': `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(AI_CHAT_TIMEOUT_MS)
    })
    if (!response.ok) return []
    const data = await response.json()
    return data?.data?.map(model => ({
      id: model.id,
      owned_by: model.owned_by || 'unknown',
      max_model_len: model.max_model_len || 0,
      description: model.description || ''
    })) || []
  } catch (error) {
    console.error('FreeLLM get models error:', error.message)
    return []
  }
}

// Generate a random delay between min and max seconds
function randomDelay (minMs, maxMs) {
  return Math.floor(Math.random() * (maxMs - minMs) + minMs)
}

// Auto AI chat handler - chats every 40-150 seconds
const AI_CHAT_INTERVAL_MIN_MS = 40 * 1000;
const AI_CHAT_INTERVAL_MAX_MS = 150 * 1000;

/**
 * Runs the AI chat loop for one bot until the caller stops it.
 *
 * @param {object} bot - the mineflayer bot instance
 * @param {(message: string) => void} send - called with each verified message
 * @param {string} botName - name to speak as
 * @param {{stop?: boolean}} [state] - when `state.stop` is true the loop exits
 * @param {(err: Error) => void} [onError] - called on every failed turn; the
 *   loop keeps going after a failure so a dead LLM does not stop the bot
 * @param {{getHistory?: () => string[], maxWords?: number, onResponse?: (raw: string) => void}} [opts] - the
 *   recent-chat window handed to the model each turn, the word limit
 *   verification enforces, and a display hook that receives the model's full
 *   response on every attempt
 */
async function autoAIChatLoop (bot, send, botName, state = {}, onError = () => {}, opts = {}) {
  const { getHistory = () => [], maxWords = 15, onResponse } = opts
  console.log('[ai-chat] Starting Auto AI Chat loop');

  while (!state.stop) {
    const delay = randomDelay(AI_CHAT_INTERVAL_MIN_MS, AI_CHAT_INTERVAL_MAX_MS);
    console.log(`[ai-chat] Waiting ${delay / 1000}s before next AI chat...`);
    await new Promise(resolve => setTimeout(resolve, delay));
    if (state.stop) break;

    let message
    try {
      message = await callFreeLLMChat(getHistory(), botName, { maxWords, onResponse })
    } catch (err) {
      // A failed turn is not a reason to stop the bot — the LLM might be down
      // for a minute. Report it and keep the cadence going. There is no
      // canned fallback: silence beats a prerecorded line pretending to be
      // part of the conversation.
      onError(err)
      continue
    }
    if (message && bot?.entity) {
      console.log(`[ai-chat] AI says: ${message}`);
      send(message);
    }
  }
}

// Export functions for use in bot.js
module.exports = {
  callFreeLLMChat,
  getAvailableModels,
  extractQuotedContent,
  verifyChatMessage,
  buildUserPrompt,
  autoAIChatLoop,
  AI_CHAT_INTERVAL_MIN_MS,
  AI_CHAT_INTERVAL_MAX_MS,
  AI_CHAT_CONTEXT_MESSAGES
};
