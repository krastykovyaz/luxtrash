(function () {
  "use strict";

  var SCHEDULE = {
    "2026-09": {3:"VB",4:"P",7:"M",8:"E",10:"VB",11:"P",14:"M",17:"VB",18:"P",21:"M",22:"E",24:"VB",25:"P",28:"M"},
    "2026-10": {1:"VB",2:"P",5:"M",6:"E",8:"VB",9:"P",12:"M",15:"VB",16:"P",19:"M",20:"E",22:"VB",23:"P",26:"M",29:"VB",30:"P"},
    "2026-11": {1:"HOLIDAY",2:"M",3:"E",5:"VB",6:"P",9:"M",12:"VB",13:"P",16:"M",17:"E",19:"VB",20:"P",23:"M",26:"VB",27:"P",30:"M"},
    "2026-12": {1:"E",3:"VB",4:"P",7:"M",10:"VB",11:"P",14:"M",15:"E",17:"VB",18:"P",21:"M",24:"VB",25:"HOLIDAY",28:"M",31:"VB"}
  };

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
  var AVATAR_COLORS = ["#55A3CE", "#E7B62B", "#D08A3E", "#B08DE0", "#E2604A", "#6FB25F", "#63C7A6", "#C77DBB"];
  var ANCHOR_MONDAY = new Date(2026, 8, 21);

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
  function guideFor(code) {
    var g = (window.GUIDE_T[currentLang] && window.GUIDE_T[currentLang][code]) || window.GUIDE_T.en[code];
    return g;
  }

  function pad(n) { return String(n).padStart(2, "0"); }
  function monthKey(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1); }
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
  function personForWeek(date) {
    var mon = mondayOf(date);
    var anchorMon = mondayOf(ANCHOR_MONDAY);
    var diffWeeks = Math.round((mon - anchorMon) / (7 * 86400000));
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

  // ---- language switcher ----
  function renderLangRow() {
    var row = document.getElementById("langRow");
    row.innerHTML = "";
    window.LANGS.forEach(function (l) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "lang-btn";
      btn.textContent = l.name;
      btn.setAttribute("aria-pressed", String(l.code === currentLang));
      btn.addEventListener("click", function () {
        currentLang = l.code;
        try { localStorage.setItem("binDutyLang", l.code); } catch (e) {}
        applyLang();
      });
      row.appendChild(btn);
    });
  }

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
    renderBadges(document.getElementById("todayBadges"), codesFor(today));
    renderBadges(document.getElementById("tomorrowBadges"), codesFor(tomorrow));
    document.getElementById("todayDate").textContent = fmtLong(today);
    document.getElementById("tomorrowDate").textContent = fmtLong(tomorrow);
    renderWeekStrip();
    renderDuty();
    renderGuide();
    renderLegend();
    renderCalendar();
    renderTaskForm();
    renderTask(currentTask);
    renderNotifyForm();
    gameShowItem();
    loadLeaderboard();
    loadSubscribers();
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

  // ---- duty ----
  function renderDuty() {
    var avatar = document.getElementById("dutyAvatar");
    avatar.style.background = AVATAR_COLORS[thisWeek.idx % AVATAR_COLORS.length];
    avatar.textContent = initials(thisWeek.name);
    document.getElementById("dutyName").textContent = thisWeek.name;
    document.getElementById("dutyNext").innerHTML = fmt("nextWeekLabel", {}) + " <b>" + nextWeek.name + "</b>";

    var rosterStrip = document.getElementById("rosterStrip");
    rosterStrip.innerHTML = "";
    ROSTER.forEach(function (name, idx) {
      var chip = document.createElement("span");
      chip.className = "roster-chip";
      var av = document.createElement("span");
      av.className = "avatar";
      av.style.background = AVATAR_COLORS[idx % AVATAR_COLORS.length];
      av.textContent = initials(name);
      chip.appendChild(av);
      chip.appendChild(document.createTextNode(name));
      var removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "chip-remove";
      removeBtn.setAttribute("aria-label", "Remove " + name);
      removeBtn.textContent = "×";
      removeBtn.addEventListener("click", function () { removeFromRoster(name); });
      chip.appendChild(removeBtn);
      rosterStrip.appendChild(chip);
    });
  }

  // ---- roster management (add / remove housemates) ----
  var rosterMsg = document.getElementById("rosterMsg");
  var addNameInput = document.getElementById("addNameInput");
  var addNameBtn = document.getElementById("addNameBtn");

  function afterRosterChange(newRoster) {
    ROSTER = newRoster;
    recomputeWeek();
    renderDuty();
    renderTaskForm();
    renderNotifyForm();
    loadTask();
    loadLeaderboard();
  }

  function addToRoster() {
    var name = addNameInput.value.trim();
    if (!name) return;
    addNameBtn.disabled = true;
    fetch("/api/roster", {
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
    fetch("/api/roster/" + encodeURIComponent(name), { method: "DELETE" })
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
  var gQueue = [], gIndex = 0, gScoreVal = 0, gStreakVal = 0, gBestVal = 0, gAnswered = false;
  var gButtonsByCode = {};

  try { gBestVal = parseInt(localStorage.getItem("binDutyBestStreak") || "0", 10) || 0; } catch (e) { gBestVal = 0; }
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
    btn.innerHTML = '<span class="dot" style="background:' + BIN_COLOR[code] + '"></span><span class="bin-btn-label"></span>';
    btn.addEventListener("click", function () { gameAnswer(code, btn); });
    gBinsEl.appendChild(btn);
    gButtonsByCode[code] = btn;
  });

  function gameResetButtons() {
    GAME_CODES.forEach(function (code) {
      var btn = gButtonsByCode[code];
      btn.disabled = false;
      btn.classList.remove("pick-correct", "pick-wrong");
      btn.querySelector(".bin-btn-label").textContent = binLabel(code);
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
      return;
    }

    gBinsEl.style.display = "";
    document.getElementById("gEyebrow").textContent = tr("whereGoes");
    gNextBtn.textContent = tr("next");
    gNameEl.textContent = gQueue[gIndex].name;
    gProgressEl.textContent = "Item " + (gIndex + 1) + " / " + gQueue.length;
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
        try { localStorage.setItem("binDutyBestStreak", String(gBestVal)); } catch (e) {}
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
      gIndex = 0; gScoreVal = 0; gStreakVal = 0;
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
        '<div class="guide-head"><span class="guide-letter" style="background:' + BIN_COLOR[code] + '">' + code + '</span>' +
        '<span class="guide-title">' + g.title + '</span></div>' +
        '<div class="guide-body">' + g.body + '</div>';
      grid.appendChild(card);
    });
    var vn = document.getElementById("verifyNote");
    if (!vn.dataset.custom) vn.textContent = fmt("verifyPrefix", {}) + " " + fmtLong(today);
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
            var cellDiv = document.createElement("div");
            cellDiv.className = "cal-cell" + (codes2 && codes2 !== "HOLIDAY" ? " has-data" : "") + (codes2 === "HOLIDAY" ? " holiday" : "");
            if (isToday) cellDiv.style.outline = "1.5px solid var(--accent)";
            var dotsMarkup = "";
            if (codes2 && codes2 !== "HOLIDAY") {
              dotsMarkup = codes2.split("").map(function (cc) {
                return BIN_COLOR[cc] ? '<span class="dot" style="background:' + BIN_COLOR[cc] + '"></span>' : "";
              }).join("");
            }
            cellDiv.innerHTML =
              '<span class="n mono">' + dayNum + '</span>' +
              (codes2 === "HOLIDAY" ? '<span class="hday"></span>' : '<span class="dots">' + dotsMarkup + '</span>');
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
  }

  function renderTaskForm() {
    fillNameSelect(outNameSelect, thisWeek.name);
    fillNameSelect(backNameSelect, currentTask && currentTask.out_by);
  }

  function renderTask(task) {
    currentTask = task;
    if (!task) {
      taskDateLabel.textContent = "";
      taskBadges.innerHTML = "";
      outRow.hidden = true;
      backRow.hidden = true;
      claimStatus.textContent = tr("taskNothing");
      return;
    }

    var date = new Date(task.date_key + "T00:00:00");
    taskDateLabel.textContent = fmtLong(date);
    renderBadges(taskBadges, task.codes);

    if (!task.out_at) {
      outRow.hidden = false;
      backRow.hidden = true;
      claimStatus.textContent = tr("outPending");
    } else {
      outRow.hidden = true;
      backRow.hidden = false;
      fillNameSelect(backNameSelect, task.out_by);
      claimStatus.textContent = fmt("outConfirmedBy", { name: task.out_by });
    }
  }

  function loadTask() {
    return fetch("/api/tasks/current")
      .then(function (r) { if (!r.ok) throw new Error("bad status"); return r.json(); })
      .then(renderTask)
      .catch(function () { claimStatus.textContent = tr("taskFailed"); });
  }

  function loadLeaderboard() {
    return fetch("/api/tasks/leaderboard")
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
          row.className = "lb-row";
          var av = document.createElement("span");
          av.className = "avatar lb-avatar";
          av.style.background = AVATAR_COLORS[idx % AVATAR_COLORS.length];
          av.textContent = initials(name);
          row.innerHTML = '<span class="lb-rank">' + (i + 1) + '</span>';
          row.appendChild(av);
          var nameSpan = document.createElement("span");
          nameSpan.className = "lb-name";
          nameSpan.textContent = name;
          row.appendChild(nameSpan);
          var coinSpan = document.createElement("span");
          coinSpan.className = "lb-coins";
          coinSpan.textContent = tally[name] + " SCRAP";
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
    fetch("/api/tasks/" + currentTask.date_key + "/out", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: outNameSelect.value })
    })
      .then(function (r) {
        if (!r.ok) return r.json().then(function (e) { throw new Error(e.error || "failed"); });
        return r.json();
      })
      .then(renderTask)
      .catch(function () { claimStatus.textContent = tr("taskFailed"); })
      .finally(function () { outBtn.disabled = false; });
  });

  backBtn.addEventListener("click", function () {
    if (!currentTask) return;
    backBtn.disabled = true;
    claimStatus.textContent = tr("backLogging");
    fetch("/api/tasks/" + currentTask.date_key + "/back", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: backNameSelect.value })
    })
      .then(function (r) {
        if (!r.ok) return r.json().then(function (e) { throw new Error(e.error || "failed"); });
        return r.json();
      })
      .then(function (task) {
        celebrate(task.out_by, task.coins);
        loadLeaderboard();
        return loadTask();
      })
      .catch(function () { claimStatus.textContent = tr("taskFailed"); })
      .finally(function () { backBtn.disabled = false; });
  });

  claimStatus.textContent = tr("taskLoading");
  loadTask();
  loadLeaderboard();

  // ---- email notification subscriptions ----
  var notifyNameSelect = document.getElementById("notifyNameSelect");
  var notifyEmailInput = document.getElementById("notifyEmailInput");
  var notifyLangSelect = document.getElementById("notifyLangSelect");
  var notifySubscribeBtn = document.getElementById("notifySubscribeBtn");
  var notifyStatus = document.getElementById("notifyStatus");
  var notifyList = document.getElementById("notifyList");
  var unsubEmailInput = document.getElementById("unsubEmailInput");
  var unsubBtn = document.getElementById("unsubBtn");

  function renderNotifyForm() {
    var currentName = notifyNameSelect.value;
    notifyNameSelect.innerHTML = "";
    ROSTER.forEach(function (name) {
      var opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      notifyNameSelect.appendChild(opt);
    });
    notifyNameSelect.value = currentName && ROSTER.includes(currentName) ? currentName : ROSTER[0];

    var currentSubLang = notifyLangSelect.value;
    notifyLangSelect.innerHTML = "";
    window.LANGS.forEach(function (l) {
      var opt = document.createElement("option");
      opt.value = l.code;
      opt.textContent = l.name;
      notifyLangSelect.appendChild(opt);
    });
    notifyLangSelect.value = currentSubLang || currentLang;
  }

  function renderNotifyList(rows) {
    notifyList.innerHTML = "";
    if (!rows.length) {
      var none = document.createElement("div");
      none.className = "claim-status";
      none.textContent = tr("subscribedNone");
      notifyList.appendChild(none);
      return;
    }
    var note = document.createElement("div");
    note.className = "claim-status";
    note.textContent = tr("subscribedListNote");
    notifyList.appendChild(note);
    rows.forEach(function (row) {
      var line = document.createElement("div");
      line.className = "lb-row";
      var nameSpan = document.createElement("span");
      nameSpan.className = "lb-name";
      nameSpan.textContent = row.name;
      line.appendChild(nameSpan);
      notifyList.appendChild(line);
    });
  }

  function loadSubscribers() {
    fetch("/api/subscribe")
      .then(function (r) { if (!r.ok) throw new Error("bad status"); return r.json(); })
      .then(renderNotifyList)
      .catch(function () {});
  }

  notifySubscribeBtn.addEventListener("click", function () {
    notifySubscribeBtn.disabled = true;
    notifyStatus.textContent = tr("notifySubscribing");
    fetch("/api/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: notifyNameSelect.value,
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
        notifyStatus.textContent = tr("notifyDone");
        loadSubscribers();
      })
      .catch(function (e) { notifyStatus.textContent = e.message || tr("notifyFailed"); })
      .finally(function () { notifySubscribeBtn.disabled = false; });
  });

  unsubBtn.addEventListener("click", function () {
    var email = unsubEmailInput.value.trim();
    if (!email) return;
    unsubBtn.disabled = true;
    fetch("/api/subscribe/" + encodeURIComponent(email), { method: "DELETE" })
      .then(function (r) { if (!r.ok) throw new Error("failed"); return r.json(); })
      .then(function () {
        unsubEmailInput.value = "";
        notifyStatus.textContent = tr("unsubDone");
        loadSubscribers();
      })
      .catch(function () { notifyStatus.textContent = tr("unsubFailed"); })
      .finally(function () { unsubBtn.disabled = false; });
  });

  // ---- camera check (backend-backed, Gemini) ----
  (function () {
    var input = document.getElementById("scanInput");
    var resultEl = document.getElementById("scanResult");

    function setStatus(text) {
      resultEl.hidden = false;
      resultEl.innerHTML = '<div class="scan-body"><div class="scan-status">' + text + '</div></div>';
    }

    function addAgainHandler() {
      var b = document.getElementById("scanAgainBtn");
      if (!b) return;
      b.addEventListener("click", function () { resultEl.hidden = true; input.value = ""; });
    }

    function renderResult(thumbUrl, data) {
      var g = guideFor(data.code);
      resultEl.hidden = false;
      resultEl.innerHTML =
        '<img class="scan-thumb" src="' + thumbUrl + '" alt="">' +
        '<div class="scan-body">' +
        '<div class="guide-head"><span class="guide-letter" style="background:' + BIN_COLOR[data.code] + '">' + data.code + '</span><span class="guide-title">' + (g ? g.title : data.code) + '</span></div>' +
        '<div class="guide-body">' + (data.item ? '<strong>' + data.item + '.</strong> ' : '') + data.why + '</div>' +
        '<button class="scan-again" type="button" id="scanAgainBtn">' + tr("scanTryAnother") + '</button>' +
        '</div>';
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
      setStatus(tr("scanThinking"));

      var formData = new FormData();
      formData.append("photo", file);

      fetch("/api/check", { method: "POST", body: formData })
        .then(function (r) {
          if (r.status === 503) throw { code: "NO_API_KEY" };
          if (r.status === 413) throw { code: "TOO_LARGE" };
          if (!r.ok) throw { code: "SERVER" };
          return r.json();
        })
        .then(function (data) {
          if (!data || !/^[MEPVBR]$/.test(data.code) || !data.why) {
            renderError(tr("scanNoTell"));
          } else {
            renderResult(thumbUrl, data);
          }
        })
        .catch(function (e) {
          if (e && e.code === "NO_API_KEY") renderError(tr("scanUnavailable"));
          else if (e && e.code === "TOO_LARGE") renderError(tr("scanTooLarge"));
          else renderError(tr("scanFailed"));
        })
        .finally(function () { busy = false; });
    });
  })();

  // ---- bootstrap: load the roster, then render everything that depends on it ----
  fetch("/api/roster")
    .then(function (r) { if (!r.ok) throw new Error("bad status"); return r.json(); })
    .then(function (roster) {
      ROSTER = roster && roster.length ? roster : ["Housemate"];
      recomputeWeek();
      applyLang();
    })
    .catch(function () {
      ROSTER = ["Housemate"];
      recomputeWeek();
      rosterMsg.textContent = "Couldn't load the housemate list from the server.";
      applyLang();
    });
})();
