

/* =========================================================

   AYARLAR

   ========================================================= */

const SERVER_API_BASE = window.SERVER_API_BASE || '/api';
const ENC_SALT = "hesap-kasasi-salt";

const AUTH_STORAGE_KEY = "hesap_kasasi_auth_token";

const FAILED_LOGIN_STORAGE_KEY = "hesap_kasasi_failed_login_log";

const SAYFA_BASI = 20;

const POLL_MS = 20000; // SSE yedek yoklama süresi



const RUTBELER = ["Unranked","Rookie","Bronze","Silver","Gold","Platinum","Diamond"];

const DETAYLI_RUTBELER = ["Unranked","Rookie 4","Rookie 3","Rookie 2","Rookie 1","Bronze 4","Bronze 3","Bronze 2","Bronze 1","Silver 4","Silver 3","Silver 2","Silver 1","Gold 4","Gold 3","Gold 2","Gold 1","Platinum 4","Platinum 3","Platinum 2","Platinum 1","Diamond 4","Diamond 3","Diamond 2","Diamond 1"];

const MAIL_SITELERI = ["notletters.com","firstmail.com","rambler.ru","mail.ru","outlook.com","hotmail.com","gmail.com","yahoo.com","sfr.fr"];

const SAHIPLER = ["Osman","Orçun"];

const RANK_RENKLERI = {Gold:"#d1b26f",Platinum:"#64b5b5",Diamond:"#6da2df",Silver:"#b0b5b8",Bronze:"#b58763",Rookie:"#8fa0a6",Unranked:"#eceef0"};

const SAHIP_RENKLERI = {Osman:"#4fc3f7",Orçun:"#ffb74d",Bilinmiyor:"#eceef0"};



let hesaplar = [];

let mevcutSayfa = 0;

let SITE_PASSWORD = null;

let pollTimer = null;

let editIndex = null;

let noteIndex = null;

let currentUser = null;

let authToken = null;

let authRefreshTimer = null;

let appInitialized = false;

let filters = { q:"", rank:"", sahip:"", durum:"" };

let sortKey = "tarih";

let sortDir = -1; // -1 yeni->eski

let selected = new Set();

let lastDeleted = null;



/* ---------------- LOGIN ---------------- */

async function tryLogin(){

  const email = document.getElementById('emailInput').value.trim();

  const pw = document.getElementById('passwordInput').value.trim();

  if(!email || !pw){ showLoginError("E-posta ve şifre giriniz."); return; }



  try {

    const res = await fetch(`${SERVER_API_BASE}/login`, {

      method: 'POST',

      headers: { 'Content-Type': 'application/json' },

      body: JSON.stringify({ email, password: pw })

    });

    const data = await res.json();

    

    if(!res.ok) {

      const reason = data.error || data.message || 'Bilinmeyen';

      const ip = data.ip || 'bilinmiyor';

      saveFailedLoginAttempt(email, `Kod: ${reason}`, ip);

      showLoginError("Giriş başarısız. Bilgileri kontrol edin.");

      document.querySelector('.login-card').classList.add('shake');

      setTimeout(()=>document.querySelector('.login-card').classList.remove('shake'),350);

      return;

    }



    // E-postanın baş kısmını isim olarak al (osman@... -> Osman)

    let namePart = email.split('@')[0];

    currentUser = namePart.charAt(0).toUpperCase() + namePart.slice(1);

    

    resetCryptoKey();
    SITE_PASSWORD = pw; // Girilen şifre artık AES şifreleme anahtarımız

    authToken = data.idToken;



    // Sayfa yenilenmelerine karşı token'ı bellekte tut

    sessionStorage.setItem('hk_session', JSON.stringify({

      idToken: data.idToken,

      refreshToken: data.refreshToken,

      expiresAt: Date.now() + Number(data.expiresIn) * 1000,

      email: email,

      pw: pw

    }));



    showApp();

  } catch (e) {

    saveFailedLoginAttempt(email, e.message || 'Sunucu hatası', 'bilinmiyor');

    console.error('Login failed', e);

    showLoginError("Sunucuya bağlanılamadı.");

  }

}



function showLoginError(msg) {

  document.getElementById('loginError').textContent = msg;

}



function getAuthHeaders() {

  return authToken ? { 'Authorization': 'Bearer ' + authToken } : {};

}



function saveFailedLoginAttempt(email, reason, ip){

  const attempt = {

    user: email || 'Bilinmiyor',

    action: 'Başarısız giriş denemesi',

    detail: `${reason} | IP: ${ip}`,

    ts: Date.now(),

    tarih: nowStr(),

  };



  try{

    const stored = JSON.parse(localStorage.getItem(FAILED_LOGIN_STORAGE_KEY) || '[]');

    stored.push(attempt);

    localStorage.setItem(FAILED_LOGIN_STORAGE_KEY, JSON.stringify(stored.slice(-200)));

  }catch(e){

    console.error('Failed to save local login attempt', e);

  }

}



async function showApp(){

  document.getElementById('loginError').textContent = '';

  document.getElementById('login-screen').style.display = 'none';

  document.getElementById('app').style.display = 'block';

  document.getElementById('whoLabel').textContent = currentUser || '';

  if(!appInitialized){

    populateSelects();

    appInitialized = true;

  }



  try {

    await ensureAuthToken();

  } catch (e) {

    console.error('Auth token refresh failed', e);

    showLoginError('Oturum yenilenemedi. Lütfen tekrar giriş yapın.');

    logout();

    return;

  }



  fetchData(true);

  clearInterval(pollTimer);

  pollTimer = setInterval(() => fetchData(false), POLL_MS);

  clearInterval(authRefreshTimer);

  authRefreshTimer = setInterval(() => ensureAuthToken().catch(e => {

    console.error('Auth refresh failed', e);

    logout();

  }), 1000 * 60 * 4);

}



function logout(){

  sessionStorage.removeItem('hk_session');

  resetCryptoKey();
  SITE_PASSWORD = null;

  currentUser = null;

  authToken = null;

  clearInterval(pollTimer);

  clearInterval(authRefreshTimer);

  document.getElementById('app').style.display='none';

  document.getElementById('login-screen').style.display='flex';

}



// Otomatik Giriş Kontrolü (Sayfa yenilenince)

window.addEventListener('DOMContentLoaded', () => {

  const sessionData = JSON.parse(sessionStorage.getItem('hk_session') || 'null');

  if(sessionData){

    resetCryptoKey();
    SITE_PASSWORD = sessionData.pw;

    let namePart = sessionData.email.split('@')[0];

    currentUser = namePart.charAt(0).toUpperCase() + namePart.slice(1);

    authToken = sessionData.idToken;

    showApp();

  }

});



async function ensureAuthToken(){

  let stored = JSON.parse(sessionStorage.getItem('hk_session') || 'null');

  if(!stored) throw new Error("Oturum bulunamadı");

  

  if(stored.expiresAt > Date.now() + 60000) return stored.idToken;



  const res = await fetch(`${SERVER_API_BASE}/refresh`, {

    method:'POST',

    headers:{'Content-Type':'application/json'},

    body: JSON.stringify({ refreshToken: stored.refreshToken })

  });

  const data = await res.json();

  if(data.id_token){

    stored.idToken = data.id_token;

    stored.refreshToken = data.refresh_token;

    stored.expiresAt = Date.now() + Number(data.expires_in) * 1000;

    sessionStorage.setItem('hk_session', JSON.stringify(stored));

    return stored.idToken;

  }

  throw new Error('Token yenilenemedi');

}



/* ---------------- ŞİFRELEME (AES-GCM) ---------------- */

let cryptoKeyPromise = null;
let cryptoKeyPassword = null;

function resetCryptoKey(){

  cryptoKeyPromise = null;
  cryptoKeyPassword = null;

}

function getCryptoKey(){

  if(!SITE_PASSWORD) throw new Error('Şifreleme anahtarı için oturum parolası gerekli');

  if(cryptoKeyPromise && cryptoKeyPassword === SITE_PASSWORD) return cryptoKeyPromise;

  cryptoKeyPassword = SITE_PASSWORD;

  const enc = new TextEncoder();

  cryptoKeyPromise = crypto.subtle.importKey('raw', enc.encode(SITE_PASSWORD), {name:'PBKDF2'}, false, ['deriveKey'])

    .then(keyMaterial => crypto.subtle.deriveKey(

      {name:'PBKDF2', salt:enc.encode(ENC_SALT), iterations:100000, hash:'SHA-256'},

      keyMaterial, {name:'AES-GCM', length:256}, false, ['encrypt','decrypt']

    ));

  return cryptoKeyPromise;

}

async function encryptField(plain){

  if(!plain) return '';

  // Yeni kayıtların şifrelenmesini backend, ortak kasa anahtarıyla yapar.
  // Eski ENC kayıtları decryptField ile geriye dönük olarak okunabilir.
  return plain;

}

async function decryptField(value){

  if(!value) return '';

  if(!value.startsWith('ENC:')) return value; // backend tarafından çözülen kayıt

  try{

    const raw = atob(value.slice(4));

    const bytes = Uint8Array.from(raw, c=>c.charCodeAt(0));

    const iv = bytes.slice(0,12);

    const data = bytes.slice(12);

    const key = await getCryptoKey();

    const dec = await crypto.subtle.decrypt({name:'AES-GCM', iv}, key, data);

    return new TextDecoder().decode(dec);

  }catch(e){

    return '⚠️ çözülemedi';

  }

}



/* ---------------- FIREBASE I/O ---------------- */

function normalize(veri){

  if(!veri) return [];

  if(Array.isArray(veri)) return veri.filter(x=>x !== null);

  return Object.keys(veri).sort((a,b)=>Number(a)-Number(b)).map(k=>veri[k]);

}



async function fetchData(isInitial){

  try{

    const res = await fetch(`${SERVER_API_BASE}/hesaplar`, { headers: getAuthHeaders() });

    if(!res.ok) throw new Error('HTTP '+res.status);

    const data = normalize(await res.json());

    const changed = JSON.stringify(data) !== JSON.stringify(hesaplar);

    if(changed || isInitial){

      hesaplar = data;

      clampPage();

      render();

    }

    setSyncStatus(true);

  }catch(e){

    console.error(e);

    setSyncStatus(false);

  }

}



async function pushData(){

  try{

    const res = await fetch(`${SERVER_API_BASE}/hesaplar`, {method:'PUT', headers:{'Content-Type':'application/json', ...getAuthHeaders()}, body:JSON.stringify(hesaplar)});

    if(!res.ok) throw new Error('HTTP '+res.status);

    setSyncStatus(true);

    return true;

  }catch(e){

    console.error(e);

    setSyncStatus(false);

    showToast('Kaydedilemedi, bağlantıyı kontrol edin');

    return false;

  }

}



function setSyncStatus(ok){

  const dot = document.getElementById('syncDot');

  const label = document.getElementById('syncLabel');

  if(ok){ dot.style.background='#4caf7a'; dot.style.boxShadow='0 0 8px #4caf7a'; label.textContent='canlı senkronize'; }

  else { dot.style.background='#e5534b'; dot.style.boxShadow='0 0 8px #e5534b'; label.textContent='bağlantı hatası'; }

}



/* ---------------- LOG (işlem geçmişi) ---------------- */

async function logAction(action, detail){

  try{

    await fetch(`${SERVER_API_BASE}/log`, {method:'POST', headers:{'Content-Type':'application/json', ...getAuthHeaders()},

      body: JSON.stringify({action, detail})});

  }catch(e){ console.error('log yazılamadı', e); }

}

async function openLog(){

  document.getElementById('logOverlay').classList.add('open');

  const list = document.getElementById('logList');

  list.innerHTML = '<div style="color:var(--text-dim);font-size:12px;">Yükleniyor…</div>';

  let entries = [];

  try{

    const res = await fetch(`${SERVER_API_BASE}/log`, {headers: getAuthHeaders()});

    if(res.ok){

      const data = await res.json();

      entries = data ? Object.values(data) : [];

    } else {

      console.error('Remote log load failed', res.status);

    }

  }catch(e){

    console.error('Remote log load failed', e);

    entries = [];

  }



  try{

    const localEntries = JSON.parse(localStorage.getItem(FAILED_LOGIN_STORAGE_KEY) || '[]');

    if(Array.isArray(localEntries)) entries = entries.concat(localEntries);

  }catch(e){

    console.error('Failed to read local failed login log', e);

  }



  entries.sort((a,b)=>(b.ts||0)-(a.ts||0));

  entries = entries.slice(0,50);

  if(!entries.length){ list.innerHTML = '<div style="color:var(--text-dim);font-size:12px;">Henüz kayıt yok.</div>'; return; }

  list.innerHTML = entries.map(e=>`

      <div class="log-entry${e.action === 'Başarısız giriş denemesi' ? ' failed' : ''}">

        <span class="who ${escapeHtml(e.user||'')}">${escapeHtml(e.user||'Bilinmiyor')}</span> — ${escapeHtml(e.action||'')}

        <div>${escapeHtml(e.detail||'')}</div>

        <div class="meta">${escapeHtml(e.tarih||'')}</div>

      </div>`).join('');

}

function closeLog(){ document.getElementById('logOverlay').classList.remove('open'); }



/* ---------------- HELPERS ---------------- */

function populateSelects(){

  fillSelect('in_rank', RUTBELER);

  fillSelect('in_site', MAIL_SITELERI);

  fillSelect('in_sahip', SAHIPLER);

  fillSelect('ed_rank', DETAYLI_RUTBELER);

  fillSelect('ed_site', MAIL_SITELERI);

  fillSelect('ed_sahip', SAHIPLER);

  fillSelect('f_rank', RUTBELER, true);

  fillSelect('f_sahip', SAHIPLER, true);



  document.getElementById('f_search').addEventListener('input', e=>{ filters.q = e.target.value; mevcutSayfa=0; render(); });

  document.getElementById('f_rank').addEventListener('change', e=>{ filters.rank = e.target.value; mevcutSayfa=0; render(); });

  document.getElementById('f_sahip').addEventListener('change', e=>{ filters.sahip = e.target.value; mevcutSayfa=0; render(); });

  document.getElementById('f_durum').addEventListener('change', e=>{ filters.durum = e.target.value; mevcutSayfa=0; render(); });



  document.querySelectorAll('th.sortable').forEach(th=>{

    th.addEventListener('click', ()=>{

      const key = th.dataset.sort;

      if(sortKey === key) sortDir *= -1; else { sortKey = key; sortDir = 1; }

      updateSortArrows();

      render();

    });

  });

  updateSortArrows();

}

function fillSelect(id, values, keepFirst){

  const el = document.getElementById(id);

  const optHtml = values.map(v=>`<option value="${v}">${v}</option>`).join('');

  el.innerHTML = keepFirst ? el.innerHTML + optHtml : optHtml;

}

function updateSortArrows(){

  ['tarih','mail','rank','sahip'].forEach(k=>{

    const el = document.getElementById('arrow_'+k);

    if(!el) return;

    el.textContent = (sortKey===k) ? (sortDir===1 ? '▲' : '▼') : '';

  });

}

function nowStr(){

  const d = new Date();

  const pad = n=>String(n).padStart(2,'0');

  return `${pad(d.getDate())}.${pad(d.getMonth()+1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

}

function parseTarih(t){

  if(!t) return 0;

  const m = t.match(/(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2})/);

  if(!m) return 0;

  return new Date(m[3],m[2]-1,m[1],m[4],m[5]).getTime();

}

function showToast(msg, actionLabel, actionFn){

  const t = document.getElementById('toast');

  document.getElementById('toastMsg').textContent = msg;

  const btn = document.getElementById('toastAction');

  if(actionLabel && actionFn){ btn.style.display='inline'; btn.textContent = actionLabel; btn.onclick = ()=>{ actionFn(); t.classList.remove('show'); }; }

  else { btn.style.display='none'; btn.onclick = null; }

  t.classList.add('show');

  clearTimeout(t._timer);

  t._timer = setTimeout(()=>t.classList.remove('show'), actionLabel?5000:1600);

}

function copyText(text,label){

  if(!text) return;

  navigator.clipboard.writeText(text).then(()=>showToast(`${label} kopyalandı`)).catch(()=>showToast('Kopyalanamadı'));

}



/* ---------------- PASSWORD GENERATOR ---------------- */

function generatePassword(){

  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

  let pw = '';

  for(let i=0;i<12;i++) pw += chars[Math.floor(Math.random()*chars.length)];

  document.getElementById('genPwDisplay').textContent = pw;

  navigator.clipboard.writeText(pw).catch(()=>{});

  showToast('Şifre üretildi ve kopyalandı');

}



/* ---------------- ADD ---------------- */

async function addAccount(){

  const mail = document.getElementById('in_mail').value.trim();

  const ea_pw = document.getElementById('in_ea_pw').value.trim();

  const mail_pw = document.getElementById('in_mail_pw').value.trim();

  const rank = document.getElementById('in_rank').value || 'Unranked';

  const site = document.getElementById('in_site').value || 'Bilinmiyor';

  const sahip = document.getElementById('in_sahip').value || 'Bilinmiyor';



  if(!mail || !ea_pw){ showToast('Mail ve EA Şifresi boş bırakılamaz'); return; }



  const [ea_enc, mail_enc] = await Promise.all([encryptField(ea_pw), encryptField(mail_pw)]);



  hesaplar.push({

    mail, ea_pw: ea_enc, mail_pw: mail_enc, rank, site, sahip,

    ban:false, ilanda:false, satildi:false,

    tarih: nowStr(), not:'', ekleyen: currentUser

  });



  const ok = await pushData();

  if(ok){

    document.getElementById('in_mail').value='';

    document.getElementById('in_ea_pw').value='';

    document.getElementById('in_mail_pw').value='';

    render();

    showToast('Hesap eklendi');

    logAction('Hesap eklendi', mail);

  }

}



/* ---------------- TOGGLE / DELETE ---------------- */

async function toggleDurum(index, key){

  hesaplar[index][key] = !hesaplar[index][key];

  render();

  const ok = await pushData();

  if(ok) logAction('Durum değişti', `${hesaplar[index].mail}: ${key} = ${hesaplar[index][key]}`);

}



async function deleteAccount(index){

  if(!confirm(`${hesaplar[index].mail} hesabını silmek istediğinize emin misiniz?`)) return;

  const removed = hesaplar[index];

  hesaplar.splice(index,1);

  selected.delete(index);

  const ok = await pushData();

  if(ok){

    lastDeleted = {item:removed, index};

    render();

    showToast('Hesap silindi', 'Geri Al', undoDelete);

    logAction('Hesap silindi', removed.mail);

  }

}

async function undoDelete(){

  if(!lastDeleted) return;

  hesaplar.splice(lastDeleted.index, 0, lastDeleted.item);

  const item = lastDeleted.item;

  lastDeleted = null;

  const ok = await pushData();

  if(ok){ render(); showToast('Geri alındı'); logAction('Silme geri alındı', item.mail); }

}



/* ---------------- BULK ---------------- */

function toggleSelectAll(cb){

  const displayed = getDisplayedList();

  if(cb.checked) displayed.forEach(({idx})=>selected.add(idx));

  else displayed.forEach(({idx})=>selected.delete(idx));

  render();

}

function toggleSelectRow(idx, checked){

  if(checked) selected.add(idx); else selected.delete(idx);

  updateBulkBar();

}

function clearSelection(){ selected.clear(); render(); }

function updateBulkBar(){

  const bar = document.getElementById('bulkBar');

  const count = selected.size;

  document.getElementById('bulkCount').textContent = `${count} seçili`;

  bar.classList.toggle('show', count>0);

}

async function bulkMarkSold(){

  if(!selected.size) return;

  selected.forEach(idx=>{ if(hesaplar[idx]) hesaplar[idx].satildi = true; });

  const ok = await pushData();

  if(ok){ logAction('Toplu işlem', `${selected.size} hesap satıldı olarak işaretlendi`); selected.clear(); render(); showToast('İşaretlendi'); }

}

async function bulkDelete(){

  if(!selected.size) return;

  if(!confirm(`${selected.size} hesabı silmek istediğinize emin misiniz?`)) return;

  const idxs = Array.from(selected).sort((a,b)=>b-a);

  idxs.forEach(idx=>hesaplar.splice(idx,1));

  selected.clear();

  const ok = await pushData();

  if(ok){ logAction('Toplu silme', `${idxs.length} hesap silindi`); render(); showToast('Silindi'); }

}



/* ---------------- EDIT MODAL ---------------- */

async function openEditModal(index){

  editIndex = index;

  const h = hesaplar[index];

  const [ea_plain, mail_plain] = await Promise.all([decryptField(h.ea_pw), decryptField(h.mail_pw)]);

  document.getElementById('ed_mail').value = h.mail || '';

  document.getElementById('ed_ea_pw').value = ea_plain;

  document.getElementById('ed_mail_pw').value = mail_plain;

  document.getElementById('ed_rank').value = h.rank || 'Unranked';

  document.getElementById('ed_site').value = h.site || MAIL_SITELERI[0];

  document.getElementById('ed_sahip').value = h.sahip || SAHIPLER[0];

  document.getElementById('editModal').classList.add('open');

}

async function saveEdit(){

  const mail = document.getElementById('ed_mail').value.trim();

  const ea_pw = document.getElementById('ed_ea_pw').value.trim();

  if(!mail || !ea_pw){ showToast('Mail ve EA Şifresi boş bırakılamaz'); return; }

  const mail_pw = document.getElementById('ed_mail_pw').value.trim();



  try{

    const res = await fetch(`${SERVER_API_BASE}/hesaplar`, { headers: getAuthHeaders() });

    const guncel = normalize(await res.json());

    if(guncel.length) hesaplar = guncel;

  }catch(e){}



  if(editIndex >= hesaplar.length){ showToast('Bu hesap artık mevcut değil'); closeModal('editModal'); render(); return; }



  const h = hesaplar[editIndex];

  const [oldEaPw, oldMailPw] = await Promise.all([decryptField(h.ea_pw), decryptField(h.mail_pw)]);

  

  // Değişen verileri tespit et

  let degisiklikler = [];

  if(h.mail !== mail) degisiklikler.push(`Mail: ${h.mail} -> ${mail}`);

  if(oldEaPw !== ea_pw) degisiklikler.push(`EA Şifresi değişti`);

  if(oldMailPw !== mail_pw) degisiklikler.push(`Mail Şifresi değişti`);

  if(h.rank !== document.getElementById('ed_rank').value) degisiklikler.push(`Rank: ${h.rank} -> ${document.getElementById('ed_rank').value}`);

  if(h.site !== document.getElementById('ed_site').value) degisiklikler.push(`Site: ${h.site} -> ${document.getElementById('ed_site').value}`);

  if(h.sahip !== document.getElementById('ed_sahip').value) degisiklikler.push(`Sahip: ${h.sahip} -> ${document.getElementById('ed_sahip').value}`);



  const degisiklikMetni = degisiklikler.length > 0 ? degisiklikler.join(', ') : 'Değişiklik yok';



  const [ea_enc, mail_enc] = await Promise.all([encryptField(ea_pw), encryptField(mail_pw)]);

  hesaplar[editIndex].mail = mail;

  hesaplar[editIndex].ea_pw = ea_enc;

  hesaplar[editIndex].mail_pw = mail_enc;

  hesaplar[editIndex].rank = document.getElementById('ed_rank').value;

  hesaplar[editIndex].site = document.getElementById('ed_site').value;

  hesaplar[editIndex].sahip = document.getElementById('ed_sahip').value;



  const ok = await pushData();

  if(ok){ 

    closeModal('editModal'); 

    render(); 

    showToast('Değişiklikler kaydedildi'); 

    if(degisiklikler.length > 0) logAction('Hesap düzenlendi', `${mail} | Detay: ${degisiklikMetni}`); 

  }

}



/* ---------------- NOTE MODAL ---------------- */

async function openNoteModal(index){

  noteIndex = index;

  const plain = await decryptField(hesaplar[index].not);

  document.getElementById('noteText').value = plain;

  document.getElementById('noteModal').classList.add('open');

}

async function saveNote(){

  const yeniNot = document.getElementById('noteText').value.trim();

  try{

    const res = await fetch(`${SERVER_API_BASE}/hesaplar`, { headers: getAuthHeaders() });

    const guncel = normalize(await res.json());

    if(guncel.length) hesaplar = guncel;

  }catch(e){}

  if(noteIndex >= hesaplar.length){ showToast('Bu hesap artık mevcut değil'); closeModal('noteModal'); render(); return; }



  const h = hesaplar[noteIndex];

  

  // Eski notu çöz ve kıyasla

  const eskiNotPlain = await decryptField(h.not);

  const gorunenEskiNot = eskiNotPlain ? eskiNotPlain : "(boş?)";

  const gorunenYeniNot = yeniNot ? yeniNot : "(boş?)";



  hesaplar[noteIndex].not = await encryptField(yeniNot);

  const ok = await pushData();

  

  if(ok){ 

    closeModal('noteModal'); 

    render(); 

    showToast('Not kaydedildi'); 

    logAction('Not güncellendi', `${h.mail} | Eski: "${gorunenEskiNot}" -> Yeni: "${gorunenYeniNot}"`); 

  }

}

function closeModal(id){ document.getElementById(id).classList.remove('open'); }



/* ---------------- REVEAL CREDENTIAL ---------------- */

async function revealAndCopy(el, encryptedValue, label){

  const plain = await decryptField(encryptedValue);

  copyText(plain, label);

  el.textContent = plain || '(boş?)';

  el.classList.add('revealed');

  clearTimeout(el._hideTimer);

  el._hideTimer = setTimeout(()=>{

  el.textContent = '•'.repeat(8);

    el.classList.remove('revealed');

  },2500);

}



/* ---------------- EXPORT ---------------- */

function exportTxt(){

  const list = getDisplayedList().map(x=>x.h);

  if(!list.length){ showToast('Dışa aktarılacak hesap yok'); return; }

  decryptAll(list).then(plainList=>{

    const lines = plainList.map(h=>`${h.mail||''}|${h.ea_pw||''}|${h.mail_pw||''}|${h.rank||'Unranked'}|${h.site||'Bilinmiyor'}|${h.sahip||'Bilinmiyor'}`);

    downloadBlob(lines.join('\n'), `hesap_listesi_${Date.now()}.txt`, 'text/plain;charset=utf-8');

  });

}

function exportCsv(){

  const list = getDisplayedList().map(x=>x.h);

  if(!list.length){ showToast('Dışa aktarılacak hesap yok'); return; }

  decryptAll(list).then(plainList=>{

    const header = ['Tarih','Mail','EA Şifre','Mail Şifre','Rank','Site','Sahip','Ban','İlan','Satıldı','Not'];

    const rows = plainList.map(h=>[h.tarih,h.mail,h.ea_pw,h.mail_pw,h.rank,h.site,h.sahip,h.ban?'Evet':'Hayır',h.ilanda?'Evet':'Hayır',h.satildi?'Evet':'Hayır',h.not].map(csvEscape).join(','));

    const csv = '\uFEFF' + [header.join(','), ...rows].join('\r\n');

    downloadBlob(csv, `hesap_listesi_${Date.now()}.csv`, 'text/csv;charset=utf-8');

  });

}

function csvEscape(v){

  v = (v===undefined||v===null) ? '' : String(v);

  if(/[",\n]/.test(v)) return '"' + v.replace(/"/g,'""') + '"';

  return v;

}

async function decryptAll(list){

  const out = [];

  for(const h of list){

    out.push({...h, ea_pw: await decryptField(h.ea_pw), mail_pw: await decryptField(h.mail_pw), not: await decryptField(h.not)});

  }

  return out;

}

function downloadBlob(content, filename, type){

  const blob = new Blob([content], {type});

  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');

  a.href = url; a.download = filename; a.click();

  URL.revokeObjectURL(url);

}



/* ---------------- FILTER / SORT / PAGINATE ---------------- */

function getFilteredSorted(){

  let list = hesaplar.map((h, idx)=>({h, idx}));

  if(filters.q) list = list.filter(({h})=>(h.mail||'').toLowerCase().includes(filters.q.toLowerCase()));

  if(filters.rank) list = list.filter(({h})=>(h.rank||'').split(' ')[0] === filters.rank);

  if(filters.sahip) list = list.filter(({h})=>h.sahip === filters.sahip);

  if(filters.durum === 'satilan') list = list.filter(({h})=>h.satildi);

  if(filters.durum === 'satilmayan') list = list.filter(({h})=>!h.satildi);

  if(filters.durum === 'ilanda') list = list.filter(({h})=>h.ilanda);

  if(filters.durum === 'ban') list = list.filter(({h})=>h.ban);



  list.sort((a,b)=>{

    let av, bv;

    if(sortKey === 'tarih'){ av = parseTarih(a.h.tarih); bv = parseTarih(b.h.tarih); }

    else { av = (a.h[sortKey]||'').toString().toLowerCase(); bv = (b.h[sortKey]||'').toString().toLowerCase(); }

    if(av < bv) return -1*sortDir;

    if(av > bv) return 1*sortDir;

    return 0;

  });

  return list;

}

function getDisplayedList(){ return getFilteredSorted(); }

function clampPage(){

  const total = getFilteredSorted().length;

  const toplamSayfa = Math.max(1, Math.ceil(total/SAYFA_BASI));

  if(mevcutSayfa >= toplamSayfa) mevcutSayfa = toplamSayfa-1;

  if(mevcutSayfa < 0) mevcutSayfa = 0;

}

function oncekiSayfa(){ if(mevcutSayfa>0){ mevcutSayfa--; render(); } }

function sonrakiSayfa(){

  const total = getFilteredSorted().length;

  const toplam = Math.max(1, Math.ceil(total/SAYFA_BASI));

  if(mevcutSayfa < toplam-1){ mevcutSayfa++; render(); }

}



/* ---------------- RENDER ---------------- */

function render(){

  const full = getFilteredSorted();

  document.getElementById('resultCount').textContent = `${full.length} / ${hesaplar.length} hesap`;



  const start = mevcutSayfa * SAYFA_BASI;

  const slice = full.slice(start, start+SAYFA_BASI);



  const tbody = document.getElementById('tableBody');

  const empty = document.getElementById('emptyState');

  tbody.innerHTML = '';

  empty.style.display = full.length ? 'none' : 'block';



  slice.forEach(({h, idx}, i)=>{

    const ownerClass = h.sahip === 'Osman' ? 'owner-osman' : (h.sahip === 'Orçun' ? 'owner-orcun' : '');

    const tr = document.createElement('tr');

    tr.className = ownerClass + (selected.has(idx) ? ' selected' : '');



    const baseRank = (h.rank||'Unranked').split(' ')[0];

    const rankColor = RANK_RENKLERI[baseRank] || '#eceef0';

    const sahipColor = SAHIP_RENKLERI[h.sahip] || '#eceef0';



    tr.innerHTML = `

      <td><input type="checkbox" ${selected.has(idx)?'checked':''} data-idx="${idx}" class="rowchk"></td>

      <td>${start+i+1}</td>

      <td class="tarih-cell">${h.tarih||'-'}</td>

      <td><span class="cred-cell" data-label="Mail">${escapeHtml(h.mail)}</span></td>

      <td><span class="cred-cell" data-enc="${escapeAttr(h.ea_pw)}" data-label="EA Şifre">${'•'.repeat(8)}</span></td>

      <td><span class="cred-cell" data-enc="${escapeAttr(h.mail_pw)}" data-label="Mail Şifre">${'•'.repeat(8)}</span></td>

      <td><span class="badge" style="color:${rankColor};background:${rankColor}22;">${h.rank||'Unranked'}</span></td>

      <td>${escapeHtml(h.site||'')}</td>

      <td><span class="badge" style="color:${sahipColor};background:${sahipColor}22;">${h.sahip||'Bilinmiyor'}</span></td>

      <td><button class="toggle-btn ${h.ban?'on ban':''}" data-key="ban">${h.ban?'✔':'☐'}</button></td>

      <td><button class="toggle-btn ${h.ilanda?'on':''}" data-key="ilanda">${h.ilanda?'✔':'☐'}</button></td>

      <td><button class="toggle-btn ${h.satildi?'on':''}" data-key="satildi">${h.satildi?'✔':'☐'}</button></td>

      <td><button class="icon-btn note ${h.not?'has':''}" data-action="note">${h.not?'Notu Gör':'Not Ekle'}</button></td>

      <td><button class="icon-btn" data-action="edit">Düzenle</button></td>

      <td><button class="icon-btn del" data-action="del">✕</button></td>

    `;



    tr.querySelector('.rowchk').addEventListener('change', e=>toggleSelectRow(idx, e.target.checked));

    tr.querySelector('[data-label="Mail"]').addEventListener('click', ()=>copyText(h.mail,'Mail'));

    tr.querySelectorAll('.cred-cell[data-enc]').forEach(el=>{

      el.addEventListener('click', ()=>revealAndCopy(el, el.dataset.enc, el.dataset.label));

    });

    tr.querySelectorAll('.toggle-btn').forEach(btn=>{

      btn.addEventListener('click', ()=>toggleDurum(idx, btn.dataset.key));

    });

    tr.querySelector('[data-action="note"]').addEventListener('click', ()=>openNoteModal(idx));

    tr.querySelector('[data-action="edit"]').addEventListener('click', ()=>openEditModal(idx));

    tr.querySelector('[data-action="del"]').addEventListener('click', ()=>deleteAccount(idx));



    tbody.appendChild(tr);

  });



  const toplamSayfa = Math.max(1, Math.ceil(full.length/SAYFA_BASI));

  document.getElementById('pageLabel').textContent = `Sayfa ${mevcutSayfa+1} / ${toplamSayfa}`;

  document.getElementById('selectAll').checked = slice.length>0 && slice.every(({idx})=>selected.has(idx));

  updateBulkBar();

}



function escapeHtml(str){

  if(!str) return '';

  return String(str).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

}

function escapeAttr(str){ return escapeHtml(str).replace(/`/g,'&#96;'); }
