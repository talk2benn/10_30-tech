# 1030 Tech

The storefront and its API run together as one Node.js service. PostgreSQL stores the catalogue, delivery zones, administrator credentials, and submitted orders.

## Run locally

Requirements: Node.js 20+ and PostgreSQL.

1. Create a PostgreSQL database named `1030tech`.
2. Copy `.env.example` to `.env`, then set `DATABASE_URL`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, and a random `JWT_SECRET` of at least 32 characters.
3. Install dependencies and start the service:

   ```sh
   npm install
   npm start
   ```

4. Open `http://localhost:3000`. The service initializes its tables, imports the 53-product catalogue when the database is empty, and adds the three default delivery zones if they are not already configured:
   - Mainland / close (Ikeja, Yaba, Surulere, Lagos Island): ₦2,500 midpoint fare (range ₦2,000–₦3,000).
   - Far Lagos (Ajah, Ikorodu, Badagry, Epe): ₦4,500 midpoint fare (range ₦4,000–₦5,000).
   - Outside Lagos (Abuja, PH, Ibadan; DHL/GIG): ₦6,000 midpoint fare (range ₦5,000–₦7,000).

   Existing fees for matching zone names are preserved. Admins can adjust fees in the dashboard.

Open the dedicated admin dashboard at `http://localhost:3000/admin` (or append `/admin` to your deployed site). Sign in with the credentials configured in `.env`; there is no client-side PIN. The JWT is kept in memory by the browser and expires after two hours. Never commit `.env` or production secrets.

The catalogue uses the original clean Unsplash category images for phones, laptops, and cars. These are representative category photos rather than exact model photos. Product view tags are not displayed.

Admins can provide a product image by entering an HTTP(S) image URL or uploading a JPEG, PNG, or WebP image up to 1 MB. A second image URL is available for an alternate view. Uploaded image data is stored with the product in PostgreSQL (not on the web service's temporary filesystem), so it remains available after redeploys. Keep uploads optimized because image data counts toward the database's storage limit. The server restores the original catalogue photos only for products still using the default Commons images; product images customized by an admin are preserved.

## Deploy with Render

1. Push this repository to GitHub.
2. In Render, create a **Blueprint** from the repository and review `render.yaml`.
3. Enter a private admin email and strong password when prompted for the `ADMIN_EMAIL` and `ADMIN_PASSWORD` values.
4. Render provisions the PostgreSQL database and web service. The blueprint generates `JWT_SECRET`.
5. After deployment, confirm the service's `/api/health` endpoint reports `{"status":"ok"}`.

Render serves both the storefront and API from the same origin. Do not deploy `index.html` by itself to GitHub Pages: a static Pages site cannot access the backend's same-origin API configuration.

## Deploy the storefront with Vercel

The Vercel deployment hosts the storefront and admin page as static files and rewrites `/api/*` to the existing Render service. This keeps the PostgreSQL database, admin credentials, and order processing on Render; keep that service running for the Vercel storefront's API and admin features to work.

1. Import this GitHub repository into Vercel and deploy from the repository root. No build command or output directory is required.
2. `vercel.json` maps `/admin` to `admin.html` and proxies API requests to the Render backend.
3. After deployment, verify the storefront, `/admin`, and `/api/health` on the Vercel domain.

## API overview

- `GET /api/health`, `/api/products`, `/api/delivery-zones`
- `POST /api/admin/login`
- Authenticated product and delivery-zone management under `/api/admin`
- `POST /api/orders` validates current server-side prices and delivery fees, then stores the order before returning its WhatsApp handoff details
