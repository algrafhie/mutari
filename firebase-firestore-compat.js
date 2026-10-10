/* ==========================================================================
   MUTARI — fb-shim.js  (versi SUPABASE)
   --------------------------------------------------------------------------
   Jembatan kompatibilitas: meniru API Firebase (auth + firestore) yang dipakai
   aplikasi, tetapi SEMUA panggilan diarahkan ke Supabase
   (Auth + Postgres + Realtime). Tidak ada Firebase, tidak ada server sendiri.

   KUNCI: satu email = satu akun. Dijamin oleh Supabase Auth
   (constraint unik di auth.users) + tabel public.profiles.
   ========================================================================== */
(function () {
  if (window.__MUTARI_SHIM__) return;
  window.__MUTARI_SHIM__ = true;

  /* ---------- konfigurasi publik (anon key memang publik) ---------- */
  var SB_URL  = 'https://trrkzarxetbdnspykznv.supabase.co';
  var SB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRycmt6YXJ4ZXRiZG5zcHlrem52Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE1NDMzNDEsImV4cCI6MjEwNzExOTM0MX0.KkUW51tpwmcGh4iYFt4P7Wy_PPTtNHN5HPGydrouP28';
  var SB_CDN  = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

  /* ---------- muat pustaka Supabase ---------- */
  var sbReady = window.__MUTARI_SB__
    ? Promise.resolve(window.__MUTARI_SB__)
    : import(SB_CDN).then(function (m) {
        var create = m.createClient || (m.default && m.default.createClient);
        if (!create) throw new Error('createClient Supabase tidak ditemukan');
        var client = create(SB_URL, SB_ANON, {
          auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
          realtime: { params: { eventsPerSecond: 10 } }
        });
        window.__MUTARI_SB__ = client;
        return client;
      });

  function sb() { return sbReady; }

  function errOf(e, fallback) {
    var err = new Error((e && (e.message || e.error_description)) || fallback || 'Gagal');
    err.code = (e && (e.code || e.error)) || 'mutari_error';
    return err;
  }

  /* ============================ AUTH ============================ */
  var authListeners = [];
  var currentUser = null;
  var authReadyResolve;
  var authReady = new Promise(function (r) { authReadyResolve = r; });

  function notifyAuth() {
    authListeners.forEach(function (cb) { try { cb(currentUser); } catch (e) {} });
  }

  function mapUser(u) {
    if (!u) return null;
    var m = u.user_metadata || {};
    return {
      uid: u.id,
      email: u.email || '',
      isAnonymous: (u.is_anonymous === true) || (!u.email && !u.phone),
      displayName: m.full_name || m.name || '',
      photoURL: m.avatar_url || m.picture || '',
      /* v1.12.3: penyedia login ('google', 'email', 'anonymous').
         Dipakai aplikasi untuk tahu bahwa sesi ini berasal dari login Google,
         sehingga login bisa diselesaikan walau sesinya baru siap belakangan. */
      provider: (u.app_metadata && u.app_metadata.provider) ||
        (u.identities && u.identities[0] && u.identities[0].provider) || ''
    };
  }

  function adoptSession(session) {
    currentUser = mapUser(session && session.user);
    notifyAuth();
    return currentUser;
  }

  /* Apakah halaman ini sedang kembali dari Google OAuth?
     Kalau ya, JANGAN buat sesi tamu — tunggu Supabase memproses token dari URL,
     supaya hasil login Google tidak tertimpa sesi anonim. */
  function isOAuthCallback() {
    var q = location.search || '', h = location.hash || '';
    return q.indexOf('code=') >= 0 || h.indexOf('access_token=') >= 0 || h.indexOf('error_description=') >= 0;
  }

  /* Pastikan selalu ada sesi: pakai yang ada, atau buat sesi tamu (anonim). */
  function ensureGuest(force) {
    return sb().then(function (c) {
      return c.auth.getSession().then(function (r) {
        var s = r && r.data && r.data.session;
        if (s && s.user) return adoptSession(s);
        if (!force && isOAuthCallback()) {
          /* Biarkan proses OAuth yang menentukan; jangan buat tamu dulu. */
          return new Promise(function (resolve) {
            var n = 0;
            var t = setInterval(function () {
              n++;
              c.auth.getSession().then(function (r2) {
                var s2 = r2 && r2.data && r2.data.session;
                if (s2 && s2.user) { clearInterval(t); resolve(adoptSession(s2)); }
                else if (n > 40) { clearInterval(t); resolve(ensureGuest(true)); }
              }).catch(function () { if (n > 40) { clearInterval(t); resolve(null); } });
            }, 250);
          });
        }
        return c.auth.signInAnonymously().then(function (res) {
          if (res.error) { console.warn('[MUTARI] sesi tamu gagal:', res.error.message); return null; }
          return adoptSession(res.data && res.data.session);
        });
      });
    }).catch(function (e) {
      console.warn('[MUTARI] ensureGuest:', e && e.message);
      return null;
    });
  }

  /* Inisialisasi awal */
  sb().then(function (c) {
    c.auth.onAuthStateChange(function (_ev, session) {
      currentUser = mapUser(session && session.user);
      notifyAuth();
    });
    return ensureGuest();
  }).then(function () {
    authReadyResolve(currentUser);
  }).catch(function (e) {
    console.warn('[MUTARI] init auth:', e && e.message);
    authReadyResolve(currentUser);
  });

  /* Selalu periksa sesi TERBARU — jangan cache hasil null, supaya login Google
     yang baru selesai tidak terlewat. */
  function redirectResultPromise() {
    return sb().then(function (c) {
      return c.auth.getSession().then(function (r) {
        var u = r && r.data && r.data.session && r.data.session.user;
        if (u && u.email) { currentUser = mapUser(u); notifyAuth(); return { user: currentUser }; }
        return null;
      });
    }).catch(function () { return null; });
  }

  function authObj() {
    return {
      get currentUser() { return currentUser; },

      onAuthStateChanged: function (cb) {
        authListeners.push(cb);
        authReady.then(function () { try { cb(currentUser); } catch (e) {} });
        return function () { var i = authListeners.indexOf(cb); if (i >= 0) authListeners.splice(i, 1); };
      },

      signInAnonymously: function () {
        return ensureGuest().then(function (u) { return { user: u }; });
      },

      createUserWithEmailAndPassword: function (email, password) {
        return sb().then(function (c) {
          return c.auth.signUp({
            email: String(email || '').trim(),
            password: String(password || ''),
            options: { data: { name: String(email || '').split('@')[0] } }
          }).then(function (res) {
            if (res.error) throw errOf(res.error);
            if (!res.data || !res.data.session) {
              throw errOf({ code: 'email_confirm_required', message: 'Pendaftaran berhasil, tetapi sesi belum aktif. Coba masuk kembali.' });
            }
            currentUser = mapUser(res.data.user); notifyAuth();
            return { user: currentUser };
          });
        });
      },

      signInWithEmailAndPassword: function (email, password) {
        return sb().then(function (c) {
          return c.auth.signInWithPassword({
            email: String(email || '').trim(),
            password: String(password || '')
          }).then(function (res) {
            if (res.error) throw errOf(res.error);
            currentUser = mapUser(res.data.user); notifyAuth();
            return { user: currentUser };
          });
        });
      },

      /* v1.12.2: menetapkan password pada akun yang SUDAH ADA (mis. akun Google).
         Dipakai agar pengguna Google juga punya password MUTARI yang berlaku
         di semua perangkat, bukan hanya di HP tempat ia mendaftar. */
      updateUser: function (data) {
        return sb().then(function (c) {
          if (!c || !c.auth || typeof c.auth.updateUser !== 'function') {
            throw errOf({ code: 'unsupported', message: 'updateUser tidak tersedia' });
          }
          var payload = {};
          if (data && data.password != null) payload.password = String(data.password);
          return c.auth.updateUser(payload).then(function (res) {
            if (res && res.error) throw errOf(res.error);
            var u = res && res.data && res.data.user;
            if (u) { currentUser = mapUser(u); notifyAuth(); }
            return { user: currentUser };
          });
        });
      },

      signOut: function () {
        return sb().then(function (c) {
          return c.auth.signOut().catch(function () {});
        }).then(function () {
          currentUser = null; notifyAuth();
          return ensureGuest();
        });
      },

      /* ---- Google OAuth ---- */
      GoogleAuthProvider: function () { this.setCustomParameters = function () {}; },

      signInWithPopup: function () {
        var dest = location.origin + location.pathname;
        sb().then(function (c) {
          return c.auth.signInWithOAuth({
            provider: 'google',
            options: { redirectTo: dest, queryParams: { prompt: 'select_account' } }
          });
        }).catch(function (e) { console.error('[MUTARI] Google OAuth:', e && e.message); });
        /* Halaman akan berpindah — promise sengaja tidak pernah selesai. */
        return new Promise(function () {});
      },

      signInWithRedirect: function () { return this.signInWithPopup(); },

      getRedirectResult: function () { return redirectResultPromise(); }
    };
  }
  var AUTH = authObj();

  /* ========================== FIRESTORE ========================== */
  var colCache = {};        // col -> { id -> data }
  var colStreams = {};      // col -> kanal realtime
  var queryListeners = [];  // { col, q, cb }

  function cacheOf(col) { return colCache[col] || (colCache[col] = {}); }

  function openStream(col) {
    if (colStreams[col]) return;
    colStreams[col] = true;   // tandai segera supaya tidak dobel
    sb().then(function (c) {
      var ch = c.channel('mutari:' + col)
        .on('postgres_changes',
            { event: '*', schema: 'public', table: 'docs', filter: 'col=eq.' + col },
            function (payload) {
              var cache = cacheOf(col);
              try {
                if (payload.eventType === 'DELETE') {
                  var oid = payload.old && payload.old.id;
                  if (oid) delete cache[oid];
                } else if (payload.new && payload.new.id != null) {
                  cache[payload.new.id] = payload.new.data;
                }
                fireQueryListeners(col);
              } catch (e) {}
            })
        .subscribe();
      colStreams[col] = ch;
    }).catch(function (e) {
      console.warn('[MUTARI] realtime', col, e && e.message);
      delete colStreams[col];
    });
  }

  function fireQueryListeners(col) {
    queryListeners.forEach(function (L) {
      if (L.col !== col) return;
      try { L.cb(buildSnapshot(col, L.q)); } catch (e) {}
    });
  }

  function matches(data, filters) {
    for (var i = 0; i < filters.length; i++) {
      var f = filters[i], v = data[f.f];
      if (f.op === '==') { if (String(v) !== String(f.v)) return false; }
      else if (f.op === '!=') { if (String(v) === String(f.v)) return false; }
      else if (f.op === 'in') { if (!Array.isArray(f.v) || f.v.map(String).indexOf(String(v)) < 0) return false; }
      else if (f.op === '>') { if (!(Number(v) > Number(f.v))) return false; }
      else if (f.op === '>=') { if (!(Number(v) >= Number(f.v))) return false; }
      else if (f.op === '<') { if (!(Number(v) < Number(f.v))) return false; }
      else if (f.op === '<=') { if (!(Number(v) <= Number(f.v))) return false; }
    }
    return true;
  }

  function docsOf(col, q) {
    var c = cacheOf(col), out = [];
    Object.keys(c).forEach(function (id) { if (matches(c[id] || {}, q.filters)) out.push({ id: id, data: c[id] }); });
    if (q.order) {
      out.sort(function (a, b) {
        var x = a.data[q.order.f], y = b.data[q.order.f];
        if (x === y) return 0;
        var r = (x > y) ? 1 : -1;
        return q.order.dir === 'desc' ? -r : r;
      });
    }
    if (q.lim) out = out.slice(0, q.lim);
    return out;
  }

  function buildSnapshot(col, q) {
    var rows = docsOf(col, q);
    var docs = rows.map(function (r) {
      return {
        id: r.id, exists: true,
        data: function () { return r.data; },
        get: function (k) { return r.data ? r.data[k] : undefined; },
        ref: new DocRef(col, r.id)
      };
    });
    return {
      docs: docs, size: docs.length, empty: docs.length === 0,
      forEach: function (cb) { docs.forEach(cb); },
      docChanges: function () { return []; }
    };
  }

  /* ---- FieldValue: penyelesaian sentinel ---- */
  function isSentinel(v) { return v && typeof v === 'object' && typeof v.__op === 'string'; }

  function splitSentinels(data) {
    var plain = {}, inc = {}, ops = {};
    Object.keys(data || {}).forEach(function (k) {
      var v = data[k];
      if (isSentinel(v)) {
        if (v.__op === 'inc') { inc[k] = Number(v.n) || 0; return; }
        if (v.__op === 'ts') { plain[k] = Date.now(); return; }
        ops[k] = v; return;              // union / remove / del
      }
      plain[k] = v;
    });
    return { plain: plain, inc: inc, ops: ops,
             hasInc: Object.keys(inc).length > 0,
             hasOps: Object.keys(ops).length > 0 };
  }

  function applyOps(current, ops) {
    var out = Object.assign({}, current || {});
    Object.keys(ops).forEach(function (k) {
      var v = ops[k];
      if (v.__op === 'union') { out[k] = (Array.isArray(out[k]) ? out[k] : []).concat(v.a); }
      else if (v.__op === 'remove') { out[k] = (Array.isArray(out[k]) ? out[k] : []).filter(function (x) { return v.a.indexOf(x) < 0; }); }
      else if (v.__op === 'del') { delete out[k]; }
    });
    return out;
  }

  function writeData(col, id, data, merge) {
    var parts = splitSentinels(data || {});
    return sb().then(function (c) {
      if (!parts.hasInc && !parts.hasOps) {
        return c.rpc('mutari_set', { p_col: col, p_id: id, p_data: parts.plain, p_merge: merge !== false });
      }
      /* ada increment / operasi array / hapus field -> butuh data saat ini */
      var cur = cacheOf(col)[id];
      function proceed(current) {
        var setObj = parts.plain;
        if (parts.hasOps) setObj = Object.assign({}, parts.plain, applyOps(current, parts.ops));
        var chained = Promise.resolve();
        if (parts.hasOps) {
          /* tulis objek penuh supaya penghapusan field benar-benar terjadi */
          var full = Object.assign({}, current || {}, setObj);
          Object.keys(parts.ops).forEach(function (k) { if (parts.ops[k].__op === 'del') delete full[k]; });
          chained = c.rpc('mutari_set', { p_col: col, p_id: id, p_data: full, p_merge: false });
        }
        return chained.then(function () {
          if (parts.hasInc) {
            return c.rpc('mutari_patch', { p_col: col, p_id: id, p_inc: parts.inc, p_set: parts.hasOps ? {} : setObj });
          }
          if (!parts.hasOps) {
            return c.rpc('mutari_set', { p_col: col, p_id: id, p_data: setObj, p_merge: merge !== false });
          }
          return null;
        });
      }
      if (cur !== undefined) return proceed(cur);
      return c.rpc('mutari_get', { p_col: col, p_id: id }).then(function (r) {
        return proceed(r && r.data ? r.data : null);
      });
    }).then(function () {
      var cache = cacheOf(col);
      var base = (merge === false) ? {} : (cache[id] || {});
      cache[id] = Object.assign({}, base, parts.plain);
      if (parts.hasInc) Object.keys(parts.inc).forEach(function (k) { cache[id][k] = (Number(cache[id][k]) || 0) + parts.inc[k]; });
      if (parts.hasOps) cache[id] = applyOps(cache[id], parts.ops);
      fireQueryListeners(col);
      return { id: id };
    });
  }

  function DocRef(col, id) { this.col = col; this.id = id; }
  /* Subcollection: chats/<id>/messages dan users/<key>/devices dipakai aplikasi. */
  DocRef.prototype.collection = function (name) { return new CollectionRef(this.col + '/' + this.id + '/' + name); };
  DocRef.prototype.set = function (data, opts) {
    var merge = !(opts && opts.merge === false);
    return writeData(this.col, this.id, data, merge);
  };
  DocRef.prototype.update = function (data) { return this.set(data, { merge: true }); };
  DocRef.prototype.get = function () {
    var self = this;
    return sb().then(function (c) {
      return c.rpc('mutari_get', { p_col: self.col, p_id: self.id });
    }).then(function (r) {
      var d = r && r.data;
      if (d == null) {
        return { id: self.id, exists: false, data: function () { return undefined; },
                 get: function () { return undefined; }, ref: self };
      }
      cacheOf(self.col)[self.id] = d;
      return { id: self.id, exists: true, data: function () { return d; },
               get: function (k) { return d[k]; }, ref: self };
    }).catch(function () {
      return { id: self.id, exists: false, data: function () { return undefined; },
               get: function () { return undefined; }, ref: self };
    });
  };
  DocRef.prototype.delete = function () {
    var self = this;
    return sb().then(function (c) {
      return c.rpc('mutari_del', { p_col: self.col, p_id: self.id });
    }).then(function () { delete cacheOf(self.col)[self.id]; fireQueryListeners(self.col); return {}; });
  };
  DocRef.prototype.onSnapshot = function (cb) {
    var self = this;
    this.get().then(function (snap) { try { cb(snap); } catch (e) {} });
    openStream(this.col);
    var L = {
      col: this.col,
      q: { filters: [], order: null, limit: 0 },
      cb: function () {
        var cache = cacheOf(self.col);
        if (cache[self.id] === undefined) {
          try { cb({ id: self.id, exists: false, data: function () { return undefined; }, ref: self }); } catch (e) {}
        } else {
          try { cb({ id: self.id, exists: true, data: function () { return cache[self.id]; },
                     get: function (k) { return cache[self.id][k]; }, ref: self }); } catch (e) {}
        }
      }
    };
    queryListeners.push(L);
    return function () { var i = queryListeners.indexOf(L); if (i >= 0) queryListeners.splice(i, 1); };
  };

  function Query(col, filters, order, lim) {
    this.col = col; this.filters = filters || []; this.order = order || null;
    /* PENTING: simpan sebagai .lim — memakai .limit akan menimpa method limit(). */
    this.lim = lim || 0;
  }
  Query.prototype.where = function (f, op, v) { return new Query(this.col, this.filters.concat([{ f: f, op: op, v: v }]), this.order, this.lim); };
  Query.prototype.orderBy = function (f, dir) { return new Query(this.col, this.filters, { f: f, dir: dir || 'asc' }, this.lim); };
  Query.prototype.limit = function (n) { return new Query(this.col, this.filters, this.order, n); };
  Query.prototype.doc = function (id) { return new DocRef(this.col, id || (Math.random().toString(36).slice(2) + Date.now().toString(36))); };
  Query.prototype.add = function (data) {
    var self = this;
    var parts = splitSentinels(data || {});
    return sb().then(function (c) {
      return c.rpc('mutari_add', { p_col: self.col, p_data: parts.plain });
    }).then(function (r) {
      var id = r && r.data;
      if (id) { cacheOf(self.col)[id] = parts.plain; fireQueryListeners(self.col); }
      return { id: id };
    });
  };
  Query.prototype.get = function () {
    var self = this;
    return this._load().then(function () { return buildSnapshot(self.col, self); });
  };
  Query.prototype._load = function () {
    var self = this;
    return sb().then(function (c) {
      return c.rpc('mutari_q', { p_col: self.col, p_limit: 5000 });
    }).then(function (r) {
      var cache = cacheOf(self.col);
      (r && r.data ? r.data : []).forEach(function (d) { cache[d.id] = d.data; });
      return true;
    });
  };
  Query.prototype.onSnapshot = function (cb, errCb) {
    var self = this;
    openStream(this.col);
    this._load()
      .then(function () { try { cb(buildSnapshot(self.col, self)); } catch (e) {} })
      .catch(function (e) { if (errCb) try { errCb(e); } catch (_) {} });
    var L = { col: this.col, q: this, cb: cb };
    queryListeners.push(L);
    return function () { var i = queryListeners.indexOf(L); if (i >= 0) queryListeners.splice(i, 1); };
  };

  function CollectionRef(col) { this.col = col; }
  CollectionRef.prototype.doc = function (id) { return new DocRef(this.col, id || (Math.random().toString(36).slice(2) + Date.now().toString(36))); };
  CollectionRef.prototype.add = function (data) { return new Query(this.col).add(data); };
  CollectionRef.prototype.where = function (f, op, v) { return new Query(this.col).where(f, op, v); };
  CollectionRef.prototype.orderBy = function (f, dir) { return new Query(this.col).orderBy(f, dir); };
  CollectionRef.prototype.limit = function (n) { return new Query(this.col).limit(n); };
  CollectionRef.prototype.get = function () { return new Query(this.col).get(); };
  CollectionRef.prototype.onSnapshot = function (cb, errCb) { return new Query(this.col).onSnapshot(cb, errCb); };

  var DB = {
    collection: function (name) { return new CollectionRef(name); },
    doc: function (path) { var p = String(path).split('/'); return new DocRef(p[0], p[1]); }
  };

  var FieldValue = {
    increment: function (n) { return { __op: 'inc', n: Number(n) || 0 }; },
    serverTimestamp: function () { return { __op: 'ts' }; },
    delete: function () { return { __op: 'del' }; },
    arrayUnion: function () { return { __op: 'union', a: Array.prototype.slice.call(arguments) }; },
    arrayRemove: function () { return { __op: 'remove', a: Array.prototype.slice.call(arguments) }; }
  };

  /* ========================== FIREBASE ROOT ========================== */
  var firebase = {
    apps: [],
    initializeApp: function () { if (!firebase.apps.length) firebase.apps.push({ name: '[MUTARI]' }); return firebase.apps[0]; },
    auth: function () { return AUTH; },
    firestore: function () { return DB; }
  };
  firebase.firestore.FieldValue = FieldValue;
  firebase.firestore.FieldPath = { documentId: function () { return '__name__'; } };
  firebase.auth.Auth = function () {};
  firebase.auth.GoogleAuthProvider = function () { this.setCustomParameters = function () {}; };

  window.firebase = firebase;
  window.__MUTARI_READY__ = sbReady;

  console.log('[MUTARI] jembatan Supabase aktif ->', SB_URL);
})();
