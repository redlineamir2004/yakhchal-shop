/* ============ Firebase init ============ */
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

// Make sure the login session survives closing/reopening the app.
// (Some Android APK wrappers need this set explicitly instead of relying on the browser default.)
auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch((e) => console.error("persistence error", e));

// Keep the user logged in across app restarts (fixes auto sign-out on relaunch)
auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch((e) => console.error("persistence error", e));

/* ============ State ============ */
let currentUser = null;   // {uid, email}
let currentRole = null;   // 'admin' | 'staff'
let currentName = "";
let unsubscribeBatches = null;
let unsubscribeProducts = null;
let productsCache = {};   // barcode -> {name, ...}
let html5QrCode = null;

let sheetMode = null;     // 'new' | 'existing' | 'edit' | 'manual'
let sheetBarcode = null;
let sheetEditBatchId = null;

let productSheetMode = null; // 'add' | 'edit'
let productSheetOriginalBarcode = null;

/* ============ Elements ============ */
const $ = (id) => document.getElementById(id);
const loginScreen = $("login-screen");
const mainApp = $("main-app");

/* ============ Theme ============ */
function applyTheme(theme) {
  document.body.setAttribute("data-theme", theme);
  $("theme-toggle").textContent = theme === "dark" ? "☀️" : "🌙";
  localStorage.setItem("expiry-app-theme", theme);
}
(function initTheme() {
  const saved = localStorage.getItem("expiry-app-theme");
  const preferred = saved || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  applyTheme(preferred);
})();
$("theme-toggle").addEventListener("click", () => {
  const isDark = document.body.getAttribute("data-theme") === "dark";
  applyTheme(isDark ? "light" : "dark");
});

/* ============ Show/hide password ============ */
document.querySelectorAll(".eye-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const input = $(btn.dataset.target);
    const showing = input.type === "text";
    input.type = showing ? "password" : "text";
    btn.textContent = showing ? "👁" : "🙈";
  });
});

/* ============ Toast ============ */
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2200);
}

/* ============ Jalali (Shamsi) date conversion ============ */
function gregorianToJalali(gy, gm, gd) {
  const g_d_m = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  let jy = (gy <= 1600) ? 0 : 979;
  gy -= (gy <= 1600) ? 621 : 1600;
  const gy2 = (gm > 2) ? (gy + 1) : gy;
  let days = (365 * gy) + Math.floor((gy2 + 3) / 4) - Math.floor((gy2 + 99) / 100) +
    Math.floor((gy2 + 399) / 400) - 80 + gd + g_d_m[gm - 1];
  jy += 33 * Math.floor(days / 12053);
  days %= 12053;
  jy += 4 * Math.floor(days / 1461);
  days %= 1461;
  jy += Math.floor((days - 1) / 365);
  if (days > 365) days = (days - 1) % 365;
  const jm = (days < 186) ? 1 + Math.floor(days / 31) : 7 + Math.floor((days - 186) / 30);
  const jd = 1 + ((days < 186) ? (days % 31) : ((days - 186) % 30));
  return [jy, jm, jd];
}
const jalaliMonths = ["فروردین","اردیبهشت","خرداد","تیر","مرداد","شهریور","مهر","آبان","آذر","دی","بهمن","اسفند"];
function formatJalali(dateStr) {
  const [gy, gm, gd] = dateStr.split("-").map(Number);
  const [jy, jm, jd] = gregorianToJalali(gy, gm, gd);
  return `${jd} ${jalaliMonths[jm - 1]} ${jy}`;
}

function jalaliToGregorian(jy, jm, jd) {
  let gy = (jy > 979) ? 1600 : 621;
  jy = (jy > 979) ? jy - 979 : jy;
  let days = (365 * jy) + (Math.floor(jy / 33) * 8) + Math.floor(((jy % 33) + 3) / 4) + 78 + jd +
    ((jm < 7) ? (jm - 1) * 31 : (((jm - 7) * 30) + 186));
  gy += 400 * Math.floor(days / 146097);
  days %= 146097;
  if (days > 36524) {
    days--;
    gy += 100 * Math.floor(days / 36524);
    days %= 36524;
    if (days >= 365) days++;
  }
  gy += 4 * Math.floor(days / 1461);
  days %= 1461;
  if (days > 365) {
    gy += Math.floor((days - 1) / 365);
    days = (days - 1) % 365;
  }
  let gd = days + 1;
  const isLeapG = (gy % 4 === 0 && gy % 100 !== 0) || (gy % 400 === 0);
  const monthDays = [0, 31, isLeapG ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let gm = 0;
  for (gm = 1; gm <= 12; gm++) {
    if (gd <= monthDays[gm]) break;
    gd -= monthDays[gm];
  }
  return [gy, gm, gd];
}
function isLeapJalaliYear(jy) {
  // practical approximation of the 33-year leap cycle, accurate for all realistic dates in this app
  return [1, 5, 9, 13, 17, 22, 26, 30].includes(((jy % 33) + 33) % 33);
}
function pad2(n) { return String(n).padStart(2, "0"); }

/* ============ Jalali date picker (day/month/year selects) ============ */
function currentJalaliYear() {
  const now = new Date();
  return gregorianToJalali(now.getFullYear(), now.getMonth() + 1, now.getDate())[0];
}
function populateJalaliPicker() {
  const daySel = $("sheet-expiry-day");
  const monthSel = $("sheet-expiry-month");
  const yearSel = $("sheet-expiry-year");

  monthSel.innerHTML = `<option value="">ماه</option>` +
    jalaliMonths.map((m, i) => `<option value="${i + 1}">${m}</option>`).join("");

  const thisYear = currentJalaliYear();
  let yearsHtml = `<option value="">سال</option>`;
  for (let y = thisYear - 1; y <= thisYear + 4; y++) yearsHtml += `<option value="${y}">${y}</option>`;
  yearSel.innerHTML = yearsHtml;

  refreshDayOptions();
  monthSel.onchange = refreshDayOptions;
  yearSel.onchange = refreshDayOptions;
}
function refreshDayOptions() {
  const daySel = $("sheet-expiry-day");
  const monthSel = $("sheet-expiry-month");
  const yearSel = $("sheet-expiry-year");
  const prevValue = daySel.value;

  const month = parseInt(monthSel.value, 10);
  const year = parseInt(yearSel.value, 10);
  let maxDay = 31;
  if (month >= 7 && month <= 11) maxDay = 30;
  else if (month === 12) maxDay = (year && isLeapJalaliYear(year)) ? 30 : 29;

  let html = `<option value="">روز</option>`;
  for (let d = 1; d <= maxDay; d++) html += `<option value="${d}">${d}</option>`;
  daySel.innerHTML = html;
  if (prevValue && parseInt(prevValue, 10) <= maxDay) daySel.value = prevValue;
}
populateJalaliPicker();

function getExpiryDateValue() {
  const d = parseInt($("sheet-expiry-day").value, 10);
  const m = parseInt($("sheet-expiry-month").value, 10);
  const y = parseInt($("sheet-expiry-year").value, 10);
  if (!d || !m || !y) return null;
  const [gy, gm, gd] = jalaliToGregorian(y, m, d);
  return `${gy}-${pad2(gm)}-${pad2(gd)}`;
}
function setExpiryDateValue(isoDateStr) {
  if (!isoDateStr) {
    $("sheet-expiry-day").value = "";
    $("sheet-expiry-month").value = "";
    $("sheet-expiry-year").value = "";
    return;
  }
  const [gy, gm, gd] = isoDateStr.split("-").map(Number);
  const [jy, jm, jd] = gregorianToJalali(gy, gm, gd);
  $("sheet-expiry-year").value = jy;
  refreshDayOptions();
  $("sheet-expiry-month").value = jm;
  refreshDayOptions();
  $("sheet-expiry-day").value = jd;
}

/* ============ Expiry status ============ */
function statusFor(dateStr) {
  const today = new Date();
  today.setHours(0,0,0,0);
  const exp = new Date(dateStr + "T00:00:00");
  const daysLeft = Math.round((exp - today) / 86400000);
  let status;
  if (daysLeft > 30) status = "green";
  else if (daysLeft >= 15) status = "yellow";
  else if (daysLeft >= 7) status = "orange";
  else status = "red";
  return { daysLeft, status };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]));
}

/* ============ Notifications (local, in-app) ============ */
function refreshNotifStatus() {
  const el = $("notif-status-text");
  if (!("Notification" in window)) {
    el.textContent = "این مرورگر/دستگاه از نوتیفیکیشن پشتیبانی نمی‌کنه.";
    return;
  }
  const map = {
    granted: "نوتیفیکیشن فعاله. وقتی وارد اپ می‌شید، اگه محصول نزدیک به انقضا باشه یه هشدار می‌بینید.",
    denied: "نوتیفیکیشن مسدود شده. برای فعال کردن، باید از تنظیمات گوشی/مرورگر به این اپ اجازه بدید.",
    default: "هنوز نوتیفیکیشن فعال نشده. دکمه‌ی بالا رو بزنید و اجازه بدید."
  };
  el.textContent = map[Notification.permission] || "";
}
$("enable-notif-btn").addEventListener("click", async () => {
  if (!("Notification" in window)) { toast("این دستگاه از نوتیفیکیشن پشتیبانی نمی‌کنه."); return; }
  try {
    await Notification.requestPermission();
  } catch (e) {}
  refreshNotifStatus();
});
refreshNotifStatus();

function checkAndNotify(redCount, orangeCount) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const today = new Date().toISOString().slice(0, 10);
  if (localStorage.getItem("expiry-app-last-notify") === today) return;
  if (redCount + orangeCount === 0) return;
  try {
    new Notification("⏰ هشدار تاریخ انقضا", {
      body: `${redCount} محصول کمتر از ۷ روز و ${orangeCount} محصول بین ۷ تا ۱۵ روز تا انقضا دارن.`,
      icon: "icons/icon-192.png"
    });
    localStorage.setItem("expiry-app-last-notify", today);
  } catch (e) { console.error(e); }
}

/* ============ Auth ============ */
$("login-btn").addEventListener("click", async () => {
  const email = $("login-email").value.trim();
  const password = $("login-password").value;
  $("login-error").textContent = "";
  if (!email || !password) {
    $("login-error").textContent = "ایمیل و رمز عبور رو وارد کنید.";
    return;
  }
  try {
    await auth.signInWithEmailAndPassword(email, password);
  } catch (e) {
    $("login-error").textContent = "ورود ناموفق بود. ایمیل یا رمز عبور اشتباهه.";
  }
});

$("logout-btn").addEventListener("click", () => auth.signOut());

auth.onAuthStateChanged(async (user) => {
  if (user) {
    currentUser = user;
    try {
      const userDoc = await db.collection("users").doc(user.uid).get();
      if (!userDoc.exists) {
        $("login-error").textContent = "این حساب هنوز در سیستم ثبت نشده. با مدیر فروشگاه هماهنگ کنید.";
        await auth.signOut();
        return;
      }
      const data = userDoc.data();
      currentRole = data.role;
      currentName = data.name || user.email;
      enterApp();
    } catch (e) {
      $("login-error").textContent = "خطا در دریافت اطلاعات حساب.";
      await auth.signOut();
    }
  } else {
    currentUser = null;
    currentRole = null;
    if (unsubscribeBatches) unsubscribeBatches();
    if (unsubscribeProducts) unsubscribeProducts();
    loginScreen.classList.remove("hidden");
    mainApp.classList.add("hidden");
    mainApp.style.display = "none";
  }
});

function enterApp() {
  loginScreen.classList.add("hidden");
  mainApp.classList.remove("hidden");
  mainApp.style.display = "flex";

  $("me-name").textContent = currentName;
  $("me-avatar").textContent = currentName.charAt(0) || "؟";
  $("me-role").textContent = currentRole === "admin" ? "مدیر فروشگاه" : "کارمند";
  if (currentRole === "admin") {
    $("admin-staff-section").classList.remove("hidden");
    loadStaffList();
  }
  listenBatches();
  listenProducts();
  switchScreen("dates");
}

/* ============ Bottom nav & screens ============ */
document.querySelectorAll(".nav-btn[data-screen]").forEach((btn) => {
  btn.addEventListener("click", () => switchScreen(btn.dataset.screen));
});
function switchScreen(name) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.add("hidden"));
  $("screen-" + name).classList.remove("hidden");
  document.querySelectorAll(".nav-btn[data-screen]").forEach((b) => b.classList.remove("active"));
  const activeBtn = document.querySelector(`.nav-btn[data-screen="${name}"]`);
  if (activeBtn) activeBtn.classList.add("active");
  const titles = { dates: "تاریخ‌ها", products: "محصولات", settings: "تنظیمات" };
  $("page-title").textContent = titles[name] || "";

  $("fab-add-date").classList.toggle("hidden", name !== "dates");
  $("fab-add-product").classList.toggle("hidden", name !== "products");
}

/* ============ Realtime products (master list) ============ */
function listenProducts() {
  if (unsubscribeProducts) unsubscribeProducts();
  unsubscribeProducts = db.collection("products")
    .orderBy("name", "asc")
    .onSnapshot((snap) => {
      productsCache = {};
      const list = $("product-list");
      if (snap.empty) {
        list.innerHTML = `<div class="empty-state"><span class="emoji">📦</span>هنوز محصولی ثبت نشده.<br>از دکمه «+» یا اسکن بارکد اضافه کنید.</div>`;
        return;
      }
      let html = "";
      snap.forEach((doc) => {
        const p = doc.data();
        productsCache[doc.id] = p;
        html += `
          <div class="product-row" data-barcode="${escapeHtml(doc.id)}" data-name="${escapeHtml(p.name)}">
            <div>
              <div class="name">${escapeHtml(p.name)}</div>
              <div class="meta">بارکد: ${escapeHtml(doc.id)}</div>
            </div>
            <span style="color:var(--text-dim); font-size:18px;">›</span>
          </div>`;
      });
      list.innerHTML = html;
      list.querySelectorAll(".product-row").forEach((row) => {
        row.addEventListener("click", () => openEditProductSheet(row.dataset.barcode, row.dataset.name));
      });
    }, () => toast("خطا در دریافت لیست محصولات"));
}

/* ============ Realtime batch list (dates) ============ */
function listenBatches() {
  if (unsubscribeBatches) unsubscribeBatches();
  unsubscribeBatches = db.collection("batches")
    .orderBy("expiryDate", "asc")
    .onSnapshot((snap) => {
      const list = $("batch-list");
      if (snap.empty) {
        list.innerHTML = `<div class="empty-state"><span class="emoji">📭</span>هنوز تاریخی ثبت نشده.<br>از دکمه «+» یا «اسکن» شروع کنید.</div>`;
        return;
      }
      let html = "";
      let redCount = 0, orangeCount = 0;
      snap.forEach((doc) => {
        const b = doc.data();
        const { daysLeft, status } = statusFor(b.expiryDate);
        if (status === "red") redCount++;
        if (status === "orange") orangeCount++;
        const dayLabel = daysLeft < 0 ? `${Math.abs(daysLeft)} روز گذشته` : daysLeft === 0 ? "امروز" : `${daysLeft} روز مانده`;
        html += `
          <div class="batch-card status-${status}" data-id="${doc.id}" data-name="${escapeHtml(b.productName)}" data-date="${b.expiryDate}">
            <div class="batch-info">
              <p class="batch-name">${escapeHtml(b.productName)}</p>
              <p class="batch-date">انقضا: ${formatJalali(b.expiryDate)}</p>
            </div>
            <span class="badge status-${status}">${dayLabel}</span>
          </div>`;
      });
      list.innerHTML = html;
      checkAndNotify(redCount, orangeCount);
      list.querySelectorAll(".batch-card").forEach((card) => {
        card.addEventListener("click", () => openEditDateSheet(card.dataset.id, card.dataset.name, card.dataset.date));
      });
    }, () => toast("خطا در دریافت لیست تاریخ‌ها"));
}

/* ============ Scanner ============ */
$("nav-scan-btn").addEventListener("click", openScanner);
$("scanner-close-btn").addEventListener("click", closeScanner);
$("manual-barcode-btn").addEventListener("click", () => {
  const code = prompt("شماره بارکد رو وارد کنید:");
  if (code && code.trim()) {
    closeScanner();
    handleScannedBarcode(code.trim());
  }
});

function openScanner() {
  $("scanner-modal").classList.remove("hidden");
  html5QrCode = new Html5Qrcode("qr-reader");
  html5QrCode.start(
    { facingMode: "environment" },
    { fps: 10, qrbox: { width: 250, height: 150 } },
    (decodedText) => {
      closeScanner();
      handleScannedBarcode(decodedText);
    },
    () => {}
  ).catch(() => {
    toast("دسترسی به دوربین ممکن نشد. از ورود دستی استفاده کنید.");
  });
}
function closeScanner() {
  $("scanner-modal").classList.add("hidden");
  if (html5QrCode) {
    html5QrCode.stop().then(() => html5QrCode.clear()).catch(() => {});
    html5QrCode = null;
  }
}

async function handleScannedBarcode(barcode) {
  try {
    const productDoc = await db.collection("products").doc(barcode).get();
    sheetBarcode = barcode;
    sheetEditBatchId = null;
    if (productDoc.exists) {
      sheetMode = "existing";
      openDateSheet({ title: "ثبت تاریخ جدید", productName: productDoc.data().name, mode: "readonly" });
    } else {
      sheetMode = "new";
      openDateSheet({ title: "ثبت محصول و تاریخ", productName: "", mode: "input" });
    }
  } catch (e) {
    toast("خطا در بررسی بارکد");
  }
}

/* ============ Date sheet (add/edit batch) ============ */
function resetDateSheetFields() {
  $("sheet-name-field").classList.add("hidden");
  $("sheet-name-readonly-field").classList.add("hidden");
  $("sheet-product-select-field").classList.add("hidden");
  $("sheet-delete-btn").classList.add("hidden");
  $("sheet-error").textContent = "";
  setExpiryDateValue(null);
}

function openDateSheet({ title, productName, mode }) {
  resetDateSheetFields();
  $("sheet-title").textContent = title;
  if (mode === "input") {
    $("sheet-name-field").classList.remove("hidden");
    $("sheet-product-name").value = productName || "";
  } else if (mode === "readonly") {
    $("sheet-name-readonly-field").classList.remove("hidden");
    $("sheet-product-name-display").textContent = productName;
  }
  $("sheet-backdrop").classList.remove("hidden");
}

function openManualDateSheet() {
  resetDateSheetFields();
  sheetMode = "manual";
  sheetBarcode = null;
  sheetEditBatchId = null;
  $("sheet-title").textContent = "ثبت تاریخ جدید";
  $("sheet-product-select-field").classList.remove("hidden");

  const select = $("sheet-product-select");
  const entries = Object.entries(productsCache);
  if (entries.length === 0) {
    select.innerHTML = `<option value="">ابتدا یک محصول ثبت کنید</option>`;
  } else {
    select.innerHTML = entries
      .sort((a, b) => a[1].name.localeCompare(b[1].name, "fa"))
      .map(([barcode, p]) => `<option value="${escapeHtml(barcode)}">${escapeHtml(p.name)}</option>`)
      .join("");
  }
  $("sheet-backdrop").classList.remove("hidden");
}
$("fab-add-date").addEventListener("click", openManualDateSheet);

function openEditDateSheet(batchId, productName, expiryDate) {
  resetDateSheetFields();
  sheetMode = "edit";
  sheetEditBatchId = batchId;
  $("sheet-title").textContent = "ویرایش تاریخ انقضا";
  $("sheet-name-readonly-field").classList.remove("hidden");
  $("sheet-product-name-display").textContent = productName;
  setExpiryDateValue(expiryDate);
  $("sheet-delete-btn").classList.remove("hidden");
  $("sheet-backdrop").classList.remove("hidden");
}

function closeDateSheet() {
  $("sheet-backdrop").classList.add("hidden");
  sheetMode = null; sheetBarcode = null; sheetEditBatchId = null;
}
$("sheet-cancel-btn").addEventListener("click", closeDateSheet);

$("sheet-save-btn").addEventListener("click", async () => {
  const expiryDate = getExpiryDateValue();
  $("sheet-error").textContent = "";
  if (!expiryDate) {
    $("sheet-error").textContent = "تاریخ انقضا رو کامل انتخاب کنید.";
    return;
  }

  try {
    if (sheetMode === "new") {
      const name = $("sheet-product-name").value.trim();
      if (!name) { $("sheet-error").textContent = "نام محصول رو وارد کنید."; return; }
      await db.collection("products").doc(sheetBarcode).set({
        name, createdAt: firebase.firestore.FieldValue.serverTimestamp(), createdBy: currentUser.uid
      });
      await db.collection("batches").add({
        barcode: sheetBarcode, productName: name, expiryDate,
        addedAt: firebase.firestore.FieldValue.serverTimestamp(),
        addedBy: currentUser.uid, addedByName: currentName
      });
      toast("محصول و تاریخ جدید ثبت شد ✅");
    } else if (sheetMode === "existing") {
      const productDoc = await db.collection("products").doc(sheetBarcode).get();
      await db.collection("batches").add({
        barcode: sheetBarcode, productName: productDoc.data().name, expiryDate,
        addedAt: firebase.firestore.FieldValue.serverTimestamp(),
        addedBy: currentUser.uid, addedByName: currentName
      });
      toast("تاریخ جدید ثبت شد ✅");
    } else if (sheetMode === "manual") {
      const barcode = $("sheet-product-select").value;
      if (!barcode) { $("sheet-error").textContent = "یک محصول انتخاب کنید."; return; }
      const p = productsCache[barcode];
      await db.collection("batches").add({
        barcode, productName: p.name, expiryDate,
        addedAt: firebase.firestore.FieldValue.serverTimestamp(),
        addedBy: currentUser.uid, addedByName: currentName
      });
      toast("تاریخ جدید ثبت شد ✅");
    } else if (sheetMode === "edit") {
      await db.collection("batches").doc(sheetEditBatchId).update({ expiryDate });
      toast("تغییرات ذخیره شد ✅");
    }
    closeDateSheet();
  } catch (e) {
    $("sheet-error").textContent = "خطا در ذخیره‌سازی. دوباره امتحان کنید.";
    console.error(e);
  }
});

$("sheet-delete-btn").addEventListener("click", async () => {
  if (!sheetEditBatchId) return;
  if (!confirm("این رکورد حذف بشه؟")) return;
  try {
    await db.collection("batches").doc(sheetEditBatchId).delete();
    toast("رکورد حذف شد");
    closeDateSheet();
  } catch (e) {
    toast("خطا در حذف رکورد");
  }
});

/* ============ Product sheet (add/edit master product) ============ */
function openAddProductSheet() {
  productSheetMode = "add";
  productSheetOriginalBarcode = null;
  $("product-sheet-title").textContent = "ثبت محصول جدید";
  $("product-sheet-name").value = "";
  $("product-sheet-barcode").value = "";
  $("product-sheet-barcode").disabled = false;
  $("product-sheet-error").textContent = "";
  $("product-sheet-delete-btn").classList.add("hidden");
  $("product-sheet-backdrop").classList.remove("hidden");
}
$("fab-add-product").addEventListener("click", openAddProductSheet);

function openEditProductSheet(barcode, name) {
  productSheetMode = "edit";
  productSheetOriginalBarcode = barcode;
  $("product-sheet-title").textContent = "ویرایش محصول";
  $("product-sheet-name").value = name;
  $("product-sheet-barcode").value = barcode;
  $("product-sheet-barcode").disabled = true; // barcode is the document id, can't change in place
  $("product-sheet-error").textContent = "";
  $("product-sheet-delete-btn").classList.remove("hidden");
  $("product-sheet-backdrop").classList.remove("hidden");
}

function closeProductSheet() {
  $("product-sheet-backdrop").classList.add("hidden");
  productSheetMode = null; productSheetOriginalBarcode = null;
}
$("product-sheet-cancel-btn").addEventListener("click", closeProductSheet);

$("product-sheet-save-btn").addEventListener("click", async () => {
  const name = $("product-sheet-name").value.trim();
  $("product-sheet-error").textContent = "";
  if (!name) { $("product-sheet-error").textContent = "نام محصول رو وارد کنید."; return; }

  try {
    if (productSheetMode === "add") {
      let barcode = $("product-sheet-barcode").value.trim();
      if (!barcode) barcode = "manual-" + Date.now();
      const existing = await db.collection("products").doc(barcode).get();
      if (existing.exists) {
        $("product-sheet-error").textContent = "محصولی با این بارکد از قبل ثبت شده.";
        return;
      }
      await db.collection("products").doc(barcode).set({
        name, createdAt: firebase.firestore.FieldValue.serverTimestamp(), createdBy: currentUser.uid
      });
      toast("محصول جدید ثبت شد ✅");
    } else if (productSheetMode === "edit") {
      await db.collection("products").doc(productSheetOriginalBarcode).update({ name });
      toast("تغییرات ذخیره شد ✅");
    }
    closeProductSheet();
  } catch (e) {
    $("product-sheet-error").textContent = "خطا در ذخیره‌سازی. دوباره امتحان کنید.";
    console.error(e);
  }
});

$("product-sheet-delete-btn").addEventListener("click", async () => {
  if (!productSheetOriginalBarcode) return;
  if (!confirm("این محصول حذف بشه؟ تاریخ‌های قبلی ثبت‌شده برای این محصول در تب «تاریخ‌ها» باقی می‌مونن.")) return;
  try {
    await db.collection("products").doc(productSheetOriginalBarcode).delete();
    toast("محصول حذف شد");
    closeProductSheet();
  } catch (e) {
    toast("خطا در حذف محصول");
  }
});

/* ============ Admin: staff management ============ */
$("staff-add-btn").addEventListener("click", async () => {
  const name = $("staff-name").value.trim();
  const email = $("staff-email").value.trim();
  const password = $("staff-password").value;
  $("staff-error").textContent = "";

  if (!name || !email || !password) {
    $("staff-error").textContent = "همه فیلدها رو پر کنید.";
    return;
  }
  if (password.length < 6) {
    $("staff-error").textContent = "رمز عبور باید حداقل ۶ کاراکتر باشه.";
    return;
  }

  try {
    // secondary app instance so creating the employee doesn't log the admin out
    const secondaryApp = firebase.initializeApp(firebaseConfig, "secondary-" + Date.now());
    const secondaryAuth = secondaryApp.auth();
    const cred = await secondaryAuth.createUserWithEmailAndPassword(email, password);
    const newUid = cred.user.uid;

    await db.collection("users").doc(newUid).set({
      name, email, role: "staff",
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      createdBy: currentUser.uid
    });

    await secondaryAuth.signOut();
    await secondaryApp.delete();

    $("staff-name").value = ""; $("staff-email").value = ""; $("staff-password").value = "";
    toast("کارمند جدید اضافه شد ✅");
    loadStaffList();
  } catch (e) {
    $("staff-error").textContent = e.code === "auth/email-already-in-use"
      ? "این ایمیل قبلاً ثبت شده."
      : "خطا در ایجاد حساب کارمند.";
    console.error(e);
  }
});

async function loadStaffList() {
  try {
    const snap = await db.collection("users").where("role", "==", "staff").get();
    const list = $("staff-list");
    if (snap.empty) {
      list.innerHTML = `<div class="empty-state">هنوز کارمندی اضافه نشده.</div>`;
      return;
    }
    let html = "";
    snap.forEach((doc) => {
      const u = doc.data();
      html += `<div class="list-row"><div><div class="name">${escapeHtml(u.name)}</div><div class="meta">${escapeHtml(u.email)}</div></div></div>`;
    });
    list.innerHTML = html;
  } catch (e) {
    console.error(e);
  }
}
