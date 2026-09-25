(function () {
  "use strict";

  // Fetched from /api/schedule at boot — the server (rotation.js) is the
  // single source of truth; this used to be a second hand-copied version
  // here that could silently drift from the one the API actually uses.
  var SCHEDULE = {};

  var BIN_COLOR = { M: "var(--bin-m)", E: "var(--bin-e)", P: "var(--bin-p)", V: "var(--bin-v)", B: "var(--bin-b)", R: "var(--bin-r)" };
  var GAME_CODES = ["M", "E", "P", "V", "B", "R"];

  var ITEMS = [
    { name: "Plastic water bottle", code: "E", why: "Bottles, tubs, cans & cartons all go in the blue Valorlux bag." },
    { name: "Empty wine bottle, rinsed", code: "V", why: "Bottles & jars only — lid, cork ring and sleeve come off first." },
    { name: "Milk or juice carton", code: "E", why: "Drink cartons are Valorlux, not paper — officially excluded from the blue bin." },
    { name: "Clean cardboard box, flattened", code: "P", why: "Paper & cardboard — has to stay clean and dry to be recycled." },
    { name: "Used cotton buds", code: "M", why: "Not recyclable anywhere — household bin." },
    { name: "Old rug", code: "R", why: "Too bulky for any bin — Resource Center or on-request pickup." },
    { name: "Banana peel", code: "B", why: "Food scraps — even raw or cooked, into biowaste." },
    { name: "Empty drink can", code: "E", why: "Metal packaging is Valorlux, with the bottles." },
    { name: "Newspaper, bundled", code: "P", why: "Clean paper — weekly with the cardboard." },
    { name: "Broken toaster", code: "R", why: "Household appliances go to the Resource Center, never the curb." },
    { name: "Rinsed jam jar, lid off", code: "V", why: "The jar is glass — the metal lid isn't, and goes in household waste." },
    { name: "Cooked leftovers", code: "B", why: "Cooked food counts too — even meat and fish go in biowaste here." },
    { name: "Used batteries", code: "R", why: "Hazardous — explicitly barred from the household bin, always dropped off." },
    { name: "Greasy pizza box", code: "M", why: "Soiled cardboard is explicitly excluded from paper recycling." },
    { name: "Yogurt pot", code: "E", why: "Plastic pots, tubs and trays are now accepted in the Valorlux bag." },
    { name: "Used aluminium foil", code: "M", why: "Explicitly excluded from Valorlux — foil goes in household waste." },
    { name: "Burnt-out light bulb", code: "R", why: "Barred from both glass and household waste — a drop-off item." },
    { name: "Used cat litter", code: "M", why: "Named as excluded from biowaste — household bin instead." }
  ];

  var ROSTER = []; // loaded from /api/roster before first render
  var ROSTER_OCCUPATION = {}; // name -> occupation string, loaded from /api/roster/full
  var ROSTER_CREATED_AT = {}; // name -> ISO date string, loaded from /api/roster/full (only known for names added after this shipped)
  var subscribedNames = {}; // name -> true, refreshed by loadSubscribers()
  var AVATAR_COLORS = ["#55A3CE", "#E7B62B", "#D08A3E", "#B08DE0", "#E2604A", "#6FB25F", "#63C7A6", "#C77DBB"];
  var ANCHOR_MONDAY = new Date(2026, 8, 21);

  // ---- which house — a plain URL param (?h=slug), never a login. The
  // original house (this app's very first one) has no param at all, so
  // every link and bookmark that predates multi-house keeps working
  // unchanged. api() appends it to every request; a bare "" means "the
  // original house" both here and on the server. ----
  var HOUSE_SLUG = "";
  try {
    HOUSE_SLUG = new URLSearchParams(location.search).get("h") || "";
  } catch (e) {}
  function api(path) {
    if (!HOUSE_SLUG) return path;
    var sep = path.indexOf("?") === -1 ? "?" : "&";
    return path + sep + "h=" + encodeURIComponent(HOUSE_SLUG);
  }
  // The houses this device has built or joined — shown on the You tab, each
  // with its own shareable link. Purely local, like everything else here:
  // nothing about "which houses you're in" lives on any server.
  var MY_HOUSES = [];
  (function initMyHouses() {
    try {
      var saved = JSON.parse(localStorage.getItem("binDutyMyHouses") || "[]");
      // slug === "" used to mean "the original house" before it needed its
      // own real invite link too — that entry is stale now (it would point
      // at the landing page), so it's dropped on load rather than shown.
      if (Array.isArray(saved)) MY_HOUSES = saved.filter(function (h) { return h && h.slug; });
    } catch (e) {}
  })();
  function rememberHouse(slug, name) {
    // slug === "" is the original house, a legitimate value here — not
    // "nothing to remember" — so this only guards against a truly missing
    // argument (undefined/null), never against the empty string.
    if (slug == null) return;
    MY_HOUSES = MY_HOUSES.filter(function (h) { return h.slug !== slug; });
    MY_HOUSES.unshift({ slug: slug, name: name || slug });
    try { localStorage.setItem("binDutyMyHouses", JSON.stringify(MY_HOUSES)); } catch (e) {}
  }
  // Owner keys for houses this browser built — the only proof of "who built
  // it" in an app with no accounts. Handed out once by the server at build
  // time; needed to destroy the house. Losing this storage loses the key.
  function getOwnerTokens() {
    try {
      var t = JSON.parse(localStorage.getItem("binDutyOwnerTokens") || "{}");
      return t && typeof t === "object" ? t : {};
    } catch (e) { return {}; }
  }
  function setOwnerToken(slug, token) {
    var t = getOwnerTokens();
    if (token) t[slug] = token; else delete t[slug];
    try { localStorage.setItem("binDutyOwnerTokens", JSON.stringify(t)); } catch (e) {}
  }
  function forgetHouse(slug) {
    MY_HOUSES = MY_HOUSES.filter(function (h) { return h.slug !== slug; });
    try {
      localStorage.setItem("binDutyMyHouses", JSON.stringify(MY_HOUSES));
      localStorage.removeItem("binDutyMe:" + slug);
      localStorage.removeItem("binDutyBestStreak:" + slug);
    } catch (e) {}
    setOwnerToken(slug, null);
  }
  function houseLink(slug) {
    var url = new URL(location.href);
    url.search = slug ? "?h=" + encodeURIComponent(slug) : "";
    url.hash = "";
    return url.toString();
  }
  // Per-person state (who you are, your best streak) is scoped per house —
  // the original house keeps its unprefixed key untouched, so nothing about
  // existing data changes; every other house gets its own namespaced key so
  // switching houses never leaks or prefills the wrong identity.
  function houseKey(base) {
    return HOUSE_SLUG ? base + ":" + HOUSE_SLUG : base;
  }

  // ---- "who am I" — a local-only preference, not an account. There is no
  // login anywhere in this app; this is exactly the same kind of choice as
  // the language picker (stored in this browser, nothing sent anywhere
  // until it's used to attribute a scan, a reaction, a donation, or a
  // quiz round to a name already on the shared roster). ----
  var ME = "";
  (function initMe() {
    try {
      var saved = localStorage.getItem(houseKey("binDutyMe"));
      if (saved) ME = saved;
    } catch (e) {}
  })();
  function setMe(name) {
    ME = name || "";
    try {
      if (ME) localStorage.setItem(houseKey("binDutyMe"), ME);
      else localStorage.removeItem(houseKey("binDutyMe"));
    } catch (e) {}
  }

  var ACHIEVEMENT_META = {
    first_scrap: { icon: "\u{1F4F7}" },
    perfect_round: { icon: "⭐" },
    on_time_streak: { icon: "⚡" },
    house_hero: { icon: "\u{1F3C6}" },
    generous_scrapper: { icon: "❤️" }
  };

  // ---- i18n ----
  var currentLang = "en";
  (function initLang() {
    try {
      var saved = localStorage.getItem("binDutyLang");
      if (saved && window.T[saved]) currentLang = saved;
    } catch (e) {}
  })();

  function tr(key) {
    var dict = window.T[currentLang] || window.T.en;
    return (dict && dict[key] != null) ? dict[key] : window.T.en[key];
  }
  function fmt(key, vars) {
    var s = tr(key) || "";
    if (vars) Object.keys(vars).forEach(function (k) { s = s.split("{" + k + "}").join(vars[k]); });
    return s;
  }
  function binLabel(code) {
    var dict = window.T[currentLang] || window.T.en;
    var labels = (dict && dict.binLabels) || window.T.en.binLabels;
    return labels[code] || code;
  }
  // Short labels for the six answer pills (they sit in one row); falls back
  // to the full name in languages that haven't got the short set yet.
  function binShort(code) {
    var dict = window.T[currentLang] || window.T.en;
    var shorts = (dict && dict.binShort) || window.T.en.binShort || {};
    return shorts[code] || binLabel(code);
  }
  function guideFor(code) {
    var g = (window.GUIDE_T[currentLang] && window.GUIDE_T[currentLang][code]) || window.GUIDE_T.en[code];
    return g;
  }

  function pad(n) { return String(n).padStart(2, "0"); }
  function monthKey(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1); }
  function dateKeyOf(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function codesFor(d) {
    var map = SCHEDULE[monthKey(d)];
    if (!map) return null;
    return map[d.getDate()] || null;
  }
  function mondayOf(d) {
    var day = (d.getDay() + 6) % 7;
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - day);
  }
  function fmtShort(d) {
    return tr("weekdays")[(d.getDay() + 6) % 7];
  }
  function fmtLong(d) {
    return fmtShort(d) + " " + d.getDate() + " " + tr("months")[d.getMonth()];
  }
  function dot(color) {
    var s = document.createElement("span");
    s.className = "dot";
    s.style.background = color;
    return s;
  }
  function initials(name) {
    return name.split(" ").map(function (p) { return p[0]; }).join("").slice(0, 2).toUpperCase();
  }
  // Weeks since the same fixed Monday the duty rotation counts from — one
  // shared "which week is this" clock the whole app can index into,
  // whether that's whose turn it is or which tip shows on the calendar.
  function weeksSinceAnchor(date) {
    var mon = mondayOf(date);
    var anchorMon = mondayOf(ANCHOR_MONDAY);
    return Math.round((mon - anchorMon) / (7 * 86400000));
  }
  function personForWeek(date) {
    var diffWeeks = weeksSinceAnchor(date);
    var idx = ((diffWeeks % ROSTER.length) + ROSTER.length) % ROSTER.length;
    return { name: ROSTER[idx], idx: idx };
  }

  var today = new Date();
  var tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  var thisWeek = { name: "", idx: 0 };
  var nextWeek = { name: "", idx: 0 };
  function recomputeWeek() {
    thisWeek = personForWeek(today);
    nextWeek = personForWeek(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 7));
  }

  // ---- custom-themed dropdowns: a native <select>'s open popup can't be
  // styled with CSS in any browser, so every select in the app gets
  // wrapped in a small custom trigger + popup that IS themed, matching
  // the rest of the UI. The real <select> stays in the DOM (hidden,
  // display:none) as the actual value-holder — every existing call site
  // elsewhere in this file keeps reading/writing .value and listening for
  // "change" on it exactly as before; this only replaces how it's shown
  // and clicked. Options are re-read from the select fresh each time the
  // popup opens, so it always reflects whatever the many render*Select
  // functions below have just filled it with. ----
  function enhanceSelect(select) {
    if (select.dataset.enhanced) return;
    select.dataset.enhanced = "1";
    var baseClass = select.className;

    var wrap = document.createElement("span");
    wrap.className = "select-wrap"; // display:contents — invisible to layout, so every
    select.parentNode.insertBefore(wrap, select); // existing contextual rule on .claim-select/
    wrap.appendChild(select);                     // .lang-select still matches the trigger below
    select.classList.add("select-native");
    select.tabIndex = -1;
    select.setAttribute("aria-hidden", "true");

    var trigger = document.createElement("div");
    // The real select is already display:none unconditionally (see
    // .select-native), so its own .hidden no longer has any visible
    // effect. Existing code all over this file still sets
    // outNameSelect.hidden = ... etc. to show/hide the whole control
    // depending on app state — this keeps that working by mirroring
    // every such assignment onto the trigger, which is what's actually
    // shown or hidden now.
    var nativeHidden = select.hidden;
    Object.defineProperty(select, "hidden", {
      configurable: true,
      get: function () { return nativeHidden; },
      set: function (v) { nativeHidden = !!v; trigger.hidden = nativeHidden; }
    });
    trigger.className = baseClass + " select-trigger";
    trigger.setAttribute("role", "button");
    trigger.tabIndex = 0;
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");
    var labelSpan = document.createElement("span");
    labelSpan.className = "select-trigger-label";
    var chev = document.createElement("span");
    chev.className = "select-chev";
    var popup = document.createElement("div");
    popup.className = "select-popup";
    popup.setAttribute("role", "listbox");
    popup.hidden = true;
    trigger.appendChild(labelSpan);
    trigger.appendChild(chev);
    trigger.appendChild(popup);
    wrap.appendChild(trigger);

    var activeIndex = -1;

    function sync() {
      var opt = select.options[select.selectedIndex];
      labelSpan.textContent = opt ? opt.textContent : "";
    }
    select._syncTrigger = sync;

    function setActive(i) {
      var rows = popup.children;
      if (activeIndex >= 0 && rows[activeIndex]) rows[activeIndex].classList.remove("active");
      activeIndex = ((i % rows.length) + rows.length) % rows.length;
      if (rows[activeIndex]) {
        rows[activeIndex].classList.add("active");
        rows[activeIndex].scrollIntoView({ block: "nearest" });
      }
    }
    function commit(i) {
      select.selectedIndex = i;
      sync();
      close();
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
    function close() {
      trigger.classList.remove("open");
      trigger.setAttribute("aria-expanded", "false");
      popup.hidden = true;
    }
    function open() {
      popup.innerHTML = "";
      activeIndex = select.selectedIndex;
      Array.prototype.forEach.call(select.options, function (opt, i) {
        var row = document.createElement("div");
        row.className = "select-option" + (i === select.selectedIndex ? " selected" : "");
        row.setAttribute("role", "option");
        row.textContent = opt.textContent;
        row.addEventListener("click", function (ev) { ev.stopPropagation(); commit(i); });
        popup.appendChild(row);
      });
      trigger.classList.remove("drop-up");
      popup.hidden = false;
      trigger.classList.add("open");
      trigger.setAttribute("aria-expanded", "true");
      // Flip above the trigger when there isn't room below (a picker
      // opened from near the bottom tab bar, most often).
      if (popup.getBoundingClientRect().bottom > window.innerHeight - 12) trigger.classList.add("drop-up");
      setActive(activeIndex);
    }

    trigger.addEventListener("click", function () {
      if (trigger.classList.contains("open")) close(); else open();
    });
    trigger.addEventListener("keydown", function (ev) {
      var isOpen = trigger.classList.contains("open");
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        if (isOpen) commit(activeIndex); else open();
      } else if (ev.key === "ArrowDown") {
        ev.preventDefault();
        if (isOpen) setActive(activeIndex + 1); else open();
      } else if (ev.key === "ArrowUp") {
        ev.preventDefault();
        if (isOpen) setActive(activeIndex - 1); else open();
      } else if (ev.key === "Escape" && isOpen) {
        ev.preventDefault();
        close();
      } else if (ev.key === "Home" && isOpen) {
        ev.preventDefault();
        setActive(0);
      } else if (ev.key === "End" && isOpen) {
        ev.preventDefault();
        setActive(popup.children.length - 1);
      }
    });
    document.addEventListener("click", function (ev) {
      if (!wrap.contains(ev.target)) close();
    });

    sync();
  }
  function syncSelectTrigger(select) {
    if (select && select._syncTrigger) select._syncTrigger();
  }
  document.querySelectorAll("select.claim-select, select.lang-select").forEach(enhanceSelect);

  // ---- language switcher ----
  var langSelect = document.getElementById("langSelect");
  var langSelectBuilt = false;
  function renderLangRow() {
    if (!langSelectBuilt) {
      window.LANGS.forEach(function (l) {
        var opt = document.createElement("option");
        opt.value = l.code;
        opt.textContent = l.name;
        langSelect.appendChild(opt);
      });
      langSelect.addEventListener("change", function () {
        currentLang = langSelect.value;
        try { localStorage.setItem("binDutyLang", currentLang); } catch (e) {}
        applyLang();
      });
      langSelectBuilt = true;
    }
    langSelect.value = currentLang;
    syncSelectTrigger(langSelect);
  }

  // ---- tabbed views (phone width) — every [data-view] section stays in
  // the DOM always; only the active one is un-hidden. Wide screens ignore
  // this entirely via CSS (see index.html's @media (min-width:900px)) and
  // show every view at once, so this never runs there in any way that
  // matters visually. ----
  var VIEWS = ["home", "roster", "rewards", "you"];
  var currentView = "home";
  (function initView() {
    try {
      var saved = localStorage.getItem("binDutyView");
      if (saved && VIEWS.indexOf(saved) !== -1) currentView = saved;
    } catch (e) {}
  })();
  // ---- Home sub-views: Scan and Sort It are launched full-screen from
  // Home's buttons rather than always sitting inline on the dashboard.
  // All three (dashboard/scan/sortit) carry data-view="home", so the tab
  // switcher above already hides/shows them together as a group — this
  // just decides which ONE of the three is active while home is showing. ----
  var homeDashboard = document.getElementById("homeDashboard");
  var scanSubview = document.getElementById("scanSubview");
  var sortItSubview = document.getElementById("sortItSubview");
  var chatSubview = document.getElementById("chatSubview");
  function showHomeSubview(which) {
    homeDashboard.hidden = which !== "dashboard";
    scanSubview.hidden = which !== "scan";
    sortItSubview.hidden = which !== "sortit";
    chatSubview.hidden = which !== "chat";
    window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
  }
  document.getElementById("scanLaunchBtn").addEventListener("click", function () { showHomeSubview("scan"); });
  document.getElementById("sortItLaunchBtn").addEventListener("click", function () { showHomeSubview("sortit"); });
  document.getElementById("scanBackBtn").addEventListener("click", function () { showHomeSubview("dashboard"); });
  document.getElementById("sortItBackBtn").addEventListener("click", function () { showHomeSubview("dashboard"); });
  // Anonymous chat — not built yet; the button opens a "coming soon" screen.
  document.getElementById("chatEntryBtn").addEventListener("click", function () { showHomeSubview("chat"); });
  document.getElementById("chatBackBtn").addEventListener("click", function () { showHomeSubview("dashboard"); });

  function showView(view) {
    if (VIEWS.indexOf(view) === -1) view = "home";
    currentView = view;
    try { localStorage.setItem("binDutyView", view); } catch (e) {}
    document.querySelectorAll("[data-view]").forEach(function (el) {
      el.hidden = el.getAttribute("data-view") !== view;
    });
    document.querySelectorAll(".tab-btn").forEach(function (btn) {
      btn.classList.toggle("active", btn.getAttribute("data-goto") === view);
    });
    // Reaching Home (from any route — a tab click, or a jump button like
    // "Full calendar" on another tab) always lands on its dashboard, never
    // wherever a Scan/Sort It sub-view was left open.
    if (view === "home") showHomeSubview("dashboard");
    window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
  }
  document.querySelectorAll(".tab-btn").forEach(function (btn) {
    btn.addEventListener("click", function () { showView(btn.getAttribute("data-goto")); });
  });
  showView(currentView);

  document.getElementById("fullCalendarJumpBtn").addEventListener("click", function () { showView("roster"); });

  function applyLang() {
    var meta = window.LANGS.find(function (l) { return l.code === currentLang; }) || window.LANGS[0];
    document.documentElement.setAttribute("dir", meta.dir);
    document.documentElement.setAttribute("lang", meta.code);
    document.body.style.fontFamily = meta.font ? meta.font + ", 'Inter', system-ui, sans-serif" : "";

    document.querySelectorAll("[data-i18n]").forEach(function (el) {
      var key = el.getAttribute("data-i18n");
      var val = tr(key);
      if (val != null) el.textContent = val;
    });
    document.querySelectorAll("[data-i18n-placeholder]").forEach(function (el) {
      var key = el.getAttribute("data-i18n-placeholder");
      var val = tr(key);
      if (val != null) el.placeholder = val;
    });

    renderLangRow();
    var todayLabelEl = document.getElementById("todayLabel");
    if (todayLabelEl) {
      todayLabelEl.textContent = fmtShort(today) + " · " + String(tr("months")[today.getMonth()]).slice(0, 3) + " " + today.getDate();
    }
    renderWeekStrip();
    renderThisWeek();
    renderDuty();
    renderGuide();
    renderLegend();
    renderStakes();
    renderCalendar();
    renderTaskForm();
    renderTask(currentTask);
    renderNotifyForm();
    renderHousesList();
    renderDestroyBox();
    gameShowItem();
    loadLeaderboard();
    loadSubscribers();
    loadMySubscription();
    renderMeSelect();
    renderDonateSelect();
    loadAchievements();
    loadReactions();
  }

  function renderBadges(container, codes) {
    container.innerHTML = "";
    if (codes === "HOLIDAY") {
      var h = document.createElement("span");
      h.className = "holiday-note";
      h.textContent = tr("publicHoliday");
      container.appendChild(h);
      return;
    }
    if (!codes) {
      var n = document.createElement("span");
      n.className = "none";
      n.textContent = tr("nothingScheduled");
      container.appendChild(n);
      return;
    }
    codes.split("").forEach(function (c) {
      if (!BIN_COLOR[c]) return;
      var b = document.createElement("span");
      b.className = "badge";
      b.appendChild(dot(BIN_COLOR[c]));
      b.appendChild(document.createTextNode(binLabel(c)));
      container.appendChild(b);
    });
  }

  // ---- week strip ----
  function renderWeekStrip() {
    var strip = document.getElementById("weekStrip");
    if (!strip) return;
    strip.innerHTML = "";
    for (var i = 0; i < 7; i++) {
      var d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
      var cell = document.createElement("div");
      cell.className = "day" + (i === 0 ? " today" : "");
      var codes = codesFor(d);
      var dotsHtml = "";
      if (codes && codes !== "HOLIDAY") {
        dotsHtml = codes.split("").map(function (c) {
          return BIN_COLOR[c] ? '<span class="dot" style="background:' + BIN_COLOR[c] + '"></span>' : "";
        }).join("");
      }
      cell.innerHTML =
        '<div class="dow">' + fmtShort(d) + '</div>' +
        '<div class="num mono">' + d.getDate() + '</div>' +
        '<div class="dots">' + (codes === "HOLIDAY" ? '<span class="dot" style="background:var(--wrong)"></span>' : dotsHtml) + '</div>';
      strip.appendChild(cell);
    }
  }

  // ---- "This week" on Home: only the days in the next 7 that actually have
  // a collection, one compact row each (the full 7-day strip lives on the
  // Roster tab) ----
  function renderThisWeek() {
    var list = document.getElementById("thisWeekList");
    if (!list) return;
    list.innerHTML = "";
    var shown = 0;
    for (var i = 0; i < 7; i++) {
      var d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
      var codes = codesFor(d);
      if (!codes) continue;
      var row = document.createElement("div");
      row.className = "this-week-row";
      var dateEl = document.createElement("span");
      dateEl.className = "tw-date";
      dateEl.textContent = fmtShort(d) + " " + d.getDate();
      row.appendChild(dateEl);
      var badges = document.createElement("span");
      badges.className = "badge-row";
      if (codes === "HOLIDAY") {
        var h = document.createElement("span");
        h.className = "holiday-note";
        h.style.fontSize = "11px";
        h.textContent = tr("publicHoliday");
        badges.appendChild(h);
      } else {
        codes.split("").forEach(function (c) {
          if (!BIN_COLOR[c]) return;
          var b = document.createElement("span");
          b.className = "badge";
          b.style.background = BIN_COLOR[c];
          b.textContent = binLabel(c);
          badges.appendChild(b);
        });
      }
      row.appendChild(badges);
      var rel = document.createElement("span");
      rel.className = "tw-rel";
      if (i === 0) rel.textContent = tr("relToday");
      else if (i === 1) { rel.textContent = tr("relTonight"); rel.classList.add("tonight"); }
      else rel.textContent = fmt("relInDays", { n: i });
      row.appendChild(rel);
      list.appendChild(row);
      shown++;
    }
    if (!shown) {
      var none = document.createElement("div");
      none.className = "this-week-empty";
      none.textContent = tr("thisWeekEmpty");
      list.appendChild(none);
    }
  }

  // ---- duty ----
  function renderDuty() {
    document.getElementById("dutyName").textContent = thisWeek.name;
    renderWeekBadges();
    renderUpcoming();
    renderRotationList(document.getElementById("rosterStrip"));
    renderRosterAvatars(document.getElementById("rosterStripHome"));
  }

  function solidBadge(code) {
    var b = document.createElement("span");
    b.className = "badge";
    b.style.background = BIN_COLOR[code];
    b.textContent = binLabel(code);
    return b;
  }

  // Every bin type collected at some point this week (Mon–Sun), once each.
  function renderWeekBadges() {
    var el = document.getElementById("weekBadges");
    if (!el) return;
    el.innerHTML = "";
    var mon = mondayOf(today);
    var seen = {};
    for (var i = 0; i < 7; i++) {
      var d = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + i);
      var codes = codesFor(d);
      if (!codes || codes === "HOLIDAY") continue;
      codes.split("").forEach(function (c) {
        if (BIN_COLOR[c] && !seen[c]) { seen[c] = true; el.appendChild(solidBadge(c)); }
      });
    }
    if (!el.children.length) {
      var n = document.createElement("span");
      n.className = "none";
      n.textContent = tr("nothingScheduled");
      el.appendChild(n);
    }
  }

  // The next three collection days, looking up to three weeks ahead.
  function renderUpcoming() {
    var list = document.getElementById("upcomingList");
    if (!list) return;
    list.innerHTML = "";
    var shown = 0;
    for (var i = 0; i < 21 && shown < 3; i++) {
      var d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
      var codes = codesFor(d);
      if (!codes || codes === "HOLIDAY") continue;
      var row = document.createElement("div");
      row.className = "poster upcoming-row";
      var tile = document.createElement("div");
      tile.className = "date-tile";
      var dow = document.createElement("div");
      dow.className = "dt-dow";
      dow.textContent = fmtShort(d);
      var num = document.createElement("div");
      num.className = "dt-num";
      num.textContent = d.getDate();
      tile.appendChild(dow);
      tile.appendChild(num);
      row.appendChild(tile);
      var badges = document.createElement("span");
      badges.className = "badge-row";
      codes.split("").forEach(function (c) { if (BIN_COLOR[c]) badges.appendChild(solidBadge(c)); });
      row.appendChild(badges);
      var rel = document.createElement("span");
      rel.className = "up-rel";
      if (i === 0) rel.textContent = tr("relToday");
      else if (i === 1) { rel.textContent = tr("relTonight"); rel.classList.add("tonight"); }
      else rel.textContent = fmt("relInDays", { n: i });
      row.appendChild(rel);
      list.appendChild(row);
      shown++;
    }
    if (!shown) {
      var none = document.createElement("div");
      none.className = "upcoming-empty";
      none.textContent = tr("thisWeekEmpty");
      list.appendChild(none);
    }
  }

  // Everyone, starting from whoever has this week, in the order their
  // turns come up — with the remove control kept per row.
  function renderRotationList(container) {
    if (!container) return;
    container.innerHTML = "";
    var n = ROSTER.length;
    for (var k = 0; k < n; k++) {
      var name = ROSTER[(thisWeek.idx + k) % n];
      var row = document.createElement("div");
      row.className = "poster rotation-row" + (subscribedNames[name] ? " subscribed" : "");
      var av = document.createElement("span");
      av.className = "avatar";
      av.textContent = initials(name);
      if (subscribedNames[name]) av.title = tr("subscribedBadge");
      row.appendChild(av);
      var text = document.createElement("div");
      text.className = "rr-text";
      var nm = document.createElement("div");
      nm.className = "rr-name";
      nm.textContent = name;
      text.appendChild(nm);
      if (ROSTER_OCCUPATION[name]) {
        var occ = document.createElement("div");
        occ.className = "rr-occ";
        occ.textContent = ROSTER_OCCUPATION[name];
        text.appendChild(occ);
      }
      row.appendChild(text);
      var when = document.createElement("span");
      when.className = "rr-when";
      when.textContent = k === 0 ? tr("relThisWeek") : k === 1 ? tr("relNextWeek") : fmt("relInWeeks", { n: k });
      row.appendChild(when);
      var removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "chip-remove";
      removeBtn.setAttribute("aria-label", "Remove " + name);
      removeBtn.textContent = "×";
      removeBtn.addEventListener("click", (function (nm2) { return function () { removeFromRoster(nm2); }; })(name));
      row.appendChild(removeBtn);
      container.appendChild(row);
    }
  }

  // Home's compact roster: a circle per person with the name (and
  // occupation, when set) stacked underneath — read-only; adding/removing
  // people stays on the Roster tab.
  function renderRosterAvatars(container) {
    if (!container) return;
    container.innerHTML = "";
    ROSTER.forEach(function (name) {
      var person = document.createElement("div");
      person.className = "roster-person" + (subscribedNames[name] ? " subscribed" : "");
      var av = document.createElement("span");
      av.className = "avatar";
      av.textContent = initials(name);
      if (subscribedNames[name]) av.title = tr("subscribedBadge");
      person.appendChild(av);
      var nm = document.createElement("div");
      nm.className = "rp-name";
      nm.textContent = name;
      person.appendChild(nm);
      if (ROSTER_OCCUPATION[name]) {
        var occ = document.createElement("div");
        occ.className = "rp-occ";
        occ.textContent = ROSTER_OCCUPATION[name];
        person.appendChild(occ);
      }
      container.appendChild(person);
    });
  }

  function renderRosterStrip(container, withRemove) {
    if (!container) return;
    container.innerHTML = "";
    ROSTER.forEach(function (name, idx) {
      var chip = document.createElement("span");
      chip.className = "roster-chip" + (subscribedNames[name] ? " subscribed" : "");
      var av = document.createElement("span");
      av.className = "avatar";
      av.style.background = AVATAR_COLORS[idx % AVATAR_COLORS.length];
      av.textContent = initials(name);
      if (subscribedNames[name]) av.title = tr("subscribedBadge");
      chip.appendChild(av);
      var nameWrap = document.createElement("span");
      nameWrap.appendChild(document.createTextNode(name));
      if (ROSTER_OCCUPATION[name]) {
        var occ = document.createElement("span");
        occ.className = "chip-occupation";
        occ.textContent = " · " + ROSTER_OCCUPATION[name];
        nameWrap.appendChild(occ);
      }
      chip.appendChild(nameWrap);
      if (withRemove) {
        var removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "chip-remove";
        removeBtn.setAttribute("aria-label", "Remove " + name);
        removeBtn.textContent = "×";
        removeBtn.addEventListener("click", function () { removeFromRoster(name); });
        chip.appendChild(removeBtn);
      }
      container.appendChild(chip);
    });
  }

  // ---- roster management (add / remove housemates) ----
  var rosterMsg = document.getElementById("rosterMsg");
  var addNameInput = document.getElementById("addNameInput");
  var addNameBtn = document.getElementById("addNameBtn");

  function loadRosterFull() {
    return fetch(api("/api/roster/full"))
      .then(function (r) { if (!r.ok) throw new Error("bad status"); return r.json(); })
      .then(function (rows) {
        ROSTER_OCCUPATION = {};
        ROSTER_CREATED_AT = {};
        rows.forEach(function (row) {
          if (row.occupation) ROSTER_OCCUPATION[row.name] = row.occupation;
          if (row.created_at) ROSTER_CREATED_AT[row.name] = row.created_at;
        });
        renderDuty();
        renderProfileHead();
      })
      .catch(function () {});
  }

  function afterRosterChange(newRoster) {
    ROSTER = newRoster;
    recomputeWeek();
    renderDuty();
    renderTaskForm();
    renderNotifyForm();
    loadTask();
    loadLeaderboard();
    loadRosterFull();
    renderMeSelect();
    renderDonateSelect();
  }

  function addToRoster() {
    var name = addNameInput.value.trim();
    if (!name) return;
    addNameBtn.disabled = true;
    fetch(api("/api/roster"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: name })
    })
      .then(function (r) {
        if (!r.ok) return r.json().then(function (e) { throw new Error(e.error || "failed"); });
        return r.json();
      })
      .then(function (roster) {
        addNameInput.value = "";
        rosterMsg.textContent = "";
        afterRosterChange(roster);
      })
      .catch(function (e) { rosterMsg.textContent = e.message || "Couldn't add that name."; })
      .finally(function () { addNameBtn.disabled = false; });
  }

  function removeFromRoster(name) {
    fetch(api("/api/roster/" + encodeURIComponent(name)), { method: "DELETE" })
      .then(function (r) {
        if (!r.ok) return r.json().then(function (e) { throw new Error(e.error || "failed"); });
        return r.json();
      })
      .then(function (roster) {
        rosterMsg.textContent = "";
        afterRosterChange(roster);
      })
      .catch(function (e) { rosterMsg.textContent = e.message || "Couldn't remove that name."; });
  }

  addNameBtn.addEventListener("click", addToRoster);
  addNameInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); addToRoster(); }
  });

  // ---- sort-it game ----
  var gScore = document.getElementById("gScore");
  var gStreak = document.getElementById("gStreak");
  var gBest = document.getElementById("gBest");
  var gItemEl = document.getElementById("gameItem");
  var gNameEl = document.getElementById("gItemName");
  var gBinsEl = document.getElementById("binButtons");
  var gFeedbackEl = document.getElementById("gFeedback");
  var gProgressEl = document.getElementById("gProgress");
  var gNextBtn = document.getElementById("gNextBtn");
  var gQueue = [], gIndex = 0, gScoreVal = 0, gStreakVal = 0, gBestVal = 0, gAnswered = false, gRoundReported = false;
  var gButtonsByCode = {};

  try { gBestVal = parseInt(localStorage.getItem(houseKey("binDutyBestStreak")) || "0", 10) || 0; } catch (e) { gBestVal = 0; }
  gBest.textContent = gBestVal;

  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  GAME_CODES.forEach(function (code) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "bin-btn";
    btn.style.background = BIN_COLOR[code];
    btn.innerHTML = '<span class="bin-btn-label"></span>';
    btn.addEventListener("click", function () { gameAnswer(code, btn); });
    gBinsEl.appendChild(btn);
    gButtonsByCode[code] = btn;
  });

  function gameResetButtons() {
    GAME_CODES.forEach(function (code) {
      var btn = gButtonsByCode[code];
      btn.disabled = false;
      btn.classList.remove("pick-correct", "pick-wrong");
      btn.querySelector(".bin-btn-label").textContent = binShort(code);
    });
  }

  function gameShowItem() {
    gAnswered = false;
    gFeedbackEl.textContent = "";
    gItemEl.classList.remove("correct", "wrong", "pulse");
    gameResetButtons();
    gNextBtn.disabled = true;

    if (gIndex >= gQueue.length) {
      gNameEl.textContent = tr("roundComplete");
      document.getElementById("gEyebrow").textContent = tr("scoreLabel") + " " + gScoreVal + " / " + gQueue.length;
      gBinsEl.style.display = "none";
      gProgressEl.textContent = tr("bestLabel") + ": " + gBestVal;
      gNextBtn.textContent = tr("playAgain");
      gNextBtn.disabled = false;
      gFeedbackEl.textContent = gScoreVal === gQueue.length ? tr("perfectRound") : tr("solidRound");
      if (gScoreVal === gQueue.length && ME && !gRoundReported) {
        gRoundReported = true;
        fetch(api("/api/quiz/complete"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: ME, correct: gScoreVal, total: gQueue.length })
        })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (data) { if (data && data.awarded) celebrateAchievements(data.unlocked); })
          .catch(function () {});
      }
      return;
    }

    gBinsEl.style.display = "";
    document.getElementById("gEyebrow").textContent = tr("tapRightBin");
    gNextBtn.textContent = tr("next");
    gNameEl.textContent = gQueue[gIndex].name;
    gProgressEl.textContent = fmt("quizProgress", { n: gIndex + 1, total: gQueue.length });
    var bar = document.getElementById("gBar");
    if (bar) bar.style.width = Math.round((gIndex / gQueue.length) * 100) + "%";
  }

  function gameAnswer(code, btn) {
    if (gAnswered || gIndex >= gQueue.length) return;
    gAnswered = true;
    var item = gQueue[gIndex];
    var correct = code === item.code;

    GAME_CODES.forEach(function (c) { gButtonsByCode[c].disabled = true; });

    if (correct) {
      gScoreVal++; gStreakVal++;
      if (gStreakVal > gBestVal) {
        gBestVal = gStreakVal; gBest.textContent = gBestVal;
        try { localStorage.setItem(houseKey("binDutyBestStreak"), String(gBestVal)); } catch (e) {}
        if (statStreak) statStreak.textContent = gBestVal;
      }
      btn.classList.add("pick-correct");
      gItemEl.classList.add("correct", "pulse");
      gFeedbackEl.innerHTML = "<strong>" + tr("rightWord") + "</strong> " + item.why;
    } else {
      gStreakVal = 0;
      btn.classList.add("pick-wrong");
      gButtonsByCode[item.code].classList.add("pick-correct");
      gItemEl.classList.add("wrong", "pulse");
      gFeedbackEl.innerHTML = "<strong>" + tr("notQuiteWord") + "</strong> " + item.why;
    }

    gScore.textContent = gScoreVal;
    gStreak.textContent = gStreakVal;
    gNextBtn.disabled = false;
  }

  gNextBtn.addEventListener("click", function () {
    if (gIndex >= gQueue.length) {
      gQueue = shuffle(ITEMS);
      gIndex = 0; gScoreVal = 0; gStreakVal = 0; gRoundReported = false;
      gScore.textContent = "0"; gStreak.textContent = "0";
      gameShowItem();
      return;
    }
    gIndex++;
    gameShowItem();
  });

  gQueue = shuffle(ITEMS);

  // ---- sorting guide ----
  function renderGuide() {
    var grid = document.getElementById("guideGrid");
    grid.innerHTML = "";
    GAME_CODES.forEach(function (code) {
      var g = guideFor(code);
      var card = document.createElement("div");
      card.className = "guide-card" + (g.flagged ? " flagged" : "");
      card.innerHTML =
        '<span class="guide-letter" style="background:' + BIN_COLOR[code] + '"></span>' +
        '<div><span class="guide-title">' + code + ' · ' + g.title + '</span> ' +
        '<span class="guide-body" style="display:inline;">' + g.body + '</span></div>';
      grid.appendChild(card);
    });
    var vn = document.getElementById("verifyNote");
    if (!vn.dataset.custom) vn.textContent = fmt("verifyPrefix", {}) + " " + fmtLong(today);
  }

  // ---- "worth knowing" tip on the Full Calendar section: a different one
  // each week, same week clock as the duty rotation, so it's identical for
  // everyone in the house at any given moment and just moves on Monday. ----
  function renderStakes() {
    var stories = tr("stakesStories");
    if (!stories || !stories.length) return;
    var idx = ((weeksSinceAnchor(today) % stories.length) + stories.length) % stories.length;
    var story = stories[idx];
    document.getElementById("stakesStrong").textContent = story.strong;
    document.getElementById("stakesRest").textContent = story.rest;
  }

  // ---- legend ----
  function renderLegend() {
    var row = document.getElementById("legendRow");
    row.innerHTML = "";
    GAME_CODES.forEach(function (code) {
      var s = document.createElement("span");
      s.appendChild(dot(BIN_COLOR[code]));
      s.appendChild(document.createTextNode(code + " " + binLabel(code)));
      row.appendChild(s);
    });
    var hs = document.createElement("span");
    hs.appendChild(dot("var(--wrong)"));
    hs.appendChild(document.createTextNode(tr("publicHoliday")));
    row.appendChild(hs);
  }

  // ---- calendar ----
  var MONTHS = [
    { y: 2026, m: 8 }, { y: 2026, m: 9 }, { y: 2026, m: 10 }, { y: 2026, m: 11 }
  ];
  // date_key -> {codes, out_by, out_at, back_by, back_at, hasOutPhoto,
  // hasBackPhoto} for every task ever started, so the full calendar can
  // show who actually marked a collection out/back — not just whose
  // rotation turn it theoretically was — and whether proof photos exist.
  var TASK_HISTORY = {};
  function loadTaskHistory() {
    // Returns the promise — callers that render the "next collection"
    // fallback (which reads TASK_HISTORY) sequence themselves after this,
    // so that check never runs against stale/empty history.
    return fetch(api("/api/tasks/history"))
      .then(function (r) { if (!r.ok) throw new Error("bad status"); return r.json(); })
      .then(function (rows) {
        TASK_HISTORY = {};
        rows.forEach(function (r) { TASK_HISTORY[r.date_key] = r; });
        renderCalendar();
      })
      .catch(function () {});
  }

  function renderCalendar() {
    var container = document.getElementById("calendarMonths");
    container.innerHTML = "";
    MONTHS.forEach(function (mo) {
      var details = document.createElement("details");
      details.className = "month";
      var isCurrent = today.getFullYear() === mo.y && today.getMonth() === mo.m;
      if (isCurrent) details.open = true;

      var summary = document.createElement("summary");
      summary.textContent = tr("months")[mo.m] + " " + mo.y;
      details.appendChild(summary);

      var body = document.createElement("div");
      body.className = "month-body";
      var table = document.createElement("table");
      table.className = "cal";
      var thead = document.createElement("tr");
      tr("weekdays").forEach(function (dw) {
        var th = document.createElement("th");
        th.textContent = dw;
        thead.appendChild(th);
      });
      table.appendChild(thead);

      var firstOfMonth = new Date(mo.y, mo.m, 1);
      var lastOfMonth = new Date(mo.y, mo.m + 1, 0);
      var startOffset = (firstOfMonth.getDay() + 6) % 7;
      var totalRows = Math.ceil((startOffset + lastOfMonth.getDate()) / 7);
      var dayNum = 1;

      for (var r = 0; r < totalRows; r++) {
        var trEl = document.createElement("tr");
        for (var c = 0; c < 7; c++) {
          var td = document.createElement("td");
          var cellIndex = r * 7 + c;
          if (cellIndex >= startOffset && dayNum <= lastOfMonth.getDate()) {
            var thisDate = new Date(mo.y, mo.m, dayNum);
            var codes2 = codesFor(thisDate);
            var isToday = thisDate.toDateString() === today.toDateString();
            var hist = TASK_HISTORY[dateKeyOf(thisDate)];
            var hasPhotos = !!(hist && (hist.hasOutPhoto || hist.hasBackPhoto));
            var cellDiv = document.createElement("div");
            cellDiv.className = "cal-cell" + (codes2 && codes2 !== "HOLIDAY" ? " has-data" : "") + (codes2 === "HOLIDAY" ? " holiday" : "") + (hasPhotos ? " has-photos" : "");
            if (isToday) cellDiv.style.outline = "1.5px solid var(--accent)";
            var dotsMarkup = "";
            if (codes2 && codes2 !== "HOLIDAY") {
              dotsMarkup = codes2.split("").map(function (cc) {
                return BIN_COLOR[cc] ? '<span class="dot" style="background:' + BIN_COLOR[cc] + '"></span>' : "";
              }).join("");
            }
            // Who actually marked it out — not just whose rotation turn it
            // theoretically was — shown right on the day, plus a camera
            // glyph when a proof photo exists for it.
            var whoMarkup = hist && hist.out_by
              ? '<span class="cal-who">' + initials(hist.out_by) + '</span>' + (hasPhotos ? '<span class="cal-cam">\u{1F4F7}</span>' : "")
              : "";
            cellDiv.innerHTML =
              '<span class="n mono">' + dayNum + '</span>' +
              (codes2 === "HOLIDAY" ? '<span class="hday"></span>' : '<span class="dots">' + dotsMarkup + '</span>') +
              whoMarkup;
            if (hasPhotos) {
              cellDiv.setAttribute("role", "button");
              cellDiv.setAttribute("tabindex", "0");
              (function (dateKey, histRow) {
                cellDiv.addEventListener("click", function () { openTaskPhotoModal(dateKey, histRow); });
                cellDiv.addEventListener("keydown", function (ev) {
                  if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); openTaskPhotoModal(dateKey, histRow); }
                });
              })(dateKeyOf(thisDate), hist);
            }
            td.appendChild(cellDiv);
            dayNum++;
          }
          trEl.appendChild(td);
        }
        table.appendChild(trEl);
      }
      body.appendChild(table);
      details.appendChild(body);
      container.appendChild(details);
    });
  }

  // ---- proof-photo viewer for a past calendar day ----
  var photoModalEl = document.getElementById("taskPhotoModal");
  var photoModalTitle = document.getElementById("photoModalTitle");
  var photoModalGrid = document.getElementById("photoModalGrid");
  function openTaskPhotoModal(dateKey, hist) {
    photoModalTitle.textContent = fmtLong(new Date(dateKey + "T00:00:00"));
    photoModalGrid.innerHTML = "";
    [
      { which: "out", has: hist.hasOutPhoto, who: hist.out_by, takenAt: hist.out_photo_taken_at, captionKey: "photoModalOutCaption" },
      { which: "back", has: hist.hasBackPhoto, who: hist.back_by, takenAt: hist.back_photo_taken_at, captionKey: "photoModalBackCaption" }
    ].forEach(function (entry) {
      if (!entry.has) return;
      var fig = document.createElement("figure");
      fig.className = "photo-modal-fig";
      var img = document.createElement("img");
      img.src = api("/api/tasks/" + dateKey + "/photo/" + entry.which);
      img.alt = tr(entry.captionKey);
      img.loading = "lazy";
      fig.appendChild(img);
      var cap = document.createElement("figcaption");
      cap.textContent = tr(entry.captionKey) + (entry.who ? " — " + entry.who : "");
      fig.appendChild(cap);
      if (entry.takenAt) {
        var takenDate = new Date(entry.takenAt);
        if (!isNaN(takenDate)) {
          var stampLine = document.createElement("div");
          stampLine.className = "photo-modal-stamp";
          stampLine.textContent = tr("photoTakenLabel") + " " + fmtLong(takenDate) + ", " +
            String(takenDate.getHours()).padStart(2, "0") + ":" + String(takenDate.getMinutes()).padStart(2, "0");
          fig.appendChild(stampLine);
        }
      }
      photoModalGrid.appendChild(fig);
    });
    photoModalEl.hidden = false;
  }
  function closeTaskPhotoModal() {
    photoModalEl.hidden = true;
    photoModalGrid.innerHTML = "";
  }
  document.getElementById("photoModalClose").addEventListener("click", closeTaskPhotoModal);
  document.getElementById("photoModalBackdrop").addEventListener("click", closeTaskPhotoModal);
  document.addEventListener("keydown", function (ev) {
    if (ev.key === "Escape" && !photoModalEl.hidden) closeTaskPhotoModal();
  });

  // ---- bin duty task: two-step out/back confirmation + leaderboard ----
  var taskDateLabel = document.getElementById("taskDateLabel");
  var taskBadges = document.getElementById("taskBadges");
  var claimStatus = document.getElementById("claimStatus");
  var outRow = document.getElementById("outRow");
  var backRow = document.getElementById("backRow");
  var outNameSelect = document.getElementById("outNameSelect");
  var backNameSelect = document.getElementById("backNameSelect");
  var outBtn = document.getElementById("outBtn");
  var backBtn = document.getElementById("backBtn");
  var leaderboardEl = document.getElementById("leaderboard");
  var currentTask = null;
  var lastRenderedTaskKey = null;

  // ---- optional proof photo on out/back: a small attach control that
  // previews the chosen image locally (an object URL — nothing is
  // uploaded until the Mark-out/Confirm-back button is pressed) and
  // resets itself whenever the underlying task changes. ----
  // ---- reading a photo's real creation time from its own EXIF data,
  // client-side — so "when was this actually taken" isn't just taken on
  // faith, whether the photo comes from the camera or the library. Only
  // JPEGs carry EXIF; anything else (PNG, HEIC re-encoded by the browser,
  // etc.) falls back to the file's own lastModified, clearly labeled as
  // such since that's a weaker signal (it's when the FILE was last
  // touched, not necessarily when the photo was taken). Hand-rolled
  // rather than a library: this only ever needs one tag out of a JPEG's
  // first ~64KB, not a general-purpose EXIF reader. ----
  function readExifDate(file) {
    return new Promise(function (resolve) {
      if (!file || !/^image\/jpe?g$/i.test(file.type)) { resolve(null); return; }
      var reader = new FileReader();
      reader.onerror = function () { resolve(null); };
      reader.onload = function () {
        try { resolve(parseExifDate(new DataView(reader.result))); }
        catch (e) { resolve(null); }
      };
      reader.readAsArrayBuffer(file.slice(0, 131072)); // EXIF always sits near the start
    });
  }
  function parseExifDate(view) {
    if (view.byteLength < 4 || view.getUint16(0) !== 0xFFD8) return null; // not a JPEG
    var offset = 2;
    while (offset + 4 <= view.byteLength) {
      var marker = view.getUint16(offset);
      if ((marker & 0xFF00) !== 0xFF00) break; // not a real marker — give up
      var segLen = view.getUint16(offset + 2);
      if (marker === 0xFFE1 && offset + 4 + 6 <= view.byteLength && view.getUint32(offset + 4) === 0x45786966) {
        var tiffStart = offset + 4 + 6; // past marker, length, "Exif\0\0"
        return readExifTiff(view, tiffStart);
      }
      offset += 2 + segLen;
    }
    return null;
  }
  function readExifTiff(view, tiffStart) {
    var little = view.getUint16(tiffStart) === 0x4949;
    var ifd0 = tiffStart + view.getUint32(tiffStart + 4, little);
    var dateStr = null, subIfdOffset = null;
    var entries = view.getUint16(ifd0, little);
    for (var i = 0; i < entries; i++) {
      var e = ifd0 + 2 + i * 12;
      var tag = view.getUint16(e, little);
      if (tag === 0x8769) subIfdOffset = tiffStart + view.getUint32(e + 8, little); // Exif SubIFD pointer
      else if (tag === 0x0132) dateStr = readExifAscii(view, tiffStart, e, little); // plain DateTime, fallback
    }
    if (subIfdOffset != null) {
      var subEntries = view.getUint16(subIfdOffset, little);
      for (var j = 0; j < subEntries; j++) {
        var se = subIfdOffset + 2 + j * 12;
        if (view.getUint16(se, little) === 0x9003) { // DateTimeOriginal — the one that matters
          dateStr = readExifAscii(view, tiffStart, se, little);
          break;
        }
      }
    }
    if (!dateStr) return null;
    var m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(dateStr);
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  }
  function readExifAscii(view, tiffStart, entryOffset, little) {
    var count = view.getUint32(entryOffset + 4, little);
    var valueOffset = entryOffset + 8;
    var dataStart = count <= 4 ? valueOffset : tiffStart + view.getUint32(valueOffset, little);
    var chars = [];
    for (var k = 0; k < count - 1 && dataStart + k < view.byteLength; k++) chars.push(String.fromCharCode(view.getUint8(dataStart + k)));
    return chars.join("");
  }

  // A picked-but-unsubmitted photo has to survive a page reload: the "back"
  // photo in particular is often picked hours after "out" was confirmed
  // (someone has to go back outside once the bin's actually been emptied),
  // long enough for iOS Safari to silently discard and reload the tab in
  // the background — no beforeunload warning fires for that, the in-memory
  // File is just gone, and the person never notices their photo wasn't
  // attached anymore. Stash every picked photo in IndexedDB immediately and
  // restore it on the next render of that same task/step so it's never
  // silently lost between picking it and pressing confirm.
  var pendingDbPromise = null;
  function pendingDb() {
    if (!pendingDbPromise) {
      pendingDbPromise = new Promise(function (resolve, reject) {
        if (!window.indexedDB) { reject(new Error("no indexedDB")); return; }
        var req = indexedDB.open("bin-duty-pending", 1);
        req.onupgradeneeded = function () { req.result.createObjectStore("photos"); };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
    }
    return pendingDbPromise;
  }
  function withPendingStore(mode, fn) {
    return pendingDb().then(function (db) {
      return new Promise(function (resolve) {
        var tx = db.transaction("photos", mode);
        var result = fn(tx.objectStore("photos"));
        tx.oncomplete = function () { resolve(result && result.result); };
        tx.onerror = function () { resolve(null); };
      });
    }).catch(function () { return null; });
  }
  function savePendingPhoto(key, record) { return withPendingStore("readwrite", function (store) { return store.put(record, key); }); }
  function loadPendingPhoto(key) { return withPendingStore("readonly", function (store) { return store.get(key); }); }
  function deletePendingPhoto(key) { return withPendingStore("readwrite", function (store) { return store.delete(key); }); }

  function makePhotoAttach(prefix) {
    var attachEl = document.getElementById(prefix + "PhotoAttach");
    var input = document.getElementById(prefix + "PhotoInput");
    var thumb = document.getElementById(prefix + "PhotoThumb");
    var clearBtn = document.getElementById(prefix + "PhotoClear");
    var metaEl = document.getElementById(prefix + "PhotoMeta");
    var file = null;
    var takenAt = null; // Date, or null when unknown
    var activeKey = null; // "out:2026-09-25" style IndexedDB key for the task/step this attach currently represents

    function reset() {
      if (activeKey) deletePendingPhoto(activeKey);
      activeKey = null;
      file = null;
      takenAt = null;
      input.value = "";
      if (thumb.src) URL.revokeObjectURL(thumb.src);
      thumb.removeAttribute("src");
      thumb.hidden = true;
      clearBtn.hidden = true;
      metaEl.hidden = true;
      metaEl.classList.remove("warn");
    }
    function renderMeta(date, fromExif) {
      if (!date) { metaEl.hidden = true; return; }
      var sameDay = date.toDateString() === new Date().toDateString();
      var stamp = fmtLong(date) + ", " + String(date.getHours()).padStart(2, "0") + ":" + String(date.getMinutes()).padStart(2, "0");
      metaEl.textContent = (fromExif ? tr("photoTakenLabel") : tr("photoFileDateLabel")) + " " + stamp + (sameDay ? "" : " " + tr("photoNotTodayNote"));
      metaEl.classList.toggle("warn", !sameDay);
      metaEl.hidden = false;
    }
    // Called every time this attach becomes the active step for a task
    // (out photo when out isn't confirmed yet, back photo once it is). If
    // nothing's picked in this session yet, checks IndexedDB for a photo
    // that was picked before an in-between reload wiped this session's JS
    // state, and silently restores it so the person never has to notice.
    function forTask(dateKey) {
      var key = dateKey ? prefix + ":" + dateKey : null;
      activeKey = key;
      if (!key || file) return;
      loadPendingPhoto(key).then(function (record) {
        if (!record || activeKey !== key || file) return; // stale response, or the person already picked something since
        file = record.blob;
        takenAt = record.takenAt ? new Date(record.takenAt) : null;
        if (thumb.src) URL.revokeObjectURL(thumb.src);
        thumb.src = URL.createObjectURL(record.blob);
        thumb.hidden = false;
        clearBtn.hidden = false;
        renderMeta(takenAt, !!record.fromExif);
      });
    }
    input.addEventListener("change", function () {
      var f = input.files && input.files[0];
      if (!f) return;
      file = f;
      takenAt = null;
      if (thumb.src) URL.revokeObjectURL(thumb.src);
      thumb.src = URL.createObjectURL(f);
      thumb.hidden = false;
      clearBtn.hidden = false;
      metaEl.hidden = true;
      if (activeKey) savePendingPhoto(activeKey, { blob: f, takenAt: null, fromExif: false });
      readExifDate(f).then(function (exifDate) {
        if (file !== f) return; // a different file was picked while this was reading
        takenAt = exifDate || (f.lastModified ? new Date(f.lastModified) : null);
        renderMeta(takenAt, !!exifDate);
        if (activeKey) savePendingPhoto(activeKey, { blob: f, takenAt: takenAt ? takenAt.toISOString() : null, fromExif: !!exifDate });
      });
    });
    clearBtn.addEventListener("click", function (ev) { ev.preventDefault(); reset(); });

    return {
      getFile: function () { return file; },
      getTakenAt: function () { return takenAt; },
      reset: reset,
      forTask: forTask,
      setHidden: function (h) { attachEl.hidden = h; }
    };
  }
  var outPhoto = makePhotoAttach("out");
  var backPhoto = makePhotoAttach("back");
  // A picked photo only lives in memory until Mark-out/Confirm-back is
  // actually pressed — nothing is uploaded before that. Warn before an
  // accidental reload or tab close throws it away unsubmitted.
  window.addEventListener("beforeunload", function (ev) {
    if (outPhoto.getFile() || backPhoto.getFile()) {
      ev.preventDefault();
      ev.returnValue = "";
    }
  });

  function fillNameSelect(select, preferredName) {
    var current = select.value;
    select.innerHTML = "";
    ROSTER.forEach(function (name) {
      var opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      select.appendChild(opt);
    });
    var fallback = preferredName && ROSTER.includes(preferredName) ? preferredName : ROSTER[0];
    select.value = current && ROSTER.includes(current) ? current : fallback;
    syncSelectTrigger(select);
  }

  function renderTaskForm() {
    fillNameSelect(outNameSelect, thisWeek.name);
    fillNameSelect(backNameSelect, currentTask && currentTask.out_by);
  }

  function renderTask(task) {
    currentTask = task;
    // A picked-but-not-yet-submitted photo belongs to one specific task; if
    // the underlying task changed (a new day opened, or the current one
    // finished and something else took its place) any pending photo is
    // stale and gets dropped rather than silently attached to the wrong day.
    var taskKey = task ? task.date_key : null;
    if (taskKey !== lastRenderedTaskKey) {
      outPhoto.reset();
      backPhoto.reset();
      lastRenderedTaskKey = taskKey;
    }
    var homeDutyAvatar = document.getElementById("homeDutyAvatar");
    var homeHero = document.getElementById("homeHero");
    var reactionsRowEl = document.getElementById("reactionsRow");
    if (!task) {
      // Nothing is open right now (today's collection is done, or its window
      // hasn't opened) — show the NEXT collection instead of an empty card,
      // with the button disabled until its window opens the evening before.
      // Reactions are only for a live task, so they stay hidden here.
      var next = null, nextOffset = 0;
      for (var i = 1; i <= 60; i++) {
        var cand = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
        var cc = codesFor(cand);
        if (!cc || cc === "HOLIDAY") continue;
        // A date can have real collection codes and still not be "next" —
        // its task may already be fully done (confirmed out AND back), most
        // commonly tonight's own task, finished before the actual pickup
        // day even arrives. TASK_HISTORY is kept fresh for exactly this
        // check (see loadTaskHistory, sequenced before this ever renders).
        var candHist = TASK_HISTORY[dateKeyOf(cand)];
        if (candHist && candHist.back_at) continue;
        next = cand; nextOffset = i; break;
      }
      backRow.hidden = true;
      backPhoto.setHidden(true);
      reactionsRowEl.hidden = true;
      if (!next) {
        taskDateLabel.textContent = "";
        taskBadges.innerHTML = "";
        outRow.hidden = true;
        outPhoto.setHidden(true);
        claimStatus.textContent = tr("taskNothing");
        homeDutyAvatar.hidden = true;
        homeHero.classList.add("no-task");
        return;
      }
      homeHero.classList.remove("no-task");
      taskDateLabel.textContent = nextOffset === 1 ? tr("tonightBinsLabel") : fmtLong(next);
      renderBadges(taskBadges, codesFor(next));
      var who = personForWeek(next).name;
      homeDutyAvatar.hidden = false;
      homeDutyAvatar.textContent = initials(who);
      claimStatus.innerHTML = "";
      var upParts = fmt(nextOffset === 1 ? "dutyTonight" : "dutyUpcoming", { name: who }).split(who);
      claimStatus.appendChild(document.createTextNode(upParts[0]));
      var upStrong = document.createElement("strong");
      upStrong.textContent = who;
      claimStatus.appendChild(upStrong);
      claimStatus.appendChild(document.createTextNode(upParts[1] || ""));
      var opens = new Date(next.getFullYear(), next.getMonth(), next.getDate() - 1);
      outRow.hidden = false;
      // Not open yet, so no photo attach either — nothing to confirm.
      outPhoto.setHidden(true);
      outNameSelect.hidden = true;
      outBtn.disabled = true;
      outBtn.textContent = fmt("opensLater", { date: fmtShort(opens) + " " + opens.getDate() });
      return;
    }
    homeHero.classList.remove("no-task");
    outBtn.disabled = false;
    outBtn.textContent = tr("confirmOutBtn");
    reactionsRowEl.hidden = false;
    loadReactions();

    var date = new Date(task.date_key + "T00:00:00");
    // The mockup's "TONIGHT'S BINS" eyebrow, but only when that's literally
    // true — an overdue or same-day task shows its real date instead, since
    // that's the whole point of surfacing it.
    var isTomorrow = date.toDateString() === tomorrow.toDateString();
    taskDateLabel.textContent = isTomorrow ? tr("tonightBinsLabel") : fmtLong(date);
    renderBadges(taskBadges, task.codes);

    var dutyPerson = task.out_by || thisWeek.name;
    homeDutyAvatar.hidden = false;
    homeDutyAvatar.textContent = initials(dutyPerson);

    // With a local "who am I" set, the name picker is redundant — it's
    // pre-filled with that person and hidden, leaving one big button.
    var meOnRoster = ME && ROSTER.includes(ME);
    outNameSelect.hidden = meOnRoster;
    backNameSelect.hidden = meOnRoster;
    if (meOnRoster) { outNameSelect.value = ME; backNameSelect.value = ME; }

    if (!task.out_at) {
      outRow.hidden = false;
      outPhoto.setHidden(false);
      outPhoto.forTask(task.date_key);
      backRow.hidden = true;
      backPhoto.setHidden(true);
      claimStatus.innerHTML = "";
      var parts = fmt("dutyTonight", { name: dutyPerson }).split(dutyPerson);
      claimStatus.appendChild(document.createTextNode(parts[0]));
      var strongName = document.createElement("strong");
      strongName.style.color = "var(--ink)";
      strongName.textContent = dutyPerson;
      claimStatus.appendChild(strongName);
      var tail = parts.slice(1).join(dutyPerson);
      var tonightWord = tr("relTonight").toLowerCase();
      var tIdx = tail.toLowerCase().lastIndexOf(tonightWord);
      if (tIdx !== -1) {
        claimStatus.appendChild(document.createTextNode(tail.slice(0, tIdx)));
        var strongTonight = document.createElement("strong");
        strongTonight.textContent = tail.slice(tIdx, tIdx + tonightWord.length);
        claimStatus.appendChild(strongTonight);
        claimStatus.appendChild(document.createTextNode(tail.slice(tIdx + tonightWord.length)));
      } else {
        claimStatus.appendChild(document.createTextNode(tail));
      }
    } else {
      outRow.hidden = true;
      outPhoto.setHidden(true);
      backRow.hidden = false;
      backPhoto.setHidden(false);
      backPhoto.forTask(task.date_key);
      if (!meOnRoster) fillNameSelect(backNameSelect, task.out_by);
      claimStatus.textContent = fmt("outConfirmedBy", { name: task.out_by });
    }
  }

  function loadTask() {
    return fetch(api("/api/tasks/current"))
      .then(function (r) { if (!r.ok) throw new Error("bad status"); return r.json(); })
      .then(renderTask)
      .catch(function () { claimStatus.textContent = tr("taskFailed"); });
  }

  function loadLeaderboard() {
    return fetch(api("/api/tasks/leaderboard"))
      .then(function (r) { if (!r.ok) throw new Error("bad status"); return r.json(); })
      .then(function (rows) {
        var tally = {};
        ROSTER.forEach(function (n) { tally[n] = 0; });
        rows.forEach(function (row) { if (tally[row.name] != null) tally[row.name] = Number(row.coins) || 0; });
        var ranked = ROSTER.slice().sort(function (a, b) { return tally[b] - tally[a]; });

        leaderboardEl.innerHTML = "";
        ranked.forEach(function (name, i) {
          var idx = ROSTER.indexOf(name);
          var row = document.createElement("div");
          row.className = "poster lb-row" + (i === 0 ? " top" : "") + (name === ME ? " mine" : "");
          var av = document.createElement("span");
          av.className = "avatar lb-avatar";
          av.textContent = initials(name);
          row.innerHTML = '<span class="lb-rank">' + (i + 1) + '</span>';
          row.appendChild(av);
          var nameSpan = document.createElement("span");
          nameSpan.className = "lb-name";
          nameSpan.appendChild(document.createTextNode(name));
          if (name === ME) {
            var youTag = document.createElement("span");
            youTag.className = "you-tag";
            youTag.textContent = " " + tr("youTag");
            nameSpan.appendChild(youTag);
          }
          row.appendChild(nameSpan);
          var coinSpan = document.createElement("span");
          coinSpan.className = "lb-coins";
          coinSpan.textContent = tally[name];
          row.appendChild(coinSpan);
          leaderboardEl.appendChild(row);
        });
      })
      .catch(function () {});
  }

  function celebrate(name, coins) {
    var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var toast = document.createElement("div");
    toast.textContent = "+" + coins + " SCRAP — " + name;
    toast.style.cssText =
      "position:fixed; left:50%; top:16px; transform:translateX(-50%); z-index:1000;" +
      "background:var(--accent); color:var(--accent-ink); font-family:'Oswald',sans-serif;" +
      "font-weight:700; letter-spacing:.03em; text-transform:uppercase; font-size:13px;" +
      "padding:10px 18px; border-radius:6px; box-shadow:var(--shadow);";
    document.body.appendChild(toast);
    setTimeout(function () { toast.remove(); }, 2600);

    if (reduce) return;
    var colors = ["var(--bin-m)", "var(--bin-e)", "var(--bin-p)", "var(--bin-v)", "var(--bin-b)", "var(--bin-r)", "var(--accent)"];
    for (var i = 0; i < 18; i++) {
      var bit = document.createElement("div");
      var x = 40 + Math.random() * 20;
      var dx = (Math.random() - 0.5) * 220;
      var dy = 160 + Math.random() * 140;
      var rot = (Math.random() - 0.5) * 540;
      var size = 6 + Math.random() * 7;
      bit.style.cssText =
        "position:fixed; left:" + x + "%; top:70px; width:" + size + "px; height:" + size + "px;" +
        "background:" + colors[i % colors.length] + "; z-index:999; pointer-events:none;" +
        "border-radius:" + (Math.random() > 0.5 ? "2px" : "50%") + ";" +
        "transition: transform 900ms cubic-bezier(.2,.7,.3,1), opacity 900ms ease;" +
        "opacity:1; transform: translate(0,0) rotate(0deg);";
      document.body.appendChild(bit);
      (function (el, dx2, dy2, rot2) {
        requestAnimationFrame(function () {
          el.style.transform = "translate(" + dx2 + "px," + dy2 + "px) rotate(" + rot2 + "deg)";
          el.style.opacity = "0";
        });
        setTimeout(function () { el.remove(); }, 950);
      })(bit, dx, dy, rot);
    }
  }

  outBtn.addEventListener("click", function () {
    if (!currentTask) return;
    outBtn.disabled = true;
    claimStatus.textContent = tr("outLogging");
    var form = new FormData();
    form.append("name", outNameSelect.value);
    var outFile = outPhoto.getFile();
    if (outFile) {
      form.append("photo", outFile);
      var outTaken = outPhoto.getTakenAt();
      if (outTaken) form.append("photoTakenAt", outTaken.toISOString());
    }
    // No content-type header — fetch sets the multipart boundary itself
    // from the FormData body; setting it manually breaks the upload.
    fetch(api("/api/tasks/" + currentTask.date_key + "/out"), { method: "POST", body: form })
      .then(function (r) {
        if (!r.ok) return r.json().then(function (e) { throw new Error(e.error || "failed"); });
        return r.json();
      })
      .then(function (task) {
        // Consumed — the date_key doesn't change here (still the same
        // task, now marked out), so renderTask's own key-change reset
        // wouldn't catch this; clear it explicitly.
        outPhoto.reset();
        renderTask(task);
        if (task.photoBonus) celebrate(task.out_by, task.photoBonus);
        celebrateAchievements(task.unlocked);
        if (task.photoBonus) loadLeaderboard();
        loadTaskHistory();
      })
      .catch(function () { claimStatus.textContent = tr("taskFailed"); })
      .finally(function () { outBtn.disabled = false; });
  });

  backBtn.addEventListener("click", function () {
    if (!currentTask) return;
    backBtn.disabled = true;
    claimStatus.textContent = tr("backLogging");
    var form = new FormData();
    form.append("name", backNameSelect.value);
    var backFile = backPhoto.getFile();
    if (backFile) {
      form.append("photo", backFile);
      var backTaken = backPhoto.getTakenAt();
      if (backTaken) form.append("photoTakenAt", backTaken.toISOString());
    }
    fetch(api("/api/tasks/" + currentTask.date_key + "/back"), { method: "POST", body: form })
      .then(function (r) {
        if (!r.ok) return r.json().then(function (e) { throw new Error(e.error || "failed"); });
        return r.json();
      })
      .then(function (task) {
        backPhoto.reset();
        celebrate(task.out_by, task.coins + (task.photoBonus || 0));
        celebrateAchievements(task.unlocked);
        loadLeaderboard();
        // History has to be fresh before loadTask re-renders — the "no
        // task open, show next" fallback reads TASK_HISTORY to skip a day
        // that's already done (most often tonight's own task, just
        // finished), so it can't run against a stale/empty history.
        return loadTaskHistory().then(loadTask);
      })
      .catch(function () { claimStatus.textContent = tr("taskFailed"); })
      .finally(function () { backBtn.disabled = false; });
  });

  claimStatus.textContent = tr("taskLoading");
  loadTaskHistory().then(loadTask); // history first — see the note in backBtn's handler
  loadLeaderboard();

  // ---- email notification subscriptions ----
  var subscribePickNote = document.getElementById("subscribePickNote");
  var subscribeFields = document.getElementById("subscribeFields");
  var notifyEmailInput = document.getElementById("notifyEmailInput");
  var notifyLangSelect = document.getElementById("notifyLangSelect");
  var notifySubscribeBtn = document.getElementById("notifySubscribeBtn");
  var notifyStatus = document.getElementById("notifyStatus");
  var notifyList = document.getElementById("notifyList");
  var unsubEmailInput = document.getElementById("unsubEmailInput");
  var unsubBtn = document.getElementById("unsubBtn");

  function renderNotifyForm() {
    // The subscription is for whoever was picked under "Who are you?" —
    // no second name picker. Until a name is picked, the form just points
    // up to that field.
    var meOnRoster = !!(ME && ROSTER.includes(ME));
    subscribePickNote.hidden = meOnRoster;
    subscribeFields.hidden = !meOnRoster;

    var currentSubLang = notifyLangSelect.value;
    notifyLangSelect.innerHTML = "";
    window.LANGS.forEach(function (l) {
      var opt = document.createElement("option");
      opt.value = l.code;
      opt.textContent = l.name;
      notifyLangSelect.appendChild(opt);
    });
    notifyLangSelect.value = currentSubLang || currentLang;
    syncSelectTrigger(notifyLangSelect);
  }

  // Who's subscribed (names only) — drives the dot on roster avatars.
  function loadSubscribers() {
    fetch(api("/api/subscribe"))
      .then(function (r) { if (!r.ok) throw new Error("bad status"); return r.json(); })
      .then(function (rows) {
        subscribedNames = {};
        rows.forEach(function (row) { subscribedNames[row.name] = true; });
        renderDuty(); // re-draw the roster with the subscribed badge
      })
      .catch(function () {});
  }

  // The "You" tab's own card: subscribed state (masked address, bonus chip,
  // unsubscribe) vs. the subscribe form.
  var subscribedState = document.getElementById("subscribedState");
  var subscribeForm = document.getElementById("subscribeForm");
  var subEmail = document.getElementById("subEmail");
  var subBonus = document.getElementById("subBonus");

  function loadMySubscription() {
    if (!ME) {
      subscribedState.hidden = true;
      subscribeForm.hidden = false;
      return;
    }
    fetch(api("/api/subscribe/status/" + encodeURIComponent(ME)))
      .then(function (r) { if (!r.ok) throw new Error("bad status"); return r.json(); })
      .then(function (s) {
        subscribedState.hidden = !s.subscribed;
        subscribeForm.hidden = !!s.subscribed;
        subEmail.textContent = s.email || "";
        subBonus.hidden = !s.bonusAwarded;
      })
      .catch(function () {
        subscribedState.hidden = true;
        subscribeForm.hidden = false;
      });
  }

  notifySubscribeBtn.addEventListener("click", function () {
    if (!ME) { renderNotifyForm(); return; }
    notifySubscribeBtn.disabled = true;
    notifyStatus.textContent = tr("notifySubscribing");
    fetch(api("/api/subscribe"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: ME,
        email: notifyEmailInput.value.trim(),
        language: notifyLangSelect.value
      })
    })
      .then(function (r) {
        if (!r.ok) return r.json().then(function (e) { throw new Error(e.error || "failed"); });
        return r.json();
      })
      .then(function () {
        notifyEmailInput.value = "";
        notifyStatus.textContent = tr("notifyPending");
      })
      .catch(function (e) { notifyStatus.textContent = e.message || tr("notifyFailed"); })
      .finally(function () { notifySubscribeBtn.disabled = false; });
  });

  unsubBtn.addEventListener("click", function () {
    if (!ME) return;
    unsubBtn.disabled = true;
    fetch(api("/api/subscribe/by-name/" + encodeURIComponent(ME)), { method: "DELETE" })
      .then(function (r) { if (!r.ok) throw new Error("failed"); return r.json(); })
      .then(function () {
        notifyStatus.textContent = tr("unsubDone");
        loadSubscribers();
        loadMySubscription();
      })
      .catch(function () { notifyStatus.textContent = tr("unsubFailed"); })
      .finally(function () { unsubBtn.disabled = false; });
  });

  // ---- houses: build one, join one with a code/link, list the ones this
  // device has been to. Same philosophy as everything else here — no
  // accounts, nothing server-side tracks "your" houses, it's purely what's
  // saved in this browser (MY_HOUSES / rememberHouse, defined up top).
  //
  // One factory, two instances: the You tab's card (used while already
  // inside a house, to see/switch/add more) and the landing page (used
  // with no house at all — the only two ways in from there are build or
  // join, there's nothing "current" to show). ----
  function initHousesWidget(ids) {
    var listEl = document.getElementById(ids.list);
    var buildToggleBtn = document.getElementById(ids.buildToggle);
    var joinToggleBtn = document.getElementById(ids.joinToggle);
    var buildForm = document.getElementById(ids.buildForm);
    var joinForm = document.getElementById(ids.joinForm);
    var buildName = document.getElementById(ids.buildName);
    var buildCity = document.getElementById(ids.buildCity);
    var buildSubmitBtn = document.getElementById(ids.buildSubmit);
    var buildStatus = document.getElementById(ids.buildStatus);
    var joinInput = document.getElementById(ids.joinInput);
    var joinSubmitBtn = document.getElementById(ids.joinSubmit);
    var joinStatus = document.getElementById(ids.joinStatus);

    function render() {
      listEl.innerHTML = "";
      if (!MY_HOUSES.length) {
        var empty = document.createElement("div");
        empty.className = "houses-empty";
        empty.textContent = tr("housesEmpty");
        listEl.appendChild(empty);
        return;
      }
      MY_HOUSES.forEach(function (h) {
        var row = document.createElement("div");
        row.className = "house-row" + (h.slug === HOUSE_SLUG ? " current" : "");

        var icon = document.createElement("div");
        icon.className = "house-row-icon";
        icon.textContent = "\u{1F3E0}";
        row.appendChild(icon);

        var text = document.createElement("div");
        text.className = "house-row-text";
        var name = document.createElement("div");
        name.className = "house-row-name";
        name.textContent = h.name;
        text.appendChild(name);
        var sub = document.createElement("div");
        sub.className = "house-row-sub";
        sub.textContent = h.slug === HOUSE_SLUG ? tr("housesCurrentTag") : tr("housesSwitchHint");
        text.appendChild(sub);
        row.appendChild(text);

        var copyBtn = document.createElement("button");
        copyBtn.className = "house-row-copy";
        copyBtn.type = "button";
        copyBtn.textContent = tr("housesCopyLink");
        copyBtn.addEventListener("click", function (ev) {
          ev.stopPropagation();
          var link = houseLink(h.slug);
          var mark = function () {
            copyBtn.textContent = tr("housesCopied");
            copyBtn.classList.add("copied");
            setTimeout(function () {
              copyBtn.textContent = tr("housesCopyLink");
              copyBtn.classList.remove("copied");
            }, 1800);
          };
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(link).then(mark).catch(function () { window.prompt(tr("housesCopyManual"), link); });
          } else {
            window.prompt(tr("housesCopyManual"), link);
          }
        });
        row.appendChild(copyBtn);

        if (h.slug !== HOUSE_SLUG) {
          row.style.cursor = "pointer";
          row.addEventListener("click", function () { location.href = houseLink(h.slug); });
        }

        listEl.appendChild(row);
      });
    }

    function closeForms() {
      buildForm.hidden = true;
      joinForm.hidden = true;
      buildStatus.textContent = "";
      joinStatus.textContent = "";
    }

    buildToggleBtn.addEventListener("click", function () {
      var opening = buildForm.hidden;
      closeForms();
      buildForm.hidden = !opening;
      if (opening) buildName.focus();
    });
    joinToggleBtn.addEventListener("click", function () {
      var opening = joinForm.hidden;
      closeForms();
      joinForm.hidden = !opening;
      if (opening) joinInput.focus();
    });

    buildSubmitBtn.addEventListener("click", function () {
      var name = buildName.value.trim();
      if (!name) { buildStatus.textContent = tr("buildHouseNameRequired"); return; }
      buildSubmitBtn.disabled = true;
      buildStatus.textContent = tr("buildHouseBuilding");
      fetch("/api/houses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name, city: buildCity.value.trim(), language: currentLang })
      })
        .then(function (r) {
          if (!r.ok) return r.json().then(function (e) { throw new Error(e.error || "failed"); });
          return r.json();
        })
        .then(function (house) {
          rememberHouse(house.slug, house.name);
          if (house.ownerToken) setOwnerToken(house.slug, house.ownerToken);
          location.href = houseLink(house.slug);
        })
        .catch(function (e) {
          buildStatus.textContent = e.message || tr("buildHouseFailed");
          buildSubmitBtn.disabled = false;
        });
    });

    joinSubmitBtn.addEventListener("click", function () {
      // A slug and the human-facing "code" are the same string — see
      // houses.js — so whatever someone pastes (a bare code or a full
      // ?h=... link) just needs the slug picked out of it.
      var raw = joinInput.value.trim();
      var slug = raw;
      try {
        if (/^https?:\/\//i.test(raw)) {
          slug = new URL(raw).searchParams.get("h") || raw;
        }
      } catch (e) {}
      slug = slug.toLowerCase().replace(/\s+/g, "");
      if (!slug) { joinStatus.textContent = tr("joinHouseEmpty"); return; }
      joinSubmitBtn.disabled = true;
      joinStatus.textContent = tr("joinHouseChecking");
      fetch("/api/houses/" + encodeURIComponent(slug))
        .then(function (r) {
          if (!r.ok) throw new Error(tr("joinHouseNotFound"));
          return r.json();
        })
        .then(function (house) {
          rememberHouse(house.slug, house.name);
          location.href = houseLink(house.slug);
        })
        .catch(function (e) {
          joinStatus.textContent = e.message || tr("joinHouseNotFound");
          joinSubmitBtn.disabled = false;
        });
    });

    return { render: render };
  }

  var housesWidget = initHousesWidget({
    list: "housesList", buildToggle: "buildHouseToggleBtn", joinToggle: "joinHouseToggleBtn",
    buildForm: "buildHouseForm", joinForm: "joinHouseForm", buildName: "buildHouseName",
    buildCity: "buildHouseCity", buildSubmit: "buildHouseSubmitBtn", buildStatus: "buildHouseStatus",
    joinInput: "joinHouseInput", joinSubmit: "joinHouseSubmitBtn", joinStatus: "joinHouseStatus"
  });
  function renderHousesList() { housesWidget.render(); }

  // ---- destroy this house: only on the browser that built it (holds its
  // owner key). Two steps, and the house name has to be typed to confirm,
  // since it wipes the house for everyone and can't be undone. ----
  var HOUSE_NAME = "";
  var destroyBox = document.getElementById("destroyHouseBox");
  var destroyToggleBtn = document.getElementById("destroyToggleBtn");
  var destroyConfirm = document.getElementById("destroyConfirm");
  var destroyWarning = document.getElementById("destroyWarning");
  var destroyNameInput = document.getElementById("destroyNameInput");
  var destroySubmitBtn = document.getElementById("destroySubmitBtn");
  var destroyStatus = document.getElementById("destroyStatus");

  function renderDestroyBox() {
    var token = HOUSE_SLUG ? getOwnerTokens()[HOUSE_SLUG] : null;
    destroyBox.hidden = !(token && HOUSE_NAME);
    if (destroyBox.hidden) return;
    destroyWarning.innerHTML = "";
    var parts = fmt("destroyHouseWarning", { name: "\u0000" }).split("\u0000");
    destroyWarning.appendChild(document.createTextNode(parts[0]));
    var strong = document.createElement("strong");
    strong.textContent = HOUSE_NAME;
    destroyWarning.appendChild(strong);
    destroyWarning.appendChild(document.createTextNode(parts[1] || ""));
  }
  destroyToggleBtn.addEventListener("click", function () {
    destroyConfirm.hidden = !destroyConfirm.hidden;
    destroyNameInput.value = "";
    destroySubmitBtn.disabled = true;
    destroyStatus.textContent = "";
    if (!destroyConfirm.hidden) destroyNameInput.focus();
  });
  destroyNameInput.addEventListener("input", function () {
    destroySubmitBtn.disabled = destroyNameInput.value.trim() !== HOUSE_NAME.trim();
  });
  destroySubmitBtn.addEventListener("click", function () {
    var token = getOwnerTokens()[HOUSE_SLUG];
    if (!token || destroyNameInput.value.trim() !== HOUSE_NAME.trim()) return;
    destroySubmitBtn.disabled = true;
    destroyStatus.textContent = tr("destroyHouseDestroying");
    fetch("/api/houses/" + encodeURIComponent(HOUSE_SLUG), {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ownerToken: token })
    })
      .then(function (r) {
        if (!r.ok) return r.json().then(function (e) { throw new Error(e.error || "failed"); });
        return r.json();
      })
      .then(function () {
        forgetHouse(HOUSE_SLUG);
        location.href = location.pathname; // back to the landing page
      })
      .catch(function (e) {
        destroyStatus.textContent = e.message || tr("destroyHouseFailed");
        destroySubmitBtn.disabled = false;
      });
  });

  // The landing page's own instance — same widget, different DOM, shown
  // full-page (see startApp/landing bootstrap below) when no house is
  // selected at all.
  var landingHousesWidget = initHousesWidget({
    list: "landingHousesList", buildToggle: "landingBuildToggleBtn", joinToggle: "landingJoinToggleBtn",
    buildForm: "landingBuildForm", joinForm: "landingJoinForm", buildName: "landingBuildName",
    buildCity: "landingBuildCity", buildSubmit: "landingBuildSubmitBtn", buildStatus: "landingBuildStatus",
    joinInput: "landingJoinInput", joinSubmit: "landingJoinSubmitBtn", joinStatus: "landingJoinStatus"
  });

  // ---- "You": who am I, my achievements ----
  var meSelect = document.getElementById("meSelect");
  var meStatus = document.getElementById("meStatus");

  function renderMeSelect() {
    var current = ME;
    meSelect.innerHTML = "";
    var blank = document.createElement("option");
    blank.value = "";
    blank.textContent = tr("mePickPrompt");
    meSelect.appendChild(blank);
    ROSTER.forEach(function (name) {
      var opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      meSelect.appendChild(opt);
    });
    meSelect.value = current && ROSTER.includes(current) ? current : "";
    if (meSelect.value !== current) setMe(meSelect.value);
    syncSelectTrigger(meSelect);
    meStatus.textContent = ME ? "" : tr("meNotPicked");
    renderProfileHead();
  }

  var profileHead = document.getElementById("profileHead");
  var profileAvatar = document.getElementById("profileAvatar");
  var profileName = document.getElementById("profileName");
  var profileSince = document.getElementById("profileSince");
  var profileStats = document.getElementById("profileStats");
  var statTurns = document.getElementById("statTurns");
  var statCoins = document.getElementById("statCoins");
  var statStreak = document.getElementById("statStreak");

  // The name picker + occupation field live in a collapsible panel: with no
  // name picked it's the whole screen; once picked, the screen matches the
  // mockup (head, stats, language, reminders) and an "Edit" link opens it.
  var profileEdit = document.getElementById("profileEdit");
  var profileEditBtn = document.getElementById("profileEditBtn");
  var profileEditOpen = false;

  function renderProfileEdit() {
    profileEdit.hidden = !!ME && !profileEditOpen;
    profileEditBtn.hidden = !ME;
    profileEditBtn.textContent = tr(profileEditOpen ? "profileDoneBtn" : "profileEditBtn");
  }
  profileEditBtn.addEventListener("click", function () {
    profileEditOpen = !profileEditOpen;
    renderProfileEdit();
  });

  function renderProfileHead() {
    renderProfileEdit();
    if (!ME) {
      profileHead.hidden = true;
      profileStats.hidden = true;
      return;
    }
    var idx = ROSTER.indexOf(ME);
    profileHead.hidden = false;
    profileStats.hidden = false;
    profileAvatar.style.background = AVATAR_COLORS[idx % AVATAR_COLORS.length];
    profileAvatar.textContent = initials(ME);
    profileName.textContent = ME;
    // "In the roster since Mar 2025" as in the mockup; when the join date
    // isn't known, the occupation takes that line instead (or nothing).
    var since = ROSTER_CREATED_AT[ME];
    var sinceDate = since ? new Date(since) : null;
    profileSince.textContent = sinceDate
      ? (tr("profileSincePrefix") + " " + tr("months")[sinceDate.getMonth()] + " " + sinceDate.getFullYear())
      : (ROSTER_OCCUPATION[ME] || "");
    statStreak.textContent = gBestVal;
  }

  meSelect.addEventListener("change", function () {
    setMe(meSelect.value);
    profileEditOpen = false; // picking a name collapses the panel
    meStatus.textContent = ME ? "" : tr("meNotPicked");
    renderProfileHead();
    renderDonateSelect();
    loadAchievements();
    loadReactions();
    loadLeaderboard();
    renderTask(currentTask);
    renderNotifyForm();
    loadMySubscription();
  });

  // ---- achievements ----
  var achvGrid = document.getElementById("achvGrid");
  var achvUnlockedMsg = document.getElementById("achvUnlockedMsg");

  function renderAchievements(list) {
    achvGrid.innerHTML = "";
    list.forEach(function (a) {
      var badge = document.createElement("div");
      badge.className = "achv-badge" + (a.unlockedAt ? " unlocked" : "");
      var circle = document.createElement("div");
      circle.className = "achv-circle";
      circle.textContent = (ACHIEVEMENT_META[a.code] && ACHIEVEMENT_META[a.code].icon) || "•";
      badge.appendChild(circle);
      var label = document.createElement("div");
      label.className = "achv-label";
      label.textContent = tr("achv_" + a.code);
      badge.appendChild(label);
      achvGrid.appendChild(badge);
    });
  }

  var balanceHero = document.getElementById("balanceHero");
  var balanceNum = document.getElementById("balanceNum");

  function loadAchievements() {
    if (!ME) {
      achvGrid.innerHTML = "";
      achvUnlockedMsg.textContent = tr("meNotPickedForAchievements");
      achvUnlockedMsg.classList.add("muted");
      balanceNum.textContent = "—";
      return;
    }
    achvUnlockedMsg.textContent = "";
    fetch(api("/api/coins/" + encodeURIComponent(ME)))
      .then(function (r) { if (!r.ok) throw new Error("bad status"); return r.json(); })
      .then(function (data) {
        renderAchievements(data.achievements);
        // "Just unlocked: …" — the most recently earned badge, if any.
        var latest = null;
        data.achievements.forEach(function (a) {
          if (a.unlockedAt && (!latest || a.unlockedAt > latest.unlockedAt)) latest = a;
        });
        achvUnlockedMsg.classList.toggle("muted", !latest);
        achvUnlockedMsg.textContent = latest ? fmt("justUnlocked", { name: tr("achv_" + latest.code) }) : tr("achvNone");
        balanceNum.textContent = data.balance;
        statCoins.textContent = data.balance;
        statTurns.textContent = data.turnsTaken;
      })
      .catch(function () {});
  }

  function celebrateAchievements(unlocked) {
    if (!unlocked || !unlocked.length) return;
    unlocked.forEach(function (code, i) {
      setTimeout(function () {
        var toast = document.createElement("div");
        toast.textContent = ((ACHIEVEMENT_META[code] && ACHIEVEMENT_META[code].icon) || "") + " " + tr("achievementUnlocked") + ": " + tr("achv_" + code);
        toast.style.cssText =
          "position:fixed; left:50%; top:16px; transform:translateX(-50%); z-index:1000;" +
          "background:var(--surface-2); color:var(--ink); border:1px solid var(--accent);" +
          "font-family:'Oswald',sans-serif; font-weight:600; font-size:13px;" +
          "padding:10px 18px; border-radius:6px; box-shadow:var(--shadow);";
        document.body.appendChild(toast);
        setTimeout(function () { toast.remove(); }, 3000);
      }, i * 700);
    });
    loadAchievements();
  }

  // ---- donate coins ----
  var donateToSelect = document.getElementById("donateToSelect");
  var donateAmountInput = document.getElementById("donateAmountInput");
  var donateBtn = document.getElementById("donateBtn");
  var donateStatus = document.getElementById("donateStatus");

  function renderDonateSelect() {
    var current = donateToSelect.value;
    donateToSelect.innerHTML = "";
    ROSTER.filter(function (n) { return n !== ME; }).forEach(function (name) {
      var opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      donateToSelect.appendChild(opt);
    });
    donateToSelect.value = current || (donateToSelect.options[0] && donateToSelect.options[0].value) || "";
    syncSelectTrigger(donateToSelect);
    donateBtn.disabled = !ME;
    donateStatus.textContent = ME ? "" : tr("meNotPickedForDonate");
  }

  donateBtn.addEventListener("click", function () {
    if (!ME) return;
    var amount = parseInt(donateAmountInput.value, 10);
    if (!amount || amount < 1) {
      donateStatus.textContent = tr("donateBadAmount");
      return;
    }
    donateBtn.disabled = true;
    donateStatus.textContent = tr("donateSending");
    fetch(api("/api/coins/donate"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: ME, to: donateToSelect.value, amount: amount })
    })
      .then(function (r) {
        if (!r.ok) return r.json().then(function (e) { throw new Error(e.error || "failed"); });
        return r.json();
      })
      .then(function (data) {
        donateAmountInput.value = "";
        donateStatus.textContent = fmt("donateDone", { amount: amount, to: donateToSelect.value });
        loadLeaderboard();
        celebrateAchievements(data.unlocked);
      })
      .catch(function (e) { donateStatus.textContent = e.message || tr("donateFailed"); })
      .finally(function () { donateBtn.disabled = false; });
  });

  // ---- reactions on tonight's task ----
  var reactHeart = document.getElementById("reactHeart");
  var reactUp = document.getElementById("reactUp");
  var reactDown = document.getElementById("reactDown");
  var reactButtons = { heart: reactHeart, up: reactUp, down: reactDown };
  var reactionHintEl = document.getElementById("reactionHint");

  function reactionDateKey() {
    // Reactions belong to the task the hero card is showing; the row is
    // hidden whenever there's no live task, so the fallback is only a guard.
    if (currentTask && currentTask.date_key) return currentTask.date_key;
    var y = tomorrow.getFullYear(), m = String(tomorrow.getMonth() + 1).padStart(2, "0"), d = String(tomorrow.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + d;
  }

  function renderReactionCounts(counts, mine) {
    Object.keys(reactButtons).forEach(function (emoji) {
      var btn = reactButtons[emoji];
      btn.querySelector("span").textContent = (counts && counts[emoji]) || 0;
      btn.classList.toggle("mine", mine === emoji);
    });
  }

  var myReaction = null;
  function loadReactions() {
    // No live task → the row is hidden, nothing to fetch (renderTask calls
    // this again once a task is shown).
    if (!currentTask) return;
    fetch(api("/api/reactions/" + reactionDateKey()))
      .then(function (r) { if (!r.ok) throw new Error("bad status"); return r.json(); })
      .then(function (data) {
        var mine = null;
        (data.rows || []).forEach(function (row) { if (row.name === ME) mine = row.emoji; });
        myReaction = mine;
        renderReactionCounts(data.counts, mine);
      })
      .catch(function () {});
    // Always the donate prompt now, whether or not a name is picked yet —
    // clicking it jumps to Rewards, which itself asks for a name first if
    // one isn't set (see meNotPickedForDonate).
    reactionHintEl.textContent = tr("donateHeading");
    reactionHintEl.classList.add("donate");
  }
  reactionHintEl.addEventListener("click", function () {
    showView("rewards");
  });

  Object.keys(reactButtons).forEach(function (emoji) {
    reactButtons[emoji].addEventListener("click", function () {
      if (!ME) return;
      fetch(api("/api/reactions/" + reactionDateKey()), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: ME, emoji: emoji })
      })
        .then(function (r) { if (!r.ok) throw new Error("failed"); return r.json(); })
        .then(function (data) {
          myReaction = emoji;
          renderReactionCounts(data.counts, emoji);
        })
        .catch(function () {});
    });
  });

  // ---- camera check (backend-backed, Gemini) ----
  (function () {
    var input = document.getElementById("scanInput");
    var resultEl = document.getElementById("scanResult");

    var thumbEl = document.getElementById("scanThumb");
    var idleEl = document.getElementById("scanPhotoIdle");
    var titleEl = document.getElementById("scanTitle");

    function showPhoto(url) {
      thumbEl.src = url;
      thumbEl.hidden = false;
      idleEl.hidden = true;
    }
    function resetScan() {
      resultEl.hidden = true;
      resultEl.innerHTML = "";
      thumbEl.hidden = true;
      thumbEl.removeAttribute("src");
      idleEl.hidden = false;
      titleEl.textContent = tr("scanScreenTitle");
      input.value = "";
    }

    function setStatus(text) {
      resultEl.hidden = false;
      resultEl.innerHTML = '<div class="scan-body"><div class="scan-status">' + text + '</div></div>';
    }

    function addAgainHandler() {
      var b = document.getElementById("scanAgainBtn");
      if (!b) return;
      b.addEventListener("click", resetScan);
    }
    document.getElementById("scanBackBtn").addEventListener("click", resetScan);

    // data.item / data.why come from Gemini's read of a user-supplied photo —
    // treated as untrusted input (the JSON schema constrains structure, not
    // string contents, and a photo can carry a prompt-injection payload).
    // Every piece of it goes through textContent, never innerHTML.
    function renderResult(thumbUrl, data) {
      var g = guideFor(data.code);
      resultEl.hidden = false;
      resultEl.innerHTML = "";

      showPhoto(thumbUrl);
      titleEl.textContent = tr("scanResultTitle");

      var bodyDiv = document.createElement("div");
      bodyDiv.className = "scan-body";

      var head = document.createElement("div");
      head.className = "guide-head";
      head.style.alignItems = "center";
      var pill = document.createElement("span");
      pill.className = "bin-pill";
      pill.style.background = BIN_COLOR[data.code];
      pill.textContent = binLabel(data.code);
      head.appendChild(pill);
      if (data.item) {
        var title = document.createElement("span");
        title.className = "guide-title";
        title.textContent = data.item;
        head.appendChild(title);
      }
      bodyDiv.appendChild(head);

      var bodyText = document.createElement("div");
      bodyText.className = "guide-body";
      bodyText.appendChild(document.createTextNode(data.why));
      bodyDiv.appendChild(bodyText);

      // Mockup layout: two buttons — "Email me this" (reveals the address
      // field) and "Scan another" (resets) — instead of an always-open form.
      var actions = document.createElement("div");
      actions.className = "scan-actions";
      var emailToggle = document.createElement("button");
      emailToggle.type = "button";
      emailToggle.className = "launch-btn launch-primary";
      emailToggle.textContent = tr("scanEmailMe");
      var again = document.createElement("button");
      again.className = "stamp-btn hero-btn";
      again.type = "button";
      again.id = "scanAgainBtn";
      again.textContent = tr("scanAnother");
      actions.appendChild(emailToggle);
      actions.appendChild(again);
      bodyDiv.appendChild(actions);

      var emailRow = document.createElement("div");
      emailRow.className = "scan-email-row";
      emailRow.hidden = true;
      emailToggle.addEventListener("click", function () {
        emailRow.hidden = !emailRow.hidden;
        if (!emailRow.hidden) emailInput.focus();
      });
      var emailInput = document.createElement("input");
      emailInput.type = "email";
      emailInput.className = "claim-select";
      emailInput.placeholder = tr("scanEmailPlaceholder");
      var emailBtn = document.createElement("button");
      emailBtn.type = "button";
      emailBtn.className = "stamp-btn ghost";
      emailBtn.textContent = tr("scanEmailBtn");
      var emailStatus = document.createElement("div");
      emailStatus.className = "claim-status";
      emailBtn.addEventListener("click", function () {
        var addr = emailInput.value.trim();
        if (!addr) return;
        emailBtn.disabled = true;
        emailStatus.textContent = tr("scanEmailSending");
        fetch(api("/api/check/email"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: addr, lang: currentLang, item: data.item, code: data.code, why: data.why })
        })
          .then(function (r) {
            if (!r.ok) return r.json().then(function (e) { throw new Error(e.error || "failed"); });
            return r.json();
          })
          .then(function () { emailStatus.textContent = tr("scanEmailDone"); })
          .catch(function () { emailStatus.textContent = tr("scanEmailFailed"); })
          .finally(function () { emailBtn.disabled = false; });
      });
      emailRow.appendChild(emailInput);
      emailRow.appendChild(emailBtn);
      bodyDiv.appendChild(emailRow);
      bodyDiv.appendChild(emailStatus);

      resultEl.appendChild(bodyDiv);
      addAgainHandler();
    }

    function renderError(msg) {
      resultEl.hidden = false;
      resultEl.innerHTML = '<div class="scan-body"><div class="scan-status">' + msg + '</div><button class="scan-again" type="button" id="scanAgainBtn">' + tr("scanTryAgain") + '</button></div>';
      addAgainHandler();
    }

    var busy = false;
    input.addEventListener("change", function () {
      var file = input.files && input.files[0];
      if (!file || busy) return;
      busy = true;
      var thumbUrl = URL.createObjectURL(file);
      showPhoto(thumbUrl);
      setStatus(tr("scanThinking"));

      var formData = new FormData();
      formData.append("photo", file);
      if (ME) formData.append("name", ME);

      fetch(api("/api/check"), { method: "POST", body: formData })
        .then(function (r) {
          if (r.status === 413) throw { code: "TOO_LARGE" };
          if (!r.ok) {
            // The server sends {code} for its own failures (no key, every
            // Gemini model out of quota, …); fall back to a generic code.
            return r.json().catch(function () { return {}; }).then(function (e) {
              throw { code: (e && e.code) || (r.status === 503 ? "NO_API_KEY" : "SERVER") };
            });
          }
          return r.json();
        })
        .then(function (data) {
          if (!data || !/^[MEPVBR]$/.test(data.code) || !data.why) {
            renderError(tr("scanNoTell"));
          } else {
            renderResult(thumbUrl, data);
            celebrateAchievements(data.unlocked);
          }
        })
        .catch(function (e) {
          if (e && e.code === "NO_API_KEY") renderError(tr("scanUnavailable"));
          else if (e && e.code === "GEMINI_BUSY") renderError(tr("scanBusy"));
          else if (e && e.code === "TOO_LARGE") renderError(tr("scanTooLarge"));
          else renderError(tr("scanFailed"));
        })
        .finally(function () { busy = false; });
    });
  })();

  // ---- bootstrap: load the roster + schedule, then render everything that depends on them ----
  function startApp() {
    var scheduleLoadFailed = false;
    Promise.all([
      fetch(api("/api/roster")).then(function (r) { if (!r.ok) throw new Error("bad status"); return r.json(); }),
      fetch(api("/api/schedule"))
        .then(function (r) { if (!r.ok) throw new Error("bad status"); return r.json(); })
        .catch(function () { scheduleLoadFailed = true; return {}; })
    ])
      .then(function (results) {
        ROSTER = results[0] && results[0].length ? results[0] : ["Housemate"];
        SCHEDULE = results[1];
        recomputeWeek();
        if (scheduleLoadFailed) rosterMsg.textContent = "Couldn't load the collection calendar from the server.";
        applyLang();
        loadRosterFull();
      })
      .catch(function () {
        ROSTER = ["Housemate"];
        recomputeWeek();
        rosterMsg.textContent = "Couldn't load the housemate list from the server.";
        applyLang();
      });
  }

  // A house link (?h=slug) has to actually exist before the rest of the app
  // tries to use it — an old/mistyped/deleted-house link shows a plain
  // "this house doesn't exist" page instead of a broken, empty app.
  var houseNotFoundEl = document.getElementById("houseNotFound");
  var houseNotFoundHomeLink = document.getElementById("houseNotFoundHomeLink");
  if (houseNotFoundHomeLink) houseNotFoundHomeLink.href = location.pathname;

  // Same trick as houseNotFound above: neither startApp() nor applyLang()
  // ever run on this path, so this page's own [data-i18n] text needs
  // filling directly.
  function fillI18n(root) {
    root.querySelectorAll("[data-i18n]").forEach(function (el) {
      var val = tr(el.getAttribute("data-i18n"));
      if (val != null) el.textContent = val;
    });
    root.querySelectorAll("[data-i18n-placeholder]").forEach(function (el) {
      var val = tr(el.getAttribute("data-i18n-placeholder"));
      if (val != null) el.placeholder = val;
    });
  }

  // No house at all — every session starts here now. Nothing loads, nothing
  // is assumed: the only two ways forward are building a new house or
  // opening one you already have a link/code for (including this device's
  // own remembered houses, if any).
  if (!HOUSE_SLUG) {
    var landingEl = document.getElementById("landingPage");
    fillI18n(landingEl);
    landingHousesWidget.render();
    landingEl.hidden = false;
  } else {
    fetch("/api/houses/" + encodeURIComponent(HOUSE_SLUG))
      .then(function (r) { if (!r.ok) throw new Error("not found"); return r.json(); })
      .then(function (house) {
        rememberHouse(house.slug, house.name);
        HOUSE_NAME = house.name;
        document.title = house.name + " · Bin Duty";
        startApp();
      })
      .catch(function () {
        // Not [hidden] — #app carries a class (.wrap) that sets its own
        // display, same specificity as the [hidden] UA rule, so the
        // attribute alone wouldn't actually hide it.
        var appEl = document.getElementById("app");
        if (appEl) appEl.style.display = "none";
        var hazardTop = document.querySelector(".hazard-bar.hazard-top");
        if (hazardTop) hazardTop.style.display = "none";
        fillI18n(houseNotFoundEl);
        houseNotFoundEl.hidden = false;
      });
  }
})();
