/* ============ Firebase init ============ */
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

/* ============ State ============ */
let currentUser = null;   // {uid, email}
let currentRole = null;   // 'admin' | 'staff'
let currentName = "";
let unsubscribeBatches = null;
let html5QrCode = null;
let sheetMode = null;     // 'new' | 'existing' | 'edit'
let sheetBarcode = null;
let sheetEditBatchId = null;

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
    $("nav-staff-btn").classList.remove("hidden");
    loadStaffList();
  }
  listenBatches();
}

/* ============ Bottom nav ============ */
document.querySelectorAll(".nav-btn[data-screen]").forEach((btn) => {
  btn.addEventListener("click", () => switchScreen(btn.dataset.screen));
});
function switchScreen(name) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.add("hidden"));
  $("screen-" + name).classList.remove("hidden");
  document.querySelectorAll(".nav-btn[data-screen]").forEach((b) => b.classList.remove("active"));
  const activeBtn = document.querySelector(`.nav-btn[data-screen="${name}"]`);
  if (activeBtn) activeBtn.classList.add("active");
  const titles = { list: "محصولات", staff: "کارمندان", settings: "تنظیمات" };
  $("page-title").textContent = titles[name] || "";
}

/* ============ Realtime batch list ============ */
function listenBatches() {
  if (unsubscribeBatches) unsubscribeBatches();
  unsubscribeBatches = db.collection("batches")
    .orderBy("expiryDate", "asc")
    .onSnapshot((snap) => {
      const list = $("batch-list");
      if (snap.empty) {
        list.innerHTML = `<div class="empty-state"><span class="emoji">📭</span>هنوز محصولی ثبت نشده.<br>از دکمه «اسکن» شروع کنید.</div>`;
        return;
      }
      let html = "";
      snap.forEach((doc) => {
        const b = doc.data();
        const { daysLeft, status } = statusFor(b.expiryDate);
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
      list.querySelectorAll(".batch-card").forEach((card) => {
        card.addEventListener("click", () => openEditSheet(card.dataset.id, card.dataset.name, card.dataset.date));
      });
    }, (err) => {
      toast("خطا در دریافت لیست محصولات");
      console.error(err);
    });
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]));
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
      openSheet({ title: "ثبت تاریخ جدید", productName: productDoc.data().name, readonly: true });
    } else {
      sheetMode = "new";
      openSheet({ title: "ثبت محصول جدید", productName: "", readonly: false });
    }
  } catch (e) {
    toast("خطا در بررسی بارکد");
  }
}

/* ============ Add/Edit sheet ============ */
function openSheet({ title, productName, readonly }) {
  $("sheet-title").textContent = title;
  $("sheet-error").textContent = "";
  $("sheet-expiry-date").value = "";
  $("sheet-delete-btn").classList.add("hidden");

  if (readonly) {
    $("sheet-name-field").classList.add("hidden");
    $("sheet-name-readonly-field").classList.remove("hidden");
    $("sheet-product-name-display").textContent = productName;
  } else {
    $("sheet-name-field").classList.remove("hidden");
    $("sheet-name-readonly-field").classList.add("hidden");
    $("sheet-product-name").value = productName || "";
  }
  $("sheet-backdrop").classList.remove("hidden");
}
function closeSheet() {
  $("sheet-backdrop").classList.add("hidden");
  sheetMode = null; sheetBarcode = null; sheetEditBatchId = null;
}
$("sheet-cancel-btn").addEventListener("click", closeSheet);

function openEditSheet(batchId, productName, expiryDate) {
  sheetMode = "edit";
  sheetEditBatchId = batchId;
  $("sheet-title").textContent = "ویرایش تاریخ انقضا";
  $("sheet-error").textContent = "";
  $("sheet-name-field").classList.add("hidden");
  $("sheet-name-readonly-field").classList.remove("hidden");
  $("sheet-product-name-display").textContent = productName;
  $("sheet-expiry-date").value = expiryDate;
  $("sheet-delete-btn").classList.remove("hidden");
  $("sheet-backdrop").classList.remove("hidden");
}

$("sheet-save-btn").addEventListener("click", async () => {
  const expiryDate = $("sheet-expiry-date").value;
  $("sheet-error").textContent = "";
  if (!expiryDate) {
    $("sheet-error").textContent = "تاریخ انقضا رو انتخاب کنید.";
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
      toast("محصول جدید ثبت شد ✅");
    } else if (sheetMode === "existing") {
      const productDoc = await db.collection("products").doc(sheetBarcode).get();
      await db.collection("batches").add({
        barcode: sheetBarcode, productName: productDoc.data().name, expiryDate,
        addedAt: firebase.firestore.FieldValue.serverTimestamp(),
        addedBy: currentUser.uid, addedByName: currentName
      });
      toast("تاریخ جدید ثبت شد ✅");
    } else if (sheetMode === "edit") {
      await db.collection("batches").doc(sheetEditBatchId).update({ expiryDate });
      toast("تغییرات ذخیره شد ✅");
    }
    closeSheet();
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
    closeSheet();
  } catch (e) {
    toast("خطا در حذف رکورد");
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
