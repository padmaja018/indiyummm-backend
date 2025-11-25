// server.js - drop-in fixed CommonJS version
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Razorpay = require("razorpay");

const app = express();
app.use(cors());
app.use(express.json());

const DB_FILE = path.join(__dirname, "db.json");

// Safe DB helpers
function readDB() {
  try {
    if (!fs.existsSync(DB_FILE)) return { reviews: [], orders: [] };
    const txt = fs.readFileSync(DB_FILE, "utf8");
    return txt ? JSON.parse(txt) : { reviews: [], orders: [] };
  } catch (e) {
    console.error("readDB error", e);
    return { reviews: [], orders: [] };
  }
}
function writeDB(obj) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(obj, null, 2), "utf8");
  } catch (e) {
    console.error("writeDB error", e);
  }
}

// Env keys
const RZP_KEY_ID = process.env.RAZORPAY_KEY_ID || "";
const RZP_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || "";

// Create Razorpay instance only if keys present
let razorpay = null;
if (RZP_KEY_ID && RZP_KEY_SECRET) {
  try {
    razorpay = new Razorpay({ key_id: RZP_KEY_ID, key_secret: RZP_KEY_SECRET });
  } catch (e) {
    console.error("razorpay init error", e);
  }
} else {
  console.warn("Razorpay keys are not set (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET).");
}

// ---------- Reviews (existing) ----------
app.get("/reviews", (req, res) => {
  const db = readDB();
  const grouped = {};
  (db.reviews || []).forEach((review) => {
    const product = review.productName;
    if (!grouped[product]) grouped[product] = [];
    grouped[product].push(review);
  });
  res.json(grouped);
});

app.post("/reviews", (req, res) => {
  const db = readDB();
  const { productName, name, rating, text } = req.body;
  if (!productName || !name || !rating || !text) {
    return res.status(400).json({ error: "Missing review fields" });
  }
  const newReview = { id: Date.now(), productName, name, rating, text };
  db.reviews = db.reviews || [];
  db.reviews.push(newReview);
  writeDB(db);
  res.json(newReview);
});

// ---------- Create order ----------
app.post("/create-order", async (req, res) => {
  try {
    const { amount, currency = "INR", receipt, cart, customer } = req.body || {};
    if (!amount) return res.status(400).json({ error: "Missing amount" });

    if (!razorpay) {
      console.error("create-order: razorpay not configured");
      return res.status(500).json({ error: "Razorpay not configured" });
    }

    const amountPaise = Math.round(Number(amount) * 100);
    const options = { amount: amountPaise, currency, receipt: String(receipt || `rcpt_${Date.now()}`), payment_capture: 1 };

    const order = await razorpay.orders.create(options);

    const db = readDB();
    db.orders = db.orders || [];
    db.orders.push({
      id: Date.now(),
      receipt: order.receipt || options.receipt,
      razorpay_order_id: order.id,
      amount,
      amount_paise: order.amount,
      currency: order.currency,
      cart: cart || null,
      customer: customer || null,
      status: "created",
      created_at: Date.now(),
    });
    writeDB(db);

    return res.json({
      success: true,
      order_id: order.id,
      amount: order.amount,
      currency: order.currency,
      receipt: order.receipt || options.receipt,
      key_id: RZP_KEY_ID,
    });
  } catch (err) {
    console.error("create-order error:", err);
    return res.status(500).json({ error: "Failed to create order", detail: String(err) });
  }
});

// ---------- Verify payment (with clear debug logs) ----------
app.post("/verify-payment", (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, receipt } = req.body || {};

    console.log("==== /verify-payment called ====");
    console.log("Received payload:", { razorpay_order_id, razorpay_payment_id, razorpay_signature, receipt });

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      console.warn("verify-payment: missing fields");
      return res.status(400).json({ verified: false, reason: "missing_fields" });
    }

    if (!RZP_KEY_SECRET) {
      console.error("verify-payment: RAZORPAY_KEY_SECRET missing in env");
      return res.status(500).json({ verified: false, reason: "server_secret_missing" });
    }

    const generated = crypto.createHmac("sha256", RZP_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    console.log("Generated signature:", generated);
    console.log("Received signature :", razorpay_signature);

    const verified = generated === razorpay_signature;

    // update DB
    const db = readDB();
    db.orders = db.orders || [];
    const idx = db.orders.findIndex(o => o.razorpay_order_id === razorpay_order_id || String(o.receipt) === String(receipt));
    if (idx !== -1 && verified) {
      db.orders[idx].status = "paid";
      db.orders[idx].razorpay_payment_id = razorpay_payment_id;
      db.orders[idx].razorpay_signature = razorpay_signature;
      db.orders[idx].paid_at = Date.now();
      writeDB(db);
      console.log("verify-payment: signature ok, order marked paid:", razorpay_order_id);
    } else if (idx !== -1 && !verified) {
      db.orders[idx].status = "payment_failed";
      writeDB(db);
      console.warn("verify-payment: signature mismatch for order index", idx);
    } else if (idx === -1) {
      console.warn("verify-payment: order not found in DB for", razorpay_order_id, receipt);
    }

    return res.json({ verified, order_index: idx, order: idx !== -1 ? db.orders[idx] : null });
  } catch (err) {
    console.error("verify-payment error:", err);
    return res.status(500).json({ verified: false, error: String(err) });
  }
});

// ---------- Admin list & health ----------
app.get("/orders", (req, res) => {
  const db = readDB();
  res.json(db.orders || []);
});
app.get("/health", (req, res) => res.json({ status: "ok", time: Date.now() }));

// ---------- Start ----------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✅ Indiyummm backend running on port ${PORT}`);
  if (!RZP_KEY_ID || !RZP_KEY_SECRET) {
    console.warn("⚠️ Razorpay keys not set. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in environment variables.");
  } else {
    console.log("Razorpay keys found.");
  }
});
