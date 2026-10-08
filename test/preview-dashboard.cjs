'use strict'
// Only renders the dashboard template; never evaluates bot startup.
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const source = fs.readFileSync(path.join(__dirname, '..', 'bot.js'), 'utf8')
const begin = source.indexOf('const PAGE_HTML = ')
const end = source.indexOf('// ── Web GUI server', begin)
const html = vm.runInNewContext(source.slice(begin, end) + '\nPAGE_HTML', { DASHBOARD_TITLE: 'Offline regression preview', WEB_REFRESH_MS: 2000 })
const mock = `<script>
window.previewCommands=[];
window.WebSocket=class {
 constructor(){this.readyState=1;setTimeout(()=>{this.onopen&&this.onopen();this.onmessage&&this.onmessage({data:JSON.stringify({t:'hello',commands:{'/start-login':'Offline fixture only','/start-rtp':'Offline fixture only'},cmdHistory:[],bots:[{id:'PreviewBot',online:true,logs:[]}],stats:{bots:1,online:1},terminalEnabled:true})})},50)}
 send(text){const m=JSON.parse(text);window.previewCommands.push(m);if(m.t==='terminal'&&m.action==='open')this.onmessage({data:JSON.stringify({t:'terminal',data:'Offline terminal fixture — no SSH session.\\n'})});if(m.t==='terminal'&&m.action==='input')this.onmessage({data:JSON.stringify({t:'terminal',data:m.data})})}
 close(){this.readyState=3}
};
window.fetch=async url=>({ok:true,json:async()=>url.includes('settings')?{groups:[{group:'Test',rows:[{key:'TEST_VALUE',type:'string',live:true,value:'',secret:false}]}],overrides:0}:{sections:[],bots:[],stats:{},lines:[]}});
</script>`
const directory = path.join(__dirname, '.preview')
fs.mkdirSync(directory, { recursive: true })
fs.writeFileSync(path.join(directory, 'dashboard.html'), html.replace('<script>', mock + '<script>'))
console.log('Offline dashboard fixture generated: test/.preview/dashboard.html')
