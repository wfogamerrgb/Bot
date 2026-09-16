/**
 * OpenMontage `/data` webhook — Google Apps Script endpoint.
 *
 * Setup (once):
 *   1. Paste this file into the Apps Script editor bound to (or standalone for)
 *      the target spreadsheet.
 *   2. Run the line below ONCE, with your spreadsheet id inside the quotes
 *      (Apps Script → Run → choose setSpreadsheetId, or paste it in the editor
 *      and press Run; the built-in "Execution log" confirms it).
 *        setSpreadsheetId('1AbC...your-sheet-id...XyZ')
 *      A no-argument setSpreadsheetId() from an older copy stored nothing, and
 *      openById(null) then threw on every push — that is the classic "it always
 *      fails" cause. The id is the part of the sheet URL between /d/ and /edit.
 *      (You can also hardcode SPREADSHEET_ID_OVERRIDE below instead.)
 *   3. Optional: run setWebhookSecret('...') and put the same value in the bot's
 *      DATA_WEBHOOK_SECRET .env variable.
 *   4. Deploy → New deployment → Web app (Execute as: Me, Who has access:
 *      Anyone). Copy the /exec URL into DATA_WEBHOOK_URL.
 *   5. Open that /exec URL in a browser: doGet returns a health JSON. If you see
 *      a Google sign-in page instead, the deployment is not public and bot.js
 *      cannot write to the sheet.
 *   6. Run testWrite() here to verify sheets, headers, and permissions.
 *
 * IMPORTANT — you edited this file after deploying once:
 *   Saving the code does NOT update a live web app. Deploy → Manage deployments
 *   → pencil icon on the existing deployment → Version: **New version** →
 *   Deploy. Keep the same deployment so the /exec URL in DATA_WEBHOOK_URL stays
 *   valid. "Who has access: Anyone" alone is not enough: it only works together
 *   with "Execute as: Me"; with "Execute as: User accessing the web app" an
 *   anonymous call has no permission to the spreadsheet and writes fail.
 *
 * Verify the whole path from the bot with: /data check
 *
 * Why writes used to fail silently: Apps Script answers a non-public web app
 * with an HTML login page and HTTP 200, so the bot logged a successful push
 * while the spreadsheet was never touched. doGet + the JSON error list below
 * make that visible.
 */

// Set a string here to skip the SPREADSHEET_ID script property.
var SPREADSHEET_ID_OVERRIDE = ''

var SHEET_BOTS = 'Bots'
var SHEET_SPAWNERS = 'Spawners'
var SHEET_LIFETIME = 'Lifetime'
// Apps Script rejects cells longer than 50,000 characters.
var MAX_CELL_LENGTH = 49000

function props_ () {
  return PropertiesService.getScriptProperties()
}

function spreadsheetId_ () {
  return String(SPREADSHEET_ID_OVERRIDE || props_().getProperty('SPREADSHEET_ID') || '').trim()
}

function secret_ () {
  return String(props_().getProperty('WEBHOOK_SECRET') || '').trim()
}

// GET /exec → health check. Never writes anything.
function doGet () {
  var sheetId = spreadsheetId_()
  var sheets = []
  var spreadsheetError = ''
  if (sheetId) {
    try {
      sheets = SpreadsheetApp.openById(sheetId).getSheets().map(function (sheet) { return sheet.getName() })
    } catch (err) {
      spreadsheetError = err.message
    }
  }
  return json_({
    ok: Boolean(sheetId) && !spreadsheetError,
    service: 'openmontage-data',
    version: 2,
    spreadsheetId: sheetId,
    spreadsheetError: spreadsheetError,
    sheets: sheets,
    secretRequired: Boolean(secret_()),
    historySheet: String(props_().getProperty('HISTORY_SHEET') || ''),
    time: new Date().toISOString()
  })
}

function doPost (e) {
  var sheetId = spreadsheetId_()
  if (!sheetId) {
    return json_({
      ok: false,
      errors: ['SPREADSHEET_ID is not set — run setSpreadsheetId("<spreadsheet id>") once in this editor (or fill SPREADSHEET_ID_OVERRIDE).']
    })
  }
  if (!e || !e.postData || !e.postData.contents) {
    return json_({
      ok: false,
      errors: ['No POST body received. Running doPost by hand (Run button) cannot pass a payload — use testWrite() for an in-editor smoke test.']
    })
  }

  var body
  try {
    body = JSON.parse(e.postData.contents)
  } catch (err) {
    return json_({ ok: false, errors: ['Request body is not valid JSON: ' + err.message] })
  }
  if (!body || typeof body !== 'object') {
    return json_({ ok: false, errors: ['Request body must be a JSON object with bots/spawners/lifetime keys.'] })
  }

  var expectedSecret = secret_()
  if (expectedSecret) {
    var provided = (e.parameter && e.parameter.secret) || body.secret || ''
    if (String(provided) !== expectedSecret) {
      return json_({ ok: false, errors: ['Invalid or missing secret — set DATA_WEBHOOK_SECRET in .env to the WEBHOOK_SECRET script property value.'] })
    }
  }

  var ss
  try {
    ss = SpreadsheetApp.openById(sheetId)
  } catch (err) {
    return json_({ ok: false, errors: ['Could not open spreadsheet ' + sheetId + ': ' + err.message] })
  }

  var written = {}
  var errors = []
  var plan = [
    [SHEET_BOTS, normalizeRows_(body.bots)],
    [SHEET_SPAWNERS, normalizeRows_(body.spawners)],
    [SHEET_LIFETIME, normalizeRows_(body.lifetime)]
  ]
  plan.forEach(function (entry) {
    try {
      written[entry[0]] = replaceSheet_(ss, entry[0], entry[1])
    } catch (err) {
      written[entry[0]] = 0
      errors.push(entry[0] + ': ' + err.message)
    }
  })

  try {
    var appended = appendHistory_(ss, plan[1][1])
    if (appended) written[String(props_().getProperty('HISTORY_SHEET') || 'History')] = appended
  } catch (err) {
    errors.push('history: ' + err.message)
  }

  return json_({
    ok: errors.length === 0,
    spreadsheetId: sheetId,
    generatedAt: body.generatedAt || null,
    written: written,
    errors: errors,
    time: new Date().toISOString()
  })
}

// Accepts an array of objects, a single object, or null. Non-objects are dropped
// so an unexpected payload can never throw inside the write path.
function normalizeRows_ (value) {
  if (!value) return []
  var list = Array.isArray(value) ? value : [value]
  var out = []
  list.forEach(function (row) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return
    if (Object.keys(row).length) out.push(row)
  })
  return out
}

function cell_ (value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') {
    var text
    try {
      text = JSON.stringify(value)
    } catch (_) {
      text = String(value)
    }
    return text.length > MAX_CELL_LENGTH ? text.slice(0, MAX_CELL_LENGTH) + '…' : text
  }
  if (typeof value === 'string') return value.length > MAX_CELL_LENGTH ? value.slice(0, MAX_CELL_LENGTH) + '…' : value
  return value
}

function headerUnion_ (rows) {
  var headers = []
  rows.forEach(function (row) {
    Object.keys(row).forEach(function (key) {
      if (headers.indexOf(key) === -1) headers.push(key)
    })
  })
  return headers
}

// Replaces a whole sheet with the current rows. Headers are the union of every
// row's keys, so a payload whose rows differ (a baseline row with no rate, a bot
// with no rank yet) can no longer throw mid-write and leave the sheet stale.
// Returns the number of data rows written.
function replaceSheet_ (ss, name, rows) {
  var sheet = ss.getSheetByName(name) || ss.insertSheet(name)
  var list = rows || []
  var headers = headerUnion_(list)
  if (!list.length || !headers.length) {
    sheet.clearContents()
    return 0
  }
  var values = [headers]
  list.forEach(function (row) {
    values.push(headers.map(function (key) { return cell_(row[key]) }))
  })
  sheet.clearContents()
  sheet.getRange(1, 1, values.length, headers.length).setValues(values)
  sheet.setFrozenRows(1)
  return list.length
}

// Optional append-only log, enabled only when the HISTORY_SHEET script property
// is set (e.g. "SpawnerHistory"). Uses the sheet's existing header row when it
// already has one, so it never rewrites or clears history.
function appendHistory_ (ss, rows) {
  var name = String(props_().getProperty('HISTORY_SHEET') || '').trim()
  if (!name || !rows || !rows.length) return 0
  var sheet = ss.getSheetByName(name) || ss.insertSheet(name)
  var existing = sheet.getLastRow() > 0
    ? sheet.getRange(1, 1, 1, Math.max(1, sheet.getLastColumn())).getValues()[0]
    : []
  var headers = existing.filter(function (header) { return header !== '' })
  if (!headers.length) {
    headers = ['appendedAt'].concat(headerUnion_(rows))
    sheet.getRange(1, 1, 1, headers.length).setValues([headers])
    sheet.setFrozenRows(1)
  } else if (headers[0] !== 'appendedAt') {
    // Keep the existing layout but stamp when each row was appended.
    headers = ['appendedAt'].concat(headers)
    sheet.getRange(1, 1, 1, headers.length).setValues([headers])
  }
  var stamp = new Date()
  var values = rows.map(function (row) {
    return headers.map(function (header) {
      if (header === 'appendedAt') return stamp
      return cell_(row[header])
    })
  })
  sheet.getRange(sheet.getLastRow() + 1, 1, values.length, headers.length).setValues(values)
  return values.length
}

function json_ (payload) {
  return ContentService.createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON)
}

// ── One-time setup helpers (run these from the editor) ───────────────────────

function setSpreadsheetId (id) {
  var value = String(id || '').trim()
  if (!value) throw new Error('Usage: setSpreadsheetId("<spreadsheet id>") — the ID is the long string in the sheet URL between /d/ and /edit.')
  props_().setProperty('SPREADSHEET_ID', value)
  return 'SPREADSHEET_ID set to ' + value
}

function setWebhookSecret (secret) {
  var value = String(secret || '').trim()
  if (!value) throw new Error('Usage: setWebhookSecret("<shared secret>")')
  props_().setProperty('WEBHOOK_SECRET', value)
  return 'WEBHOOK_SECRET set — put the same value in DATA_WEBHOOK_SECRET in .env'
}

function setHistorySheet (name) {
  var value = String(name || '').trim()
  if (!value) throw new Error('Usage: setHistorySheet("<sheet name>")')
  props_().setProperty('HISTORY_SHEET', value)
  return 'HISTORY_SHEET set to ' + value
}

// In-editor smoke test: writes a sample snapshot and logs the JSON result.
function testWrite () {
  var secret = secret_()
  var result = doPost({
    parameter: {},
    postData: {
      contents: JSON.stringify({
        bots: [{ bot: 'TestBot', rank: 'Member', shards: 1, coins: 2, balance: 3.5, botPosition: { x: 1, y: 2, z: 3 }, spawnerCount: 1, recordedAt: Date.now() }],
        spawners: [{ bot: 'TestBot', spawnerNumber: 1, earned: 10, lifetimeEarned: 10, ratePerHour: 120, balanceBefore: 0, balanceAfter: 10, status: 'calculated' }],
        lifetime: { totalEarned: 10, samples: 1 },
        generatedAt: new Date().toISOString(),
        secret: secret
      })
    }
  })
  Logger.log(result.getContent())
  return result.getContent()
}
