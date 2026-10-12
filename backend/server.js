"use strict";

require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const bcrypt = require("bcryptjs");
const cors = require("cors");
const express = require("express");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

const requiredEnvironment = ["DATABASE_URL", "ADMIN_EMAIL", "ADMIN_PASSWORD", "JWT_SECRET"];
const missingEnvironment = requiredEnvironment.filter((key) => !process.env[key]);
if (missingEnvironment.length) {
  throw new Error(`Missing required environment variables: ${missingEnvironment.join(", ")}`);
}
if (process.env.JWT_SECRET.length < 32) {
  throw new Error("JWT_SECRET must contain at least 32 characters.");
}

const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const port = Number(process.env.PORT) || 3000;
const jwtSecret = process.env.JWT_SECRET;
const maxProductImageBytes = 1024 * 1024;
const seedProducts = JSON.parse(fs.readFileSync(path.join(__dirname, "seed-products.json"), "utf8"));
const defaultDeliveryZones = [
  {
    name: "Zone 1 - Mainland: Ikeja, Yaba, Surulere, Lagos Island (₦2k-₦3k)",
    fee: 2500,
  },
  {
    name: "Zone 2 - Far Lagos: Ajah, Ikorodu, Badagry, Epe (₦4k-₦5k)",
    fee: 4500,
  },
  {
    name: "Zone 3 - Outside Lagos: Abuja, PH, Ibadan (DHL/GIG; ₦5k-₦7k)",
    fee: 6000,
  },
];
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many login attempts. Try again in 15 minutes." },
});
const orderLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many orders submitted. Please try again later." },
});

app.disable("x-powered-by");
if (process.env.NODE_ENV === "production") app.set("trust proxy", 1);
app.use(cors({
  origin(origin, callback) {
    const allowedOrigin = process.env.FRONTEND_ORIGIN;
    if (!origin || origin === allowedOrigin || (process.env.NODE_ENV !== "production" && origin === "null")) {
      return callback(null, true);
    }
    return callback(null, false);
  },
}));
app.use(helmet({
  crossOriginResourcePolicy: { policy: "same-site" },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      imgSrc: ["'self'", "https:", "data:"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
    },
  },
}));
app.use(express.json({ limit: "2mb" }));

function apiError(res, status, message) {
  return res.status(status).json({ error: message });
}

function requireAdmin(req, res, next) {
  const authorization = req.get("authorization") || "";
  const [scheme, token] = authorization.split(" ");
  if (scheme !== "Bearer" || !token) return apiError(res, 401, "Admin authentication is required.");
  try {
    const claims = jwt.verify(token, jwtSecret);
    if (claims.role !== "admin") return apiError(res, 403, "Admin access is required.");
    req.adminEmail = claims.sub;
    return next();
  } catch {
    return apiError(res, 401, "Admin session is invalid or expired. Sign in again.");
  }
}

function filterFor(category, brand) {
  if (category === "Phones") return "iPhones";
  if (category === "Laptops") return "HP Laptops";
  return brand;
}

function validateProduct(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { error: "A product object is required." };
  }
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const brand = typeof input.brand === "string" ? input.brand.trim() : "";
  const category = input.category;
  const specifications = typeof input.specifications === "string" ? input.specifications.trim() : "";
  const status = typeof input.status === "string" ? input.status.trim() : "";
  const price = Number(input.price);
  const allowedCategories = ["Phones", "Laptops", "Cars"];
  if (!title || title.length > 120 || !brand || brand.length > 60) {
    return { error: "Product name and brand are required (maximum 120 and 60 characters)."
    };
  }
  if (!allowedCategories.includes(category)) return { error: "Choose a valid product category." };
  if (!specifications || specifications.length > 300 || !status || status.length > 40) {
    return { error: "Specifications and status are required and must fit the allowed length." };
  }
  if (!Number.isSafeInteger(price) || price < 1) return { error: "Price must be a positive whole number of naira." };

  let image = typeof input.image === "string" ? input.image.trim() : "";
  if (image) {
    if (image.startsWith("data:")) {
      const match = image.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
      if (!match) return { error: "Uploaded images must be valid JPEG, PNG, or WebP files." };
      const bytes = Buffer.from(match[2], "base64");
      if (bytes.length > maxProductImageBytes || bytes.toString("base64") !== match[2]) {
        return { error: "Uploaded images must be 1 MB or smaller." };
      }
      const validSignature = match[1] === "jpeg"
        ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
        : match[1] === "png"
          ? bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
          : bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
      if (!validSignature) return { error: "The uploaded file contents do not match a supported image format." };
    } else {
      try {
        const imageUrl = new URL(image);
        if (!["https:", "http:"].includes(imageUrl.protocol)) throw new Error();
        image = imageUrl.href;
      } catch {
        return { error: "Image must be a valid HTTP or HTTPS URL." };
      }
    }
  }

  let storage;
  let storagePrices;
  if (input.storage !== undefined || input.storagePrices !== undefined) {
    if (!Array.isArray(input.storage) || !input.storage.length || input.storage.length > 8) {
      return { error: "Storage options must be a non-empty list of at most 8 values." };
    }
    if (input.storage.some((capacity) => typeof capacity !== "string" || !/^\d+(GB|TB)$/i.test(capacity)) ||
      new Set(input.storage).size !== input.storage.length) {
      return { error: "Storage options must be unique capacities such as 128GB or 1TB." };
    }
    if (!input.storagePrices || typeof input.storagePrices !== "object" || Array.isArray(input.storagePrices)) {
      return { error: "A price is required for every storage option." };
    }
    storagePrices = {};
    for (const capacity of input.storage) {
      const tierPrice = Number(input.storagePrices[capacity]);
      if (!Number.isSafeInteger(tierPrice) || tierPrice < 1) {
        return { error: `Enter a valid price for ${capacity}.` };
      }
      storagePrices[capacity] = tierPrice;
    }
    storage = input.storage;
  }

  return {
    product: {
      id: typeof input.id === "string" ? input.id : undefined,
      title,
      brand,
      category,
      filter: filterFor(category, brand),
      specifications,
      price,
      image: image || null,
      status,
      ...(storage ? { storage, storagePrices } : {}),
    },
  };
}

function priceFor(product, storage) {
  if (!Array.isArray(product.storage) || !product.storage.length) {
    if (storage) throw new Error(`${product.title} does not have storage options.`);
    return product.price;
  }
  if (!product.storage.includes(storage)) throw new Error(`Choose a valid storage size for ${product.title}.`);
  const tierPrice = Number(product.storagePrices?.[storage]);
  if (!Number.isSafeInteger(tierPrice) || tierPrice < 1) {
    throw new Error(`A price is not configured for ${product.title} (${storage}).`);
  }
  return tierPrice;
}

async function ensureDefaultDeliveryZones() {
  for (const zone of defaultDeliveryZones) {
    await pool.query(
      `INSERT INTO delivery_zones (id, name, fee) VALUES ($1, $2, $3)
       ON CONFLICT (LOWER(name)) DO NOTHING`,
      [randomUUID(), zone.name, zone.fee]
    );
  }
}

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS delivery_zones (
      id UUID PRIMARY KEY,
      name TEXT NOT NULL,
      fee BIGINT NOT NULL CHECK (fee >= 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS delivery_zones_name_lower_idx
      ON delivery_zones (LOWER(name));
    CREATE TABLE IF NOT EXISTS admin_users (
      email TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS orders (
      id UUID PRIMARY KEY,
      customer_name TEXT NOT NULL,
      customer_phone TEXT NOT NULL,
      fulfilment TEXT NOT NULL CHECK (fulfilment IN ('pickup', 'delivery')),
      delivery_address TEXT,
      delivery_zone_name TEXT,
      delivery_fee BIGINT NOT NULL CHECK (delivery_fee >= 0),
      subtotal BIGINT NOT NULL CHECK (subtotal >= 0),
      total BIGINT NOT NULL CHECK (total >= 0),
      items JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS orders_created_at_idx ON orders (created_at DESC);
  `);

  const configuredEmail = process.env.ADMIN_EMAIL.trim().toLowerCase();
  const passwordHash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 12);
  await pool.query(
    `INSERT INTO admin_users (email, password_hash) VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = NOW()`,
    [configuredEmail, passwordHash]
  );

  await ensureDefaultDeliveryZones();

  const { rows } = await pool.query("SELECT COUNT(*)::int AS count FROM products");
  if (rows[0].count === 0) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const product of seedProducts) {
        await client.query("INSERT INTO products (id, data) VALUES ($1, $2::jsonb)", [product.id, JSON.stringify(product)]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    console.info(`Seeded ${seedProducts.length} products.`);
  }
}

app.get("/api/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    return res.json({ status: "ok" });
  } catch (error) {
    console.error("Health check database error:", error);
    return apiError(res, 503, "Database is unavailable.");
  }
});

app.get("/api/products", async (_req, res, next) => {
  try {
    const { rows } = await pool.query("SELECT data FROM products ORDER BY created_at, id");
    return res.json(rows.map((row) => row.data));
  } catch (error) {
    return next(error);
  }
});

app.get("/api/delivery-zones", async (_req, res, next) => {
  try {
    let { rows } = await pool.query("SELECT id, name, fee FROM delivery_zones ORDER BY name");
    if (!rows.length) {
      await ensureDefaultDeliveryZones();
      ({ rows } = await pool.query("SELECT id, name, fee FROM delivery_zones ORDER BY name"));
    }
    return res.json(rows.map((zone) => ({ ...zone, fee: Number(zone.fee) })));
  } catch (error) {
    return next(error);
  }
});

app.post("/api/admin/login", loginLimiter, async (req, res, next) => {
  try {
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!email || !password) return apiError(res, 400, "Email and password are required.");
    const { rows } = await pool.query("SELECT email, password_hash FROM admin_users WHERE email = $1", [email]);
    const admin = rows[0];
    const valid = admin ? await bcrypt.compare(password, admin.password_hash) : false;
    if (!valid) return apiError(res, 401, "Email or password is incorrect.");
    const token = jwt.sign({ role: "admin" }, jwtSecret, { subject: admin.email, expiresIn: "2h" });
    return res.json({ token, expiresIn: 7200 });
  } catch (error) {
    return next(error);
  }
});

app.post("/api/admin/products", requireAdmin, async (req, res, next) => {
  try {
    const result = validateProduct(req.body);
    if (result.error) return apiError(res, 400, result.error);
    const product = result.product;
    product.id = randomUUID();
    if (!product.image) {
      product.image = product.category === "Phones" ? seedProducts[0].image :
        product.category === "Laptops" ? seedProducts.find((item) => item.category === "Laptops").image :
          product.brand.toLowerCase().includes("toyota")
            ? seedProducts.find((item) => item.brand === "Toyota").image
            : seedProducts.find((item) => item.brand === "Mercedes-Benz").image;
    }
    await pool.query("INSERT INTO products (id, data) VALUES ($1, $2::jsonb)", [product.id, JSON.stringify(product)]);
    return res.status(201).json(product);
  } catch (error) {
    return next(error);
  }
});

app.put("/api/admin/products/:id", requireAdmin, async (req, res, next) => {
  try {
    const result = validateProduct(req.body);
    if (result.error) return apiError(res, 400, result.error);
    const { rows } = await pool.query("SELECT data FROM products WHERE id = $1", [req.params.id]);
    if (!rows[0]) return apiError(res, 404, "Product was not found.");
    const previous = rows[0].data;
    const product = { ...result.product, id: req.params.id, image: result.product.image || previous.image };
    await pool.query("UPDATE products SET data = $2::jsonb, updated_at = NOW() WHERE id = $1", [product.id, JSON.stringify(product)]);
    return res.json(product);
  } catch (error) {
    return next(error);
  }
});

app.delete("/api/admin/products/:id", requireAdmin, async (req, res, next) => {
  try {
    const { rowCount } = await pool.query("DELETE FROM products WHERE id = $1", [req.params.id]);
    if (!rowCount) return apiError(res, 404, "Product was not found.");
    return res.status(204).end();
  } catch (error) {
    return next(error);
  }
});

app.post("/api/admin/delivery-zones", requireAdmin, async (req, res, next) => {
  try {
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const fee = Number(req.body?.fee);
    if (!name || name.length > 80 || !Number.isSafeInteger(fee) || fee < 0) {
      return apiError(res, 400, "Enter a location name (up to 80 characters) and a valid non-negative whole-naira fee.");
    }
    const { rows } = await pool.query(
      `INSERT INTO delivery_zones (id, name, fee) VALUES ($1, $2, $3)
       ON CONFLICT (LOWER(name)) DO UPDATE SET fee = EXCLUDED.fee, name = EXCLUDED.name, updated_at = NOW()
       RETURNING id, name, fee`,
      [randomUUID(), name, fee]
    );
    return res.status(200).json({ ...rows[0], fee: Number(rows[0].fee) });
  } catch (error) {
    return next(error);
  }
});

app.delete("/api/admin/delivery-zones/:id", requireAdmin, async (req, res, next) => {
  try {
    const { rowCount } = await pool.query("DELETE FROM delivery_zones WHERE id = $1", [req.params.id]);
    if (!rowCount) return apiError(res, 404, "Delivery zone was not found.");
    return res.status(204).end();
  } catch (error) {
    return next(error);
  }
});

app.post("/api/orders", orderLimiter, async (req, res, next) => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  const phone = typeof req.body?.phone === "string" ? req.body.phone.trim() : "";
  const address = typeof req.body?.address === "string" ? req.body.address.trim() : "";
  const fulfilment = req.body?.fulfilment;
  const itemsInput = req.body?.items;
  if (!name || name.length > 120 || !phone || phone.length > 40) {
    return apiError(res, 400, "Enter a customer name and phone number.");
  }
  if (fulfilment !== "pickup" && fulfilment !== "delivery") {
    return apiError(res, 400, "Choose store pickup or delivery.");
  }
  if (fulfilment === "delivery" && (!address || address.length > 500)) {
    return apiError(res, 400, "A delivery address is required (maximum 500 characters).");
  }
  if (!Array.isArray(itemsInput) || !itemsInput.length || itemsInput.length > 50) {
    return apiError(res, 400, "The order must contain between 1 and 50 cart lines.");
  }

  let client;
  let transactionStarted = false;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    transactionStarted = true;
    let deliveryZone = null;
    if (fulfilment === "delivery") {
      const zoneId = typeof req.body.zoneId === "string" ? req.body.zoneId : "";
      const zoneResult = await client.query("SELECT id, name, fee FROM delivery_zones WHERE id = $1", [zoneId]);
      deliveryZone = zoneResult.rows[0];
      if (!deliveryZone) {
        await client.query("ROLLBACK");
        return apiError(res, 400, "Choose a valid delivery zone.");
      }
    }

    const itemLines = [];
    let subtotal = 0;
    for (const input of itemsInput) {
      const productId = typeof input?.productId === "string" ? input.productId : "";
      const quantity = Number(input?.quantity);
      if (!productId || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 99) {
        await client.query("ROLLBACK");
        return apiError(res, 400, "Every cart item needs a valid product and quantity from 1 to 99.");
      }
      const productResult = await client.query("SELECT data FROM products WHERE id = $1", [productId]);
      const product = productResult.rows[0]?.data;
      if (!product) {
        await client.query("ROLLBACK");
        return apiError(res, 400, "A product in the cart is no longer available. Refresh the catalogue.");
      }
      let unitPrice;
      try {
        unitPrice = priceFor(product, input.storage);
      } catch (error) {
        await client.query("ROLLBACK");
        transactionStarted = false;
        return apiError(res, 400, error.message);
      }
      const lineTotal = unitPrice * quantity;
      if (!Number.isSafeInteger(lineTotal) || !Number.isSafeInteger(subtotal + lineTotal)) {
        await client.query("ROLLBACK");
        transactionStarted = false;
        return apiError(res, 400, "The order total is too large to process.");
      }
      subtotal += lineTotal;
      itemLines.push({
        productId,
        title: product.title,
        storage: input.storage || null,
        quantity,
        unitPrice,
        lineTotal,
      });
    }
    const deliveryFee = deliveryZone ? Number(deliveryZone.fee) : 0;
    const total = subtotal + deliveryFee;
    if (!Number.isSafeInteger(total)) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return apiError(res, 400, "The order total is too large to process.");
    }
    const id = randomUUID();
    await client.query(
      `INSERT INTO orders
        (id, customer_name, customer_phone, fulfilment, delivery_address, delivery_zone_name, delivery_fee, subtotal, total, items)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
      [id, name, phone, fulfilment, fulfilment === "delivery" ? address : null, deliveryZone?.name || null, deliveryFee, subtotal, total, JSON.stringify(itemLines)]
    );
    await client.query("COMMIT");
    transactionStarted = false;
    return res.status(201).json({
      orderId: id,
      items: itemLines,
      subtotal,
      deliveryFee,
      deliveryZone: deliveryZone?.name || null,
      total,
    });
  } catch (error) {
    if (client && transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("Order transaction rollback failed:", rollbackError);
      }
    }
    return next(error);
  } finally {
    if (client) client.release();
  }
});

app.get(["/", "/admin"], (_req, res) => res.sendFile(path.join(__dirname, "..", "index.html")));
app.use((req, res) => apiError(res, 404, `Route not found: ${req.method} ${req.path}`));
app.use((error, _req, res, _next) => {
  console.error("Request failed:", error);
  if (res.headersSent) return;
  if (error.type === "entity.too.large") return apiError(res, 413, "Request is too large. Product image uploads must be 1 MB or smaller.");
  if (error.status === 400) return apiError(res, 400, "Request body must contain valid JSON.");
  return apiError(res, 500, "The request could not be completed.");
});

initializeDatabase()
  .then(() => {
    app.listen(port, () => console.info(`1030 Tech backend listening on port ${port}.`));
  })
  .catch(async (error) => {
    console.error("Backend startup failed:", error);
    await pool.end();
    process.exitCode = 1;
  });

process.on("SIGTERM", async () => {
  await pool.end();
  process.exit(0);
});
