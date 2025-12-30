// ============================================
// SMART STOCK MANAGEMENT SYSTEM
// FLOOR-WISE STOCK TRACKING (STABLE FINAL)
// ============================================

const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// ============================================
// MIDDLEWARE
// ============================================

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================
// DATABASE
// ============================================

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST,
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  port: process.env.MYSQL_PORT,
  waitForConnections: true,
  connectionLimit: 10
});

pool.getConnection()
  .then(c => {
    console.log("✅ MySQL Connected");
    c.release();
  })
  .catch(e => console.error("❌ DB Error:", e.message));

// ============================================
// SOCKET.IO
// ============================================

io.on('connection', socket => {
  console.log("📡 Client connected:", socket.id);
  socket.on('disconnect', () =>
    console.log("📴 Client disconnected:", socket.id)
  );
});

// ============================================
// FLOOR MAP
// ============================================

const floorColumnMap = {
  "Ground Floor": "ground_floor_stock",
  "2nd Floor": "second_floor_stock",
  "3rd Floor": "third_floor_stock"
};

// ============================================
// STOCK IN
// ============================================

app.post('/api/scan-in', async (req, res) => {
  const { barcode, productName, floor } = req.body;
  if (!barcode || !floor) return res.status(400).json({ error: "Invalid data" });

  const floorColumn = floorColumnMap[floor];
  if (!floorColumn) return res.status(400).json({ error: "Invalid floor" });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [rows] = await conn.query(
      "SELECT * FROM products WHERE barcode = ?",
      [barcode]
    );

    if (rows.length) {
      await conn.query(
        `UPDATE products SET
          total_in = total_in + 1,
          current_stock = current_stock + 1,
          ${floorColumn} = ${floorColumn} + 1
         WHERE barcode = ?`,
        [barcode]
      );
    } else {
      await conn.query(
        `INSERT INTO products
         (barcode, product_name, total_in, current_stock, ${floorColumn})
         VALUES (?, ?, 1, 1, 1)`,
        [barcode, productName || "Unknown"]
      );
    }

    await conn.query(
      `INSERT INTO floor_stock (barcode, product_name, floor, stock)
       VALUES (?, ?, ?, 1)
       ON DUPLICATE KEY UPDATE stock = stock + 1`,
      [barcode, productName || "Unknown", floor]
    );

    const [[product]] = await conn.query(
      "SELECT * FROM products WHERE barcode = ?",
      [barcode]
    );

    await conn.query(
      `INSERT INTO stock_logs
       (barcode, product_name, action, quantity, floor, new_stock)
       VALUES (?, ?, 'IN', 1, ?, ?)`,
      [barcode, product.product_name, floor, product.current_stock]
    );

    await conn.commit();
    conn.release();

    io.emit("stock-update", product);

    res.json({ success: true, product });
  } catch (e) {
    await conn.rollback();
    conn.release();
    res.status(500).json({ error: e.message });
  }
});

// ============================================
// STOCK OUT
// ============================================

app.post('/api/scan-out', async (req, res) => {
  const { barcode, floor } = req.body;
  if (!barcode || !floor) return res.status(400).json({ error: "Invalid data" });

  const floorColumn = floorColumnMap[floor];
  if (!floorColumn) return res.status(400).json({ error: "Invalid floor" });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[fs]] = await conn.query(
      "SELECT stock FROM floor_stock WHERE barcode = ? AND floor = ?",
      [barcode, floor]
    );

    if (!fs || fs.stock <= 0) throw new Error("No stock");

    await conn.query(
      "UPDATE floor_stock SET stock = stock - 1 WHERE barcode = ? AND floor = ?",
      [barcode, floor]
    );

    await conn.query(
      `UPDATE products SET
        total_out = total_out + 1,
        current_stock = current_stock - 1,
        ${floorColumn} = ${floorColumn} - 1
       WHERE barcode = ?`,
      [barcode]
    );

    const [[product]] = await conn.query(
      "SELECT * FROM products WHERE barcode = ?",
      [barcode]
    );

    await conn.commit();
    conn.release();

    io.emit("stock-update", product);

    res.json({ success: true, product });
  } catch (e) {
    await conn.rollback();
    conn.release();
    res.status(400).json({ error: e.message });
  }
});

// ============================================
// PRODUCTS (✔ FRONTEND COMPATIBLE)
// ============================================

app.get('/api/products', async (_, res) => {
  const [products] = await pool.query(
    "SELECT * FROM products ORDER BY updated_at DESC"
  );
  res.json({ success: true, products });
});

// ============================================
// DASHBOARD STATS (✔ FIXED)
// ============================================

app.get('/api/stats', async (_, res) => {
  try {
    const [[tp]] = await pool.query("SELECT COUNT(*) count FROM products");
    const [[ts]] = await pool.query("SELECT SUM(current_stock) total FROM products");
    const [[ls]] = await pool.query("SELECT COUNT(*) count FROM products WHERE current_stock < 10");

    let floorStats = [];
    try {
      [floorStats] = await pool.query(
        "SELECT floor, SUM(stock) total FROM floor_stock GROUP BY floor"
      );
    } catch {
      floorStats = [];
    }

    res.json({
      success: true,
      stats: {
        totalProducts: tp.count,
        totalStock: ts.total || 0,
        lowStock: ls.count,
        todayIn: 0,
        todayOut: 0,
        floorStats
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================
// SERVER START
// ============================================

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`🚀 Smart Stock Server Running on port ${PORT}`);
});



