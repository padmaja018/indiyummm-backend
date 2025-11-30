// server.js - Indiyummm backend with simple auth (email+password) and orders
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
    if (!fs.existsSync(DB_FILE)) return { reviews: [], orders: [], users: [] };
    const txt = fs.readFileSync(DB_FILE, "utf8");
    return txt ? JSON.parse(txt) : { reviews: [], orders: [], users: [] };
  } catch (e) {
    console.error("readDB error", e);
    return { reviews: [], orders: [], users: [] };
  }
}
function writeDB(obj) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(obj, null, 2), "utf8");
  } catch (e) {
    console.error("writeDB error", e);
  }
}

// Password hashing helpers (pbkdf2)
function genSalt() {
  return crypto.randomBytes(16).toString("hex");
}
function hashPassword(password, salt) {
  const hash = crypto.pbkdf2Sync(String(password), salt, 100000, 64, "sha512");
  return hash.toString("hex");
}
function verifyPassword(password, salt, hashed) {
  const h = hashPassword(password, salt);
  return crypto.timingSafeEqual(Buffer.from(h, "hex"), Buffer.from(hashed, "hex"));
}

// Token generator
function genToken() {
  return crypto.randomBytes(24).toString("hex");
}

// Razorpay keys from env
const RZP_KEY_ID = process.env.RAZORPAY_KEY_ID || "rzp_live_Rk1n4SeiHtIW3P";
const RZP_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || "OCY1TU71FCRZ2pHci43OqXxT";

let razorpay = null;
if (RZP_KEY_ID && RZP_KEY_SECRET) {
  try {
    razorpay = new Razorpay({ key_id: RZP_KEY_ID, key_secret: RZP_KEY_SECRET });
    console.log("Razorpay initialized.");
  } catch (e) {
    console.error("razorpay init error", e);
  }
} else {
  console.warn("⚠️ Razorpay keys missing.");
}

// ----------------- AUTH: register / login / me -----------------

// Register: { name, email, password }
app.post("/register", (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!email || !password || !name) return res.status(400).json({ error: "Missing fields" });

    const db = readDB();
    db.users = db.users || [];

    const exists = db.users.find((u) => String(u.email).toLowerCase() === String(email).toLowerCase());
    if (exists) return res.status(400).json({ error: "User already exists" });

    const salt = genSalt();
    const hashed = hashPassword(password, salt);
    const token = genToken();

    const user = {
      id: Date.now(),
      name,
      email: String(email).toLowerCase(),
      salt,
      password: hashed,
      token,
      created_at: Date.now(),
    };

    db.users.push(user);
    writeDB(db);

    // send token and basic user (without password)
    const { password: _p, salt: _s, ...userSafe } = user;
    return res.json({ success: true, user: userSafe, token });
  } catch (e) {
    console.error("register error", e);
    return res.status(500).json({ error: "server_error" });
  }
});
  app.get("/reviews", (req, res) => {
  const data = JSON.parse(fs.readFileSync("db.json")).reviews || [];
  res.json(data);
});


// Login: { email, password }
app.post("/login", (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Missing fields" });

    const db = readDB();
    db.users = db.users || [];

    const user = db.users.find((u) => String(u.email).toLowerCase() === String(email).toLowerCase());
    if (!user) return res.status(400).json({ error: "Invalid credentials" });

    const ok = verifyPassword(password, user.salt, user.password);
    if (!ok) return res.status(400).json({ error: "Invalid credentials" });

    // rotate token
    user.token = genToken();
    writeDB(db);

    const { password: _p, salt: _s, ...userSafe } = user;
    return res.json({ success: true, user: userSafe, token: user.token });
  } catch (e) {
    console.error("login error", e);
    return res.status(500).json({ error: "server_error" });
  }
});

// Get current user by token: Authorization: Bearer <token>
app.get("/me", (req, res) => {
  try {
    const auth = req.headers.authorization || "";
    const token = auth.replace("Bearer ", "").trim();
    if (!token) return res.status(401).json({ error: "missing_token" });

    const db = readDB();
    db.users = db.users || [];
    const user = db.users.find((u) => u.token === token);
    if (!user) return res.status(401).json({ error: "invalid_token" });

    const { password: _p, salt: _s, ...userSafe } = user;
    return res.json({ success: true, user: userSafe });
  } catch (e) {
    console.error("me error", e);
    return res.status(500).json({ error: "server_error" });
  }
});

// ----------------- ORDERS (create, verify, my-orders, admin) -----------------

// Create order endpoint (supports cart OR selectedProduct)
app.post("/create-order", async (req, res) => {
  try {
    const { amount, currency = "INR", receipt, cart, selectedProduct, customer, cod } = req.body;
    if (!amount) return res.status(400).json({ error: "Missing amount" });

    const amountPaise = Math.round(Number(amount) * 100);
    const finalReceipt = receipt || `rcpt_${Date.now()}`;

    let rzpOrder = {};
    if (!cod && razorpay) {
      rzpOrder = await razorpay.orders.create({
        amount: amountPaise,
        currency,
        receipt: finalReceipt,
        payment_capture: 1,
      });
    } else {
      rzpOrder = { id: `cod_${Date.now()}`, amount: amountPaise, currency };
    }

    // Convert quick-view selectedProduct into cart item if cart empty
    let finalCart = cart && cart.length > 0 ? cart : [];
    if (finalCart.length === 0 && selectedProduct) {
      finalCart = [
        {
          name: selectedProduct.name,
          img: selectedProduct.img || "",
          pricePerKg: selectedProduct.price,
          qty: selectedProduct.packKg,
          packLabel: selectedProduct.packLabel,
          calculatedPrice: Math.round(Number(selectedProduct.price) * Number(selectedProduct.packKg)),
        },
      ];
    }

    const db = readDB();
    db.orders = db.orders || [];
    db.orders.push({
      id: Date.now(),
      receipt: finalReceipt,
      razorpay_order_id: rzpOrder.id,
      amount,
      amount_paise: rzpOrder.amount,
      currency: rzpOrder.currency,
      cart: finalCart,
      customer,
      status: "created",
      created_at: Date.now(),
      eta: null,
    });
    writeDB(db);

    return res.json({
      success: true,
      order_id: rzpOrder.id,
      amount: rzpOrder.amount,
      currency: rzpOrder.currency,
      receipt: finalReceipt,
      key_id: RZP_KEY_ID,
    });
  } catch (err) {
    console.error("create-order error:", err);
    return res.status(500).json({ error: "Failed to create order" });
  }
});

// Verify payment
app.post("/verify-payment", (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, receipt } = req.body;
    const generated = crypto.createHmac("sha256", RZP_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");
    const verified = generated === razorpay_signature;

    const db = readDB();
    db.orders = db.orders || [];
    const idx = db.orders.findIndex(o => o.razorpay_order_id === razorpay_order_id || o.receipt === receipt);
    if (idx !== -1) {
      db.orders[idx].status = verified ? "paid" : "payment_failed";
      db.orders[idx].razorpay_payment_id = razorpay_payment_id;
      writeDB(db);
    }

    return res.json({ verified });
  } catch (err) {
    console.error("verify-payment error:", err);
    return res.status(500).json({ verified: false });
  }
});

// Get orders by customer phone OR email
app.get("/my-orders/phone/:phone", (req, res) => {
  const phone = String(req.params.phone || "").trim();
  const db = readDB();
  const orders = (db.orders || []).filter(o => (o.customer && String(o.customer.phone || "") === phone));
  res.json(orders);
});
app.get("/my-orders/email/:email", (req, res) => {
  const email = String(req.params.email || "").trim().toLowerCase();
  const db = readDB();
  // attempt match by customer.email OR by user email that placed orders
  const orders = (db.orders || []).filter(o => {
    if (!o.customer) return false;
    const custEmail = (o.customer.email || "").toLowerCase();
    return custEmail === email;
  });
  res.json(orders);
});

// Admin: get all orders
app.get("/orders", (req, res) => {
  const db = readDB();
  res.json(db.orders || []);
});

// Update status / eta
app.patch("/update-status/:id", (req, res) => {
  const id = req.params.id;
  const { status, eta } = req.body;
  const db = readDB();
  db.orders = db.orders || [];
  const idx = db.orders.findIndex(o => o.razorpay_order_id === id || o.receipt === id);
  if (idx === -1) return res.status(404).json({ error: "Not found" });
  if (status) db.orders[idx].status = status;
  if (eta) db.orders[idx].eta = eta;
  writeDB(db);
  res.json({ success: true, order: db.orders[idx] });
});

// Delete order
app.delete("/delete-order/:id", (req, res) => {
  const id = req.params.id;
  const db = readDB();
  db.orders = db.orders || [];
  db.orders = db.orders.filter(o => o.razorpay_order_id !== id && o.receipt !== id);
  writeDB(db);
  res.json({ success: true });
});

// health
app.get("/health", (req, res) => res.json({ status: "ok", time: Date.now() }));

// start
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✅ Indiyummm backend running on port ${PORT}`);
  if (!RZP_KEY_ID || !RZP_KEY_SECRET) console.warn("⚠️ Razorpay keys not set.");
});
