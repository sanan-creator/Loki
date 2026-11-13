(() => {
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];

  const KEYS = {
    tasks: 'loki_pwa_tasks_v1',
    routines: 'loki_pwa_routines_v1',
    settings: 'loki_pwa_settings_v1',
    deletions: 'loki_pwa_deletions_v1'
  };

  const REMINDER_KEY = 'loki_pwa_fired_reminders_v1';

  const weekdaysFa = ['یکشنبه','دوشنبه','سه‌شنبه','چهارشنبه','پنجشنبه','جمعه','شنبه'];
  const weekdaysEn = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const monthsFa = ['فروردین','اردیبهشت','خرداد','تیر','مرداد','شهریور','مهر','آبان','آذر','دی','بهمن','اسفند'];
  const monthsEn = ['Farvardin','Ordibehesht','Khordad','Tir','Mordad','Shahrivar','Mehr','Aban','Azar','Dey','Bahman','Esfand'];
  const daysFa = ['ش','ی','د','س','چ','پ','ج'];
  const daysEn = ['Sat','Sun','Mon','Tue','Wed','Thu','Fri'];

  const labels = {
    fa: {
      personalAssistant:'دستیار شخصی تو',
      workspace:'فضای کاری',
      dashboard:'داشبورد',
      tasks:'کارها',
      routines:'روتین‌ها',
      calendar:'تقویم شمسی',
      assistant:'دستیار',
      settings:'تنظیمات',
      localStorage:'ذخیره‌سازی محلی فعال',
      yourWorkspace:'فضای شخصی شما',
      newTask:'کار جدید',
      footer:'ساخته‌شده برای نظم بیشتر، قدم‌به‌قدم.',
      title:'عنوان',
      notes:'توضیحات',
      category:'دسته‌بندی',
      priority:'اولویت',
      date:'تاریخ (شمسی)',
      time:'ساعت',
      repeat:'تکرار',
      confirmCompletion:'برای این روتین تأیید انجام‌شدن هم داشته باش',
      cancel:'انصراف',
      save:'ذخیره'
    },
    en: {
      personalAssistant:'Your personal assistant',
      workspace:'WORKSPACE',
      dashboard:'Dashboard',
      tasks:'Tasks',
      routines:'Routines',
      calendar:'Persian calendar',
      assistant:'Assistant',
      settings:'Settings',
      localStorage:'Local storage active',
      yourWorkspace:'Your workspace',
      newTask:'New task',
      footer:'Built for better focus, one step at a time.',
      title:'Title',
      notes:'Notes',
      category:'Category',
      priority:'Priority',
      date:'Date',
      time:'Time',
      repeat:'Repeat',
      confirmCompletion:'Allow completion confirmation for this routine',
      cancel:'Cancel',
      save:'Save'
    }
  };

  let settings = read(KEYS.settings, {
    theme: 'dark',
    language: 'fa'
  });
  let settingsUpdatedAt = Number(localStorage.getItem('loki_settings_updated_at_v1')) || Date.now();
  let persistedSettingsJson = JSON.stringify(settings);

  function toMillis(value, fallback = Date.now()) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function normalizeRecords(list) {
    return (Array.isArray(list) ? list : []).filter(item =>
      item && typeof item === 'object' && String(item.title || '').trim()
    ).map(item => ({
      ...item,
      id: String(item.id ?? uid()),
      title: String(item.title || ''),
      createdAt: toMillis(item.createdAt),
      modifiedAt: toMillis(item.modifiedAt ?? item.createdAt)
    }));
  }

  let tasks = normalizeRecords(read(KEYS.tasks, []));
  let routines = normalizeRecords(read(KEYS.routines, []));
  // Tombstones make deletions sync across devices instead of resurrecting records.
  let deletions = (Array.isArray(read(KEYS.deletions, [])) ? read(KEYS.deletions, []) : []).map(item => ({
    ...item, id: String(item.id), deletedAt: Number(item.deletedAt || Date.now())
  }));

  let page = 'dashboard';
  let selectedDate = dateKey(new Date());
  let monthCursor = new Date();
  let calendarView = 'month';
  let toastTimer;

  const text = (faText, enText) =>
    settings.language === 'fa' ? faText : enText;

  function read(k, fallback) {
    try {
      return JSON.parse(localStorage.getItem(k)) ?? fallback;
    } catch {
      return fallback;
    }
  }

  // Local-first data layer: keep the synchronous localStorage path for
  // compatibility, and mirror every committed snapshot into IndexedDB.
  const LOKI_DB_NAME = 'loki-data-core';
  const LOKI_DB_VERSION = 1;
  let lokiDbPromise = null;
  let cloudSyncTimer = null;
  let cloudSyncRunning = false;
  let cloudSyncQueued = false;
  let cloudWorkspaceLoaded = false;
  let authTransitionId = 0;
  let cloudUnsubscribe = null;
  let lastCloudSnapshotAt = 0;
  let workspaceRevision = 0;

  function openLokiDB() {
    if (!('indexedDB' in window)) return Promise.resolve(null);
    if (lokiDbPromise) return lokiDbPromise;
    lokiDbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(LOKI_DB_NAME, LOKI_DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('snapshots')) {
          db.createObjectStore('snapshots', { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB open failed'));
      request.onblocked = () => console.warn('Loki IndexedDB upgrade is blocked by another tab.');
    }).catch(error => {
      lokiDbPromise = null;
      console.warn('Loki IndexedDB unavailable; localStorage remains active.', error);
      return null;
    });
    return lokiDbPromise;
  }

  async function writeIndexedSnapshot() {
    const db = await openLokiDB();
    if (!db) return false;
    const snapshot = {
      id: activeWorkspaceUid || 'guest', schemaVersion: 2, savedAt: Date.now(),
      tasks, routines, settings, settingsUpdatedAt, deletions
    };
    return new Promise(resolve => {
      try {
        const tx = db.transaction('snapshots', 'readwrite');
        tx.objectStore('snapshots').put(snapshot);
        tx.oncomplete = () => resolve(true);
        tx.onerror = tx.onabort = () => resolve(false);
      } catch (error) { console.warn('Loki IndexedDB write failed.', error); resolve(false); }
    });
  }

  async function restoreIndexedSnapshot() {
    const db = await openLokiDB();
    if (!db) return false;
    return new Promise(resolve => {
      try {
        const snapshotStore = db.transaction('snapshots', 'readonly').objectStore('snapshots');
        // Once an account has been used, the old guest snapshot may contain a
        // copy of the first account's migrated data. Never restore it after
        // sign-out or on a logged-out launch.
        const legacyAllowed = !localStorage.getItem('loki_first_account_uid_v1');
        if (!legacyAllowed) return resolve(false);
        const request = snapshotStore.get('main');
        request.onsuccess = () => {
          const saved = request.result;
          if (!saved || !Array.isArray(saved.tasks) || !Array.isArray(saved.routines)) return resolve(false);
          const localHasData = tasks.length || routines.length;
          if (!localHasData && (saved.tasks.length || saved.routines.length)) {
            tasks = normalizeRecords(saved.tasks);
            routines = normalizeRecords(saved.routines);
            if (Array.isArray(saved.deletions)) deletions = saved.deletions.map(item => ({
              ...item, id: String(item.id), deletedAt: toMillis(item.deletedAt, 0)
            }));
            if (saved.settings && typeof saved.settings === 'object') settings = { ...settings, ...saved.settings };
            settingsUpdatedAt = Number(saved.settingsUpdatedAt || settingsUpdatedAt);
            persistedSettingsJson = JSON.stringify(settings);
            localStorage.setItem('loki_settings_updated_at_v1', String(settingsUpdatedAt));
            localStorage.setItem(KEYS.tasks, JSON.stringify(tasks));
            localStorage.setItem(KEYS.routines, JSON.stringify(routines));
            localStorage.setItem(KEYS.deletions, JSON.stringify(deletions));
            localStorage.setItem(KEYS.settings, JSON.stringify(settings));
            return resolve(true);
          }
          resolve(false);
        };
        request.onerror = () => resolve(false);
      } catch (_) { resolve(false); }
    });
  }

  const WORKSPACE_PREFIX = 'loki_workspace_v1:';
  let activeWorkspaceUid = null;
  let authWorkspaceReady = false;

  function workspaceSnapshot() {
    return {
      schemaVersion: 1,
      tasks, routines, settings, settingsUpdatedAt, deletions,
      cloudReady: !activeWorkspaceUid || cloudWorkspaceLoaded,
      savedAt: Date.now()
    };
  }

  function saveWorkspaceScope(scope) {
    try {
      localStorage.setItem(WORKSPACE_PREFIX + scope, JSON.stringify(workspaceSnapshot()));
      return true;
    } catch (error) {
      console.warn('Loki workspace snapshot could not be saved.', error);
      return false;
    }
  }

  function loadWorkspaceScope(scope) {
    try {
      const raw = localStorage.getItem(WORKSPACE_PREFIX + scope);
      if (!raw) return false;
      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.tasks) || !Array.isArray(data.routines)) return false;
      tasks = normalizeRecords(data.tasks);
      routines = normalizeRecords(data.routines);
      deletions = Array.isArray(data.deletions) ? data.deletions.map(item => ({
        ...item, id: String(item.id), deletedAt: Number(item.deletedAt || Date.now())
      })) : [];
      if (data.settings && typeof data.settings === 'object') settings = { ...settings, ...data.settings };
      settingsUpdatedAt = Number(data.settingsUpdatedAt || settingsUpdatedAt);
      persistedSettingsJson = JSON.stringify(settings);
      cloudWorkspaceLoaded = !activeWorkspaceUid || data.cloudReady !== false;
      return true;
    } catch (error) {
      console.warn('Loki workspace snapshot is invalid.', error);
      return false;
    }
  }

  function writeBaseWorkspace() {
    localStorage.setItem(KEYS.tasks, JSON.stringify(tasks));
    localStorage.setItem(KEYS.routines, JSON.stringify(routines));
    localStorage.setItem(KEYS.settings, JSON.stringify(settings));
    localStorage.setItem(KEYS.deletions, JSON.stringify(deletions));
  }

  function persist(options = {}) {
    workspaceRevision++;
    const nextSettingsJson = JSON.stringify(settings);
    if (nextSettingsJson !== persistedSettingsJson) {
      settingsUpdatedAt = Date.now();
      persistedSettingsJson = nextSettingsJson;
      localStorage.setItem('loki_settings_updated_at_v1', String(settingsUpdatedAt));
    }
    writeBaseWorkspace();
    saveWorkspaceScope(activeWorkspaceUid || 'guest');
    writeIndexedSnapshot();
    queueCloudSync(Boolean(options.immediateCloudSync));
  }

  function queueCloudSync(immediate = false) {
    if (!cloudUser || !firebaseDbInstance || !cloudWorkspaceLoaded) return;
    clearTimeout(cloudSyncTimer);
    cloudSyncTimer = setTimeout(() => syncLokiCloud().catch(error =>
      console.warn('Loki cloud sync deferred:', error)
    ), immediate ? 0 : 1200);
  }

  function mergeCloudWorkspace(local, remote = {}) {
    const mergedDeletions = new Map();
    [...(Array.isArray(local.deletions) ? local.deletions : []),
      ...(Array.isArray(remote.deletions) ? remote.deletions : [])].forEach(item => {
      if (!item || !item.id || !item.kind) return;
      const id = String(item.id);
      const key = `${item.kind}:${id}`;
      const normalized = { ...item, id, deletedAt: toMillis(item.deletedAt, 0) };
      const previous = mergedDeletions.get(key);
      if (!previous || normalized.deletedAt >= previous.deletedAt) mergedDeletions.set(key, normalized);
    });

    const tombstones = [...mergedDeletions.values()];
    const deletedAt = new Map(tombstones.map(item => [
      `${item.kind}:${String(item.id)}`, Number(item.deletedAt || 0)
    ]));

    const mergeRecords = (kind, localItems, remoteItems) => {
      const map = new Map();
      [...(Array.isArray(localItems) ? localItems : []),
        ...(Array.isArray(remoteItems) ? remoteItems : [])].forEach(item => {
        if (!item || item.id == null) return;
        const normalized = { ...item, id: String(item.id) };
        const tombstoneTime = deletedAt.get(`${kind}:${normalized.id}`) || 0;
        const stamp = toMillis(normalized.modifiedAt ?? normalized.createdAt, 0);
        if (tombstoneTime && tombstoneTime >= stamp) return;
        const previous = map.get(normalized.id);
        const previousStamp = previous
          ? toMillis(previous.modifiedAt ?? previous.createdAt, 0)
          : -1;
        if (!previous || stamp >= previousStamp) map.set(normalized.id, normalized);
      });
      return [...map.values()];
    };

    const localSettingsTime = Number(local.settingsUpdatedAt || 0);
    const remoteSettingsTime = Number(remote.settingsUpdatedAt || 0);
    const useRemoteSettings = remoteSettingsTime > localSettingsTime &&
      remote.settings && typeof remote.settings === 'object';

    return {
      schemaVersion: 2,
      tasks: mergeRecords('task', local.tasks, remote.tasks),
      routines: mergeRecords('routine', local.routines, remote.routines),
      settings: useRemoteSettings ? { ...local.settings, ...remote.settings } : local.settings,
      settingsUpdatedAt: useRemoteSettings ? remoteSettingsTime : localSettingsTime,
      deletions: tombstones
    };
  }

  async function syncLokiCloud() {
    if (!cloudUser || !firebaseDbInstance || !cloudWorkspaceLoaded || !activeWorkspaceUid) return;
    if (cloudSyncRunning) { cloudSyncQueued = true; return; }

    cloudSyncRunning = true;
    const syncUid = String(cloudUser.uid);
    const syncTransitionId = authTransitionId;
    const syncRevision = workspaceRevision;
    const localSnapshot = JSON.parse(JSON.stringify({
      tasks, routines, settings, settingsUpdatedAt, deletions
    }));

    try {
      const ref = firebaseDbInstance.collection('users').doc(syncUid)
        .collection('loki').doc('main');

      // A Firestore transaction prevents two devices from overwriting each
      // other's changes after both have read the same older document.
      const committed = await firebaseDbInstance.runTransaction(async transaction => {
        const snapshot = await transaction.get(ref);
        const remote = snapshot.exists ? (snapshot.data() || {}) : {};
        const merged = mergeCloudWorkspace(localSnapshot, remote);
        const updatedAt = Math.max(
          Date.now(),
          Number(remote.updatedAt || 0) + 1,
          lastCloudSnapshotAt + 1
        );
        const document = { ...merged, updatedAt };
        transaction.set(ref, document);
        return document;
      });

      // An account switch may happen while the network transaction is pending.
      // Never apply an old account's result to the newly active workspace.
      if (
        String(activeWorkspaceUid) !== syncUid ||
        !cloudUser ||
        String(cloudUser.uid) !== syncUid ||
        syncTransitionId !== authTransitionId
      ) return;

      lastCloudSnapshotAt = Math.max(lastCloudSnapshotAt, Number(committed.updatedAt || 0));

      // If the user edited something while the transaction was pending, leave
      // their live state untouched and immediately queue a second merge.
      if (workspaceRevision !== syncRevision) {
        cloudSyncQueued = true;
        return;
      }

      tasks = normalizeRecords(committed.tasks);
      routines = normalizeRecords(committed.routines);
      settings = { ...settings, ...(committed.settings || {}) };
      settingsUpdatedAt = Number(committed.settingsUpdatedAt || settingsUpdatedAt);
      persistedSettingsJson = JSON.stringify(settings);
      deletions = Array.isArray(committed.deletions) ? committed.deletions.map(item => ({
        ...item, id: String(item.id), deletedAt: toMillis(item.deletedAt, 0)
      })) : [];

      writeBaseWorkspace();
      saveWorkspaceScope(syncUid);
      await writeIndexedSnapshot();
      if (page === 'settings') render();
    } finally {
      cloudSyncRunning = false;
      if (cloudSyncQueued) {
        cloudSyncQueued = false;
        queueCloudSync();
      }
    }
  }


  function listenToCloudWorkspace(uid, transitionId, ref) {
    if (cloudUnsubscribe) cloudUnsubscribe();
    cloudUnsubscribe = ref.onSnapshot(snapshot => {
      if (transitionId !== authTransitionId || String(activeWorkspaceUid) !== String(uid) || !snapshot.exists) return;
      const remoteUpdatedAt = Number((snapshot.data() || {}).updatedAt || 0);
      if (remoteUpdatedAt > lastCloudSnapshotAt) {
        lastCloudSnapshotAt = remoteUpdatedAt;
        syncLokiCloud().catch(error => console.warn('Loki realtime sync deferred:', error));
      }
    }, error => console.warn('Loki realtime listener failed:', error));
  }

  async function retryPendingCloudWorkspace() {
    if (!cloudUser || !activeWorkspaceUid || cloudWorkspaceLoaded || cloudSyncRunning) return;
    const uid = String(cloudUser.uid);
    const transitionId = authTransitionId;
    const ref = firebaseDbInstance.collection('users').doc(uid)
      .collection('loki').doc('main');

    // Retry only after a fresh online event; the pending local snapshot is
    // merged transactionally with cloud data before it is marked cloud-ready.
    cloudWorkspaceLoaded = true;
    try {
      await syncLokiCloud();
      if (transitionId !== authTransitionId || String(activeWorkspaceUid) !== uid) return;
      saveWorkspaceScope(uid);
      await writeIndexedSnapshot();
      listenToCloudWorkspace(uid, transitionId, ref);
    } catch (error) {
      if (transitionId === authTransitionId && String(activeWorkspaceUid) === uid) {
        cloudWorkspaceLoaded = false;
        saveWorkspaceScope(uid);
      }
      console.warn('Loki cloud reconnect retry failed:', error);
    }
  }

  function uid() {
    return crypto.randomUUID
      ? crypto.randomUUID()
      : String(Date.now()) + Math.random().toString(16).slice(2);
  }

  function dateKey(d) {
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }

  function parseKey(k) {
    if (!k) return null;
    const [y,m,d] = k.split('-').map(Number);
    return new Date(y,m-1,d,12);
  }

  const jalaliBreaks = [
    -61,9,38,199,426,686,756,818,1111,1181,
    1210,1635,2060,2097,2192,2262,2324,2394,2456,3178
  ];

  const div = (a,b) => Math.floor(a/b);
  const mod = (a,b) => a - Math.floor(a/b)*b;

  function jalaliCalendar(jy) {
    const bl = jalaliBreaks.length;

    if (jy < jalaliBreaks[0] || jy >= jalaliBreaks[bl-1]) {
      throw new RangeError('Jalali year out of supported range');
    }

    let gy = jy + 621;
    let leapJ = -14;
    let jp = jalaliBreaks[0];
    let jump = 0;

    for (let i=1; i<bl; i++) {
      const jm = jalaliBreaks[i];
      jump = jm-jp;

      if (jy < jm) break;

      leapJ += div(jump,33)*8 + div(mod(jump,33),4);
      jp = jm;
    }

    let n = jy-jp;

    leapJ += div(n,33)*8 + div(mod(n,33)+3,4);

    if (mod(jump,33)===4 && jump-n===4) leapJ++;

    const leapG = div(gy,4)-div((div(gy,100)+1)*3,4)-150;
    const march = 20+leapJ-leapG;

    if (jump-n<6) {
      n = n-jump+div(jump+4,33)*33;
    }

    let leap = mod(mod(n+1,33)-1,4);

    if (leap===-1) leap=4;

    return {leap,gy,march};
  }

  function gregorianJdn(gy,gm,gd) {
    return Math.floor(Date.UTC(gy,gm-1,gd)/86400000)+2440588;
  }

  function jalaliJdn(jy,jm,jd) {
    const c = jalaliCalendar(jy);

    return gregorianJdn(c.gy,3,c.march)
      +(jm-1)*31-div(jm,7)*(jm-7)+jd-1;
  }

  function jalaliParts(date) {
    const jdn = Math.floor(
      Date.UTC(date.getFullYear(),date.getMonth(),date.getDate())/86400000
    )+2440588;

    const utc = new Date((jdn-2440588)*86400000);
    let gy = utc.getUTCFullYear();
    let jy = gy-621;
    let c = jalaliCalendar(jy);

    let k = jdn-gregorianJdn(gy,3,c.march);

    if (k<0) {
      jy--;
      c = jalaliCalendar(jy);
      k = jdn-gregorianJdn(gy-1,3,c.march);
    }

    let month,day;

    if (k<=185) {
      month = 1+div(k,31);
      day = mod(k,31)+1;
    } else {
      k -= 186;
      month = 7+div(k,30);
      day = mod(k,30)+1;
    }

    return {year:jy,month,day};
  }

  function jalaliKey(date) {
    const p = jalaliParts(date);

    return `${p.year}/${String(p.month).padStart(2,'0')}/${String(p.day).padStart(2,'0')}`;
  }

  function jalaliLabel(date,withDay=true) {
    const p = jalaliParts(date);

    const month = settings.language==='fa'
      ? monthsFa[p.month-1]
      : monthsEn[p.month-1];

    const day = settings.language==='fa'
      ? new Intl.NumberFormat('fa-IR').format(p.day)
      : String(p.day);

    const year = settings.language==='fa'
      ? new Intl.NumberFormat('fa-IR').format(p.year)
      : String(p.year);

    const weekday = settings.language==='fa'
      ? weekdaysFa[date.getDay()]
      : weekdaysEn[date.getDay()];

    return `${withDay?weekday+' ':''}${day} ${month} ${year}`;
  }

  function fromJalali(y,m,d) {
    if (
      !Number.isInteger(y) ||
      !Number.isInteger(m) ||
      !Number.isInteger(d) ||
      m<1 ||
      m>12 ||
      d<1 ||
      d>(m<=6?31:m<=11?30:(jalaliCalendar(y).leap===0?30:29))
    ) {
      throw new RangeError('Invalid Jalali date');
    }

    const jdn = jalaliJdn(y,m,d);
    const date = new Date((jdn-2440588)*86400000);

    return new Date(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      12
    );
  }

  function currentJalaliMonth(date) {
    const p = jalaliParts(date);
    return {y:p.year,m:p.month};
  }

  function jalaliMonthLength(y,m) {
    if (m<=6) return 31;
    if (m<=11) return 30;
    return jalaliCalendar(y).leap===0?30:29;
  }

  function shiftJalaliMonth(date,delta) {
    const p = jalaliParts(date);
    let y = p.year;
    let m = p.month+delta;

    while (m<1) {
      m+=12;
      y--;
    }

    while (m>12) {
      m-=12;
      y++;
    }

    return fromJalali(y,m,1);
  }

  function addDays(date,days) {
    const d = new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate(),
      12
    );

    d.setDate(d.getDate()+days);
    return d;
  }

  function saturdayStart(date) {
    return addDays(date,-((date.getDay()+1)%7));
  }

  function displayDayNumber(date) {
    const n = jalaliParts(date).day;

    return settings.language==='fa'
      ? new Intl.NumberFormat('fa-IR').format(n)
      : String(n);
  }

  function monthName(y,m) {
    return settings.language==='fa'
      ? `${monthsFa[m-1]} ${y}`
      : `${monthsEn[m-1]} ${y}`;
  }

  function escapeHtml(s='') {
    return String(s).replace(/[&<>"']/g,c=>({
      '&':'&amp;',
      '<':'&lt;',
      '>':'&gt;',
      '"':'&quot;',
      "'":'&#39;'
    }[c]));
  }

  function showToast(msg) {
    const el = $('#toast');
    if (!el) return;

    el.textContent = msg;
    el.classList.add('show');

    clearTimeout(toastTimer);

    toastTimer = setTimeout(
      () => el.classList.remove('show'),
      2500
    );
  }

  function fmtTime(t) {
    return t||'—';
  }

  function catName(c) {
    return ({
      personal:text('شخصی','Personal'),
      study:text('درس','Study'),
      work:text('کار','Work'),
      health:text('سلامت','Health')
    })[c]||c;
  }

  function priorityName(p) {
    return ({
      normal:text('معمولی','Normal'),
      high:text('بالا','High'),
      urgent:text('ضروری','Urgent')
    })[p]||p;
  }

  function applyLanguage() {
    document.documentElement.lang = settings.language;
    document.documentElement.dir =
      settings.language==='fa'?'rtl':'ltr';

    $$('[data-i18n]').forEach(el=>{
      const k = el.dataset.i18n;

      if (labels[settings.language][k]) {
        el.textContent = labels[settings.language][k];
      }
    });

    $('#headerDate').textContent = jalaliLabel(new Date());

    $('#pageTitle').textContent = ({
      dashboard:text('داشبورد','Dashboard'),
      tasks:text('کارها','Tasks'),
      routines:text('روتین‌های ثابت','Fixed routines'),
      calendar:text('تقویم شمسی','Persian calendar'),
      assistant:text('دستیار','Assistant'),
      settings:text('تنظیمات','Settings')
    })[page];

    $('#quickAdd span').textContent =
      text('کار جدید','New task');
  }

  function setPage(p) {
    page = p;

    $$('.nav-item[data-page]').forEach(b=>{
      b.classList.toggle('active',b.dataset.page===p);
    });

    $('#sidebar').classList.remove('open');

    applyLanguage();
    render();
  }

  
  function render() {
    applyLanguage();

    $('#taskCount').textContent =
      tasks.filter(t=>!t.done).length;

    const root = $('#page');

    root.innerHTML = ({
      dashboard: dashboardPage,
      tasks: tasksPage,
      routines: routinesPage,
      calendar: calendarPage,
      assistant: assistantPage,
      settings: settingsPage
    }[page] || dashboardPage)();
  }

  function taskRow(t,card=false) {

    return `
      <div class="${card?'task-card':'task-row'} ${t.done?'done':''}">
        <input
          class="task-check"
          type="checkbox"
          data-done="${t.id}"
          ${t.done?'checked':''}
          aria-label="done"
        >

        <div class="task-main">
          <div class="task-title">${escapeHtml(t.title)}</div>

          <div class="task-meta">
            ${catName(t.category)} ·
            ${t.date
              ?jalaliLabel(parseKey(t.date),false)
              :text('بدون تاریخ','No date')}
            ${t.time?'· '+fmtTime(t.time):''}
          </div>
        </div>

        <span class="tag ${t.priority}">
          ${priorityName(t.priority)}
        </span>

        ${card?`
          <div class="card-actions">
            <button class="mini-btn" data-edit-task="${t.id}">✎</button>
            <button class="mini-btn" data-delete-task="${t.id}">×</button>
          </div>
        `:''}
      </div>
    `;
  }

  function routineMatches(r,date) {
    if (!r.enabled) return false;

    const dow = date.getDay();
    const p = jalaliParts(date);

    if (r.repeat==='daily') return true;

    if (r.repeat==='weekdays') {
      return (r.weekdays||[]).includes(dow);
    }

    if (r.repeat==='weekly') {
      return dow===Number(r.weekday);
    }

    if (r.repeat==='monthly') {
      return p.day===Number(r.monthDay||1);
    }

    return false;
  }

  function routineRow(r,card=false) {
    return `
      <div class="${card?'routine-card':'routine-mini'}">
        <div class="routine-timebox">
          ${escapeHtml(r.time||'09:00')}
        </div>

        <div class="task-main">
          <b>${escapeHtml(r.title)}</b>
          <small>
            ${catName(r.category)} ·
            ${r.confirm
              ?text('با تأیید انجام','Completion check')
              :text('یادآوری ساده','Reminder only')}
          </small>
        </div>

        ${card?`
          <label title="${text('فعال','Enabled')}">
            <input
              class="switch"
              type="checkbox"
              data-routine-toggle="${r.id}"
              ${r.enabled?'checked':''}
            >
          </label>

          <div class="card-actions">
            <button class="mini-btn" data-edit-routine="${r.id}">✎</button>
            <button class="mini-btn" data-delete-routine="${r.id}">×</button>
          </div>
        `:''}
      </div>
    `;
  }

  function dashboardPage() {
    const today = dateKey(new Date());

    const todays = tasks.filter(
      t=>!t.done&&(!t.date||t.date===today)
    );

    const done = tasks.filter(t=>t.done).length;
    const active = routines.filter(r=>r.enabled);

    const dueR = active
      .filter(r=>routineMatches(r,new Date()))
      .sort((a,b)=>(a.time||'').localeCompare(b.time||''));

    return `
      <div class="welcome">
        <div>
          <div class="eyebrow">YOUR PERSONAL COMMAND CENTER</div>

          <h2>
            ${text(
              'سلام! آماده‌ای امروز رو بسازی؟',
              'Welcome back. Ready to make today count?'
            )}
          </h2>

          <p>
            ${text(
              'کارهای مهمت رو ببین و با یک قدم کوچک شروع کن.',
              'See what matters and start with one small step.'
            )}
          </p>
        </div>

        <div class="welcome-mark">
          ✦ ${text('نسخه اول Loki','Loki · First release')}
        </div>
      </div>

      <div class="stats">
        <div class="stat">
          <span class="stat-icon">▤</span>
          <div class="label">${text('کارهای باقی‌مانده','Open tasks')}</div>
          <strong>${tasks.filter(t=>!t.done).length}</strong>
          <div class="sub">${text('در فهرست کارها','In your task list')}</div>
        </div>

        <div class="stat">
          <span class="stat-icon">✓</span>
          <div class="label">${text('انجام‌شده','Completed')}</div>
          <strong>${done}</strong>
          <div class="sub">${text('تا این لحظه','So far')}</div>
        </div>

        <div class="stat">
          <span class="stat-icon">⟳</span>
          <div class="label">${text('روتین‌های فعال','Active routines')}</div>
          <strong>${active.length}</strong>
          <div class="sub">${text('برنامه‌های تکرارشونده','Recurring habits')}</div>
        </div>

        <div class="stat">
          <span class="stat-icon">◷</span>
          <div class="label">${text('کارهای پیش رو','Upcoming today')}</div>
          <strong>${todays.length+dueR.length}</strong>
          <div class="sub">${text('کار و روتین امروز','Tasks and routines today')}</div>
        </div>
      </div>

      <div class="content-grid">
        <section class="panel">
          <div class="panel-head">
            <h3>${text('کارهای پیش رو','Upcoming tasks')}</h3>
            <button class="text-link" data-goto="tasks">
              ${text('مشاهده همه ←','View all →')}
            </button>
          </div>

          <div class="task-list">
            ${
              todays.length
              ?todays.slice(0,5).map(t=>taskRow(t)).join('')
              :`
                <div class="empty">
                  <b>${text('فعلاً کار فوری نداری','Nothing urgent right now')}</b>
                  ${text('می‌تونی یک کار تازه اضافه کنی.','You can add a new task.')}
                </div>
              `
            }
          </div>
        </section>

        <section class="panel">
          <div class="panel-head">
            <h3>${text('روتین‌های امروز','Today’s routines')}</h3>
            <button class="text-link" data-goto="routines">
              ${text('مدیریت ←','Manage →')}
            </button>
          </div>

          ${
            dueR.length
            ?dueR.slice(0,5).map(r=>routineRow(r)).join('')
            :`
              <div class="empty">
                <b>${text('روتینی برای امروز نیست','No routines scheduled')}</b>
                ${text('روتین‌های ثابتت رو اضافه کن.','Add your recurring routines.')}
              </div>
            `
          }

          <div class="quick-actions">
            <button class="quick-action" data-action="task">
              <span>＋</span>${text('افزودن کار','Add task')}
            </button>

            <button class="quick-action" data-action="routine">
              <span>⟳</span>${text('روتین جدید','New routine')}
            </button>
          </div>
        </section>
      </div>
    `;
  }

  function tasksPage() {
    return `
      <div class="toolbar">
        <input
          class="search"
          id="taskSearch"
          placeholder="${text('جست‌وجو بین کارها...','Search tasks...')}"
        >

        <select class="filter-select" id="taskFilter">
          <option value="all">${text('همه کارها','All tasks')}</option>
          <option value="open">${text('باز','Open')}</option>
          <option value="done">${text('انجام‌شده','Completed')}</option>
        </select>

        <span class="spacer"></span>

        <button class="primary-btn" data-action="task">
          ＋ ${text('کار جدید','New task')}
        </button>
      </div>

      <div id="taskResults">
        ${
          tasks.length
          ?tasks.map(t=>taskRow(t,true)).join('')
          :`
            <div class="empty">
              <b>${text('هنوز کاری ثبت نشده','No tasks yet')}</b>
              ${text('اولین کارت رو اضافه کن تا شروع کنیم.','Add your first task to get started.')}
            </div>
          `
        }
      </div>
    `;
  }

  function routinesPage() {
    return `
      <div class="welcome">
        <div>
          <div class="eyebrow">REPEATABLE PLANS</div>

          <h2>
            ${text(
              'روتین‌هایی که به برنامه‌ات شکل می‌دن',
              'Build a rhythm that works'
            )}
          </h2>

          <p>
            ${text(
              'هر روتین تنظیمات و شیوه تأیید مستقل خودش رو داره.',
              'Each routine has its own schedule and completion setting.'
            )}
          </p>
        </div>

        <button class="primary-btn" data-action="routine">
          ＋ ${text('روتین جدید','New routine')}
        </button>
      </div>

      <div class="panel">
        <div class="panel-head">
          <h3>${text('فهرست روتین‌ها','Your routines')}</h3>

          <span class="tag">
            ${routines.filter(r=>r.enabled).length}
            ${text('فعال','active')}
          </span>
        </div>

        ${
          routines.length
          ?routines.map(r=>routineRow(r,true)).join('')
          :`
            <div class="empty">
              <b>${text('هنوز روتینی نساختی','No routines created')}</b>
              ${text(
                'روتین‌هایی مثل مطالعه، ورزش یا مرور روزانه رو اضافه کن.',
                'Add routines such as reading, exercise, or daily review.'
              )}
            </div>
          `
        }
      </div>

      <p class="task-meta" style="margin-top:13px">
        ${text(
          'یادآوری‌های نسخه فعلی داخل برنامه نمایش داده می‌شوند؛ برای اعلان حتی وقتی برنامه بسته است، اتصال سرویس اعلان در مرحله بعدی اضافه می‌شود.',
          'This release shows reminders while the app is open. Background notifications can be connected in a later deployment step.'
        )}
      </p>
    `;
  }

  function calendarPage() {
    const selected = parseKey(selectedDate)||new Date();
    const today = dateKey(new Date());
    const anchor = calendarView==='month'?monthCursor:selected;

    const p = jalaliParts(anchor);
    const y = p.year;
    const m = p.month;

    const title = calendarView==='month'
      ?monthName(y,m)
      :`${jalaliLabel(saturdayStart(selected),false)} — ${jalaliLabel(addDays(saturdayStart(selected),6),false)}`;

    const navButtons = `
      <div class="month-controls">
        <button data-period="-1" aria-label="Previous">‹</button>
        <button data-period="0" aria-label="Today">•</button>
        <button data-period="1" aria-label="Next">›</button>
      </div>
    `;

    const viewToggle = `
      <div class="calendar-view-toggle">
        <button
          class="${calendarView==='month'?'active':''}"
          data-calendar-view="month"
        >${text('ماهانه','Month')}</button>

        <button
          class="${calendarView==='week'?'active':''}"
          data-calendar-view="week"
        >${text('هفتگی','Week')}</button>
      </div>
    `;

    let grid = '';

    if (calendarView==='month') {
      const first = fromJalali(y,m,1);
      const len = jalaliMonthLength(y,m);
      const offset = (first.getDay()+1)%7;

      for (let i=0;i<offset;i++) {
        grid += '<div class="day muted" aria-hidden="true"></div>';
      }

      for (let d=1;d<=len;d++) {
        const dt = fromJalali(y,m,d);
        const key = dateKey(dt);
        const isToday = key===today;
        const isSelected = key===selectedDate;

        const hasTask = tasks.some(t=>t.date===key);
        const hasRoutine = routines.some(r=>routineMatches(r,dt));

        grid += `
          <button
            class="day ${isToday?'today':''} ${isSelected?'selected':''}"
            data-date="${key}"
          >
            <span class="day-num">${displayDayNumber(dt)}</span>

            <span class="day-markers">
              ${hasTask?'<i></i>':''}
              ${hasRoutine?'<i class="routine"></i>':''}
            </span>
          </button>
        `;
      }

      const trailing = (7-((offset+len)%7))%7;

      for (let i=0;i<trailing;i++) {
        grid += '<div class="day muted" aria-hidden="true"></div>';
      }

    } else {
      const start = saturdayStart(selected);

      for (let i=0;i<7;i++) {
        const dt = addDays(start,i);
        const key = dateKey(dt);
        const dayTasks = tasks.filter(t=>t.date===key);
        const dayRoutines = routines.filter(r=>routineMatches(r,dt));

        grid += `
          <button
            class="week-day ${key===today?'today':''} ${key===selectedDate?'selected':''}"
            data-date="${key}"
          >
            <span class="week-day-name">
              ${
                (settings.language==='fa'
                  ?['شنبه','یکشنبه','دوشنبه','سه‌شنبه','چهارشنبه','پنجشنبه','جمعه']
                  :['Sat','Sun','Mon','Tue','Wed','Thu','Fri'])[i]
              }
            </span>

            <strong>${displayDayNumber(dt)}</strong>

            <span class="week-day-count">
              ${dayTasks.length
                ?text(`${dayTasks.length} کار`,` ${dayTasks.length} tasks`)
                :''}
              ${dayRoutines.length
                ?` · ${dayRoutines.length} ${text('روتین','routines')}`
                :''}
            </span>
          </button>
        `;
      }
    }

    const dt = parseKey(selectedDate);
    const dayTasks = tasks.filter(t=>t.date===selectedDate);
    const dayRoutines = routines.filter(r=>routineMatches(r,dt||new Date()));
    const dayHeading = dt?jalaliLabel(dt):'';

    const details = `
      <div class="selected-day">
        <h4>${dayHeading}</h4>

        ${
          dayTasks.length
          ?dayTasks.map(t=>taskRow(t)).join('')
          :`
            <div class="task-meta">
              ${text('کاری برای این تاریخ ثبت نشده.','No tasks for this date.')}
            </div>
          `
        }

        ${
          dayRoutines.length
          ?`
            <div class="task-meta" style="margin:12px 0 6px">
              ${text('روتین‌های این روز','Routines for this day')}
            </div>

            ${dayRoutines.map(r=>routineRow(r)).join('')}
          `
          :''
        }

        <div style="margin-top:12px">
          <button
            class="secondary-btn"
            data-action="task"
            data-prefill-date="${selectedDate}"
          >
            ＋ ${text('افزودن کار برای این روز','Add task for this day')}
          </button>
        </div>
      </div>
    `;

    return `
      <div class="calendar-wrap">
        <div class="calendar-head">
          <div>
            <div class="eyebrow">${text('تقویم شمسی دقیق','PERSIAN CALENDAR')}</div>
            <h3>${title}</h3>
          </div>

          <div class="calendar-tools">
            ${viewToggle}
            ${navButtons}
          </div>
        </div>

        <div class="calendar-grid ${calendarView==='week'?'week-mode':''}">
          ${
            (settings.language==='fa'?daysFa:daysEn)
              .map(d=>`<div class="weekday">${d}</div>`)
              .join('')
          }
          ${grid}
        </div>

        ${details}
      </div>
    `;
  }

  function assistantPage() {
    return `
      <div class="assistant-box">
        <div class="assistant-intro">
          <div class="assistant-orb">✧</div>
          <div class="eyebrow">LOKI</div>

          <h2>${text('دستیار آماده کمک است','Ready to help')}</h2>

          <p>
            ${text(
              'فعلاً می‌تونی با زبان طبیعی کار ثبت کنی و کارهایت را مرور کنی. اتصال هوش مصنوعی آنلاین در مرحله بعدی فعال می‌شود.',
              'For now, create tasks in natural language and review your plans. Online AI integration comes in a later stage.'
            )}
          </p>
        </div>

        <div class="chat-log" id="chatLog">
          <div class="bubble bot">
            ${text(
              'سلام! مثلاً بنویس: «فردا ساعت ۵ ریاضی بخون» تا یک کار برات ثبت کنم.',
              'Hi! Try: “Study math tomorrow at 5” and I’ll create a task.'
            )}
          </div>
        </div>

        <form class="chat-form" id="chatForm">
          <input
            id="chatInput"
            placeholder="${text('به Loki بگو چه کاری داری...','Tell Loki what you need to do...')}"
          >

          <button class="primary-btn">
            ${text('ارسال','Send')}
          </button>
        </form>

        <div class="suggestions">
          <button data-prompt="${text('فردا ساعت ۵ ریاضی بخون','Study math tomorrow at 5')}">
            ${text('ثبت کار برای فردا','Add task for tomorrow')}
          </button>

          <button data-prompt="${text('کارهای باز من رو نشون بده','Show my open tasks')}">
            ${text('نمایش کارهای باز','Show open tasks')}
          </button>

          <button data-prompt="${text('یک روتین جدید بساز','Create a new routine')}">
            ${text('ساخت روتین','Create routine')}
          </button>
        </div>
      </div>
    `;
  }

  function notificationStatusLabel() {
    if (!('Notification' in window)) {
      return text('این مرورگر اعلان را پشتیبانی نمی‌کند','Notifications unsupported');
    }

    if (
      Notification.permission==='granted' &&
      settings.notificationsEnabled
    ) {
      return text('فعال','Enabled');
    }

    if (Notification.permission==='denied') {
      return text('مجوز مسدود شده','Permission blocked');
    }

    return text('غیرفعال','Disabled');
  }

  const FIREBASE_CONFIG = {
    apiKey: 'AIzaSyBXfTGg2JB6hLCy78WEC0aNOAuXMqg7CV4',
    authDomain: 'loki-2d9d9.firebaseapp.com',
    projectId: 'loki-2d9d9',
    storageBucket: 'loki-2d9d9.firebasestorage.app',
    messagingSenderId: '890801691330',
    appId: '1:890801691330:web:56ecdcbf0138cd851bb95b',
    measurementId: 'G-GGTVKG9CNP'
  };

  const FIREBASE_VAPID_KEY =
    'BByX6sNBDJicLrdhRiA8yjc4HEEPXpCgBxeyKdpac6yu3vO_PMMhs7wG-sNRrfvdUiEC4wLmP8KTBCWLg-BNe2w';

  let firebaseMessagingInstance = null;
  let firebaseAuthInstance = null;
  let firebaseDbInstance = null;
  let cloudUser = null;

  const firebaseScriptPromises = new Map();

  function loadFirebaseCompatScript(src) {
    const ready = () => {
      if (!window.firebase) return false;

      if (src.includes('firebase-app-compat')) {
        return typeof firebase.initializeApp==='function';
      }

      if (src.includes('firebase-auth-compat')) {
        return typeof firebase.auth==='function';
      }

      if (src.includes('firebase-firestore-compat')) {
        return typeof firebase.firestore==='function';
      }

      if (src.includes('firebase-messaging-compat')) {
        return typeof firebase.messaging==='function';
      }

      return false;
    };

    if (ready()) return Promise.resolve();

    if (firebaseScriptPromises.has(src)) {
      return firebaseScriptPromises.get(src);
    }

    const promise = new Promise((resolve,reject)=>{
      const existing = [...document.scripts].find(
        script=>script.src===src
      );

      if (existing) {
        existing.addEventListener('load',()=>{
          ready()
            ?resolve()
            :reject(new Error('Firebase SDK did not initialize'));
        },{once:true});

        existing.addEventListener('error',()=>{
          reject(new Error('Firebase SDK could not be loaded'));
        },{once:true});

        return;
      }

      const script = document.createElement('script');
      script.src = src;

      script.onload = () => {
        ready()
          ?resolve()
          :reject(new Error('Firebase SDK did not initialize'));
      };

      script.onerror = () => {
        reject(new Error('Firebase SDK could not be loaded'));
      };

      document.head.appendChild(script);
    });

    firebaseScriptPromises.set(src,promise);

    promise.catch(()=>{
      firebaseScriptPromises.delete(src);
    });

    return promise;
  }

  async function ensureFirebaseServices() {
    const base = 'https://www.gstatic.com/firebasejs/13.0.0/';

    await loadFirebaseCompatScript(
      base+'firebase-app-compat.js'
    );

    await loadFirebaseCompatScript(
      base+'firebase-auth-compat.js'
    );

    await loadFirebaseCompatScript(
      base+'firebase-firestore-compat.js'
    );

    if (!window.firebase) {
      throw new Error('Firebase SDK unavailable');
    }

    if (!firebase.apps.length) {
      firebase.initializeApp(FIREBASE_CONFIG);
    }

    firebaseAuthInstance = firebase.auth();
    firebaseDbInstance = firebase.firestore();

    return {
      auth:firebaseAuthInstance,
      db:firebaseDbInstance
    };
  }

  async function pushTokenDocumentId(token) {
    if (crypto.subtle && window.TextEncoder) {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
      return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    }
    return encodeURIComponent(token).replaceAll('%', '_').slice(0, 140);
  }

  async function syncDeviceTokenRecord(enabled = true) {
    const token = localStorage.getItem('loki_fcm_token');
    if (!token || !cloudUser || !firebaseDbInstance) return false;
    const tokenId = await pushTokenDocumentId(token);
    await firebaseDbInstance.collection('users').doc(cloudUser.uid)
      .collection('devices').doc(tokenId).set({
        token,
        notificationsEnabled: !!enabled,
        platform: navigator.userAgent || 'unknown',
        updatedAt: Date.now()
      }, { merge: true });
    localStorage.setItem('loki_fcm_token_doc_id', tokenId);
    return true;
  }

  async function registerFirebasePush(registration) {
    const base = 'https://www.gstatic.com/firebasejs/13.0.0/';

    await loadFirebaseCompatScript(
      base+'firebase-app-compat.js'
    );

    await loadFirebaseCompatScript(
      base+'firebase-messaging-compat.js'
    );

    if (!window.firebase) {
      throw new Error('Firebase SDK unavailable');
    }

    if (!firebase.apps.length) {
      firebase.initializeApp(FIREBASE_CONFIG);
    }

    firebaseMessagingInstance = firebase.messaging();

    const token = await firebaseMessagingInstance.getToken({
      vapidKey:FIREBASE_VAPID_KEY,
      serviceWorkerRegistration:registration
    });

    if (!token) {
      throw new Error('Firebase did not return a push token');
    }

    localStorage.setItem('loki_fcm_token',token);
    await syncDeviceTokenRecord(true);

    if (!firebaseMessagingInstance.__lokiForegroundHandler) {
      firebaseMessagingInstance.onMessage(payload=>{
        const title =
          payload?.notification?.title||'Loki';

        const body =
          payload?.notification?.body||
          payload?.data?.body||
          text(
            'پیام جدیدی دریافت شد.',
            'You received a new message.'
          );

        if (Notification.permission==='granted') {
          registration.showNotification(title,{
            body,
            icon:'./icon-192.png',
            badge:'./icon-192.png',
            tag:'loki-fcm-foreground'
          });
        }
      });

      firebaseMessagingInstance.__lokiForegroundHandler = true;
    }

    return token;
  }

  async function enableNotifications() {
    if (!('Notification' in window)) {
      showToast(
        text(
          'مرورگر از اعلان پشتیبانی نمی‌کند.',
          'This browser does not support notifications.'
        )
      );
      return;
    }

    if (
      !('serviceWorker' in navigator) ||
      location.protocol==='file:'
    ) {
      showToast(
        text(
          'برای اعلان‌ها Loki را از HTTPS یا localhost باز کن.',
          'Open Loki over HTTPS or localhost to enable notifications.'
        )
      );
      return;
    }

    let permission = Notification.permission;

    if (permission!=='granted') {
      permission = await Notification.requestPermission();
    }

    if (permission==='granted') {
      settings.notificationsEnabled = true;
      persist();
      render();

      try {
        const reg = await navigator.serviceWorker.ready;

        await reg.showNotification(
          text(
            'اعلان‌های Loki فعال شد',
            'Loki notifications enabled'
          ),
          {
            body:text(
              'مجوز اعلان فعال است. در حال ثبت دستگاه برای دریافت Push از Firebase…',
              'Notification permission is enabled. Registering this device for Firebase Push…'
            ),
            icon:'./icon-192.png',
            tag:'loki-notifications-enabled'
          }
        );

        try {
          await registerFirebasePush(reg);

          showToast(
            text(
              'مجوز اعلان فعال و شناسه دستگاه ثبت شد؛ ارسال یادآوری در حالت بسته هنوز به سرور زمان‌بندی نیاز دارد.',
              'Notification permission is enabled and the device token is registered; closed-app scheduled delivery still needs a backend scheduler.'
            )
          );

        } catch (pushError) {
          console.error(
            'Loki Firebase Push registration:',
            pushError
          );

          showToast(
            text(
              'اعلان محلی فعال شد، اما اتصال Firebase کامل نشد. اتصال HTTPS و تنظیمات Firebase را بررسی می‌کنیم.',
              'Local notifications are enabled, but Firebase Push registration failed. Check HTTPS and Firebase setup.'
            )
          );
        }

      } catch (error) {
        console.error(error);

        showToast(
          text(
            'اعلان‌ها فعال شدند، اما سرویس اعلان آماده نشد.',
            'Notifications are enabled, but the notification service did not become ready.'
          )
        );
      }

      checkReminders();

    } else {
      settings.notificationsEnabled = false;
      persist();
      render();

      showToast(
        text(
          'مجوز اعلان داده نشد؛ تنظیمات مجوز مرورگر را بررسی کن.',
          'Permission was not granted. Check browser notification settings.'
        )
      );
    }
  }

  function reminderHistory() {
    try {
      return JSON.parse(
        localStorage.getItem(REMINDER_KEY)||'[]'
      );
    } catch {
      return [];
    }
  }

  async function sendReminder(key,title,body) {
    const fired = reminderHistory();

    if (fired.includes(key)) return;

    const options = {
      body,
      icon:'./icon-192.png',
      badge:'./icon-192.png',
      tag:key,
      renotify:false,
      dir:document.documentElement.dir||'auto',
      lang:document.documentElement.lang||'fa',
      timestamp:Date.now(),
      data:{
        url:'./',
        reminderKey:key
      }
    };

    let sent = false;

    try {
      const registration = await navigator.serviceWorker.ready;

      await registration.showNotification(title,options);
      sent = true;

    } catch {
      try {
        if (
          'Notification' in window &&
          Notification.permission==='granted'
        ) {
          new Notification(title,options);
          sent = true;
        }
      } catch {}
    }

    if (sent) {
      fired.push(key);

      try {
        localStorage.setItem(
          REMINDER_KEY,
          JSON.stringify(fired.slice(-250))
        );
      } catch {}
    }
  }

  function checkReminders() {
    if (
      !settings.notificationsEnabled ||
      !('Notification' in window) ||
      Notification.permission!=='granted'
    ) {
      return;
    }

    const now = new Date();
    const nowMinute = Math.floor(now.getTime()/60000);
    const today = dateKey(now);

    const due = (date,time) => {
      if (!date||!time) return false;

      const target = new Date(`${date}T${time}:00`);
      const minute = Math.floor(target.getTime()/60000);

      return Number.isFinite(minute) &&
        minute<=nowMinute &&
        minute>=nowMinute-1;
    };

    tasks
      .filter(t=>!t.done&&due(t.date,t.time))
      .forEach(t=>{
        sendReminder(
          `task:${t.id}:${t.date}:${t.time}`,
          text('یادآوری کار در Loki','Loki task reminder'),
          t.title
        );
      });

    routines
      .filter(r=>r.enabled&&r.time&&routineMatches(r,now))
      .forEach(r=>{
        if (due(today,r.time)) {
          sendReminder(
            `routine:${r.id}:${today}:${r.time}`,
            text('یادآوری روتین در Loki','Loki routine reminder'),
            r.title
          );
        }
      });
  }

  async function initializeLokiAuth() {
    try {
      const {auth} = await ensureFirebaseServices();

      auth.onAuthStateChanged(async user => {
        const transitionId = ++authTransitionId;
        const nextUid = user ? String(user.uid) : null;
        if (authWorkspaceReady && nextUid === activeWorkspaceUid) {
          cloudUser = user;
          if (nextUid && !cloudWorkspaceLoaded) retryPendingCloudWorkspace();
          if (page === 'settings') render();
          return;
        }

        // Do not snapshot the pre-auth bootstrap state as "guest" before
        // Firebase has told us which identity owns the existing browser data.
        if (authWorkspaceReady) saveWorkspaceScope(activeWorkspaceUid || 'guest');
        if (cloudUnsubscribe) {
          cloudUnsubscribe();
          cloudUnsubscribe = null;
        }
        cloudWorkspaceLoaded = false;
        cloudUser = user;
        activeWorkspaceUid = nextUid;

        if (nextUid) {
          const loadedLocal = loadWorkspaceScope(nextUid);
          cloudWorkspaceLoaded = loadedLocal && cloudWorkspaceLoaded;
          const ref = firebaseDbInstance.collection('users').doc(nextUid)
            .collection('loki').doc('main');

          // A local snapshot marked cloud-pending must be merged with Firestore
          // before it is allowed to sync; it must not be mistaken for a complete
          // account workspace after a failed/offline first read.
          if (!loadedLocal || !cloudWorkspaceLoaded) {
            try {
              const remoteSnapshot = await ref.get();
              if (transitionId !== authTransitionId) return;
              if (remoteSnapshot.exists) {
                if (!loadedLocal) {
                  const remote = remoteSnapshot.data() || {};
                  tasks = normalizeRecords(remote.tasks);
                  routines = normalizeRecords(remote.routines);
                  deletions = Array.isArray(remote.deletions) ? remote.deletions.map(item => ({
                    ...item, id: String(item.id), deletedAt: toMillis(item.deletedAt, 0)
                  })) : [];
                  if (remote.settings && typeof remote.settings === 'object') settings = { ...settings, ...remote.settings };
                  settingsUpdatedAt = Number(remote.settingsUpdatedAt || settingsUpdatedAt);
                  persistedSettingsJson = JSON.stringify(settings);
                  localStorage.setItem('loki_settings_updated_at_v1', String(settingsUpdatedAt));
                }
              } else if (!loadedLocal) {
                // Import the anonymous workspace only for the first account ever
                // used on this browser. Never copy account A's data into account B.
                const firstAccount = localStorage.getItem('loki_first_account_uid_v1');
                if (!firstAccount) {
                  // One-time migration of the original anonymous browser data
                  // into the first account only.
                  loadWorkspaceScope('guest');
                  if (!localStorage.getItem(WORKSPACE_PREFIX + 'guest')) {
                    saveWorkspaceScope('guest');
                  }
                  localStorage.setItem('loki_first_account_uid_v1', nextUid);
                } else {
                  tasks = [];
                  routines = [];
                  deletions = [];
                  settings = { theme: 'dark', language: 'fa' };
                  settingsUpdatedAt = Date.now();
                  persistedSettingsJson = JSON.stringify(settings);
                  localStorage.setItem('loki_settings_updated_at_v1', String(settingsUpdatedAt));
                }
              }
              cloudWorkspaceLoaded = true;
            } catch (error) {
              if (transitionId !== authTransitionId) return;
              console.warn('Loki could not load the account cloud workspace.', error);
              // Preserve pending local edits. If this is the first auth load and
              // no scoped snapshot exists, quarantine the unassigned bootstrap
              // data instead of uploading it to the account.
              if (!loadedLocal) {
                if (!authWorkspaceReady) saveWorkspaceScope('legacy-unassigned');
                tasks = [];
                routines = [];
                deletions = [];
                settings = { theme: 'dark', language: 'fa' };
                settingsUpdatedAt = Date.now();
                persistedSettingsJson = JSON.stringify(settings);
                localStorage.setItem('loki_settings_updated_at_v1', String(settingsUpdatedAt));
              }
              cloudWorkspaceLoaded = false;
              showToast(text(
                'اطلاعات ابری بارگذاری نشد؛ فضای محلی این حساب جداگانه باز شد.',
                'Cloud data could not be loaded; this account opened in an isolated local workspace.'
              ));
            }
          }

          if (transitionId !== authTransitionId) return;
          if (cloudWorkspaceLoaded && !localStorage.getItem('loki_first_account_uid_v1')) {
            localStorage.setItem('loki_first_account_uid_v1', nextUid);
          }
          writeBaseWorkspace();
          saveWorkspaceScope(nextUid);
          if (cloudWorkspaceLoaded) await writeIndexedSnapshot();
          if (cloudWorkspaceLoaded) {
            try {
              await syncLokiCloud();
              if (settings.notificationsEnabled && 'Notification' in window && Notification.permission === 'granted') {
                const registration = await navigator.serviceWorker.ready;
                await registerFirebasePush(registration);
              }
            } catch (error) {
              console.warn('Loki initial cloud sync or push association failed:', error);
            }
            listenToCloudWorkspace(nextUid, transitionId, ref);
          }
        } else {
          cloudWorkspaceLoaded = false;
          const hasUsedAccount = Boolean(localStorage.getItem('loki_first_account_uid_v1'));
          const guestLoaded = hasUsedAccount ? false : loadWorkspaceScope('guest');

          // Account data must never become the logged-out workspace. The guest
          // snapshot may be a legacy copy created during first-account migration.
          if (hasUsedAccount || !guestLoaded) {
            tasks = [];
            routines = [];
            deletions = [];
            settings = { theme: 'dark', language: 'fa' };
            settingsUpdatedAt = Date.now();
            persistedSettingsJson = JSON.stringify(settings);
            localStorage.setItem('loki_settings_updated_at_v1', String(settingsUpdatedAt));
          }
          writeBaseWorkspace();
          await writeIndexedSnapshot();
        }

        if (transitionId !== authTransitionId) return;
        authWorkspaceReady = true;
        document.body.classList.toggle('light', settings.theme === 'light');
        render();
      });

    } catch (error) {
      console.error('LOKI AUTH INIT ERROR:',error);
    }
  }

  
function accountSettingsCard() {
  if (cloudUser) {
    return `
      <div class="setting-card">
        <div class="eyebrow">LOKI ACCOUNT</div>

        <h3>${text('حساب کاربری Loki','Loki account')}</h3>

        <p>
          ${text('حساب شما متصل است.','Your account is connected.')}
        </p>

        <div class="setting-row">
          <span>${text('ایمیل حساب','Account email')}</span>
          <span class="tag">${escapeHtml(cloudUser.email||'')}</span>
        </div>

        <div class="setting-row">
          <button class="secondary-btn" id="lokiSignOut">
            ${text('خروج از حساب','Sign out')}
          </button>
        </div>
      </div>
    `;
  }

  const savedEmail = localStorage.getItem('loki_saved_auth_email_v1') || '';

  return `
    <div class="setting-card">
      <div class="eyebrow">LOKI ACCOUNT</div>

      <h3>${text('حساب کاربری Loki','Loki account')}</h3>

      <p>
        ${text(
          'برای اتصال اطلاعات به فضای ابری، حساب بساز یا وارد شو.',
          'Create an account or sign in to connect your data to the cloud.'
        )}
      </p>

      <form id="lokiAuthForm">
        <label>${text('ایمیل','Email')}</label>

        <input
          id="lokiAuthEmail"
          type="email"
          required
          autocomplete="email"
          value="${escapeHtml(savedEmail)}"
          placeholder="name@example.com"
        >

        <label>${text('رمز عبور','Password')}</label>

        <div class="setting-row">
          <input
            id="lokiAuthPassword"
            type="password"
            required
            minlength="6"
            autocomplete="current-password"
            placeholder="${text('حداقل ۶ کاراکتر','At least 6 characters')}"
            style="flex:1;min-width:0"
          >

          <button
            class="secondary-btn"
            type="button"
            id="lokiTogglePassword"
          >
            ${text('نمایش','Show')}
          </button>
        </div>

        <div class="setting-row">
          <button
            class="primary-btn"
            type="submit"
            id="lokiSignIn"
          >
            ${text('ورود','Sign in')}
          </button>

          <button
            class="secondary-btn"
            type="button"
            id="lokiSignUp"
          >
            ${text('ساخت حساب','Create account')}
          </button>
        </div>
      </form>
    </div>
  `;
}

  function settingsPage() {
    return `
      <div class="settings-grid">
        ${accountSettingsCard()}

        <div class="setting-card">
          <div class="eyebrow">APPEARANCE</div>

          <h3>${text('ظاهر برنامه','Appearance')}</h3>

          <p>
            ${text(
              'تم برنامه رو مطابق سلیقه‌ات انتخاب کن.',
              'Choose the theme that suits you.'
            )}
          </p>

          <div class="setting-row">
            <span>${text('تم روشن / تاریک','Light / dark theme')}</span>

            <button class="secondary-btn" id="settingTheme">
              ${settings.theme==='dark'
                ?text('تاریک','Dark')
                :text('روشن','Light')}
            </button>
          </div>
        </div>

        <div class="setting-card">
          <div class="eyebrow">LANGUAGE</div>

          <h3>${text('زبان','Language')}</h3>

          <p>
            ${text(
              'رابط کاربری فارسی و انگلیسی.',
              'Persian and English interface.'
            )}
          </p>

          <div class="setting-row">
            <span>${text('زبان فعلی','Current language')}</span>

            <button class="secondary-btn" id="settingLanguage">
              ${settings.language==='fa'?'فارسی':'English'}
            </button>
          </div>
        </div>

        <div class="setting-card">
          <div class="eyebrow">REMINDERS</div>

          <h3>${text('اعلان‌ها و یادآوری‌ها','Notifications & reminders')}</h3>

          <p>
            ${text(
              'اعلان مرورگر و ثبت دستگاه قابل فعال‌سازی است؛ اما ارسال یادآوری زمان‌بندی‌شده هنگام بسته‌بودن کامل برنامه هنوز به سرویس زمان‌بندی سمت سرور نیاز دارد.',
              'Browser notifications and device registration can be enabled. Scheduled reminders while the app is fully closed still require a server-side scheduler.'
            )}
          </p>

          <div class="setting-row">
            <span>${text('وضعیت اعلان‌ها','Notification status')}</span>

            <span class="tag" id="notificationStatus">
              ${notificationStatusLabel()}
            </span>
          </div>

          <div class="setting-row">
            <span>${text('یادآوری‌ها','Reminders')}</span>

            <button class="secondary-btn" id="enableNotifications">
              ${settings.notificationsEnabled
                ?text('خاموش کردن','Turn off')
                :text('فعال‌سازی اعلان‌ها','Enable notifications')}
            </button>
          </div>

          ${
            localStorage.getItem('loki_fcm_token')
            ?`
              <div class="setting-row">
                <span>${text('اتصال Firebase','Firebase connection')}</span>

                <button class="secondary-btn" id="copyPushToken">
                  ${text('کپی شناسه دستگاه','Copy device token')}
                </button>
              </div>
            `
            :''
          }
        </div>

        <div class="setting-card">
          <div class="eyebrow">DATA & PRIVACY</div>

          <h3>${text('اطلاعات و حریم خصوصی','Data & privacy')}</h3>

          <p>
            ${text(
              'اطلاعات فعلاً فقط در حافظه مرورگر همین دستگاه نگهداری می‌شود. پاک‌کردن داده‌های مرورگر ممکن است اطلاعات را حذف کند.',
              'Your data is currently stored in this browser on this device. Clearing browser data may erase it.'
            )}
          </p>

          <div class="setting-row">
            <span>${text('پشتیبان‌گیری','Backup')}</span>

            <button class="secondary-btn" id="exportData">
              ${text('دریافت فایل JSON','Export JSON')}
            </button>
          </div>

          <div class="setting-row">
            <span>${text('بازیابی اطلاعات','Restore')}</span>

            <label
              class="secondary-btn"
              for="importData"
              style="cursor:pointer"
            >
              ${text('انتخاب فایل','Choose file')}
            </label>

            <input
              id="importData"
              type="file"
              accept="application/json"
              class="hidden"
            >
          </div>
        </div>

        <div class="setting-card">
          <div class="eyebrow">INSTALLATION</div>

          <h3>${text('نصب Loki','Install Loki')}</h3>

          <p>
            ${text(
              'از منوی مرورگر گزینه Install app یا Add to Home Screen را انتخاب کن. برای نصب، برنامه باید روی HTTPS یا localhost اجرا شود.',
              'Use Install app or Add to Home Screen in your browser. Installation requires HTTPS or localhost.'
            )}
          </p>

          <div class="setting-row">
            <span>${text('وضعیت برنامه','App status')}</span>
            <span class="tag">${text('نسخه وب پیش‌رونده','PWA')}</span>
          </div>
        </div>
      </div>
    `;
  }

  function setupJalaliDatePicker() {
    const original = $('#itemDate');

    if (!original || $('#jalaliDatePicker')) return;

    original.classList.add('hidden');

    const wrap = document.createElement('div');
    wrap.id = 'jalaliDatePicker';
    wrap.className = 'jalali-date-picker';

    wrap.innerHTML = `
      <select id="jalaliYear" aria-label="${text('سال شمسی','Persian year')}"></select>
      <select id="jalaliMonth" aria-label="${text('ماه شمسی','Persian month')}"></select>
      <select id="jalaliDay" aria-label="${text('روز','Day')}"></select>
      <button type="button" id="clearJalaliDate" class="mini-btn">
        ${text('بدون تاریخ','No date')}
      </button>
    `;

    original.insertAdjacentElement('afterend',wrap);

    const year = $('#jalaliYear');
    const month = $('#jalaliMonth');
    const day = $('#jalaliDay');

    const years = Array.from({length:21},(_,i)=>1390+i);

    year.innerHTML =
      `<option value="">${text('سال','Year')}</option>`+
      years.map(y=>`
        <option value="${y}">
          ${settings.language==='fa'
            ?new Intl.NumberFormat('fa-IR').format(y)
            :y}
        </option>
      `).join('');

    month.innerHTML =
      `<option value="">${text('ماه','Month')}</option>`+
      monthsFa.map((m,i)=>`
        <option value="${i+1}">
          ${settings.language==='fa'?m:monthsEn[i]}
        </option>
      `).join('');

    day.innerHTML =
      `<option value="">${text('روز','Day')}</option>`;

    const refreshDays = (selected='') => {
      const y = Number(year.value);
      const m = Number(month.value);
      const max = y&&m?jalaliMonthLength(y,m):31;

      day.innerHTML =
        `<option value="">${text('روز','Day')}</option>`+
        Array.from({length:max},(_,i)=>i+1)
          .map(d=>`
            <option value="${d}">
              ${settings.language==='fa'
                ?new Intl.NumberFormat('fa-IR').format(d)
                :d}
            </option>
          `).join('');

      if (selected&&Number(selected)<=max) {
        day.value = String(selected);
      }
    };

    year.addEventListener('change',()=>{
      refreshDays();
      syncHidden();
    });

    month.addEventListener('change',()=>{
      refreshDays();
      syncHidden();
    });

    day.addEventListener('change',syncHidden);

    $('#clearJalaliDate').addEventListener('click',()=>{
      year.value = '';
      month.value = '';
      refreshDays();
      original.value = '';
    });

    function syncHidden() {
      if (year.value&&month.value&&day.value) {
        try {
          original.value = dateKey(
            fromJalali(
              Number(year.value),
              Number(month.value),
              Number(day.value)
            )
          );
        } catch {
          original.value = '';
        }
      } else {
        original.value = '';
      }
    }

    wrap._setDate = value => {
      if (!value) {
        year.value = '';
        month.value = '';
        refreshDays();
        original.value = '';
        return;
      }

      const p = jalaliParts(parseKey(value));

      if (!years.includes(p.year)) {
        const opt = document.createElement('option');
        opt.value = p.year;
        opt.textContent = p.year;
        year.add(opt);
      }

      year.value = String(p.year);
      month.value = String(p.month);

      refreshDays(p.day);
      syncHidden();
    };

    wrap._sync = syncHidden;

    const style = document.createElement('style');

    style.textContent = `
      .jalali-date-picker{
        display:flex;
        gap:8px;
        align-items:center;
        flex-wrap:wrap;
        margin-top:7px
      }

      .jalali-date-picker select{
        min-width:82px;
        flex:1;
        background:var(--field-bg,rgba(255,255,255,.05));
        color:inherit;
        border:1px solid var(--border,rgba(255,255,255,.12));
        border-radius:10px;
        padding:10px;
        font:inherit
      }

      .jalali-date-picker option{
        background:#10271d;
        color:#fff
      }

      #itemDate.hidden{
        display:none!important
      }
    `;

    document.head.appendChild(style);
  }

  function setJalaliDatePicker(value) {
    setupJalaliDatePicker();
    $('#jalaliDatePicker')._setDate(value||'');
  }

  function openModal(kind,id=null,prefill=null) {
    const isRoutine = kind==='routine';

    const item = id
      ?(isRoutine?routines:tasks).find(x=>String(x.id)===String(id))
      :null;

    $('#itemForm').dataset.kind = kind;
    $('#itemId').value = item?.id||'';

    $('#modalTitle').textContent = item
      ?text('ویرایش مورد','Edit item')
      :isRoutine
        ?text('روتین جدید','New routine')
        :text('کار جدید','New task');

    $('#modalEyebrow').textContent =
      isRoutine?'LOKI / ROUTINE':'LOKI / TASK';

    $('#itemTitle').value = item?.title||'';
    $('#itemNotes').value = item?.notes||'';
    $('#itemCategory').value = item?.category||'personal';
    $('#itemPriority').value = item?.priority||'normal';

    $('#itemDate').value =
      item?.date||(prefill||dateKey(new Date()));

    setJalaliDatePicker($('#itemDate').value);

    $('#itemTime').value = item?.time||'';

    $('#taskFields').classList.toggle('hidden',isRoutine);
    $('#priorityField').classList.toggle('hidden',isRoutine);
    $('#routineFields').classList.toggle('hidden',!isRoutine);

    $('#routineRepeat').value = item?.repeat||'daily';
    $('#routineConfirm').checked = !!item?.confirm;

    $$('#weekdayPicks input').forEach(c=>{
      c.checked = (item?.weekdays||[]).includes(Number(c.value));
    });

    $('#weekdayPicks').classList.toggle(
      'hidden',
      $('#routineRepeat').value!=='weekdays'
    );

    $('#itemDialog').showModal();

    setTimeout(()=>$('#itemTitle').focus(),50);
  }

  function closeModal() {
    $('#itemDialog').close();
  }

  function saveItem(e) {
    e.preventDefault();

    const kind = $('#itemForm').dataset.kind;
    const id = $('#itemId').value;
    const title = $('#itemTitle').value.trim();

    if (!title) return;

    if (kind==='task') {
      $('#jalaliDatePicker')?._sync?.();

      const obj = {
        id:id||uid(),
        title,
        notes:$('#itemNotes').value,
        category:$('#itemCategory').value,
        priority:$('#itemPriority').value,
        date:$('#itemDate').value,
        time:$('#itemTime').value,
        done:id
          ?(tasks.find(t=>String(t.id)===String(id))?.done||false)
          :false,
        createdAt:id ? (tasks.find(t=>String(t.id)===String(id))?.createdAt || Date.now()) : Date.now(),
        modifiedAt:Date.now()
      };

      if (id) {
        tasks = tasks.map(t=>String(t.id)===String(id)?obj:t);
      } else {
        tasks.unshift(obj);
      }

    } else {
      const obj = {
        id:id||uid(),
        title,
        notes:$('#itemNotes').value,
        category:$('#itemCategory').value,
        time:$('#itemTime').value||'09:00',
        repeat:$('#routineRepeat').value,
        weekdays:$$('#weekdayPicks input:checked')
          .map(c=>Number(c.value)),
        weekday:new Date().getDay(),
        monthDay:jalaliParts(new Date()).day,
        confirm:$('#routineConfirm').checked,
        enabled:id
          ?(routines.find(r=>String(r.id)===String(id))?.enabled??true)
          :true,
        createdAt:id ? (routines.find(r=>String(r.id)===String(id))?.createdAt || Date.now()) : Date.now(),
        modifiedAt:Date.now()
      };

      if (obj.repeat==='weekdays'&&!obj.weekdays.length) {
        showToast(
          text(
            'حداقل یک روز هفته انتخاب کن.',
            'Choose at least one weekday.'
          )
        );
        return;
      }

      if (id) {
        routines = routines.map(r=>String(r.id)===String(id)?obj:r);
      } else {
        routines.unshift(obj);
      }
    }

    persist();
    closeModal();
    render();

    showToast(
      text('با موفقیت ذخیره شد.','Saved successfully.')
    );
  }

  function deleteItem(kind,id) {
    if (!confirm(text(
      'از حذف این مورد مطمئنی؟',
      'Are you sure you want to delete this item?'
    ))) return;

    id = String(id);
    const deletedAt = Date.now();
    deletions = deletions.filter(item => !(item.kind===kind && String(item.id)===id));
    deletions.push({ kind, id, deletedAt });
    if (kind==='task') {
      tasks = tasks.filter(t=>String(t.id)!==id);
    } else {
      routines = routines.filter(r=>String(r.id)!==id);
    }

    // Render the removal immediately and bypass the normal cloud-sync debounce.
    render();
    persist({ immediateCloudSync: true });

    showToast(text('حذف شد.','Deleted.'));
  }

  function toggleDone(id,done) {
    id = String(id);
    tasks = tasks.map(t=>String(t.id)===id?{...t,done,modifiedAt:Date.now()}:t);
    persist();
    render();
  }

  function filterTasks() {
    const q = $('#taskSearch')?.value.toLowerCase()||'';
    const f = $('#taskFilter')?.value||'all';

    const list = tasks.filter(t=>
      (t.title+' '+(t.notes||'')).toLowerCase().includes(q)&&
      (
        f==='all'||
        (f==='done'?t.done:!t.done)
      )
    );

    $('#taskResults').innerHTML = list.length
      ?list.map(t=>taskRow(t,true)).join('')
      :`
        <div class="empty">
          ${text('موردی پیدا نشد.','No matching tasks.')}
        </div>
      `;
  }

  function parseNatural(input) {
    const lower = input.toLowerCase();

    if (/کارهای باز|کارها.*نشون|show.*tasks|open tasks/.test(lower)) {
      return {type:'list'};
    }

    if (/روتین|routine/.test(lower)) {
      return {type:'routine'};
    }

    let date = new Date();

    if (/فردا|tomorrow/.test(lower)) {
      date.setDate(date.getDate()+1);
    } else if (/پس.?فردا/.test(lower)) {
      date.setDate(date.getDate()+2);
    }

    let time = '';

    const tm = lower.match(
      /(?:ساعت\s*)?(\d{1,2})(?::(\d{2}))?\s*(?:صبح|عصر|شب|am|pm)?/
    );

    if (
      tm&&
      /ساعت|am|pm|صبح|عصر|شب/.test(lower)
    ) {
      let h = Number(tm[1]);

      if (/عصر|شب|pm/.test(lower)&&h<12) {
        h += 12;
      }

      time =
        String(h%24).padStart(2,'0')+
        ':'+
        String(Number(tm[2]||0)).padStart(2,'0');
    }

    let title = input.replace(
      /فردا|tomorrow|پس.?فردا|ساعت\s*\d{1,2}(?::\d{2})?\s*(صبح|عصر|شب)?/gi,
      ''
    ).trim();

    title = title.replace(
      /^(لطفا|لطفاً|یک کار|یه کار|ثبت کن|یادآوری کن)\s*/,
      ''
    ).trim();

    if (!title) title = input;

    return {
      type:'task',
      title,
      date:dateKey(date),
      time
    };
  }

  function assistantSend(input) {
    const log = $('#chatLog');

    const add = (who,msg) => {
      log.insertAdjacentHTML(
        'beforeend',
        `<div class="bubble ${who}">${escapeHtml(msg)}</div>`
      );

      log.scrollTop = log.scrollHeight;
    };

    add('user',input);

    const parsed = parseNatural(input);

    if (parsed.type==='list') {
      const open = tasks.filter(t=>!t.done);

      add(
        'bot',
        open.length
          ?open.map((t,i)=>`${i+1}. ${t.title}`).join(' · ')
          :text('کار بازی نداری.','You have no open tasks.')
      );

      return;
    }

    if (parsed.type==='routine') {
      setPage('routines');
      openModal('routine');
      return;
    }

    if (!parsed.title) {
      add(
        'bot',
        text(
          'متوجه عنوان کار نشدم؛ دوباره واضح‌تر بنویس.',
          'I could not identify the task title. Please rephrase.'
        )
      );

      return;
    }

    tasks.unshift({
      id:uid(),
      title:parsed.title,
      notes:'',
      category:/درس|ریاضی|مطالعه|study|math/.test(input.toLowerCase())
        ?'study'
        :'personal',
      priority:'normal',
      date:parsed.date,
      time:parsed.time,
      done:false,
      createdAt:Date.now()
    });

    persist();

    add(
      'bot',
      text(
        `ثبت شد: ${parsed.title} · ${jalaliLabel(parseKey(parsed.date),false)}${parsed.time?' · '+parsed.time:''}`,
        `Added: ${parsed.title} · ${jalaliLabel(parseKey(parsed.date),false)}${parsed.time?' · '+parsed.time:''}`
      )
    );

    $('#taskCount').textContent =
      tasks.filter(t=>!t.done).length;
  }

  document.addEventListener('click',e=>{
    const nav = e.target.closest('[data-page]');

    if (nav) {
      setPage(nav.dataset.page);
      return;
    }

    const go = e.target.closest('[data-goto]');

    if (go) {
      setPage(go.dataset.goto);
      return;
    }

    const action = e.target.closest('[data-action]');

    if (action) {
      openModal(
        action.dataset.action,
        null,
        action.dataset.prefillDate||null
      );
      return;
    }

    const done = e.target.closest('[data-done]');

    if (done) {
      toggleDone(done.dataset.done,done.checked);
      return;
    }

    const edit = e.target.closest('[data-edit-task]');

    if (edit) {
      openModal('task',edit.dataset.editTask);
      return;
    }

    const del = e.target.closest('[data-delete-task]');

    if (del) {
      deleteItem('task',del.dataset.deleteTask);
      return;
    }

    const er = e.target.closest('[data-edit-routine]');

    if (er) {
      openModal('routine',er.dataset.editRoutine);
      return;
    }

    const dr = e.target.closest('[data-delete-routine]');

    if (dr) {
      deleteItem('routine',dr.dataset.deleteRoutine);
      return;
    }

    const date = e.target.closest('[data-date]');

    if (date) {
      selectedDate = date.dataset.date;

      const chosen = parseKey(selectedDate);

      if (chosen) monthCursor = chosen;

      render();
      return;
    }

    const view = e.target.closest('[data-calendar-view]');

    if (view) {
      calendarView = view.dataset.calendarView;
      render();
      return;
    }

    const period = e.target.closest('[data-period]');

    if (period) {
      const delta = Number(period.dataset.period);

      if (delta===0) {
        selectedDate = dateKey(new Date());
        monthCursor = new Date();

      } else if (calendarView==='month') {
        monthCursor = shiftJalaliMonth(monthCursor,delta);

      } else {
        const selected = parseKey(selectedDate)||new Date();

        selectedDate = dateKey(
          addDays(selected,delta*7)
        );

        monthCursor = parseKey(selectedDate);
      }

      render();
      return;
    }

    const prompt = e.target.closest('[data-prompt]');

    if (prompt) {
      $('#chatInput').value = prompt.dataset.prompt;
      $('#chatForm').requestSubmit();
    }
  });

  document.addEventListener('change',e=>{
    if (e.target.matches('[data-routine-toggle]')) {
      const routineId = String(e.target.dataset.routineToggle);
      routines = routines.map(r=>
        String(r.id)===routineId
          ?{...r,enabled:e.target.checked,modifiedAt:Date.now()}
          :r
      );

      persist();
      render();
    }

    if (e.target.id==='taskFilter') {
      filterTasks();
    }

    if (e.target.id==='importData'&&e.target.files[0]) {
      const reader = new FileReader();

      reader.onload = () => {
        try {
          const d = JSON.parse(reader.result);

          if (
            !Array.isArray(d.tasks)||
            !Array.isArray(d.routines)
          ) {
            throw Error();
          }

          if (d.schemaVersion && Number(d.schemaVersion) > 1) {
            throw new Error('Unsupported backup version');
          }
          const validRecords = list => list.every(item => item && typeof item === 'object' && typeof item.id === 'string' && typeof item.title === 'string');
          if (!validRecords(d.tasks) || !validRecords(d.routines)) throw new Error('Invalid backup records');
          tasks = d.tasks;
          routines = d.routines;
          if (d.settings && typeof d.settings === 'object') settings = { ...settings, ...d.settings };

          persist();
          render();

          showToast(
            text('اطلاعات بازیابی شد.','Data restored.')
          );

        } catch {
          showToast(
            text('فایل پشتیبان معتبر نیست.','Invalid backup file.')
          );
        }
      };

      reader.readAsText(e.target.files[0]);
    }

    if (e.target.id==='routineRepeat') {
      $('#weekdayPicks').classList.toggle(
        'hidden',
        e.target.value!=='weekdays'
      );
    }
  });

  document.addEventListener('input',e=>{
    if (e.target.id==='taskSearch') {
      filterTasks();
    }
  });

  $('#quickAdd').addEventListener('click',()=>{
    openModal('task');
  });

  $('#closeModal').addEventListener('click',closeModal);
  $('#cancelModal').addEventListener('click',closeModal);
  $('#itemForm').addEventListener('submit',saveItem);

  $('#menuBtn').addEventListener('click',()=>{
    $('#sidebar').classList.toggle('open');
  });

  $('#themeBtn').addEventListener('click',()=>{
    settings.theme =
      settings.theme==='dark'?'light':'dark';

    document.body.classList.toggle(
      'light',
      settings.theme==='light'
    );

    persist();
  });

  // Keep delegated listeners registered once; #page content is re-rendered.
  $('#page').addEventListener('input', e => {
    if (e.target.id === 'lokiAuthEmail') {
      const email = e.target.value.trim();

      if (email) {
        localStorage.setItem('loki_saved_auth_email_v1', email);
      } else {
        localStorage.removeItem('loki_saved_auth_email_v1');
      }
    }
  });

  $('#page').addEventListener('click', e => {
    const toggle = e.target.closest('#lokiTogglePassword');
    if (!toggle) return;

    const password = $('#lokiAuthPassword');
    if (!password) return;

    const showing = password.type === 'password';
    password.type = showing ? 'text' : 'password';
    toggle.textContent = showing
      ? text('مخفی','Hide')
      : text('نمایش','Show');
  });

  // This handler owns the settings and account actions that use await.
  $('#page').addEventListener('click', async e => {
    if (e.target.closest('#settingTheme')) {
      $('#themeBtn').click();
      render();
      return;
    }

    if (e.target.id==='settingLanguage') {
      settings.language =
        settings.language==='fa'?'en':'fa';

      persist();
      render();
    }

    if (e.target.id==='enableNotifications') {
      if (settings.notificationsEnabled) {
        settings.notificationsEnabled = false;
        persist();
        syncDeviceTokenRecord(false).catch(error => console.warn('Loki could not update device notification preference:', error));
        render();

        showToast(
          text('اعلان‌ها خاموش شدند.','Notifications disabled.')
        );

      } else {
        enableNotifications();
      }
    }

    if (e.target.id==='copyPushToken') {
      const token = localStorage.getItem('loki_fcm_token');

      if (token&&navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(token)
          .then(()=>{
            showToast(
              text(
                'شناسه دستگاه کپی شد. آن را فقط در Firebase Console وارد کن.',
                'Device token copied. Paste it only in Firebase Console.'
              )
            );
          })
          .catch(()=>{
            showToast(
              text('کپی انجام نشد.','Copy failed.')
            );
          });
      }
    }

    if (e.target.id==='exportData') {
      const blob = new Blob(
        [
          JSON.stringify(
            {
              schemaVersion: 1,
              tasks,
              routines,
              settings,
              exportedAt:new Date().toISOString()
            },
            null,
            2
          )
        ],
        {type:'application/json'}
      );

      const a = document.createElement('a');

      a.href = URL.createObjectURL(blob);
      a.download = 'loki-backup.json';
      a.click();

      URL.revokeObjectURL(a.href);
    }

    if (e.target.id==='lokiSignUp') {
      const email = $('#lokiAuthEmail')?.value.trim();
      const password = $('#lokiAuthPassword')?.value;

      if (!email||!password) {
        showToast(
          text(
            'ایمیل و رمز عبور را وارد کن.',
            'Enter your email and password.'
          )
        );

        return;
      }

      try {
        await ensureFirebaseServices();

        await firebaseAuthInstance
          .createUserWithEmailAndPassword(email,password);

        showToast(
          text(
            'حساب Loki با موفقیت ساخته شد.',
            'Loki account created successfully.'
          )
        );

      } catch (error) {
        console.error('LOKI SIGN UP ERROR:',error);

        showToast(
          text(
            'ساخت حساب ناموفق بود. اطلاعات را بررسی کن.',
            'Account creation failed. Check your details.'
          )
        );
      }
    }

    if (e.target.id==='lokiSignOut') {
      try {
        await syncDeviceTokenRecord(false).catch(error => console.warn('Loki could not disable this device token before sign-out:', error));
        await firebaseAuthInstance.signOut();

        showToast(
          text('از حساب خارج شدی.','Signed out successfully.')
        );

      } catch (error) {
        console.error('LOKI SIGN OUT ERROR:',error);

        showToast(
          text('خروج از حساب ناموفق بود.','Sign out failed.')
        );
      }
    }
  });

  $('#page').addEventListener('submit',async e=>{
    if (e.target.id==='chatForm') {
      e.preventDefault();

      const input = $('#chatInput').value.trim();

      if (input) {
        $('#chatInput').value = '';
        assistantSend(input);
      }

      return;
    }

    if (e.target.id==='lokiAuthForm') {
      e.preventDefault();

      const email = $('#lokiAuthEmail').value.trim();
      const password = $('#lokiAuthPassword').value;

      try {
        await ensureFirebaseServices();

        await firebaseAuthInstance
          .signInWithEmailAndPassword(email,password);

        // FIX: Use the actual toast function.
        showToast(
          text(
            'با موفقیت وارد حساب شدی.',
            'Signed in successfully.'
          )
        );

      } catch (error) {
        console.error('LOKI SIGN IN ERROR:',error);

        // FIX: Use the actual toast function.
        const authCode = error?.code || '';
        const networkFailure = authCode === 'auth/network-request-failed' ||
          authCode === 'auth/timeout' || !navigator.onLine;

        showToast(
          networkFailure
            ? text(
                'اتصال به سرور ورود Firebase برقرار نشد؛ احتمالاً دسترسی شبکه به سرویس‌های Google محدود است. کد: ' + (authCode || 'network'),
                'Could not reach Firebase Auth. Network access to Google services may be restricted. Code: ' + (authCode || 'network')
              )
            : text(
                'ورود ناموفق بود. کد خطا: ' + (authCode || 'unknown'),
                'Sign-in failed. Error code: ' + (authCode || 'unknown')
              )
        );
      }
    }
  });

  document.body.classList.toggle(
    'light',
    settings.theme==='light'
  );

  applyLanguage();
  render();

  // Restore IndexedDB before writing a fresh snapshot or starting cloud sync.
  // Starting both operations concurrently could overwrite the only good local
  // snapshot with an empty localStorage state during first launch.
  (async () => {
    const restored = await restoreIndexedSnapshot();
    if (restored) {
      document.body.classList.toggle('light', settings.theme === 'light');
      applyLanguage();
      render();
    } else {
      await writeIndexedSnapshot();
    }
    await initializeLokiAuth();
  })().catch(error => console.error('LOKI DATA CORE INIT ERROR:', error));

  window.addEventListener('online', retryPendingCloudWorkspace);

  if (
    'serviceWorker' in navigator &&
    location.protocol!=='file:'
  ) {
    navigator.serviceWorker.register('./sw.js')
      .then(reg=>{
        console.log('LOKI SW REGISTERED:',reg.scope);
      })
      .catch(err=>{
        console.error('LOKI SW ERROR:',err);
      });
  }

  checkReminders();

  setInterval(checkReminders, 15000);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      checkReminders();
    }
  });

  // Firebase Push can receive server-sent messages in the background.
  // Scheduled task delivery still needs a trusted server scheduler.

  
})()