# NotaDigital — Nasi Uduk 22 Kosambi - Mpok Indri

Aplikasi web POS & kontrol stok harian untuk **Nasi Uduk 22 Kosambi - Mpok Indri**, dibangun menggunakan **Rust (Axum + SQLx/SQLite)** dan **React (Vite + TypeScript + Tailwind CSS)** dengan tema warna hangat yang diturunkan dari logo usaha.

---

## Fitur Utama

### 1. Autentikasi Terpadu, RBAC & Keamanan
- **Unified Login** untuk seluruh peran dengan hak akses ketat:
  - **Pelayan (`waiter`)**: Catat Nota saja.
  - **Kasir (`cashier`)**: Kasir & Daftar Nota + cetak struk 58mm.
  - **Pemilik (`owner`)**: Catat Nota, Kasir, Menu & Stok (Buka/Tutup Toko), **Pengeluaran**, **Laporan & Analitik**, serta Void nota `PAID`.
  - **Administrator (`admin`)**: Akses penuh termasuk **Admin (Kelola Pengguna, Riwayat Sesi, Log Keamanan, Konfigurasi Header/Footer Nota)**, membuka akun terkunci, serta **Reset & Rollback Operasional Hari Ini**.
- **Session & Audit Keamanan**:
  - Password di-hash menggunakan **Argon2id** (dijalankan pada worker thread dengan concurrency guard).
  - Cookie sesi `HttpOnly; SameSite=Strict` (+ `Secure` saat `COOKIE_SECURE=true`), mencatat waktu `login_at`, `logout_at`, dan seluruh `auth_events` (berhasil, gagal, terkunci, dibuka).
  - **Proteksi Brute-Force**: akun terkunci otomatis setelah *N* percobaan gagal (`AUTH_MAX_FAILED_ATTEMPTS`), otomatis terbuka setelah `AUTH_LOCKOUT_MINUTES`, bisa dibuka lebih awal oleh Admin di UI, atau dibuka tanpa restart server via CLI `unlock-user`.
  - Header keamanan HTTP (`CSP`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `HSTS` saat HTTPS) dan proteksi CSRF berbasis `Origin` / `Sec-Fetch-Site`.

### 2. Siklus Operasional Toko (Buka / Tutup Toko & Reset Admin)
- **Buka Toko**: Pelayan dan Kasir otomatis diblokir (*Toko Belum Dibuka*) hingga Pemilik/Admin membuka toko hari ini sambil menginput stok awal.
- **Restock Tengah Hari**: Penambahan stok dapat dilakukan kapan saja selama toko berstatus buka.
- **Tutup Toko Terproteksi**:
  - Otomatis **ditolak** jika masih ada nota berstatus `UNPAID`.
  - **Stok Opname** bersifat opsional saat penutupan.
  - Dilindungi verifikasi hitungan matematika sederhana (`+` / `-`) untuk mencegah penutupan tidak sengaja.
  - Bersifat **final** (tidak bisa dibuka ulang secara normal di hari yang sama) dan otomatis mereset semua stok berjalan ke `0`.
- **Reset & Rollback Operasional Hari Ini (Khusus Admin)**:
  - Tombol **Reset Hari Ini** (dilindungi verifikasi matematika) untuk mengembalikan status operasional hari berjalan ke `BELUM DIBUKA`.
  - Secara otomatis membuat file backup SQL (`force-backup-{YYYYMMDD-HHMMSS}.sql`) di direktori `BACKUP_DIR` server **sebelum** menghapus data operasional hari ini (`store_days`, `orders`, `order_items`, `order_stock_deductions`, snapshot & pergerakan stok).
  - Jika pembuatan backup gagal, transaksi dibatalkan sepenuhnya tanpa menghapus data.
  - Data **Pengeluaran (`daily_expenses`)**, menu, master stok, pengguna, dan riwayat hari sebelumnya **tetap aman**.

### 3. Manajemen Multi-Stok, Menu, Harga & Import CSV
- **Entitas Stok Terpisah (`stock_items`)** dengan pemetaan **Multi-Stok (`menu_stock_requirements`)**:
  - Setiap menu terhubung ke **minimal 1 item stok** (mendukung menu paket yang mengonsumsi beberapa stok sekaligus).
  - Opsi otomatis membuat item stok sendiri (*self-stock*) saat menambahkan menu baru.
  - Ketersediaan menu dihitung otomatis dari item stok pembatas (*limiting stock*); jika salah satu komponen stok habis (`0`), menu otomatis tidak tersedia.
  - Penghapusan menu/stok yang memiliki histori nota otomatis diarsipkan (*soft-delete*) agar audit tetap utuh, dengan toggle tampilkan/pulihkan arsip.
- **Format Pemisah Ribuan Otomatis**: Input nominal harga (Tambah/Edit Menu) dan pengeluaran otomatis menampilkan pemisah ribuan format Indonesia (`.`, contoh: `25.000`).
- **Bulk Import CSV Menu**: Upload file CSV untuk tambah menu/harga massal (otomatis melewati nama menu yang sudah ada) lengkap dengan tombol unduh template CSV.

### 4. Saluran Penjualan (Extensible Sales Channels)
- Saluran penjualan disimpan di database (`sales_channels`) dengan 4 bawaan: **Regular**, **GoFood**, **GrabFood**, dan **ShopeeFood** (dapat ditambah/dikelola).
- Harga seragam di semua saluran.
- Pesanan dari saluran selain `Regular` (GoFood, GrabFood, ShopeeFood) **otomatis berstatus `PAID`**.
- **Pembatalan Nota (`VOIDED`)**: Kasir hanya dapat membatalkan nota `UNPAID`; pembatalan nota `PAID` hanya diizinkan untuk **Pemilik** dan **Administrator** (stok otomatis dikembalikan & tercatat di log audit).

### 5. Catat Nota (Pelayan), Kasir, Printer Thermal 58mm & Konfigurasi Struk
- **Pelayan**: Identitas pelayan (`@username`) tampil *read-only*, tersimpan di database, dan tercetak di struk; notifikasi *toast* mengambang yang hilang otomatis saat nota berhasil dicatat.
- **Kasir**: Pencetakan nota khusus di halaman Kasir; setelah menekan **Tandai Lunas**, muncul pilihan cepat untuk langsung cetak atau lewati.
- **Printer Bluetooth 58mm Tanpa Dialog (Android — Iware X583)**:
  - Formatter ESC/POS 32 karakter/baris dengan koneksi **Web Bluetooth (BLE)** (*pair* 1× di awal shift, cetak berikutnya langsung keluar tanpa dialog browser).
  - Dilengkapi dukungan **RawBT Android (58mm)** dan **Browser Print Preview** (`58mm`, `80mm`, `A4`).
- **Konfigurasi Header & Footer Nota (Khusus Admin)**:
  - Admin dapat mengatur teks **Header Nota** (multi-baris, maks. 8 baris / 300 karakter) dan **Footer Nota** (opsional, multi-baris) langsung dari tab **Admin → Header & Footer Nota** tanpa perlu compile ulang aplikasi.
  - Pengaturan gaya baris pertama header: **Cetak Tebal (Bold + Double-Strike)** dan **Ukuran Font ESC/POS** (`Normal 1x1`, `Tinggi 1x2`, `Lebar 2x1`, `Besar 2x2`) lengkap dengan live preview 58mm.

### 6. Pengeluaran Toko (Tab Khusus Pemilik & Admin)
- **Bebas Status Buka/Tutup Toko**: Pemilik dan Admin dapat mencatat, mengedit, dan menghapus pengeluaran kapan saja (`BELUM BUKA`, `BUKA`, maupun `TUTUP`) dengan pemilihan **tanggal bebas (`business_date`)**.
- **Sinkronisasi Otomatis Hari Tutup**: Perubahan pengeluaran pada hari yang sudah ditutup otomatis memperbarui `total_expenses` dan `net_profit` di `store_days`.
- **Kategori Pengeluaran Dinamis (`expense_categories`)**: Kategori dapat ditambah, diubah nama (otomatis memperbarui label pada catatan pengeluaran), dan dinonaktifkan tanpa menghapus histori.
- **Grafik Perbandingan Persentase Kategori**: Visualisasi *stacked bar* dan rincian persentase per kategori pengeluaran beserta input nominal berpemisah ribuan.

### 7. Laporan Harian & Analitik Performa
- **Laporan Harian**: Navigasi stepper tanggal (`<` / `>` / Hari Ini), rekap omzet lunas, belum bayar, void, pengeluaran, **Laba Bersih**, rekonsiliasi stok (awal/restock/terjual/selisih opname fisik), drill-down riwayat mutasi stok, serta **Export CSV**.
- **Analitik Performa**: Filter rentang waktu (`Hari Ini`, `7 Hari`, `30 Hari`, `Bulan Ini`, `Custom`), proporsi saluran penjualan, grafik tren ganda (Pendapatan vs Pengeluaran), menu terlaris & terendah, variansi stok, jam sibuk, hari tersibuk, serta **interval pembuatan nota per user**.

---

## Struktur Proyek

```text
application/
├── backend/
│   ├── migrations/              # Embedded SQLite migrations (0001..0006, LF-only)
│   ├── src/
│   │   ├── auth.rs              # Argon2id, session cookies, lockout, CLI unlock
│   │   ├── db.rs                # SQLite WAL pool, schema & optional sample seeding
│   │   ├── handlers/            # auth, admin, store, stocks, menu, channels, orders, expenses, reports
│   │   └── main.rs / lib.rs     # Axum router, security headers, graceful shutdown
│   └── tests/api_integration.rs # Integration & security regression tests
├── frontend/
│   ├── public/logo.jpeg         # Logo usaha Nasi Uduk 22 Kosambi - Mpok Indri
│   └── src/
│       ├── pages/               # Login, Waiter, Cashier, MenuStock, Expenses, DailyReport, AdminUsers
│       ├── components/          # BottomSheet, ReceiptPrintView, ToastContainer
│       └── utils/               # thermalPrinter.ts (ESC/POS BLE/RawBT), format.ts
├── deploy/
│   └── nota-digital.service     # Hardened non-root systemd unit
├── Dockerfile                   # Multi-stage container image
├── Dockerfile.linux-static      # Static x86_64-unknown-linux-musl release bundle
├── docker-compose.yml
└── LICENSE                      # GNU AGPLv3
```

---

## Prasyarat

- **Rust** (`rustup`, `cargo`, `rustc` — di Windows menggunakan `stable-x86_64-pc-windows-gnu` atau MSVC Build Tools)
- **Node.js** 20+ & **npm**
- *(Opsional untuk build rilis Linux statis)* **Podman** atau **Docker**

---

## Cara Menjalankan

### 1. Mode Development (Backend + Frontend terpisah)

**Terminal 1 — Jalankan Rust Backend (port 3000):**
```powershell
cd backend
$env:ADMIN_USERNAME="admin"
$env:ADMIN_PASSWORD="password-dev-anda"
$env:SEED_SAMPLE_DATA="true"   # opsional, hanya jika ingin contoh menu/stok
cargo run
```

**Terminal 2 — Jalankan React Frontend (port 5173):**
```powershell
cd frontend
npm install
npm run dev
```
Buka browser di `http://localhost:5173`. Request `/api/*` otomatis di-proxy ke `http://127.0.0.1:3000`.

### 2. Mode Production Lokal (Single Server)

```powershell
cd frontend && npm run build
cd ../backend && cargo run --release
```
Server Axum melayani API `/api/*` sekaligus file statis dari `../frontend/dist`.

### 3. Deployment VPS Linux Tanpa Docker (Static `musl` + `systemd` + Caddy HTTPS)

Build arsip biner statis `x86_64-unknown-linux-musl` di mesin lokal (menggunakan Podman atau Docker):
```bash
podman build --platform linux/amd64 -f Dockerfile.linux-static -t nota-digital-static:latest .
```

Ekstrak isi bundle (`/nota-digital-backend`, `/static`, `/nota-digital.service`) ke `/opt/nota-digital` di server Linux:
1. Buat user sistem non-root `nota-digital`, direktori data `/opt/nota-digital/data`, dan direktori backup `/opt/nota-digital/backups` (`chown nota-digital:nota-digital`, `chmod 750`).
2. Simpan kredensial admin di `/etc/nota-digital.env` (`chown root:nota-digital`, `chmod 640`):
   ```ini
   ADMIN_USERNAME=nama-admin-anda
   ADMIN_PASSWORD=password-kuat-anda
   ```
3. Pasang unit [deploy/nota-digital.service](deploy/nota-digital.service) ke `/etc/systemd/system/nota-digital.service` lalu jalankan `systemctl enable --now nota-digital`.
4. Pasang **Caddy** sebagai reverse proxy HTTPS otomatis ke `127.0.0.1:3000` dengan meneruskan IP klien:
   ```caddy
   domain-anda.web.id {
       encode zstd gzip
       reverse_proxy 127.0.0.1:3000 {
           header_up X-Real-IP {remote_host}
       }
   }
   ```

---

## Variabel Lingkungan (Backend)

| Variabel | Default | Keterangan |
| :--- | :--- | :--- |
| `HOST` | `0.0.0.0` | Alamat bind HTTP (`127.0.0.1` di belakang Caddy) |
| `PORT` | `3000` | Port HTTP server |
| `DATABASE_URL` | `sqlite://data/nota_digital.db?mode=rwc` | Lokasi file database SQLite |
| `STATIC_DIR` | `../frontend/dist` | Lokasi hasil build frontend |
| `BACKUP_DIR` | `backups` | Direktori penyimpanan `force-backup-{timestamp}.sql` saat Admin mereset hari |
| `TZ` | `Asia/Jakarta` | Zona waktu operasional & pelaporan harian |
| `ADMIN_USERNAME` | `admin` | Username akun Administrator bawaan |
| `ADMIN_PASSWORD` | *(wajib diisi)* | Password akun Administrator bawaan (di-hash Argon2id saat startup) |
| `AUTH_MAX_FAILED_ATTEMPTS` | `5` | Jumlah salah password berturut-turut sebelum akun dikunci (`3` pada unit produksi) |
| `AUTH_LOCKOUT_MINUTES` | `15` | Durasi kunci otomatis dalam menit (`0` = terkunci hingga dibuka Admin) |
| `SESSION_TTL_HOURS` | `12` | Masa berlaku sesi login dalam jam |
| `COOKIE_SECURE` | `false` | Set `true` saat berjalan di belakang HTTPS (Caddy) |
| `SEED_SAMPLE_DATA` | `false` | Set `true` hanya untuk mengisi contoh menu & stok saat database kosong |

### Membuka Kunci Akun Tanpa Restart Server (CLI)

Jika akun (termasuk Administrator) terkunci karena batas gagal login dan ingin dibuka lebih awal tanpa me-restart server:

```bash
sudo -u nota-digital \
  DATABASE_URL=sqlite:///opt/nota-digital/data/nota_digital.db?mode=rwc \
  /opt/nota-digital/nota-digital-backend unlock-user <username>
```

---

## Menjalankan Pengujian

**Backend Integration & Security Tests (SQLite in-memory):**
```powershell
cd backend
cargo test
```

**Frontend Type-check & Production Build:**
```powershell
cd frontend
npm run build
```

---

## Lisensi

Proyek ini dilisensikan di bawah **GNU Affero General Public License v3.0 (AGPL-3.0)** — lihat file [LICENSE](LICENSE) untuk detail lengkap.
