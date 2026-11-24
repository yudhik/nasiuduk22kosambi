use std::{net::SocketAddr, path::PathBuf};

use nota_digital_backend::{build_router, db::init_pool, AppState};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

#[tokio::main]
async fn main() {
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "nota_digital_backend=info,tower_http=info".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    let database_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "sqlite://data/nota_digital.db?mode=rwc".to_string());
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(3000);
    let static_dir = std::env::var("STATIC_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("../frontend/dist"));

    let pool = init_pool(&database_url, true)
        .await
        .expect("Gagal menginisialisasi database SQLite");

    let state = AppState { pool };
    let app = build_router(state, Some(static_dir.clone()));

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    tracing::info!(
        "NotaDigital API aktif di http://{} (database: {}, static: {})",
        addr,
        database_url,
        static_dir.display()
    );

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("Gagal bind port server");
    axum::serve(listener, app)
        .await
        .expect("Server berhenti dengan error");
}
