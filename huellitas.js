/* Huellitas: conexión con Supabase.
   La app fue creada como artefacto de Claude y pide sus servicios con window.claude.use('db' | 'user' | 'assets' | 'downloads').
   Este archivo entrega esos mismos servicios, pero guardando en Supabase, y agrega el inicio de sesión. */
(function () {
  'use strict';

  var SUPABASE_URL = 'https://diunajvdeodljghenrrq.supabase.co';
  var SUPABASE_KEY = 'sb_publishable_P6iAk_g3OBBs4gxspY992Q_13CKN6Sf';
  var BUCKET = 'examenes';
  var MAX_BYTES = 20 * 1024 * 1024;
  var BUCKET_TYPES = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
  var SIGN_SECONDS = 7 * 24 * 3600;
  var JSZIP = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';

  var sb = null, session = null, me = null; /* me = { id, household, name, email } */
  var signed = new Map();                   /* id de archivo -> { url, exp } */
  var collections = {};
  var readyResolve, ready = new Promise(function (r) { readyResolve = r; });

  /* ---------- utilidades ---------- */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function newId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '');
    return Date.now().toString(16) + Math.random().toString(16).slice(2, 14);
  }
  function filePath(id) { return me.household + '/' + id; }
  function el(html) { var d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstChild; }
  function loadScript(src) {
    return new Promise(function (ok, bad) { var s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = bad; document.head.appendChild(s); });
  }

  /* Busca archivos dentro de los datos: todo objeto con id y un tipo como "application/pdf" o "image/jpeg". */
  function collectFiles(value, out) {
    if (!value || typeof value !== 'object') return out;
    if (Array.isArray(value)) { value.forEach(function (v) { collectFiles(v, out); }); return out; }
    if (typeof value.id === 'string' && typeof value.type === 'string' && value.type.indexOf('/') > 0) out.push(value.id);
    Object.keys(value).forEach(function (k) { if (value[k] && typeof value[k] === 'object') collectFiles(value[k], out); });
    return out;
  }
  async function ensureSigned(datas) {
    var now = Date.now(), want = {};
    collectFiles(datas, []).forEach(function (id) {
      var s = signed.get(id);
      if (!s || s.exp - now < 24 * 3600 * 1000) want[id] = 1;
    });
    var ids = Object.keys(want);
    for (var i = 0; i < ids.length; i += 100) {
      var part = ids.slice(i, i + 100);
      try {
        var res = await sb.storage.from(BUCKET).createSignedUrls(part.map(filePath), SIGN_SECONDS);
        (res.data || []).forEach(function (row, j) {
          if (row && row.signedUrl && !row.error) signed.set(part[j], { url: row.signedUrl, exp: now + SIGN_SECONDS * 1000 });
        });
      } catch (e) { /* sin vista previa para esos archivos */ }
    }
  }

  /* ---------- datos (equivale a claude.use('db')) ---------- */
  function collection(name) {
    if (collections[name]) return collections[name];
    var cache = new Map(), subs = [], loaded = false, started = false;
    function snap() { return { docs: Array.from(cache.entries()).map(function (en) { return { id: en[0], data: function () { return en[1]; } }; }) }; }
    function emit() { subs.forEach(function (s) { try { s.ok(snap()); } catch (e) { console.error(e); } }); }
    async function fetchAll() {
      var res = await sb.from('docs').select('id,data').eq('collection', name);
      if (res.error) throw res.error;
      cache = new Map(res.data.map(function (r) { return [r.id, r.data]; }));
      await ensureSigned(res.data.map(function (r) { return r.data; }));
      loaded = true;
      emit();
    }
    function refresh() { return fetchAll().catch(function (e) { subs.forEach(function (s) { if (s.err) s.err(e); }); }); }
    async function write(id, data) {
      var res = await sb.from('docs').upsert({ household_id: me.household, collection: name, id: id, data: data, updated_at: new Date().toISOString() }, { onConflict: 'household_id,collection,id' });
      if (res.error) { refresh(); throw res.error; }
    }
    var api = {
      onSnapshot: function (ok, err) {
        subs.push({ ok: ok, err: err });
        if (!started) { started = true; refresh(); } else if (loaded) setTimeout(function () { ok(snap()); }, 0);
        return function () {};
      },
      add: function (d) { return api.doc(newId()).set(d); },
      doc: function (id) {
        return {
          set: function (d) { cache.set(id, d); emit(); return write(id, d); },
          update: function (d) { var nd = Object.assign({}, cache.get(id) || {}, d); cache.set(id, nd); emit(); return write(id, nd); },
          delete: async function () {
            cache.delete(id); emit();
            var res = await sb.from('docs').delete().eq('collection', name).eq('id', id);
            if (res.error) { refresh(); throw res.error; }
          }
        };
      },
      _refresh: refresh,
      _remote: function (type, row) {
        if (type === 'DELETE') { if (cache.delete(row.id)) emit(); return; }
        cache.set(row.id, row.data);
        ensureSigned([row.data]).then(emit);
      }
    };
    collections[name] = api;
    return api;
  }
  function refreshAll() { Object.keys(collections).forEach(function (k) { collections[k]._refresh(); }); }

  function listenChanges() {
    sb.channel('docs-' + me.household)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'docs', filter: 'household_id=eq.' + me.household }, function (p) {
        var row = p.eventType === 'DELETE' ? p.old : p.new;
        if (row && row.collection && collections[row.collection]) collections[row.collection]._remote(p.eventType, row);
      })
      .subscribe();
    /* Al volver a la app (por ejemplo, desde otra app del celular), se recargan los datos por si hubo cambios. */
    var last = Date.now();
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && Date.now() - last > 15000) refreshAll();
      last = Date.now();
    });
  }

  /* ---------- archivos (equivale a claude.use('assets')) ---------- */
  var assets = {
    upload: async function (blob, opts) {
      var type = (opts && opts.type) || blob.type || '';
      if (!BUCKET_TYPES[type]) throw { code: 'unsupported_type' };
      if (blob.size > MAX_BYTES) throw { code: 'too_large' };
      var id = newId();
      if (blob.type !== type) blob = blob.slice(0, blob.size, type);
      var res = await sb.storage.from(BUCKET).upload(filePath(id), blob, { contentType: type, upsert: false });
      if (res.error) throw { code: /size|large/i.test(res.error.message || '') ? 'too_large' : 'upload' };
      await ensureSigned([{ id: id, type: type }]);
      return { id: id, url: blobUrl(id), sizeBytes: blob.size, contentType: type };
    },
    delete: async function (id) { await sb.storage.from(BUCKET).remove([filePath(id)]); signed.delete(id); },
    list: async function () { return { assets: [], usage: {} }; }
  };
  function blobUrl(id) { var s = signed.get(id); return s ? s.url : ''; }

  /* ---------- personas (equivale a claude.use('user')) ---------- */
  var user = {
    can: function () { return Promise.resolve(true); },
    canEdit: function () { return Promise.resolve(true); },
    isOwner: function () { return Promise.resolve(true); },
    id: function () { return Promise.resolve(me.id); },
    me: function () { return Promise.resolve({ id: me.id, name: me.name }); },
    profiles: async function (ids) {
      var out = {};
      if (!ids || !ids.length) return out;
      var res = await sb.from('members').select('user_id,display_name').in('user_id', ids);
      (res.data || []).forEach(function (r) { out[r.user_id] = { id: r.user_id, name: r.display_name || '' }; });
      return out;
    }
  };

  /* ---------- descargas (equivale a claude.use('downloads')) ---------- */
  var downloads = {
    save: async function (req) {
      var blob = req.data instanceof Blob ? req.data : new Blob([req.data]);
      var url = URL.createObjectURL(blob), a = document.createElement('a');
      a.href = url; a.download = req.filename || 'archivo'; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
      return { status: 'saved' };
    }
  };

  window.claude = {
    use: function (name) {
      return ready.then(function () {
        if (name === 'db') return { collection: collection };
        if (name === 'user') return user;
        if (name === 'assets') return assets;
        if (name === 'downloads') return downloads;
        return null;
      });
    }
  };
  window.HUELLITAS = { blobUrl: blobUrl };

  /* ---------- pantallas propias: entrar, pie de página, contraseña, importar ---------- */
  var CSS = '' +
    '.hz-gate{position:fixed;inset:0;z-index:1000;display:grid;place-items:center;overflow:auto;background:radial-gradient(120% 90% at 85% 0%,#6B2E7E 0%,#3A1A4C 45%,#24102F 100%);' +
    'padding:max(24px,env(safe-area-inset-top,0px)) max(16px,env(safe-area-inset-right,0px)) max(24px,env(safe-area-inset-bottom,0px)) max(16px,env(safe-area-inset-left,0px));font-family:Inter,system-ui,-apple-system,sans-serif;color:#2A1638}' +
    '.hz-card{width:min(100%,380px);background:#FBF5EC;border-radius:28px;padding:28px 22px 22px;box-shadow:0 20px 60px rgba(0,0,0,.35);display:grid;gap:14px}' +
    '.hz-card img.hz-ic{width:84px;height:84px;border-radius:22px;justify-self:center;box-shadow:0 8px 24px rgba(36,16,47,.35)}' +
    '.hz-card h1{margin:0;text-align:center;font:600 30px/1.1 Lora,Georgia,serif;color:#24102F}' +
    '.hz-card p{margin:0;font-size:14px;line-height:1.45;color:#6B5A78}' +
    '.hz-card .hz-sub{text-align:center}' +
    '.hz-card label{display:grid;gap:5px;font-size:13px;font-weight:600;color:#2A1638}' +
    '.hz-card input,.hz-card select{font:16px Inter,system-ui,sans-serif;padding:12px 14px;border-radius:14px;border:1px solid #EADFCF;background:#fff;color:#2A1638;min-width:0}' +
    '.hz-card input:focus,.hz-card select:focus{outline:2px solid #6B2E7E;outline-offset:1px}' +
    '.hz-btn{font:600 15px Inter,system-ui,sans-serif;min-height:48px;border-radius:999px;border:0;background:#24102F;color:#FBF5EC;cursor:pointer;padding:10px 18px}' +
    '.hz-btn[disabled]{opacity:.6;cursor:default}' +
    '.hz-btn.hz-ghost{background:transparent;color:#24102F;border:1px solid #EADFCF}' +
    '.hz-err{color:#B23A17!important;font-weight:600}' +
    '.hz-ok{color:#1D6B3F!important;font-weight:600}' +
    '.hz-row{display:flex;gap:8px;flex-wrap:wrap}.hz-row>*{flex:1 1 140px}' +
    '.hz-list{display:grid;gap:10px;max-height:40vh;overflow:auto}' +
    '.hz-person{display:grid;gap:6px;padding:10px 12px;border-radius:14px;background:#F1E7DA}' +
    '.hz-foot{display:flex;flex-wrap:wrap;justify-content:center;gap:4px 14px;padding:26px 0 8px;font-size:12.5px;color:#8C7698}' +
    '.hz-foot button{border:0;background:none;padding:6px 2px;font:600 12.5px Inter,system-ui,sans-serif;color:#6B2E7E;cursor:pointer}';

  function addStyles() { var s = document.createElement('style'); s.textContent = CSS; document.head.appendChild(s); }

  function gate(inner) {
    var g = document.getElementById('hz-gate');
    if (!g) { g = el('<div class="hz-gate" id="hz-gate" role="dialog" aria-modal="true"></div>'); document.body.appendChild(g); }
    g.innerHTML = '<div class="hz-card">' + inner + '</div>';
    g.hidden = false;
    return g;
  }
  function closeGate() { var g = document.getElementById('hz-gate'); if (g) g.remove(); }

  function loginScreen(msg) {
    var g = gate(
      '<img class="hz-ic" src="icons/icon-192.png" alt="">' +
      '<h1>Huellitas</h1>' +
      '<p class="hz-sub">La salud, los horarios y los gastos de tus mascotas en un solo lugar.</p>' +
      '<form id="hz-login" style="display:grid;gap:12px" novalidate>' +
      '<label for="hz-email">Correo<input id="hz-email" type="email" autocomplete="username" inputmode="email" required></label>' +
      '<label for="hz-pass">Contraseña<input id="hz-pass" type="password" autocomplete="current-password" required></label>' +
      '<p id="hz-msg" class="hz-err" role="alert">' + esc(msg || '') + '</p>' +
      '<button class="hz-btn" type="submit">Entrar</button>' +
      '</form>' +
      '<p class="hz-sub" style="font-size:12.5px">¿Olvidaste tu contraseña? Pídele a quien administra la app que te asigne una nueva.</p>'
    );
    var f = g.querySelector('#hz-login'), m = g.querySelector('#hz-msg');
    f.addEventListener('submit', async function (e) {
      e.preventDefault();
      var email = f.querySelector('#hz-email').value.trim(), pass = f.querySelector('#hz-pass').value;
      if (!email || !pass) { m.textContent = 'Escribe tu correo y tu contraseña.'; return; }
      var b = f.querySelector('button'); b.disabled = true; b.textContent = 'Entrando…'; m.textContent = '';
      var res = await sb.auth.signInWithPassword({ email: email, password: pass });
      if (res.error) {
        b.disabled = false; b.textContent = 'Entrar';
        m.textContent = /invalid/i.test(res.error.message || '') ? 'El correo o la contraseña no coinciden.' : 'No se pudo entrar. Revisa tu conexión e intenta de nuevo.';
        return;
      }
      start(res.data.session);
    });
    if (!msg) setTimeout(function () { var i = g.querySelector('#hz-email'); if (i) i.focus(); }, 50);
  }

  function noHouseholdScreen() {
    var g = gate('<img class="hz-ic" src="icons/icon-192.png" alt=""><h1>Huellitas</h1>' +
      '<p class="hz-sub">Tu cuenta todavía no tiene un hogar asignado. Pídele a quien administra la app que te agregue.</p>' +
      '<button class="hz-btn hz-ghost" id="hz-out">Cerrar sesión</button>');
    g.querySelector('#hz-out').addEventListener('click', signOut);
  }

  async function signOut() { await sb.auth.signOut(); location.reload(); }

  function passwordScreen() {
    var g = gate('<h1 style="font-size:24px">Cambiar contraseña</h1>' +
      '<form id="hz-pw" style="display:grid;gap:12px" novalidate>' +
      '<label for="hz-p1">Nueva contraseña<input id="hz-p1" type="password" autocomplete="new-password" minlength="8"></label>' +
      '<label for="hz-p2">Repítela<input id="hz-p2" type="password" autocomplete="new-password" minlength="8"></label>' +
      '<p id="hz-pmsg" role="alert"></p>' +
      '<div class="hz-row"><button type="button" class="hz-btn hz-ghost" id="hz-pcancel">Cancelar</button><button class="hz-btn" type="submit">Guardar</button></div></form>');
    var f = g.querySelector('#hz-pw'), m = g.querySelector('#hz-pmsg');
    g.querySelector('#hz-pcancel').addEventListener('click', closeGate);
    f.addEventListener('submit', async function (e) {
      e.preventDefault();
      var a = f.querySelector('#hz-p1').value, b = f.querySelector('#hz-p2').value;
      m.className = 'hz-err';
      if (a.length < 8) { m.textContent = 'Usa al menos 8 caracteres.'; return; }
      if (a !== b) { m.textContent = 'Las dos contraseñas no coinciden.'; return; }
      var res = await sb.auth.updateUser({ password: a });
      if (res.error) { m.textContent = 'No se pudo cambiar. Intenta con otra contraseña.'; return; }
      m.className = 'hz-ok'; m.textContent = 'Contraseña actualizada.';
      setTimeout(closeGate, 1200);
    });
  }

  function footer() {
    if (document.getElementById('hz-foot')) return;
    var wrap = document.querySelector('.wrap') || document.body;
    var f = el('<footer class="hz-foot" id="hz-foot"><span>Sesión de ' + esc(me.name || me.email) + '</span>' +
      '<button type="button" id="hz-fpw">Cambiar contraseña</button>' +
      '<button type="button" id="hz-fimp">Importar respaldo</button>' +
      '<button type="button" id="hz-fout">Cerrar sesión</button></footer>');
    wrap.appendChild(f);
    f.querySelector('#hz-fpw').addEventListener('click', passwordScreen);
    f.querySelector('#hz-fimp').addEventListener('click', importScreen);
    f.querySelector('#hz-fout').addEventListener('click', signOut);
  }

  /* ---------- importar respaldo (.zip con datos.json y carpeta archivos/) ---------- */
  async function importScreen() {
    var g = gate('<h1 style="font-size:24px">Importar respaldo</h1>' +
      '<p>Elige el archivo de respaldo (.zip). Se agregan sus mascotas, registros y archivos a tu hogar. Si lo importas dos veces, no se duplica nada.</p>' +
      '<label for="hz-zip">Archivo de respaldo<input id="hz-zip" type="file" accept=".zip,application/zip"></label>' +
      '<div id="hz-iarea" style="display:grid;gap:12px"></div>' +
      '<button type="button" class="hz-btn hz-ghost" id="hz-icancel">Cerrar</button>');
    g.querySelector('#hz-icancel').addEventListener('click', closeGate);
    g.querySelector('#hz-zip').addEventListener('change', function (e) { var f = e.target.files && e.target.files[0]; if (f) readBackup(f, g.querySelector('#hz-iarea')); });
  }

  async function readBackup(file, area) {
    area.innerHTML = '<p>Leyendo el respaldo…</p>';
    try {
      if (!window.JSZip) await loadScript(JSZIP);
      var zip = await window.JSZip.loadAsync(file);
      var jf = zip.file('datos.json');
      if (!jf) throw new Error('formato');
      var data = JSON.parse(await jf.async('string'));
      if (!data || !data.collections) throw new Error('formato');
    } catch (e) {
      area.innerHTML = '<p class="hz-err">Este archivo no es un respaldo válido de la app.</p>';
      return;
    }
    var cols = data.collections, names = Object.keys(cols);
    var total = names.reduce(function (n, k) { return n + cols[k].length; }, 0);
    var files = data.files || [];
    var LABEL = { pets: 'mascotas', records: 'registros', conditions: 'patologías', expenses: 'gastos', treatments: 'tratamientos', doses: 'dosis' };
    var summary = names.map(function (k) { return cols[k].length + ' ' + (LABEL[k] || k); }).join(', ');

    /* Las dosis guardan quién las dio con un código de la app anterior: se elige a qué persona corresponde cada código. */
    var people = {};
    (cols.doses || []).forEach(function (d) {
      var by = d.data && d.data.byId;
      if (!by) return;
      var p = people[by] || (people[by] = { n: 0, last: '' });
      p.n++;
      var when = (d.data.date || '') + ' ' + (d.data.at || d.data.time || '');
      if (when > p.last) p.last = when;
    });
    var members = (await sb.from('members').select('user_id,display_name')).data || [];
    var opts = members.map(function (m) { return '<option value="' + esc(m.user_id) + '">' + esc(m.display_name || 'Sin nombre') + '</option>'; }).join('') + '<option value="">No sé / dejar sin nombre</option>';
    var pkeys = Object.keys(people);
    var peopleHtml = pkeys.length ? '<p><b>¿Quién dio las dosis?</b> La app anterior identificaba a cada persona con un código. Elige a quién corresponde cada uno.</p><div class="hz-list">' +
      pkeys.map(function (k, i) {
        var p = people[k];
        var sel = members.length === 1 ? members[0].user_id : (k === data.exportedBy && members.some(function (m) { return m.user_id === me.id; }) ? me.id : '');
        return '<div class="hz-person"><label for="hz-who' + i + '">Persona ' + (i + 1) + ': ' + p.n + ' dosis, la última el ' + esc(p.last.trim()) +
          '<select id="hz-who' + i + '" data-by="' + esc(k) + '">' + opts.replace('value="' + esc(sel) + '"', 'value="' + esc(sel) + '" selected') + '</select></label></div>';
      }).join('') + '</div>' : '';

    area.innerHTML = '<p>Contiene ' + esc(summary) + ' y ' + files.length + ' archivos (' + total + ' datos en total).</p>' + peopleHtml +
      '<p id="hz-iprog" role="status"></p><button type="button" class="hz-btn" id="hz-igo">Importar a mi hogar</button>';
    area.querySelector('#hz-igo').addEventListener('click', async function () {
      var btn = this, prog = area.querySelector('#hz-iprog'), map = {};
      area.querySelectorAll('select[data-by]').forEach(function (s) { map[s.getAttribute('data-by')] = s.value; });
      var nameOf = {}; members.forEach(function (m) { nameOf[m.user_id] = m.display_name || ''; });
      btn.disabled = true; area.querySelectorAll('select').forEach(function (s) { s.disabled = true; });
      prog.className = '';
      try {
        var failed = 0, firstErr = '';
        for (var i = 0; i < files.length; i++) {
          var f = files[i];
          prog.textContent = 'Subiendo archivo ' + (i + 1) + ' de ' + files.length + '…';
          var zf = zip.file(f.path);
          if (!zf) { failed++; continue; }
          /* El archivo sale del zip sin tipo: se le asigna el suyo (PDF o foto), porque el almacén rechaza archivos sin tipo. */
          var blob = new Blob([await zf.async('arraybuffer')], { type: f.type });
          var up = await sb.storage.from(BUCKET).upload(filePath(f.id), blob, { contentType: f.type, upsert: true });
          if (up.error) { failed++; if (!firstErr) firstErr = up.error.message || String(up.error); }
        }
        var rows = [];
        names.forEach(function (k) {
          cols[k].forEach(function (d) {
            var v = Object.assign({}, d.data);
            if (k === 'doses' && v.byId && Object.prototype.hasOwnProperty.call(map, v.byId)) {
              var who = map[v.byId];
              if (who) { v.byId = who; v.by = ''; } else { v.by = v.by || 'Alguien'; v.byId = ''; }
            }
            rows.push({ household_id: me.household, collection: k, id: d.id, data: v, updated_at: new Date().toISOString() });
          });
        });
        for (var j = 0; j < rows.length; j += 100) {
          prog.textContent = 'Guardando datos ' + Math.min(j + 100, rows.length) + ' de ' + rows.length + '…';
          var res = await sb.from('docs').upsert(rows.slice(j, j + 100), { onConflict: 'household_id,collection,id' });
          if (res.error) throw res.error;
        }
        signed.clear();
        refreshAll();
        prog.className = failed ? 'hz-err' : 'hz-ok';
        prog.textContent = failed ? 'Se importaron los datos, pero ' + failed + ' archivo(s) no se pudieron subir. Puedes volver a importar el mismo respaldo para reintentarlo. Detalle: ' + firstErr :
          'Listo: se importaron ' + rows.length + ' datos y ' + files.length + ' archivos.';
        btn.textContent = 'Importado';
      } catch (e) {
        prog.className = 'hz-err';
        prog.textContent = 'No se pudo terminar la importación. Revisa tu conexión y vuelve a intentarlo: lo ya importado no se duplica.';
        btn.disabled = false;
      }
    });
  }

  /* ---------- arranque ---------- */
  async function start(sess) {
    session = sess;
    var res = await sb.from('members').select('household_id,display_name').eq('user_id', sess.user.id).maybeSingle();
    if (res.error && !res.data) { loginScreen('No se pudo conectar. Revisa tu conexión e intenta de nuevo.'); return; }
    if (!res.data) { noHouseholdScreen(); return; }
    me = { id: sess.user.id, email: sess.user.email, household: res.data.household_id, name: res.data.display_name || '' };
    closeGate();
    listenChanges();
    readyResolve();
    footer();
  }

  async function init() {
    addStyles();
    if (!window.supabase || !window.supabase.createClient) {
      gate('<h1>Huellitas</h1><p class="hz-sub hz-err">No se pudo cargar la app. Revisa tu conexión a internet y vuelve a abrirla.</p>');
      return;
    }
    sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } });
    var s = await sb.auth.getSession();
    if (s.data && s.data.session) start(s.data.session); else loginScreen();
    sb.auth.onAuthStateChange(function (ev) { if (ev === 'SIGNED_OUT' && me) location.reload(); });
  }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () {}); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
