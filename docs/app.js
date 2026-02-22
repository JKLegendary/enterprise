/***********************
 * CONFIG
 ***********************/
const STALL_PIN = "1234"; // Basic gate only. Not secure.

const firebaseConfig = {
  // TODO: paste your Firebase web config here
  // apiKey: "...",
  // authDomain: "...",
  // projectId: "...",
};

firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();

/***********************
 * STATE
 ***********************/
let currentView = "cashier";
let items = [];              // menu items
let cart = new Map();        // itemId -> {item, qty, notesOverride?}
let unsubscribeFns = [];

/***********************
 * UTIL
 ***********************/
const £ = (n) => `£${(Math.round((n + Number.EPSILON) * 100) / 100).toFixed(2)}`;
const el = (id) => document.getElementById(id);

function clearUnsubs() {
  unsubscribeFns.forEach((fn) => { try { fn(); } catch {} });
  unsubscribeFns = [];
}

function setView(view) {
  currentView = view;
  document.querySelectorAll(".navbtn").forEach(b => {
    b.classList.toggle("active", b.dataset.view === view);
  });
  ["cashier","cook","completion","history"].forEach(v => {
    el(`view-${v}`).classList.toggle("hidden", v !== view);
  });
}

/***********************
 * PASSCODE GATE
 ***********************/
function initGate() {
  const gate = el("gate");
  const unlocked = sessionStorage.getItem("unlocked") === "1";
  if (unlocked) gate.style.display = "none";

  el("pinBtn").onclick = () => {
    const pin = el("pinInput").value.trim();
    if (pin === STALL_PIN) {
      sessionStorage.setItem("unlocked", "1");
      gate.style.display = "none";
      el("pinErr").textContent = "";
    } else {
      el("pinErr").textContent = "Incorrect passcode.";
    }
  };
}

/***********************
 * ITEMS (menu)
 ***********************/
function subscribeItems() {
  const unsub = db.collection("items").orderBy("createdAt", "asc")
    .onSnapshot((snap) => {
      items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      renderItemsGrid();
      renderItemsAdminList();
    });
  unsubscribeFns.push(unsub);
}

function renderItemsGrid() {
  const grid = el("itemsGrid");
  grid.innerHTML = "";
  for (const it of items) {
    const btn = document.createElement("button");
    btn.className = "card";
    btn.innerHTML = `<div style="font-weight:900;font-size:18px;">${it.name}</div>
                     <div style="opacity:.8;margin-top:6px;">${£(it.price)}</div>`;
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
      if (!confirm(`Delete "${it.name}"?`)) return;
      await db.collection("items").doc(it.id).delete();
    };
    list.appendChild(card);
  }
}

async function addItemFromModal() {
  const name = el("newItemName").value.trim();
  const price = Number(el("newItemPrice").value);
  const notes = el("newItemNotes").value.trim();
  if (!name || !Number.isFinite(price)) return;

  await db.collection("items").add({
    name,
    price,
    notes,
    createdAt: Date.now(),
  });

  el("newItemName").value = "";
  el("newItemPrice").value = "";
  el("newItemNotes").value = "";
}

/***********************
 * CART + CASHIER FLOW
 ***********************/
function addToCart(itemId) {
  const it = items.find(x => x.id === itemId);
  if (!it) return;
  const existing = cart.get(itemId);
  if (existing) existing.qty += 1;
  else cart.set(itemId, { item: it, qty: 1 });
  renderCart();
}

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

function openPay() {
  if (cart.size === 0) return;
  el("payErr").textContent = "";
  el("givenInput").value = "";
  el("dueAmt").textContent = £(cartTotal());
  el("changeAmt").textContent = £(0);
  el("payModal").classList.remove("hidden");
}

function closePay() {
  el("payModal").classList.add("hidden");
}

function calcChange() {
  const due = cartTotal();
  const given = Number(el("givenInput").value);
  const change = Number.isFinite(given) ? (given - due) : 0;
  el("changeAmt").textContent = £(Math.max(0, change));
}

async function completePayment() {
  el("payErr").textContent = "";
  const due = cartTotal();
  const given = Number(el("givenInput").value);
  if (!Number.isFinite(given) || given < due) {
    el("payErr").textContent = "Amount given must be at least the amount due.";
    return;
  }

  // Build order lines
  const lines = [];
  for (const { item, qty } of cart.values()) {
    lines.push({ itemId: item.id, name: item.name, price: item.price, qty, notes: item.notes || "" });
  }

  // Atomic order number + create order
  try {
    await db.runTransaction(async (tx) => {
      const counterRef = db.collection("meta").doc("counters");
      const counterSnap = await tx.get(counterRef);
      const next = (counterSnap.exists && counterSnap.data().nextOrderNumber) ? counterSnap.data().nextOrderNumber : 1;

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
    closePay();
    alert("Order sent to kitchen ✅");
  } catch (e) {
    console.error(e);
    el("payErr").textContent = "Could not complete order. Check connection.";
  }
}

/***********************
 * COOK VIEW
 ***********************/
function subscribeCookingOrders() {
  const unsub = db.collection("orders")
    .where("status", "==", "COOKING")
    .orderBy("paidAt", "desc")
    .onSnapshot((snap) => {
      const orders = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      renderCookOrders(orders);
    });
  unsubscribeFns.push(unsub);
}

function renderCookOrders(orders) {
  const list = el("cookOrders");
  list.innerHTML = "";
  for (const o of orders) {
    const card = document.createElement("div");
    card.className = "card";

    const linesHtml = o.lines.map(l => `<div class="row"><span>${l.qty}× ${l.name}</span><span>${£(l.price*l.qty)}</span></div>`).join("");

    card.innerHTML = `
      <div class="row">
        <div style="font-weight:900;font-size:18px;">Order #${o.number}</div>
        <button class="primary" style="width:auto;padding:10px 12px;">✅</button>
      </div>
      <div class="tiny" style="margin-top:6px;opacity:.85">Tap to expand</div>
      <div class="details hidden" style="margin-top:10px;display:flex;flex-direction:column;gap:8px;">
        ${linesHtml}
        <div class="row" style="margin-top:6px;"><strong>Total</strong><strong>${£(o.total)}</strong></div>
      </div>
    `;

    const details = card.querySelector(".details");
    card.onclick = (ev) => {
      // avoid toggle when pressing the ✅ button
      if (ev.target.tagName === "BUTTON") return;
      details.classList.toggle("hidden");
    };

    card.querySelector("button").onclick = async () => {
      if (!confirm(`Mark Order #${o.number} as READY?`)) return;
      await db.collection("orders").doc(o.id).set({
        status: "READY",
        readyAt: Date.now(),
      }, { merge: true });
    };

    list.appendChild(card);
  }
}

/***********************
 * READY / COMPLETION VIEW
 ***********************/
function subscribeReadyOrders() {
  const unsub = db.collection("orders")
    .where("status", "==", "READY")
    .orderBy("readyAt", "desc")
    .onSnapshot((snap) => {
      const orders = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      renderReadyOrders(orders);
      renderSoundboard(orders);
      renderCashierReady(orders);
    });
  unsubscribeFns.push(unsub);
}

function renderCashierReady(orders) {
  const list = el("cashierReadyList");
  list.innerHTML = "";
  for (const o of orders) {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `<div class="row"><strong>Order #${o.number}</strong><span class="tiny">READY</span></div>`;
    list.appendChild(card);
  }
}

function renderReadyOrders(orders) {
  const list = el("readyOrders");
  list.innerHTML = "";
  for (const o of orders) {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <div class="row">
        <div>
          <div style="font-weight:900;font-size:18px;">Order #${o.number}</div>
          <div class="tiny">${o.lines.length} line(s)</div>
        </div>
        <button class="ghost" style="width:auto;">Taken</button>
      </div>
    `;
    card.querySelector("button").onclick = async () => {
      if (!confirm(`Customer collected Order #${o.number}?`)) return;
      await db.collection("orders").doc(o.id).set({
        status: "PICKED_UP",
        pickedUpAt: Date.now(),
      }, { merge: true });
    };
    list.appendChild(card);
  }
}

function speak(text) {
  if (!("speechSynthesis" in window)) {
    alert("Speech not supported on this device/browser.");
    return;
  }
  const u = new SpeechSynthesisUtterance(text);
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(u);
}

function renderSoundboard(orders) {
  const board = el("soundboard");
  board.innerHTML = "";
  for (const o of orders) {
    const btn = document.createElement("button");
    btn.className = "card";
    btn.innerHTML = `<div style="font-weight:900;font-size:22px;">#${o.number}</div><div class="tiny">Tap to announce</div>`;
    btn.onclick = () => speak(`Order ${o.number} is ready`);
    board.appendChild(btn);
  }
}

/***********************
 * HISTORY VIEW
 ***********************/
function subscribeHistory() {
  const unsub = db.collection("orders")
    .orderBy("createdAt", "desc")
    .limit(200)
    .onSnapshot((snap) => {
      const orders = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      renderHistory(orders);
    });
  unsubscribeFns.push(unsub);
}

function renderHistory(orders) {
  const list = el("historyList");
  list.innerHTML = "";
  for (const o of orders) {
    const card = document.createElement("div");
    card.className = "card";

    const linesHtml = o.lines.map(l => `<div class="row"><span>${l.qty}× ${l.name}</span><span>${£(l.price*l.qty)}</span></div>`).join("");

    card.innerHTML = `
      <div class="row">
        <div>
          <div style="font-weight:900">Order #${o.number} <span class="tiny">(${o.status})</span></div>
          <div class="tiny">Total ${£(o.total)} • Paid ${£(o.paid)} • Change ${£(o.change)}</div>
        </div>
        <button class="ghost" style="width:auto;">Details</button>
      </div>
      <div class="details hidden" style="margin-top:10px;display:flex;flex-direction:column;gap:8px;">
        ${linesHtml}
      </div>
    `;

    const details = card.querySelector(".details");
    card.querySelector("button").onclick = () => details.classList.toggle("hidden");
    list.appendChild(card);
  }
}

/***********************
 * INIT + EVENTS
 ***********************/
function initNav() {
  document.querySelectorAll(".navbtn").forEach(b => {
    b.onclick = () => setView(b.dataset.view);
  });
}

function initCashierUi() {
  el("clearCartBtn").onclick = () => { cart.clear(); renderCart(); };
  el("payBtn").onclick = openPay;
  el("cancelPayBtn").onclick = closePay;
  el("completePayBtn").onclick = completePayment;
  el("givenInput").oninput = calcChange;

  el("editItemsBtn").onclick = () => el("itemsModal").classList.remove("hidden");
  el("closeItemsBtn").onclick = () => el("itemsModal").classList.add("hidden");
  el("addItemBtn").onclick = addItemFromModal;
}

function boot() {
  initGate();
  initNav();
  initCashierUi();
  setView("cashier");
  renderCart();

  // Live subscriptions
  subscribeItems();
  subscribeReadyOrders();     // used by Cashier + Completion
  subscribeCookingOrders();
  subscribeHistory();
}

boot();
