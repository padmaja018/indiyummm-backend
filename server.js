import express from "express";
import cors from "cors";
import fs from "fs";

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
    return { reviews: [] };
  }
}

// Save data to file
function saveDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// ✅ Get all reviews grouped by productName
app.get("/reviews", (req, res) => {
  const db = readDB();
  const grouped = {};

  (db.reviews || []).forEach(review => {
    const product = review.productName;
    if (!grouped[product]) grouped[product] = [];
    grouped[product].push(review);
  });

  res.json(grouped);
});

// ✅ Add a new review
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
    text
  };

  db.reviews = db.reviews || [];
  db.reviews.push(newReview);
  saveDB(db);

  res.json(newReview);
});

// Start server
app.listen(5000, () => {
  console.log("✅ Indiyummm backend running on ");
});
