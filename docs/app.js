/***********************
 * HELPERS
 ***********************/
const el = (id) => document.getElementById(id);
const £ = (n) => `£${(Math.round((n + Number.EPSILON) * 100) / 100).toFixed(2)}`;

function setStatus(msg) {
  const s = el("statusText");
  if (s) s.textContent = msg;
}

function showModal(id) { el(id).style.display = "flex"; }
function hideModal(id) { el(id).style.display = "none"; }

/***********************
 * STATE
 ***********************/
let items = [];
let cart = new Map();
let db = null; // will set after Firebase init

/***********************
 * NAV
 ***********************/
function setView(view) {
  document.querySelectorAll(".navbtn").forEach(b => {
    b.classList.toggle("active", b.dataset.view === view);
  });
  ["cashier","cook","history","completion"].forEach(v => {
    el(`view-${v}`).classList.toggle("hidden", v !== view);
  });
}

function initNav() {
  document.querySelectorAll(".navbtn").forEach(b => {
    b.onclick = () => setView(b.dataset.view);
  });
}

/***********************
 * CART UI
 ***********************/
function cartTotal() {
  let total = 0;
  for (const { item, qty } of cart.values()) total += item.price * qty;
  return total;
}

function renderCart() {
  const list = el("cartList");
  list.innerHTML = "";

  for (const [itemId, entry] of cart.entries()) {
    const { item, qty } = entry;

    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <div class="row">
        <div>
          <div style="font-weight:900">${item.name}</div>
          <div class="tiny">${£(item.price)} each</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;">
          <button class="ghost" style="padding:8px 10px;">−</button>
          <strong style="min-width:28px;text-align:center;">${qty}</strong>
          <button class="ghost" style="padding:8px 10px;">+</button>
        </div>
      </div>
      <div class="row" style="margin-top:8px;">
        <span class="tiny">Line total</span>
        <strong>${£(item.price * qty)}</strong>
      </div>
    `;

    const [minusBtn, plusBtn] = card.querySelectorAll("button");
    minusBtn.onclick = () => {
      const e = cart.get(itemId);
      if (!e) return;
      e.qty -= 1;
      if (e.qty <= 0) cart.delete(itemId);
      renderCart();
    };
    plusBtn.onclick = () => {
      const e = cart.get(itemId);
      if (!e) return;
      e.qty += 1;
      renderCart();
    };

    list.appendChild(card);
  }

  el("cartTotal").textContent = £(cartTotal());
}

/***********************
 * MENU ITEMS UI
 ***********************/
function addToCart(itemId) {
  const it = items.find(x => x.id === itemId);
  if (!it) return;
  const existing = cart.get(itemId);
  if (existing) existing.qty += 1;
  else cart.set(itemId, { item: it, qty: 1 });
  renderCart();
}

function renderItemsGrid() {
  const grid = el("itemsGrid");
  grid.innerHTML = "";
  for (const it of items) {
    const btn = document.createElement("button");
    btn.className = "card";
    btn.innerHTML = `
      <div style="font-weight:900;font-size:18px;">${it.name}</div>
      <div style="opacity:.8;margin-top:6px;">${£(it.price)}</div>
    `;
    btn.onclick = () => addToCart(it.id);
    grid.appendChild(btn);
  }
}

function renderItemsAdminList() {
  const list = el("itemsAdminList");
  list.innerHTML = "";
  for (const it of items) {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <div class="row">
        <div>
          <div style="font-weight:900">${it.name} <span style="opacity:.7">(${£(it.price)})</span></div>
          <div class="tiny">${it.notes || ""}</div>
        </div>
        <button class="ghost">Delete</button>
      </div>
    `;
    card.querySelector("button").onclick = async () => {
      if (!db) return alert("Firebase not ready.");
      if (!confirm(`Delete "${it.name}"?`)) return;
      await db.collection("items").doc(it.id).delete();
    };
    list.appendChild(card);
  }
}

/***********************
 * ITEMS + PAY MODALS
 ***********************/
async function addItemFromModal() {
  if (!db) return alert("Firebase not ready.");
  const name = el("newItemName").value.trim();
  const price = Number(el("newItemPrice").value);
  const notes = el("newItemNotes").value.trim();
  if (!name || !Number.isFinite(price)) return;

  await db.collection("items").add({ name, price, notes, createdAt: Date.now() });

  el("newItemName").value = "";
  el("newItemPrice").value = "";
  el("newItemNotes").value = "";
}

function openPay() {
  if (cart.size === 0) return;
  el("payErr").textContent = "";
  el("givenInput").value = "";
  el("dueAmt").textContent = £(cartTotal());
  el("changeAmt").textContent = £(0);
  showModal("payModal");
}

function calcChange() {
  const due = cartTotal();
  const given = Number(el("givenInput").value);
  const change = Number.isFinite(given) ? (given - due) : 0;
  el("changeAmt").textContent = £(Math.max(0, change));
}

async function completePayment() {
  if (!db) return alert("Firebase not ready.");
  el("payErr").textContent = "";
  const due = cartTotal();
  const given = Number(el("givenInput").value);
  if (!Number.isFinite(given) || given < due) {
    el("payErr").textContent = "Amount given must be at least the amount due.";
    return;
  }

  const lines = [];
  for (const { item, qty } of cart.values()) {
    lines.push({ itemId: item.id, name: item.name, price: item.price, qty, notes: item.notes || "" });
  }

  try {
    await db.runTransaction(async (tx) => {
      const counterRef = db.collection("meta").doc("counters");
      const counterSnap = await tx.get(counterRef);
      const next = (counterSnap.exists && counterSnap.data().nextOrderNumber)
        ? counterSnap.data().nextOrderNumber
        : 1;

      tx.set(counterRef, { nextOrderNumber: next + 1 }, { merge: true });

      const orderRef = db.collection("orders").doc();
      tx.set(orderRef, {
        number: next,
        status: "COOKING",
        lines,
        total: due,
        paid: given,
        change: given - due,
        createdAt: Date.now(),
        paidAt: Date.now(),
        readyAt: null,
        pickedUpAt: null,
      });
    });

    cart.clear();
    renderCart();
    hideModal("payModal");
    alert("Order sent to kitchen ✅");
  } catch (e) {
    console.error(e);
    el("payErr").textContent = "Could not complete order. Check connection.";
  }
}

/***********************
 * REALTIME SUBS (only after Firebase ready)
 ***********************/
function subscribeItems() {
  db.collection("items").orderBy("createdAt", "asc").onSnapshot((snap) => {
    items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderItemsGrid();
    renderItemsAdminList();
  });
}

/* The rest (cook/ready/history) can be added back after this works.
   For now, we prove buttons + items are working first. */

/***********************
 * INIT UI (always)
 ***********************/
function initUI() {
  initNav();
  setView("cashier");
  renderCart();

  el("clearCartBtn").onclick = () => { cart.clear(); renderCart(); };
  el("payBtn").onclick = openPay;
  el("cancelPayBtn").onclick = () => hideModal("payModal");
  el("completePayBtn").onclick = completePayment;
  el("givenInput").oninput = calcChange;

  el("editItemsBtn").onclick = () => showModal("itemsModal");
  el("closeItemsBtn").onclick = () => hideModal("itemsModal");
  el("addItemBtn").onclick = addItemFromModal;

  el("itemsModal").onclick = (e) => { if (e.target === el("itemsModal")) hideModal("itemsModal"); };
  el("payModal").onclick = (e) => { if (e.target === el("payModal")) hideModal("payModal"); };

  setStatus("JS loaded ✅ (UI wired)");
}

/***********************
 * INIT FIREBASE (may fail; UI still works)
 ***********************/
function initFirebase() {
  try {
    if (!window.firebase) {
      setStatus("UI OK ✅ | Firebase FAILED ❌ (CDN not loaded)");
      return;
    }

    const firebaseConfig = {
      apiKey: "AIzaSyARBfapCjXLkhlmuTKT9lJRbLLAc6u0jU0",
      authDomain: "enterprise-d157a.firebaseapp.com",
      projectId: "enterprise-d157a",
      storageBucket: "enterprise-d157a.firebasestorage.app",
      messagingSenderId: "776029370493",
      appId: "1:776029370493:web:7117b4338120ac89719914",
      measurementId: "G-3FBXQ78259"
    };

    firebase.initializeApp(firebaseConfig);
    db = firebase.firestore();

    setStatus("UI OK ✅ | Firebase OK ✅");
    subscribeItems();
  } catch (e) {
    console.error(e);
    setStatus("UI OK ✅ | Firebase crashed ❌ (check console)");
  }
}

window.addEventListener("DOMContentLoaded", () => {
  initUI();
  initFirebase();
});