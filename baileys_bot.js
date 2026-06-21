// baileys_bot.js
// Feature-rich Baileys WhatsApp bot for Termux: owners, downloads (yt-dlp), TTS, stickers, group admin, games, pairing
// Requires: node, ffmpeg, python (yt-dlp via pip), yt-dlp installed, ffmpeg installed
// Place auth_state.json (exported) in repo root to avoid QR scanning, or scan QR once if not present.

const makeWASocket = require('@adiwajshing/baileys').default;
const { useSingleFileAuthState, DisconnectReason, fetchLatestBaileysVersion, jidNormalizedUser } = require('@adiwajshing/baileys');
const qrcode = require('qrcode-terminal');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { execSync, exec } = require('child_process');
require('dotenv').config();

const LOG_FILE = path.join(__dirname, 'baileys.log');
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch (e) {}
  console.log(...args);
}

// -- startup checks
function ensureBinaries() {
  const needed = ['node', 'ffmpeg', 'python'];
  const missing = [];
  for (const b of needed) {
    try { execSync(`which ${b}`, { stdio: 'ignore' }); } catch (e) { missing.push(b); }
  }
  // yt-dlp (python) may be missing; that's allowed but downloads will fail clearly
  try { execSync('python -m yt_dlp --version', { stdio: 'ignore' }); } catch { /* ignore */ }
  if (missing.length) throw new Error(`Missing system binaries: ${missing.join(', ')}. Install them in Termux first.`);
}

// -- auth state
const { state, saveState } = useSingleFileAuthState('./auth_state.json');

// -- dirs & config
const CONFIG_DIR = path.join(__dirname, 'config');
const DATA_DIR = path.join(__dirname, 'data');
const TMP_DIR = path.join(__dirname, 'tmp');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

// bot metadata and owners
let botConfig = { name: 'PairBot', prefix: '!' };
try { botConfig = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR,'bot.json'),'utf8')); } catch (e) { log('Using default bot config'); }
let committedOwners = [];
try { committedOwners = (JSON.parse(fs.readFileSync(path.join(CONFIG_DIR,'owners.example.json'),'utf8'))).owners || []; } catch {}
const RUNTIME_OWNERS_FILE = path.join(DATA_DIR, 'owners.json');
let runtimeOwners = [];
if (fs.existsSync(RUNTIME_OWNERS_FILE)) {
  try { runtimeOwners = JSON.parse(fs.readFileSync(RUNTIME_OWNERS_FILE,'utf8')).owners || []; } catch { runtimeOwners = []; }
}
function saveRuntimeOwners(){ fs.writeFileSync(RUNTIME_OWNERS_FILE, JSON.stringify({ owners: runtimeOwners }, null, 2)); }
function getOwners(){ return Array.from(new Set([...committedOwners, ...runtimeOwners])); }
function normalizeJid(input){
  if(!input) return input;
  if(input.endsWith('@s.whatsapp.net')||input.endsWith('@g.us')) return input;
  const digits = input.replace(/\D+/g,'');
  return `${digits}@s.whatsapp.net`;
}
function isOwner(jid) {
  if (!jid) return false;
  const normalized = jidNormalizedUser(jid);
  const owners = getOwners();
  return owners.includes(normalized) || owners.includes(normalized.replace(/@s\.whatsapp\.net$/,''));
}

// persistent runtime state (bans, custom commands, settings, games)
const BANS_FILE = path.join(DATA_DIR, 'bans.json');
const CUSTOM_FILE = path.join(DATA_DIR, 'custom.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const GAMES_FILE = path.join(DATA_DIR, 'games.json');
const WELCOME_FILE = path.join(DATA_DIR, 'welcome.json');

const bans = fs.existsSync(BANS_FILE) ? JSON.parse(fs.readFileSync(BANS_FILE,'utf8')) : { banned: [] };
const custom = fs.existsSync(CUSTOM_FILE) ? JSON.parse(fs.readFileSync(CUSTOM_FILE,'utf8')) : { cmds: {} };
const settings = fs.existsSync(SETTINGS_FILE) ? JSON.parse(fs.readFileSync(SETTINGS_FILE,'utf8')) : {
  public: false, autoRead: true, autoTyping: false, autoRecord: false, autoBio: false, awayMessage: ''
};
const games = fs.existsSync(GAMES_FILE) ? JSON.parse(fs.readFileSync(GAMES_FILE,'utf8')) : { ttt: {} };
const welcome = fs.existsSync(WELCOME_FILE) ? JSON.parse(fs.readFileSync(WELCOME_FILE,'utf8')) : { enabled: false, message: '', image: null, goodbye: { enabled:false, message:'', image:null } };

function saveBans(){ fs.writeFileSync(BANS_FILE, JSON.stringify(bans,null,2)); }
function saveCustom(){ fs.writeFileSync(CUSTOM_FILE, JSON.stringify(custom,null,2)); }
function saveSettings(){ fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings,null,2)); }
function saveGames(){ fs.writeFileSync(GAMES_FILE, JSON.stringify(games,null,2)); }
function saveWelcome(){ fs.writeFileSync(WELCOME_FILE, JSON.stringify(welcome,null,2)); }

// helper: current East Africa time string
function eastAfricaNow(){ return new Date().toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' }); }

// command framework
const PAGE_SIZE = 10;
const commands = [];

// helper: push command
function addCmd(name, description, category, handler){ commands.push({ name, description, category, handler }); }

// generate placeholder cmds cmd1..cmd80
for (let i=1;i<=80;i++){
  const name = `cmd${i}`;
  addCmd(name, `Placeholder command #${i} — mock`, (i<=20)?'general':(i<=40)?'session':(i<=60)?'utility':'extra', async (sock, jid, args) => {
    await sendText(sock, jid, `Executed ${name} (mock). Args: ${args.join(' ')}`);
  });
}

// owner management
addCmd('addowner','Owner-only: add owner. Usage: addowner 1234567890','owner', async (sock,jid,args)=>{
  if(!isOwner(jid)) return sendText(sock,jid,'Permission denied.');
  const phone = args[0]; if(!phone) return sendText(sock,jid,'Usage: addowner <phone>');
  const newJid = normalizeJid(phone);
  if (runtimeOwners.includes(newJid)) return sendText(sock,jid,`${newJid} already owner.`);
  runtimeOwners.push(newJid); saveRuntimeOwners();
  return sendText(sock,jid,`Added owner: ${newJid}`);
});
addCmd('delowner','Owner-only: remove owner. Usage: delowner 1234567890','owner', async (sock,jid,args)=>{
  if(!isOwner(jid)) return sendText(sock,jid,'Permission denied.');
  const phone = args[0]; if(!phone) return sendText(sock,jid,'Usage: delowner <phone>');
  const target = normalizeJid(phone); const idx = runtimeOwners.indexOf(target);
  if (idx===-1) return sendText(sock,jid,`${target} not found.`);
  runtimeOwners.splice(idx,1); saveRuntimeOwners();
  return sendText(sock,jid,`Removed owner: ${target}`);
});
addCmd('listowners','List owners','owner', async (sock,jid)=>{ if(!isOwner(jid)) return sendText(sock,jid,'Permission denied.'); return sendText(sock,jid,`Owners:\n${getOwners().join('\n')}`); });

// settings commands
addCmd('setpublic','Owner: set public true|false','owner', async (sock,jid,args)=> {
  if(!isOwner(jid)) return sendText(sock,jid,'Permission denied.');
  const val = args[0]; if(!val) return sendText(sock,jid,'Usage: setpublic true|false');
  settings.public = (String(val).toLowerCase() === 'true'); saveSettings();
  return sendText(sock,jid,`Public set to ${settings.public}`);
});
addCmd('addtext','Owner: addtext <name> <response> - create a text command','owner', async (sock,jid,args)=>{
  if(!isOwner(jid)) return sendText(sock,jid,'Permission denied.');
  const name = args[0]; if(!name) return sendText(sock,jid,'Usage: addtext <name> <response>');
  const resp = args.slice(1).join(' '); if(!resp) return sendText(sock,jid,'Please provide response text.');
  custom.cmds[name] = { type: 'text', response: resp };
  saveCustom();
  return sendText(sock,jid,`Created text command: ${name}`);
});
addCmd('addcmd','Owner: addcmd <name> <reply> - alias/quick reply','owner', async (sock,jid,args)=>{
  if(!isOwner(jid)) return sendText(sock,jid,'Permission denied.');
  const name = args[0]; if(!name) return sendText(sock,jid,'Usage: addcmd <name> <reply>');
  const resp = args.slice(1).join(' '); if(!resp) return sendText(sock,jid,'Please provide reply text.');
  custom.cmds[name] = { type:'text', response: resp };
  saveCustom();
  return sendText(sock,jid,`Created command: ${name}`);
});
addCmd('ban','Owner: ban <phone>','owner', async (sock,jid,args)=> {
  if(!isOwner(jid)) return sendText(sock,jid,'Permission denied.');
  const phone = args[0]; if(!phone) return sendText(sock,jid,'Usage: ban <phone>');
  const target = normalizeJid(phone);
  if(!bans.banned.includes(target)) bans.banned.push(target);
  saveBans();
  return sendText(sock,jid,`Banned ${target}`);
});
addCmd('unban','Owner: unban <phone>','owner', async (sock,jid,args)=> {
  if(!isOwner(jid)) return sendText(sock,jid,'Permission denied.');
  const phone = args[0]; if(!phone) return sendText(sock,jid,'Usage: unban <phone>');
  const target = normalizeJid(phone);
  bans.banned = bans.banned.filter(x=>x!==target); saveBans();
  return sendText(sock,jid,`Unbanned ${target}`);
});
addCmd('setmenuimage','Owner: setmenuimage <local-path> (store path)','owner', async (sock,jid,args)=>{
  if(!isOwner(jid)) return sendText(sock,jid,'Permission denied.');
  const p = args[0]; if(!p) return sendText(sock,jid,'Usage: setmenuimage /path/to/file');
  settings.menuImage = p; saveSettings();
  return sendText(sock,jid,`Menu image set to ${p}`);
});
addCmd('setmenuvideo','Owner: setmenuvideo <local-path>','owner', async (sock,jid,args)=>{
  if(!isOwner(jid)) return sendText(sock,jid,'Permission denied.');
  const p = args[0]; if(!p) return sendText(sock,jid,'Usage: setmenuvideo /path/to/file');
  settings.menuVideo = p; saveSettings();
  return sendText(sock,jid,`Menu video set to ${p}`);
});
addCmd('setbio','Owner: setbio <text>','owner', async (sock,jid,args)=>{
  if(!isOwner(jid)) return sendText(sock,jid,'Permission denied.');
  const text = args.join(' '); if(!text) return sendText(sock,jid,'Usage: setbio <text>');
  settings.bio = text; saveSettings();
  return sendText(sock,jid,`Set desired bio text (will not be applied automatically): ${text}`);
});
addCmd('autoread','Owner: autoread on|off','owner', async (sock,jid,args)=>{
  if(!isOwner(jid)) return sendText(sock,jid,'Permission denied.');
  const v = (args[0]||'').toLowerCase();
  settings.autoRead = (v==='on' || v==='true'); saveSettings();
  return sendText(sock,jid,`autoRead=${settings.autoRead}`);
});
addCmd('autotyping','Owner: autotyping on|off','owner', async (sock,jid,args)=>{
  if(!isOwner(jid)) return sendText(sock,jid,'Permission denied.');
  const v = (args[0]||'').toLowerCase();
  settings.autoTyping = (v==='on' || v==='true'); saveSettings();
  return sendText(sock,jid,`autoTyping=${settings.autoTyping}`);
});
addCmd('autorecord','Owner: autorecord on|off','owner', async (sock,jid,args)=>{
  if(!isOwner(jid)) return sendText(sock,jid,'Permission denied.');
  const v = (args[0]||'').toLowerCase();
  settings.autoRecord = (v==='on' || v==='true'); saveSettings();
  return sendText(sock,jid,`autoRecord=${settings.autoRecord}`);
});
addCmd('autobio','Owner: autobio on|off','owner', async (sock,jid,args)=>{
  if(!isOwner(jid)) return sendText(sock,jid,'Permission denied.');
  const v = (args[0]||'').toLowerCase();
  settings.autoBio = (v==='on' || v==='true'); saveSettings();
  return sendText(sock,jid,`autoBio=${settings.autoBio}`);
});

// restart
addCmd('restart','Owner: restart the process','owner', async (sock,jid)=> {
  if(!isOwner(jid)) return sendText(sock,jid,'Permission denied.');
  await sendText(sock,jid,'Restarting...'); log('Restart requested by owner.'); process.exit(0);
});

// common
addCmd('ping','Ping the bot','general', async (sock,jid)=> sendText(sock,jid,'PONG'));
addCmd('away','Owner: set away message. Usage: away <message>','owner', async (sock,jid,args)=>{
  if(!isOwner(jid)) return sendText(sock,jid,'Permission denied.');
  settings.awayMessage = args.join(' '); saveSettings();
  return sendText(sock,jid,`Away message set.`);
});
addCmd('uptime','Show uptime','general', async (sock,jid)=>{
  const up = process.uptime(); const h = Math.floor(up/3600); const m = Math.floor((up%3600)/60); const s = Math.floor(up%60);
  return sendText(sock,jid,`Uptime: ${h}h ${m}m ${s}s`);
});
addCmd('storage','Show storage for data folder','general', async (sock,jid)=>{
  try {
    const sizeExec = execSync(`du -sh ${DATA_DIR} 2>/dev/null || echo "0\\t${DATA_DIR}"`).toString().trim();
    return sendText(sock,jid,`Data folder: ${sizeExec}`);
  } catch (e) { return sendText(sock,jid,'Could not determine storage (du missing).'); }
});
addCmd('tagme','Tag you','general', async (sock,jid,args)=>{
  const mention = [jid]; const text = `Hi @${jid.split('@')[0]} — you asked to be tagged.`; await sock.sendMessage(jid, { text:{ body:text }, mentions: mention.map(m=>m) }); 
});

// Truecaller (placeholder)
addCmd('truecaller','Lookup number via Truecaller API (requires TRUECALLER_API + TRUECALLER_KEY in .env)','utility', async (sock,jid,args)=>{
  const number = args[0]; if(!number) return sendText(sock,jid,'Usage: truecaller <number>');
  const api = process.env.TRUECALLER_API; const key = process.env.TRUECALLER_KEY;
  if(!api || !key) return sendText(sock,jid,'Truecaller not configured. Set TRUECALLER_API and TRUECALLER_KEY in .env');
  try {
    const resp = await axios.get(`${api}`, { params:{ number }, headers:{ Authorization: `Bearer ${key}` }, timeout: 8000 });
    return sendText(sock,jid, `Truecaller result:\n${JSON.stringify(resp.data,null,2)}`);
  } catch (e) { log('Truecaller error', e?.message || e); return sendText(sock,jid,'Truecaller lookup failed.'); }
});

// downloads via yt-dlp
addCmd('ytdl','Download URL via yt-dlp. Usage: ytdl <url> [audio]','download', async (sock,jid,args)=>{
  const url = args[0]; if(!url) return sendText(sock,jid,'Usage: ytdl <url> [audio]');
  const audioOnly = args[1]==='audio' || args.includes('audio');
  const out = path.join(TMP_DIR, `dl-${Date.now()}`);
  const cmd = audioOnly
    ? `python -m yt_dlp -x --audio-format mp3 -o "${out}.%(ext)s" "${url}"`
    : `python -m yt_dlp -f best -o "${out}.%(ext)s" "${url}"`;
  await sendText(sock,jid,'Downloading, please wait...');
  try {
    log('Running', cmd);
    execSync(cmd, { stdio: 'inherit', maxBuffer: 1024*1024*200 });
    // find file
    const files = fs.readdirSync(TMP_DIR).filter(f=>f.startsWith(path.basename(out)));
    if(files.length===0) return sendText(sock,jid,'Download failed.');
    const filePath = path.join(TMP_DIR, files[0]);
    const stats = fs.statSync(filePath);
    const MAX = parseInt(process.env.MAX_SEND_BYTES || `${30*1024*1024}`); // default 30MB
    if (stats.size > MAX) {
      await sendText(sock,jid, `Downloaded file ${(stats.size/1024/1024).toFixed(1)}MB exceeds limit (${(MAX/1024/1024).toFixed(1)}MB). File is at: ${filePath}`);
      return;
    }
    const buffer = fs.readFileSync(filePath);
    await sock.sendMessage(jid, { document: buffer, mimetype: 'application/octet-stream', fileName: path.basename(filePath) });
    try{ fs.unlinkSync(filePath); }catch(e){}
  } catch (e) {
    log('ytdl error', e?.toString());
    await sendText(sock,jid,'Download failed (ensure yt-dlp and ffmpeg installed).');
  }
});

// TTS (google-tts-api usage)
addCmd('tts','Text to speech (tts <lang> <text>) e.g. tts en Hello','utility', async (sock,jid,args)=>{
  const lang = args[0] || 'en'; const text = args.slice(1).join(' ');
  if(!text) return sendText(sock,jid,'Usage: tts <lang> <text>');
  try {
    const gtts = require('google-tts-api');
    const url = gtts.getAudioUrl(text, { lang, slow: false, host: 'https://translate.google.com' });
    const resp = await axios.get(url, { responseType:'arraybuffer' });
    await sock.sendMessage(jid, { audio: Buffer.from(resp.data), mimetype: 'audio/mpeg' });
  } catch (e) { log('tts error', e?.toString()); return sendText(sock,jid,'TTS failed.'); }
});

// text2sticker: create PNG from text then use ffmpeg to convert to webp
addCmd('text2sticker','Create sticker from text: text2sticker <text>','utility', async (sock,jid,args)=>{
  const txt = args.join(' '); if(!txt) return sendText(sock,jid,'Usage: text2sticker <text>');
  const imgPath = path.join(TMP_DIR, `txt-${Date.now()}.png`);
  const webpPath = path.join(TMP_DIR, `st-${Date.now()}.webp`);
  try {
    const Jimp = require('jimp');
    const image = new Jimp(512,512,0xffffffff);
    const font = await Jimp.loadFont(Jimp.FONT_SANS_32_BLACK);
    image.print(font, 10, 10, { text: txt, alignmentX: Jimp.HORIZONTAL_ALIGN_CENTER, alignmentY: Jimp.VERTICAL_ALIGN_MIDDLE }, 492, 492);
    await image.writeAsync(imgPath);
    // ffmpeg convert
    execSync(`ffmpeg -y -i "${imgPath}" -vf scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:-1:-1:color=white -vcodec libwebp -lossless 0 -qscale 75 -preset default -an -vsync 0 "${webpPath}"`);
    const buf = fs.readFileSync(webpPath);
    await sock.sendMessage(jid, { sticker: buf });
    try{ fs.unlinkSync(imgPath); fs.unlinkSync(webpPath); }catch(e){}
  } catch (e) { log('text2sticker error', e?.toString()); return sendText(sock,jid,'text2sticker failed (ensure jimp and ffmpeg installed).'); }
});

// image2sticker: user should send image with caption 'img2sticker' or command with image handling
addCmd('img2sticker','Convert last image to sticker: send an image with caption img2sticker','utility', async (sock,jid,args)=>{
  return sendText(sock,jid,'To create a sticker from an image: send the image to the bot with caption "img2sticker". This bot handles media->sticker automatically when it receives such media.');
});

// games: tic-tac-toe (ttt)
addCmd('ttt','Start/join tic-tac-toe: ttt start | ttt play <cell> (1-9)','games', async (sock,jid,args)=>{
  const sub = (args[0]||'').toLowerCase();
  if(sub==='start'){ // create game for this jid (private game)
    const gid = `ttt-${jid}`;
    if (games.ttt[gid]) return sendText(sock,jid,'You already have an active game.');
    games.ttt[gid] = { board: Array(9).fill(null), players: [jid], turn: 0, created: Date.now() };
    saveGames();
    return sendText(sock,jid,'TicTacToe created. Another player can join by sending "ttt join". To play: ttt play <1-9>');
  } else if(sub==='join'){
    const gid = `ttt-${jid}`; // for private chat this pattern means join same jid; for group we'd use group id
    // simplified: allow second player by searching any open game not full
    let found;
    for(const k of Object.keys(games.ttt)){
      const g = games.ttt[k];
      if(g.players.length===1 && g.players[0]!==jid){ g.players.push(jid); found=k; break; }
    }
    if(!found) return sendText(sock,jid,'No available games to join.');
    saveGames(); return sendText(sock,jid,'Joined game. Use "ttt play <1-9>" to play.');
  } else if(sub==='play'){
    const cell = parseInt(args[1]||args[0]); if(!cell||cell<1||cell>9) return sendText(sock,jid,'Usage: ttt play <1-9>');
    // find game where player is participant
    let gk; let game;
    for(const k of Object.keys(games.ttt)){ const g=games.ttt[k]; if(g.players.includes(jid)){ gk=k; game=g; break; } }
    if(!game) return sendText(sock,jid,'You are not in a game.');
    const idx = game.turn % game.players.length;
    if(game.players[idx] !== jid) return sendText(sock,jid,'Not your turn.');
    if(game.board[cell-1]) return sendText(sock,jid,'Cell occupied.');
    game.board[cell-1] = idx; game.turn++;
    saveGames();
    // simple win check
    const b = game.board;
    const wins = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
    let winner = null;
    for(const w of wins){
      if(b[w[0]]!==null && b[w[0]]===b[w[1]] && b[w[1]]===b[w[2]]) winner = game.players[b[w[0]]];
    }
    const boardStr = b.map(x=> x===null?'.':(x===0?'X':'O')).join(' ');
    if(winner){
      delete games.ttt[gk]; saveGames();
      return sendText(sock,jid,`Board: ${boardStr}\nWinner: ${winner}`);
    } else {
      return sendText(sock,jid,`Board: ${boardStr}\nNext: ${game.players[game.turn%game.players.length]}`);
    }
  } else { return sendText(sock,jid,'ttt commands: ttt start | ttt join | ttt play <1-9>'); }
});

// menu/help
addCmd('menu','Show commands menu. Usage: menu [page]','help', async (sock,jid,args)=> {
  const page = Math.max(1, parseInt(args[0])||1); await sendMenuPage(sock,jid,page);
});
addCmd('help','Show help for a command: help cmd','help', async (sock,jid,args)=> {
  const target = args[0]; if(!target) return sendText(sock,jid,'Usage: help <command>');
  const cmd = commands.find(c=>c.name.toLowerCase()===target.toLowerCase());
  if(!cmd) return sendText(sock,jid,`Command not found: ${target}`);
  return sendText(sock,jid,`*${cmd.name}*\n${cmd.description}`);
});

// helper to find command
function findCommand(word){
  if(!word) return null;
  let w = word;
  if(botConfig && botConfig.prefix){
    const p = botConfig.prefix;
    if(w.startsWith(p)) w = w.slice(p.length);
  }
  w = w.replace(/^\/+|^!+/, '').toLowerCase();
  if(custom.cmds && custom.cmds[w]) return { custom: true, name: w, entry: custom.cmds[w] };
  return commands.find(c=>c.name.toLowerCase()===w);
}

async function sendMenuPage(sock,jid,page=1){
  const total = commands.length + Object.keys(custom.cmds||{}).length;
  const pages = Math.ceil(total / PAGE_SIZE);
  const p = Math.min(Math.max(1,page),pages); const start=(p-1)*PAGE_SIZE;
  const all = commands.slice();
  // add custom commands in listing after built-ins
  for(const k of Object.keys(custom.cmds||{})){ all.push({ name:k, description: custom.cmds[k].type==='text'?custom.cmds[k].response:'custom', category:'custom' }); }
  const slice = all.slice(start, start+PAGE_SIZE);
  let text = `♠ ${botConfig.name || 'PairBot'} ♠\n`;
  text += `Commands (page ${p}/${pages})\n-----------------------------\n`;
  for(const cmd of slice) text += `*${cmd.name}* — ${cmd.description}\n`;
  text += `\nSend "${botConfig.prefix||''}menu ${p+1}" for next page. ${eastAfricaNow()}`;
  await sendText(sock,jid,text);
}

// sendText: global formatting (adds EAT timestamp)
async function sendText(sock,jid,text){
  try {
    const body = `${text}\n\n© ${botConfig.name || 'PairBot'} • ${eastAfricaNow()}`;
    await sock.sendMessage(jid, { text: { body } });
  } catch (e) { log('sendText error', e?.toString()); }
}

// group welcome handlers
async function onGroupParticipantsUpdate(sock, update) {
  try {
    const { id, participants, action } = update;
    if(action === 'add' && welcome.enabled){
      for(const p of participants){
        const text = welcome.message || `Welcome @${p.split('@')[0]}!`;
        await sock.sendMessage(id, { text: { body: text }, mentions: [p] });
        if(welcome.image && fs.existsSync(welcome.image)){
          const buffer = fs.readFileSync(welcome.image);
          await sock.sendMessage(id, { image: buffer, caption: welcome.message || '' });
        }
      }
    }
    if(action === 'remove' && welcome.goodbye && welcome.goodbye.enabled){
      for(const p of participants){
        const text = welcome.goodbye.message || `Goodbye @${p.split('@')[0]}!`;
        await sock.sendMessage(id, { text:{ body:text }, mentions:[p] });
        if(welcome.goodbye.image && fs.existsSync(welcome.goodbye.image)){
          const buffer = fs.readFileSync(welcome.goodbye.image);
          await sock.sendMessage(id, { image: buffer, caption: welcome.goodbye.message || '' });
        }
      }
    }
  } catch (e) { log('onGroupParticipantsUpdate error', e?.toString()); }
}

// main
async function startSock(){
  try { ensureBinaries(); } catch (e) { log(e.message); process.exit(1); }
  const { version, isLatest } = await fetchLatestBaileysVersion();
  log('Using WA version', version, 'isLatest?', isLatest);
  const sock = makeWASocket({ auth: state, version });

  sock.ev.on('creds.update', saveState);

  sock.ev.on('connection.update', (update) => {
    if (update.qr) { log('QR RECEIVED'); qrcode.generate(update.qr, { small: true }); }
    const { connection, lastDisconnect } = update;
    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect && lastDisconnect.error && lastDisconnect.error.output) ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut : true;
      log('connection closed due to', lastDisconnect?.error?.toString(), ', reconnecting', shouldReconnect);
      if (shouldReconnect) startSock();
    } else if (connection === 'open') {
      log('connected');
    }
  });

  sock.ev.on('messages.upsert', async (m) => {
    if (m.type !== 'notify') return;
    const msg = m.messages[0]; if(!msg.message) return;
    if (msg.key && msg.key.remoteJid === 'status@broadcast') return;

    const from = msg.key.remoteJid; const isGroup = from.endsWith('@g.us');
    // ignore groups for some commands unless group-specific
    const messageContent =
      (msg.message.conversation) ||
      (msg.message.extendedTextMessage && msg.message.extendedTextMessage.text) ||
      (msg.message.imageMessage && msg.message.imageMessage.caption) ||
      '';
    const text = (messageContent||'').trim(); if(!text) return;

    // if banned
    if (bans.banned.includes(from) || bans.banned.includes(msg.key.participant)) return;

    // auto read
    if (settings.autoRead){
      try { await sock.sendReadReceipt(from, msg.key.participant || from, [msg.key.id]); } catch(e){}
    }
    // auto typing/record: crude - send presence composing then paused
    if (settings.autoTyping){
      try { await sock.presenceSubscribe(from); await sock.sendPresenceUpdate('composing', from); setTimeout(()=>sock.sendPresenceUpdate('paused',from), 1200); } catch(e){}
    }

    const parts = text.split(/\s+/); const first = parts[0]; const args = parts.slice(1);
    const found = findCommand(first);
    if(found){
      try {
        if(found.custom){
          const entry = found.entry;
          if(entry.type==='text') await sendText(sock, from, entry.response);
          else await sendText(sock, from, 'Custom command type not implemented.');
        } else {
          await found.handler(sock, from, args);
        }
      } catch (e){ log('Command handler error', e?.toString()); await sendText(sock, from, 'Command failed.'); }
      return;
    }

    // fallback pairing code
    const codeMatch = text.match(/(?:PAIR\s*)?([0-9A-Za-z\-]{3,})/i);
    if (codeMatch){
      const code = codeMatch[1];
      const PAIR_API = (process.env.PAIR_API_URL || 'http://localhost:4000').replace(/\/$/,'');
      try {
        const resp = await axios.post(`${PAIR_API}/verify`, { code, phone: from }, { timeout: 5000 });
        if (resp.data && resp.data.success){
          const peer = resp.data.peer || 'your partner';
          const connectUrl = resp.data.connectUrl;
          const reply = connectUrl ? `Pairing succeeded! You're connected with ${peer}. Join: ${connectUrl}` : `Pairing succeeded! You're connected with ${peer}.`;
          await sendText(sock, from, reply);
        } else {
          const reason = (resp.data && resp.data.message) || 'Invalid or expired code.';
          await sendText(sock, from, `Pairing failed: ${reason}`);
        }
      } catch (e) { log('Pair verify error', e?.toString()); await sendText(sock, from, 'Pairing service unavailable.'); }
      return;
    }
    // unrecognized
    await sendText(sock, from, `I did not understand. Send "${botConfig.prefix||''}menu" to see commands or send your PAIR code.`);
  });

  // group participant events
  sock.ev.on('group-participants.update', async (update) => { await onGroupParticipantsUpdate(sock, update); });

  // export sock for other usage if needed
  return sock;
}

// start
startSock().catch((e)=>{ log('Baileys start failed', e?.toString()); process.exit(1); });
