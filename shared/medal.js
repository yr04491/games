// ============================================================
//  shared/medal.js — 全ゲーム共通の「メダル」
//  ・Firebase の匿名ログインで、初めて来た人も自動でアカウントを持つ
//  ・ゲームは Medal.add(枚数) を呼ぶだけ（数秒ごとにまとめて保存）
//  ・No.001〜006 は最初から遊べる。007 以降は 1000 メダルで解放
//  ・shared/firebase-config.js が空のときはメダル機能ごとオフ（ゲームはそのまま遊べる）
//  ・ローカル確認用：localhost で ?emu を付けると Firebase エミュレーターにつなぐ
// ============================================================
(function () {
  "use strict";
  const FB = "https://www.gstatic.com/firebasejs/12.19.0/";
  const FREE_UP_TO = 6;
  const UNLOCK_COST = 1000;
  const FLUSH_MS = 5000;

  const BASE = new URL("./", document.currentScript.src);   // .../shared/
  const TOP = new URL("../", BASE);                           // 置き場のトップ

  const state = { enabled: null, ready: false, uid: null, guest: true, name: "", medals: 0, total: 0, unlocked: [] };
  const listeners = [];
  let fb = null, auth = null, db = null, ref = null;
  let pending = 0, flushTimer = null, readyResolve;
  const readyP = new Promise(r => { readyResolve = r; });

  function emit() { for (const cb of listeners) { try { cb(state); } catch (e) { console.error(e); } } }
  function setReady(enabled) {
    if (state.enabled !== null) return;
    state.enabled = enabled; state.ready = true; emit(); readyResolve(enabled);
  }
  const noNum = no => parseInt(no, 10);

  // ---------- 小さな通知（ゲーム画面の下に「+5 メダル」） ----------
  let toastEl = null, toastSum = 0, toastTimer = null;
  function toast(text) {
    if (!document.body) return;
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.style.cssText = "position:fixed;left:50%;bottom:max(16px,env(safe-area-inset-bottom));transform:translate(-50%,8px);" +
        "z-index:2147483000;pointer-events:none;padding:6px 14px 6px 10px;border-radius:999px;background:rgba(20,20,24,.82);color:#ffe08a;" +
        "font:800 14px/1.2 system-ui,-apple-system,'Hiragino Sans','Noto Sans JP',sans-serif;display:flex;gap:6px;align-items:center;" +
        "opacity:0;transition:opacity .25s,transform .25s;box-shadow:0 4px 14px rgba(0,0,0,.25)";
      document.body.appendChild(toastEl);
    }
    toastEl.innerHTML = '<span style="width:14px;height:14px;border-radius:50%;background:radial-gradient(circle at 35% 35%,#fff3b0,#f2b134 55%,#b9781a);box-shadow:inset 0 0 0 1.5px #a86a12"></span>' + text;
    toastEl.style.opacity = "1"; toastEl.style.transform = "translate(-50%,0)";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.style.opacity = "0"; toastEl.style.transform = "translate(-50%,8px)"; toastSum = 0; }, 1600);
  }

  // ---------- 保存（数秒ごとにまとめて書く） ----------
  async function flush() {
    clearTimeout(flushTimer); flushTimer = null;
    if (!state.enabled || !ref || pending <= 0) return;
    const n = pending; pending = 0;
    try {
      await fb.setDoc(ref, { medals: fb.increment(n), total: fb.increment(n), updatedAt: fb.serverTimestamp() }, { merge: true });
    } catch (e) {
      console.warn("[medal] 保存に失敗。あとで再送します", e);
      pending += n; schedule();
    }
  }
  function schedule() { if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS); }
  addEventListener("visibilitychange", () => { if (document.hidden) flush(); });
  addEventListener("pagehide", flush);

  // ---------- 読み込み ----------
  async function load() {
    const snap = await fb.getDoc(ref);
    const d = snap.exists() ? snap.data() : {};
    state.medals = (d.medals || 0) + pending;
    state.total = (d.total || 0) + pending;
    state.unlocked = Array.isArray(d.unlocked) ? d.unlocked : [];
    emit();
  }

  async function init() {
    const local = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
    const emu = local && new URLSearchParams(location.search).has("emu");
    let cfg;
    if (emu) cfg = { apiKey: "demo-key", projectId: "demo-games", authDomain: "localhost" };
    else {
      try { cfg = (await import(new URL("firebase-config.js", BASE).href)).default; } catch (e) { cfg = null; }
    }
    if (!cfg || !cfg.apiKey || !cfg.projectId) { setReady(false); return; }

    const [app, a, f] = await Promise.all([
      import(FB + "firebase-app.js"), import(FB + "firebase-auth.js"), import(FB + "firebase-firestore-lite.js"),
    ]);
    fb = Object.assign({}, a, f);
    const appInst = app.initializeApp(cfg);
    auth = a.getAuth(appInst);
    db = f.getFirestore(appInst);
    if (emu) {
      a.connectAuthEmulator(auth, "http://" + location.hostname + ":9099", { disableWarnings: true });
      f.connectFirestoreEmulator(db, location.hostname, 8080);
    }
    a.onAuthStateChanged(auth, async user => {
      if (!user) { try { await a.signInAnonymously(auth); } catch (e) { console.warn("[medal] ログイン失敗", e); setReady(false); } return; }
      state.uid = user.uid; state.guest = user.isAnonymous;
      state.name = user.isAnonymous ? "" : (user.displayName || user.email || "Google");
      ref = f.doc(db, "users", user.uid);
      try { await load(); } catch (e) { console.warn("[medal] 読み込み失敗", e); }
      setReady(true); emit();
      if (pending > 0) schedule();
    });
  }

  // ---------- 公開する機能 ----------
  const Medal = {
    FREE_UP_TO, UNLOCK_COST,
    get state() { return state; },
    ready: () => readyP,
    onChange(cb) { listeners.push(cb); if (state.ready) cb(state); },

    // メダルを足す。ゲームは好きなタイミングで呼ぶだけ
    add(n) {
      n = Math.floor(n);
      if (!(n > 0) || state.enabled === false) return;
      pending += n; state.medals += n; state.total += n;
      toastSum += n; toast("+" + toastSum + " メダル");
      emit(); schedule();
    },

    isFree: no => noNum(no) <= FREE_UP_TO,
    isUnlocked(no) {
      if (state.enabled === false || noNum(no) <= FREE_UP_TO) return true;
      return state.unlocked.includes(String(no).padStart(3, "0"));
    },

    // 1000 メダルで解放。成功したら true
    async unlock(no) {
      no = String(no).padStart(3, "0");
      if (!state.enabled || Medal.isUnlocked(no)) return true;
      await flush();
      const ok = await fb.runTransaction(db, async tx => {
        const snap = await tx.get(ref);
        const d = snap.exists() ? snap.data() : {};
        const have = d.medals || 0, list = Array.isArray(d.unlocked) ? d.unlocked : [];
        if (list.includes(no)) return true;
        if (have < UNLOCK_COST) return false;
        tx.set(ref, { medals: have - UNLOCK_COST, unlocked: list.concat(no), updatedAt: fb.serverTimestamp() }, { merge: true });
        return true;
      });
      await load();
      return ok;
    },

    // 007 以降のゲームのページで呼ぶ。未解放ならトップへ戻す
    requireUnlock(no) {
      if (noNum(no) <= FREE_UP_TO) return;
      const cover = document.createElement("div");
      cover.style.cssText = "position:fixed;inset:0;z-index:2147483001;background:#16161c;color:#bbb;display:flex;align-items:center;justify-content:center;font:700 15px system-ui,sans-serif";
      cover.textContent = "読み込み中…";
      const put = () => document.body.appendChild(cover);
      document.body ? put() : addEventListener("DOMContentLoaded", put);
      const done = () => cover.remove();
      const timer = setTimeout(done, 8000);   // 通信できないときは遊べるようにする
      readyP.then(() => {
        clearTimeout(timer);
        if (Medal.isUnlocked(no)) done();
        else location.replace(new URL("?locked=" + String(no).padStart(3, "0") + location.search.replace(/^\?/, "&"), TOP).href);
      });
    },

    // ゲストのデータを Google アカウントにつなぐ
    async linkGoogle() {
      if (!state.enabled) return;
      const provider = new fb.GoogleAuthProvider();
      try {
        const res = await fb.linkWithPopup(auth.currentUser, provider);
        state.guest = false; state.name = res.user.displayName || res.user.email || "Google"; emit();
      } catch (e) {
        if (e && e.code === "auth/credential-already-in-use") {
          const cred = fb.GoogleAuthProvider.credentialFromError(e);
          if (cred && confirm("このGoogleアカウントには別のメダルが保存されています。\nそちらに切り替えますか？（今のゲストのメダルは引き継げません）")) {
            await flush();
            await fb.signInWithCredential(auth, cred);
          }
        } else if (!e || e.code !== "auth/popup-closed-by-user") {
          alert("Googleとつなげませんでした：" + (e && e.code || e));
        }
      }
    },
    async signOut() {
      if (!state.enabled) return;
      await flush();
      await fb.signOut(auth);   // ログアウト後は新しいゲストになる
    },
  };

  window.Medal = Medal;
  init().catch(e => { console.warn("[medal] 初期化失敗", e); setReady(false); });
})();
