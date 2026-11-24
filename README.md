# NotaDigital — Aplikasi Pemesanan Makanan & Stok Harian

Aplikasi web untuk mendigitalisasi proses pencatatan nota pesanan makanan dari pelayan ke kasir & pemilik warung, dibangun menggunakan **Rust (Axum + SQLx/SQLite)** dan **React (Vite + TypeScript + Tailwind CSS)**.

## Fitur Utama

1. **Catat Nota (Pelayan)**
   - Pemilihan menu cepat dengan pencarian, filter kategori, dan indikator sisa stok real-time.
   - Dukungan catatan per item (misal *sambal pisah*, *tanpa es*) serta label meja/nama konsumen & nama pelayan.
   - Transaksi atomik: saat nota disimpan, stok otomatis berkurang dan sistem menolak pesanan jika stok tidak mencukupi.
2. **Kasir & Daftar Nota**
   - Filter cepat nota **Belum Bayar (`UNPAID`)**, **Lunas (`PAID`)**, dan **Dibatalkan (`VOIDED`)**.
   - **Tandai Lunas** 1-klik saat konsumen membayar.
   - **Batalkan Nota (`VOIDED`)** untuk nota belum bayar (stok otomatis dikembalikan & tercatat di log audit).
   - **Cetak Nota / Struk** siap print untuk kertas **Thermal 58mm**, **Thermal 80mm**, maupun **Standar A4**.
3. **Manajemen Menu & Stok Harian**
   - Tambah/edit/nonaktifkan menu dan harga (harga pada nota lama tetap terkunci sebagai snapshot).
   - Tombol **Mulai Hari Baru** untuk mereset stok awal harian ke stok default dalam 1 klik.
   - Fitur **Restock** tengah hari dan **Set Stok Awal**.
4. **Laporan Pendapatan & Rekonsiliasi Stok Akhir Hari (Pemilik)**
   - Rekap otomatis total pendapatan lunas, nota belum dibayar, nota dibatalkan, dan total porsi terjual per tanggal.
   - Tabel **Rekonsiliasi Stok Akhir Hari**: `Stok Awal + Restock − Terjual = Sisa Sistem`, dilengkapi input **Stok Fisik** untuk langsung mendeteksi selisih (`Cocok`, `Kurang`, `Lebih`) dan menyimpannya ke database.
   - Rincian omzet per menu, log mutasi stok, serta tombol **Export CSV**.

---

## Struktur Proyek

```text
application/
├── backend/       # Rust + Axum + SQLx (SQLite WAL mode + embedded migrations)
└── frontend/      # React + Vite + TypeScript + Tailwind CSS
```

## Prasyarat

- **Rust** (`rustup`, `cargo`, `rustc` — di Windows menggunakan toolchain `stable-x86_64-pc-windows-gnu` + WinLibs MinGW-w64 atau MSVC Build Tools)
- **Node.js** 20+ & **npm**

---

## Cara Menjalankan

### 1. Mode Development (Backend + Frontend terpisah dengan hot-reload)

**Terminal 1 — Jalankan Rust Backend (port 3000):**
```powershell
cd backend
cargo run
```
Database SQLite akan otomatis dibuat di `backend/data/nota_digital.db` beserta migrasi dan contoh menu bawaan pada startup pertama.

**Terminal 2 — Jalankan React Frontend (port 5173):**
```powershell
cd frontend
npm install
npm run dev
```
Buka browser di `http://localhost:5173`. Request `/api/*` otomatis di-proxy ke `http://127.0.0.1:3000`.

### 2. Mode Production (Single Server — Cocok untuk Wi-Fi Lokal Warung)

Build frontend terlebih dahulu:
```powershell
cd frontend
npm run build
```

Lalu jalankan backend dalam mode release:
```powershell
cd backend
cargo run --release
```
Server Rust Axum otomatis melayani API `/api/*` sekaligus file statis dari `../frontend/dist` di `http://0.0.0.0:3000`.
- Komputer kasir: buka `http://localhost:3000`
- HP/Tablet pelayan di Wi-Fi yang sama: buka `http://<IP-KOMPUTER-KASIR>:3000`

### Variabel Lingkungan Opsional (Backend)

| Variabel | Default | Keterangan |
| :--- | :--- | :--- |
| `PORT` | `3000` | Port HTTP server |
| `DATABASE_URL` | `sqlite://data/nota_digital.db?mode=rwc` | Lokasi file database SQLite |
| `STATIC_DIR` | `../frontend/dist` | Lokasi hasil build frontend |

---

## Menjalankan Pengujian

**Backend Integration Tests (SQLite in-memory):**
```powershell
cd backend
cargo test
```

**Frontend Type-check & Build:**
```powershell
cd frontend
npm run build
```
