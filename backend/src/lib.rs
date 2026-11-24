pub mod db;
pub mod error;
pub mod handlers;
pub mod models;

use axum::{
    routing::{get, post, put},
    Json, Router,
};
use serde_json::{json, Value};
use sqlx::SqlitePool;
use std::path::PathBuf;
use tower_http::{
    cors::{Any, CorsLayer},
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};

#[derive(Clone)]
pub struct AppState {
    pub pool: SqlitePool,
}

async fn health_check() -> Json<Value> {
    Json(json!({ "status": "ok" }))
}

pub fn build_router(state: AppState, static_dir: Option<PathBuf>) -> Router {
    let api_routes = Router::new()
        .route("/health", get(health_check))
        // Menus & Daily Stock
        .route(
            "/menus",
            get(handlers::menu::list_menus).post(handlers::menu::create_menu),
        )
        .route(
            "/menus/:id",
            put(handlers::menu::update_menu).delete(handlers::menu::delete_menu),
        )
        .route(
            "/menus/:id/stock/set-initial",
            post(handlers::menu::set_initial_stock),
        )
        .route("/menus/:id/stock/restock", post(handlers::menu::restock_menu))
        .route("/stock/start-day", post(handlers::menu::start_day))
        // Orders (Nota Digital)
        .route(
            "/orders",
            get(handlers::orders::list_orders).post(handlers::orders::create_order),
        )
        .route("/orders/:id", get(handlers::orders::get_order))
        .route("/orders/:id/pay", post(handlers::orders::pay_order))
        .route("/orders/:id/void", post(handlers::orders::void_order))
        // Reports & Reconciliation
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
        );

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let mut router = Router::new()
        .nest("/api", api_routes)
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    if let Some(dir) = static_dir {
        if dir.exists() {
            let index_file = dir.join("index.html");
            let serve = ServeDir::new(dir).not_found_service(ServeFile::new(index_file));
            router = router.fallback_service(serve);
        }
    }

    router
}
