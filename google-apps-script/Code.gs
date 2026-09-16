function doPost(e) {
  var body = JSON.parse(e.postData.contents || '{}');
  var ss = SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID'));
  replaceSheet_(ss, 'Bots', body.bots || []);
  replaceSheet_(ss, 'Spawners', body.spawners || []);
  replaceSheet_(ss, 'Lifetime', [body.lifetime || {}]);
  return ContentService.createTextOutput(JSON.stringify({ ok: true }))
    .setMimeType(ContentService.MimeType.JSON);
}

function replaceSheet_(ss, name, rows) {
  var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  sheet.clearContents();
  if (!rows.length) return;
  var headers = Object.keys(rows[0]);
  var values = [headers];
  rows.forEach(function(row) {
    values.push(headers.map(function(key) {
      var value = row[key];
      return value && typeof value === 'object' ? JSON.stringify(value) : value == null ? '' : value;
    }));
  });
  sheet.getRange(1, 1, values.length, headers.length).setValues(values);
  sheet.setFrozenRows(1);
}

// Run once in the Apps Script editor before deploying:
function setSpreadsheetId() {
  PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', 'PASTE_SPREADSHEET_ID_HERE');
}
