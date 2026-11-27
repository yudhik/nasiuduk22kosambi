pub mod auth;
pub mod db;
pub mod error;
pub mod handlers;
pub mod models;

use auth::AuthConfig;
use axum::{
    extract::{DefaultBodyLimit, State},
    http::{header, HeaderValue, Method},
    middleware::{self, Next},
    response::Response,
    routing::{get, post, put},
    Json, Router,
};
use error::AppError;
use serde_json::{json, Value};
use sqlx::SqlitePool;
use std::{path::PathBuf, sync::Arc};
use tokio::sync::Semaphore;
use tower_http::{
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};

#[derive(Clone)]
pub struct AppState {
    pub pool: SqlitePool,
    pub auth_config: AuthConfig,
    pub hash_semaphore: Arc<Semaphore>,
    pub backup_dir: PathBuf,
}

impl AppState {
    pub fn new(pool: SqlitePool, auth_config: AuthConfig) -> Self {
        Self {
            pool,
            auth_config: auth_config.redacted_for_state(),
            // Cap concurrent Argon2id calls to 2 (~38 MiB peak RAM) to protect 1 vCPU / 956 MiB host
            hash_semaphore: Arc::new(Semaphore::new(2)),
            backup_dir: PathBuf::from("backups"),
        }
    }

    pub fn with_backup_dir(mut self, backup_dir: PathBuf) -> Self {
        self.backup_dir = backup_dir;
        self
    }
}

pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const APP_GIT_SHA: &str = env!("APP_GIT_SHA");

async fn health_check() -> Json<Value> {
    Json(json!({
        "status": "ok",
        "version": APP_VERSION,
        "git_sha": APP_GIT_SHA,
    }))
}

/// Defense-in-depth CSRF guard for state-changing API routes:
/// requires either `Sec-Fetch-Site: same-origin` (or `none`) or custom `X-Requested-With` header.
async fn csrf_guard(
    req: axum::http::Request<axum::body::Body>,
    next: Next,
) -> Result<Response, AppError> {
    let is_mutating = matches!(
        *req.method(),
        Method::POST | Method::PUT | Method::PATCH | Method::DELETE
    );
    if is_mutating {
        if let Some(sfs) = req
            .headers()
            .get("sec-fetch-site")
            .and_then(|v| v.to_str().ok())
        {
            if sfs != "same-origin" && sfs != "none" {
                return Err(AppError::Forbidden(
                    "Permintaan lintas-situs ditolak (CSRF protection)".into(),
                ));
            }
        }
    }
    Ok(next.run(req).await)
}

async fn security_headers(
    State(state): State<AppState>,
    req: axum::http::Request<axum::body::Body>,
    next: Next,
) -> Response {
    let is_api = req.uri().path().starts_with("/api/");
    let mut res = next.run(req).await;
    let headers = res.headers_mut();
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("same-origin"),
    );
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'",
        ),
    );
    if state.auth_config.cookie_secure {
        headers.insert(
            header::STRICT_TRANSPORT_SECURITY,
            HeaderValue::from_static("max-age=31536000; includeSubDomains"),
        );
    }
    if is_api && !headers.contains_key(header::CACHE_CONTROL) {
        headers.insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-store"),
        );
    }
    res
}

pub fn build_router(state: AppState, static_dir: Option<PathBuf>) -> Router {
    // Tight 4 KiB body limit on /api/auth/login to prevent oversized payload abuse
    let login_route = Router::new()
        .route("/auth/login", post(handlers::auth::login))
        .layer(DefaultBodyLimit::max(4 * 1024));

    let api_routes = Router::new()
        .route("/health", get(health_check))
        .merge(login_route)
        // Authentication (Unified for all roles including Admin)
        .route("/auth/logout", post(handlers::auth::logout))
        .route("/auth/me", get(handlers::auth::me))
        // Admin: User Management & Login/Logout Audit
        .route(
            "/admin/users",
            get(handlers::admin::list_users).post(handlers::admin::create_user),
        )
        .route("/admin/users/:id", put(handlers::admin::update_user))
        .route(
            "/admin/users/:id/reset-password",
            post(handlers::admin::reset_password),
        )
        .route("/admin/users/:id/unlock", post(handlers::admin::unlock_user))
        .route("/admin/sessions", get(handlers::admin::list_sessions))
        .route("/admin/auth-events", get(handlers::admin::list_auth_events))
        .route(
            "/admin/receipt-settings",
            put(handlers::admin::update_receipt_settings),
        )
        .route("/receipt-settings", get(handlers::admin::get_receipt_settings))
        // Daily Store Open / Close Lifecycle
        .route("/store/status", get(handlers::store::get_store_status))
        .route("/store/open", post(handlers::store::open_store))
        .route("/store/close", post(handlers::store::close_store))
        .route("/store/reset-day", post(handlers::store::reset_store_day))
        // Stock Items (Separate daily stock entities)
        .route(
            "/stocks",
            get(handlers::stocks::list_stocks).post(handlers::stocks::create_stock),
        )
        .route(
            "/stocks/:id",
            put(handlers::stocks::update_stock).delete(handlers::stocks::delete_stock),
        )
        .route("/stocks/:id/restock", post(handlers::stocks::restock_item))
        .route(
            "/stocks/:id/set-initial",
            post(handlers::stocks::set_initial_stock_item),
        )
        // Menus & CSV Import
        .route(
            "/menus",
            get(handlers::menu::list_menus).post(handlers::menu::create_menu),
        )
        .route("/menus/import-csv", post(handlers::menu::import_menus_csv))
        .route(
            "/menus/template.csv",
            get(handlers::menu::download_menu_csv_template),
        )
        .route(
            "/menus/:id",
            put(handlers::menu::update_menu).delete(handlers::menu::delete_menu),
        )
        // Extensible Sales Channels
        .route(
            "/channels",
            get(handlers::channels::list_channels).post(handlers::channels::create_channel),
        )
        .route("/channels/:id", put(handlers::channels::update_channel))
        // Daily Expenses
        .route(
            "/expenses",
            get(handlers::expenses::list_expenses).post(handlers::expenses::create_expense),
        )
        .route(
            "/expenses/:id",
            put(handlers::expenses::update_expense).delete(handlers::expenses::delete_expense),
        )
        .route(
            "/expense-categories",
            get(handlers::expenses::list_expense_categories)
                .post(handlers::expenses::create_expense_category),
        )
        .route(
            "/expense-categories/:id",
            put(handlers::expenses::update_expense_category),
        )
        // Promotions (Quota-based discounts + receipt promo section)
        .route(
            "/promotions",
            get(handlers::promotions::list_promotions)
                .post(handlers::promotions::create_promotion),
        )
        .route(
            "/promotions/:id",
            put(handlers::promotions::update_promotion)
                .delete(handlers::promotions::delete_promotion),
        )
        // Orders (Nota Digital)
        .route(
            "/orders",
            get(handlers::orders::list_orders).post(handlers::orders::create_order),
        )
        .route("/orders/:id", get(handlers::orders::get_order))
        .route(
            "/orders/:id/promo",
            post(handlers::orders::apply_order_promo)
                .delete(handlers::orders::remove_order_promo),
        )
        .route("/orders/:id/pay", post(handlers::orders::pay_order))
        .route("/orders/:id/void", post(handlers::orders::void_order))
        // Reports, Reconciliation & Performance Analytics
        .route("/reports/daily", get(handlers::reports::get_daily_report))
        .route(
            "/reports/daily/physical-stock",
            put(handlers::reports::update_physical_stock),
        )
        .route(
            "/reports/daily/export.csv",
            get(handlers::reports::export_daily_csv),
        )
        .route(
            "/reports/movements",
            get(handlers::reports::list_stock_movements),
        )
        .route(
            "/analytics/performance",
            get(handlers::reports::get_performance_analytics),
        )
        // Return JSON 404 for unknown /api/* paths instead of serving index.html
        .fallback(|| async { AppError::NotFound("Endpoint API tidak ditemukan".into()) })
        .layer(middleware::from_fn(csrf_guard))
        .layer(DefaultBodyLimit::max(2 * 1024 * 1024));

    let mut router = Router::new().nest("/api", api_routes);

    // Attach SPA fallback BEFORE security_headers & TraceLayer so index.html & static assets also get security headers!
    if let Some(dir) = static_dir {
        if dir.exists() {
            let index_file = dir.join("index.html");
            let serve = ServeDir::new(dir).not_found_service(ServeFile::new(index_file));
            router = router.fallback_service(serve);
        }
    }

    router
        .layer(middleware::from_fn_with_state(
            state.clone(),
            security_headers,
        ))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}
