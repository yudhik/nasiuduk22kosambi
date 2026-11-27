use std::{
    net::{IpAddr, SocketAddr},
    path::PathBuf,
    time::Duration,
};

use nota_digital_backend::{
    auth::{prune_old_auth_records, sync_env_admin, unlock_user_by_username, AuthConfig},
    build_router,
    db::{init_pool, init_pool_existing_only},
    AppState, APP_GIT_SHA, APP_VERSION,
};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };

    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut sig) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            sig.recv().await;
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}

#[tokio::main]
async fn main() {
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "nota_digital_backend=info,tower_http=info".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    // CLI version flag: `nota-digital-backend --version` (exits before touching DB/env)
    let args: Vec<String> = std::env::args().collect();
    if args.len() >= 2 && matches!(args[1].as_str(), "--version" | "-V" | "version") {
        println!("nota-digital-backend {APP_VERSION} ({APP_GIT_SHA})");
        return;
    }

    let database_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "sqlite://data/nota_digital.db?mode=rwc".to_string());

    // Zero-downtime CLI utility: `nota-digital-backend unlock-user <username>`
    // Opens existing DB without creating new files or running migrations.
    if args.len() >= 2 && args[1] == "unlock-user" {
        let Some(username) = args.get(2) else {
            eprintln!("Penggunaan: {} unlock-user <username>", args[0]);
            std::process::exit(1);
        };

        let pool = init_pool_existing_only(&database_url)
            .await
            .unwrap_or_else(|err| {
                eprintln!(
                    "Gagal membuka database SQLite yang sudah ada ({database_url}): {err}"
                );
                std::process::exit(1);
            });
        match unlock_user_by_username(
            &pool,
            username,
            "Dibuka melalui server CLI (unlock-user)",
            "local-cli",
        )
        .await
        {
            Ok(user) => {
                println!(
                    "Berhasil membuka kunci pengguna '{}' (role: {}, id: {}).",
                    user.username, user.role, user.id
                );
                pool.close().await;
                return;
            }
            Err(err) => {
                eprintln!("Gagal membuka kunci pengguna '{username}': {err}");
                pool.close().await;
                std::process::exit(1);
            }
        }
    }

    let auth_config = AuthConfig::from_env().unwrap_or_else(|msg| {
        eprintln!("Konfigurasi autentikasi tidak lengkap: {msg}");
        std::process::exit(1);
    });

    let host: IpAddr = std::env::var("HOST")
        .ok()
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(IpAddr::from([0, 0, 0, 0]));
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(3000);
    let static_dir = std::env::var("STATIC_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("../frontend/dist"));
    let backup_dir = std::env::var("BACKUP_DIR")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("backups"));

    let seed_sample_data = std::env::var("SEED_SAMPLE_DATA")
        .ok()
        .map(|v| matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes"))
        .unwrap_or(false);

    let pool = init_pool(&database_url, seed_sample_data)
        .await
        .expect("Gagal menginisialisasi database SQLite");

    sync_env_admin(&pool, &auth_config)
        .await
        .expect("Gagal menyinkronkan akun admin dari environment variable");

    // Periodic background cleanup for expired sessions & aged auth audit logs (90-day retention)
    let cleanup_pool = pool.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(6 * 3600));
        loop {
            interval.tick().await;
            if let Err(err) = prune_old_auth_records(&cleanup_pool).await {
                tracing::warn!(error = %err, "failed to prune old auth records");
            }
        }
    });

    let state = AppState::new(pool.clone(), auth_config.clone()).with_backup_dir(backup_dir.clone());
    let app = build_router(state, Some(static_dir.clone()));

    let addr = SocketAddr::new(host, port);
    let tz_offset = chrono::Local::now().offset().to_string();
    tracing::info!(
        "NotaDigital v{} ({}) aktif di http://{} (tz: {}, database: {}, static: {}, backups: {}, admin: {}, max_failed: {}, lockout_min: {})",
        APP_VERSION,
        APP_GIT_SHA,
        addr,
        tz_offset,
        database_url,
        static_dir.display(),
        backup_dir.display(),
        auth_config.admin_username,
        auth_config.max_failed_attempts,
        auth_config.lockout_minutes
    );

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("Gagal bind port server");
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await
    .expect("Server berhenti dengan error");

    tracing::info!("Server berhenti dengan bersih, menutup koneksi database...");
    pool.close().await;
}
