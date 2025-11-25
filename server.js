
import express from "express";
import cors from "cors";
import fs from "fs";
import crypto from "crypto";
import Razorpay from "razorpay";

const app = express();
app.use(cors());
app.use(express.json());

const DB_FILE = "./db.json";

// Read data from file
function readDB() {
  try {
    const data = fs.readFileSync(DB_FILE, "utf8");
    return JSON.parse(data);
  } catch {
    return { reviews: [], orders: [] };
  }
}

// Save data to file
function saveDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// helper to get env vars with fallback
const RZP_KEY_ID = process.env.RAZORPAY_KEY_ID || "";
const RZP_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || "";

// initialize razorpay instance
const razorpay = new Razorpay({
  key_id: RZP_KEY_ID,
  key_secret: RZP_KEY_SECRET,
});

// ----------------- Reviews (existing) -----------------
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

  const newReview = {
    id: Date.now(),
    productName,
    name,
    rating,
    text,
  };

  db.reviews = db.reviews || [];
  db.reviews.push(newReview);
  saveDB(db);

  res.json(newReview);
});

// ----------------- Orders (new) -----------------

// Create order: frontend calls this to get a Razorpay order_id
// Body: { amount, currency, receipt, cart, customer }
// amount expected in rupees (number) — we'll convert to paise.
app.post("/create-order", async (req, res) => {
  try {
    const { amount, currency = "INR", receipt, cart, customer } = req.body;
    if (!amount || !receipt) {
      return res.status(400).json({ error: "Missing amount or receipt" });
    }

    const amountPaise = Math.round(Number(amount) * 100); // convert ₹ to paise

    // create razorpay order
    const options = {
      amount: amountPaise,
      currency,
      receipt: String(receipt),
      payment_capture: 1,
    };

    const order = await razorpay.orders.create(options);

    // save order skeleton in DB with status 'created'
    const db = readDB();
    db.orders = db.orders || [];
    const newOrder = {
      id: Date.now(),
      receipt: order.receipt || receipt,
      razorpay_order_id: order.id,
      amount: amount,
      amount_paise: amountPaise,
      currency,
      cart: cart || null,
      customer: customer || null,
      status: "created",
      created_at: Date.now(),
    };
    db.orders.push(newOrder);
    saveDB(db);

    res.json({
      success: true,
      order_id: order.id,
      amount: amountPaise,
      currency,
      receipt: order.receipt || receipt,
      key_id: RZP_KEY_ID,
    });
  } catch (err) {
    console.error("create-order error:", err);
    res.status(500).json({ error: "Failed to create order", detail: String(err) });
  }
});

// Verify payment: frontend sends razorpay fields for verification
// Body: { razorpay_order_id, razorpay_payment_id, razorpay_signature, receipt }
app.post("/verify-payment", (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, receipt } = req.body;
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: "Missing Razorpay fields" });
    }

    // Verify signature
    const hmac = crypto.createHmac("sha256", RZP_KEY_SECRET);
    hmac.update(`${razorpay_order_id}|${razorpay_payment_id}`);
    const generated_signature = hmac.digest("hex");

    const verified = generated_signature === razorpay_signature;

    // update DB order status
    const db = readDB();
    db.orders = db.orders || [];
    const idx = db.orders.findIndex(o => o.razorpay_order_id === razorpay_order_id || String(o.receipt) === String(receipt));
    if (idx !== -1 && verified) {
      db.orders[idx].status = "paid";
      db.orders[idx].razorpay_payment_id = razorpay_payment_id;
      db.orders[idx].razorpay_signature = razorpay_signature;
      db.orders[idx].paid_at = Date.now();
      saveDB(db);
    } else if (idx !== -1 && !verified) {
      db.orders[idx].status = "payment_failed";
      saveDB(db);
    }

    res.json({ verified, order_index: idx, order: idx !== -1 ? db.orders[idx] : null });
  } catch (err) {
    console.error("verify-payment error:", err);
    res.status(500).json({ error: "Verification failed", detail: String(err) });
  }
});

// Admin: list orders
app.get("/orders", (req, res) => {
  const db = readDB();
  res.json(db.orders || []);
});

// Health
app.get("/health", (req, res) => {
  res.json({ status: "ok", time: Date.now() });
});

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✅ Indiyummm backend running on port ${PORT}`);
  if (!RZP_KEY_ID || !RZP_KEY_SECRET) {
    console.warn("⚠️ Razorpay keys not set. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in environment variables.");
  } else {
    console.log("Razorpay keys found.");
  }
});
