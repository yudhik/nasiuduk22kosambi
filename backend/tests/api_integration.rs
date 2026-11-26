use axum::{
    body::Body,
    http::{header, Method, Request, StatusCode},
};
use http_body_util::BodyExt;
use nota_digital_backend::{
    auth::{sync_env_admin, unlock_user_by_username, AuthConfig},
    build_router,
    db::init_pool,
    models::{
        AdminUserSummary, AuthUserResponse, DailyExpense, DailyReportResponse,
        ImportMenuCsvResponse, MenuItem, OrderDetail, PerformanceAnalyticsResponse, SalesChannel,
        StockItem, StoreStatusResponse, UserSessionLog,
    },
    AppState,
};
use serde_json::{json, Value};
use sqlx::SqlitePool;
use tower::ServiceExt;

fn test_auth_config(max_failed_attempts: i64, lockout_minutes: i64) -> AuthConfig {
    AuthConfig {
        admin_username: "superadmin".to_string(),
        admin_password: "AdminSecret123!".to_string(),
        max_failed_attempts,
        lockout_minutes,
        session_ttl_hours: 12,
        cookie_secure: false,
    }
}

async fn setup_app_with_config(auth_config: AuthConfig) -> (axum::Router, SqlitePool) {
    let pool = init_pool("sqlite::memory:", false)
        .await
        .expect("failed to init in-memory sqlite");
    sync_env_admin(&pool, &auth_config)
        .await
        .expect("failed to sync env admin");
    let app = build_router(AppState::new(pool.clone(), auth_config), None);
    (app, pool)
}

async fn setup_app() -> (axum::Router, SqlitePool, String) {
    let cfg = test_auth_config(5, 15);
    let (app, pool) = setup_app_with_config(cfg.clone()).await;
    let (status, _, cookie) = login_request(&app, &cfg.admin_username, &cfg.admin_password).await;
    assert_eq!(status, StatusCode::OK);
    (app, pool, cookie.expect("admin session cookie"))
}

async fn send_json_with_cookie(
    app: &axum::Router,
    method: Method,
    uri: &str,
    cookie: Option<&str>,
    body: Option<Value>,
) -> (StatusCode, Value, Option<String>) {
    let mut builder = Request::builder().method(method).uri(uri);
    if let Some(c) = cookie {
        builder = builder.header(header::COOKIE, c);
    }
    let req = match body {
        Some(val) => builder
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(val.to_string()))
            .unwrap(),
        None => builder.body(Body::empty()).unwrap(),
    };

    let response = app.clone().oneshot(req).await.unwrap();
    let status = response.status();
    let set_cookie = response
        .headers()
        .get(header::SET_COOKIE)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.split(';').next())
        .map(str::to_string);
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let parsed = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into_owned()))
    };
    (status, parsed, set_cookie)
}

async fn login_request(
    app: &axum::Router,
    username: &str,
    password: &str,
) -> (StatusCode, Value, Option<String>) {
    send_json_with_cookie(
        app,
        Method::POST,
        "/api/auth/login",
        None,
        Some(json!({ "username": username, "password": password })),
    )
    .await
}

async fn create_stock(app: &axum::Router, cookie: &str, name: &str, unit: &str) -> StockItem {
    let (status, val, _) = send_json_with_cookie(
        app,
        Method::POST,
        "/api/stocks",
        Some(cookie),
        Some(json!({ "name": name, "unit": unit })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    serde_json::from_value(val).unwrap()
}

#[tokio::test]
async fn test_multistock_store_lifecycle_channels_expenses_and_analytics() {
    let (app, _pool, admin_cookie) = setup_app().await;

    // 1. Create separate stock items
    let s_nasi = create_stock(&app, &admin_cookie, "Nasi Uduk", "porsi").await;
    let s_ayam = create_stock(&app, &admin_cookie, "Ayam Goreng", "potong").await;
    let s_teh = create_stock(&app, &admin_cookie, "Es Teh Manis", "gelas").await;

    // Menu without stock requirements must be rejected (400)
    let (status, _, _) = send_json_with_cookie(
        &app,
        Method::POST,
        "/api/menus",
        Some(&admin_cookie),
        Some(json!({
            "name": "Invalid Menu",
            "category": "Makanan",
            "price": 10000,
            "stock_requirements": []
        })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // 2. Create single-stock menu and multi-stock combo menu
    let (status, nasi_val, _) = send_json_with_cookie(
        &app,
        Method::POST,
        "/api/menus",
        Some(&admin_cookie),
        Some(json!({
            "name": "Nasi Uduk Biasa",
            "category": "Makanan",
            "price": 10000,
            "stock_requirements": [{ "stock_item_id": s_nasi.id, "qty_per_unit": 1 }]
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let m_nasi: MenuItem = serde_json::from_value(nasi_val).unwrap();

    let (status, paket_val, _) = send_json_with_cookie(
        &app,
        Method::POST,
        "/api/menus",
        Some(&admin_cookie),
        Some(json!({
            "name": "Paket Ayam Komplit",
            "category": "Paket",
            "price": 30000,
            "stock_requirements": [
                { "stock_item_id": s_nasi.id, "qty_per_unit": 1 },
                { "stock_item_id": s_ayam.id, "qty_per_unit": 1 },
                { "stock_item_id": s_teh.id, "qty_per_unit": 1 }
            ]
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let m_paket: MenuItem = serde_json::from_value(paket_val).unwrap();
    assert_eq!(m_paket.available_stock, 0);

    // 3. Ordering BEFORE opening the store must be rejected (409)
    let (status, _, _) = send_json_with_cookie(
        &app,
        Method::POST,
        "/api/orders",
        Some(&admin_cookie),
        Some(json!({
            "items": [{ "menu_item_id": m_nasi.id, "quantity": 1 }]
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);

    // 4. Open store with initial stocks: Nasi=10, Ayam=3, Teh=0 (so Paket must show 0 available!)
    let (status, st_val, _) = send_json_with_cookie(
        &app,
        Method::POST,
        "/api/store/open",
        Some(&admin_cookie),
        Some(json!({
            "stocks": [
                { "stock_item_id": s_nasi.id, "initial_stock": 10 },
                { "stock_item_id": s_ayam.id, "initial_stock": 3 },
                { "stock_item_id": s_teh.id, "initial_stock": 0 }
            ]
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let st: StoreStatusResponse = serde_json::from_value(st_val).unwrap();
    assert_eq!(st.status, "OPEN");

    // Verify Paket availability is 0 because Es Teh is 0
    let (_, menus_val, _) =
        send_json_with_cookie(&app, Method::GET, "/api/menus", Some(&admin_cookie), None).await;
    let menus: Vec<MenuItem> = serde_json::from_value(menus_val).unwrap();
    assert_eq!(
        menus.iter().find(|m| m.id == m_paket.id).unwrap().available_stock,
        0
    );

    // Mid-day restock Es Teh +5 -> Paket availability becomes min(10, 3, 5) = 3
    let (status, _, _) = send_json_with_cookie(
        &app,
        Method::POST,
        &format!("/api/stocks/{}/restock", s_teh.id),
        Some(&admin_cookie),
        Some(json!({ "quantity": 5, "note": "Bikin es teh" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (_, menus_val, _) =
        send_json_with_cookie(&app, Method::GET, "/api/menus", Some(&admin_cookie), None).await;
    let menus: Vec<MenuItem> = serde_json::from_value(menus_val).unwrap();
    assert_eq!(
        menus.iter().find(|m| m.id == m_paket.id).unwrap().available_stock,
        3
    );

    // 5. Atomic rollback across multi-stock: ordering 2 Paket + 9 Nasi needs 11 Nasi (> 10) -> must fail 409 & keep Ayam=3
    let (status, err_val, _) = send_json_with_cookie(
        &app,
        Method::POST,
        "/api/orders",
        Some(&admin_cookie),
        Some(json!({
            "items": [
                { "menu_item_id": m_paket.id, "quantity": 2 },
                { "menu_item_id": m_nasi.id, "quantity": 9 }
            ]
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(err_val["code"], "INSUFFICIENT_STOCK");

    // 6. Channels check: Regular (UNPAID) vs GoFood (auto PAID)
    let (_, ch_val, _) =
        send_json_with_cookie(&app, Method::GET, "/api/channels", Some(&admin_cookie), None).await;
    let channels: Vec<SalesChannel> = serde_json::from_value(ch_val).unwrap();
    let ch_regular = channels.iter().find(|c| c.code == "regular").unwrap();
    let ch_gofood = channels.iter().find(|c| c.code == "gofood").unwrap();

    // Order #1 on Regular -> UNPAID; waiter_name locked to auth.username ("superadmin")
    let (status, o1_val, _) = send_json_with_cookie(
        &app,
        Method::POST,
        "/api/orders",
        Some(&admin_cookie),
        Some(json!({
            "channel_id": ch_regular.id,
            "customer_label": "Meja 1",
            "items": [{ "menu_item_id": m_paket.id, "quantity": 2 }]
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let o1: OrderDetail = serde_json::from_value(o1_val).unwrap();
    assert_eq!(o1.status, "UNPAID");
    assert_eq!(o1.channel_name, "Regular");
    assert_eq!(o1.waiter_name, "superadmin");
    assert_eq!(o1.total_amount, 60000);

    // Order #2 on GoFood -> automatically PAID!
    let (status, o2_val, _) = send_json_with_cookie(
        &app,
        Method::POST,
        "/api/orders",
        Some(&admin_cookie),
        Some(json!({
            "channel_id": ch_gofood.id,
            "customer_label": "GF-99",
            "items": [{ "menu_item_id": m_nasi.id, "quantity": 3 }]
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let o2: OrderDetail = serde_json::from_value(o2_val).unwrap();
    assert_eq!(o2.status, "PAID");
    assert!(o2.paid_at.is_some());
    assert_eq!(o2.channel_name, "GoFood");

    // 7. Record daily expense
    let (status, exp_val, _) = send_json_with_cookie(
        &app,
        Method::POST,
        "/api/expenses",
        Some(&admin_cookie),
        Some(json!({
            "title": "Beli Gas 3kg",
            "category": "Gas / Listrik",
            "amount": 22000
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let _exp: DailyExpense = serde_json::from_value(exp_val).unwrap();

    // 8. Attempting to CLOSE store while o1 is still UNPAID must be BLOCKED (409)
    let (status, _, _) = send_json_with_cookie(
        &app,
        Method::POST,
        "/api/store/close",
        Some(&admin_cookie),
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);

    // Pay o1
    let (status, _, _) = send_json_with_cookie(
        &app,
        Method::POST,
        &format!("/api/orders/{}/pay", o1.id),
        Some(&admin_cookie),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // 9. Close store with optional physical stock opname -> succeeds, resets all stocks to 0
    let (status, closed_val, _) = send_json_with_cookie(
        &app,
        Method::POST,
        "/api/store/close",
        Some(&admin_cookie),
        Some(json!({
            "physical_stocks": [
                { "stock_item_id": s_nasi.id, "physical_stock": 5, "notes": "Pas" },
                { "stock_item_id": s_ayam.id, "physical_stock": 0, "notes": "1 jatuh" }
            ],
            "closing_notes": "Hari pertama lancar"
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let closed: StoreStatusResponse = serde_json::from_value(closed_val).unwrap();
    assert_eq!(closed.status, "CLOSED");
    let summary = closed.closing_summary.unwrap();
    assert_eq!(summary.gross_revenue, 90000);
    assert_eq!(summary.total_expenses, 22000);
    assert_eq!(summary.net_profit, 68000);

    // Stocks must all be reset to 0 after closing
    let (_, stocks_val, _) =
        send_json_with_cookie(&app, Method::GET, "/api/stocks", Some(&admin_cookie), None).await;
    let stocks: Vec<StockItem> = serde_json::from_value(stocks_val).unwrap();
    assert!(stocks.iter().all(|s| s.current_stock == 0));

    // Reopening today must fail (409) and adding expenses after close must fail (409)
    let (status, _, _) = send_json_with_cookie(
        &app,
        Method::POST,
        "/api/store/open",
        Some(&admin_cookie),
        Some(json!({ "stocks": [] })),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);

    let (status, _, _) = send_json_with_cookie(
        &app,
        Method::POST,
        "/api/expenses",
        Some(&admin_cookie),
        Some(json!({ "title": "Telat", "amount": 5000 })),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);

    // 10. Verify Daily Report & Performance Analytics (preset=today)
    let (status, rep_val, _) = send_json_with_cookie(
        &app,
        Method::GET,
        "/api/reports/daily",
        Some(&admin_cookie),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let rep: DailyReportResponse = serde_json::from_value(rep_val).unwrap();
    assert_eq!(rep.store_status, "CLOSED");
    assert_eq!(rep.revenue.paid_total, 90000);
    assert_eq!(rep.revenue.total_expenses, 22000);
    assert_eq!(rep.revenue.net_profit, 68000);
    assert_eq!(rep.sales_by_channel.len(), 2);

    let (status, ana_val, _) = send_json_with_cookie(
        &app,
        Method::GET,
        "/api/analytics/performance?preset=today",
        Some(&admin_cookie),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let ana: PerformanceAnalyticsResponse = serde_json::from_value(ana_val).unwrap();
    assert_eq!(ana.summary.total_revenue, 90000);
    assert_eq!(ana.summary.total_expenses, 22000);
    assert_eq!(ana.summary.net_profit, 68000);
    assert_eq!(ana.summary.closed_days_count, 1);
    assert_eq!(ana.by_channel.len(), 2);
    assert_eq!(ana.user_order_intervals.len(), 1);
    assert_eq!(ana.user_order_intervals[0].username, "superadmin");
    assert_eq!(ana.user_order_intervals[0].orders_created, 2);
    assert_eq!(ana.user_order_intervals[0].interval_samples, 1);
}

#[tokio::test]
async fn test_csv_menu_import_skips_duplicates_and_supports_multistock() {
    let (app, _pool, admin_cookie) = setup_app().await;

    let csv = "\
name,category,price,stock_items
Nasi Uduk Biasa,Makanan,10000,Nasi Uduk:1
Ayam Goreng,Lauk,18000,Ayam Goreng:1
Paket Komplit,Paket,26000,Nasi Uduk:1|Ayam Goreng:1
";

    let (status, res1_val, _) = send_json_with_cookie(
        &app,
        Method::POST,
        "/api/menus/import-csv",
        Some(&admin_cookie),
        Some(json!({ "csv_content": csv })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let res1: ImportMenuCsvResponse = serde_json::from_value(res1_val).unwrap();
    assert_eq!(res1.imported_count, 3);
    assert_eq!(res1.skipped_count, 0);
    assert_eq!(res1.created_stock_items, 2);

    // Re-importing with duplicates + 1 new item must SKIP duplicates
    let csv2 = "\
name,category,price,stock_items
Nasi Uduk Biasa,Makanan,99999,Nasi Uduk:1
Tempe Goreng,Lauk,4000,
";
    let (status, res2_val, _) = send_json_with_cookie(
        &app,
        Method::POST,
        "/api/menus/import-csv",
        Some(&admin_cookie),
        Some(json!({ "csv_content": csv2 })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let res2: ImportMenuCsvResponse = serde_json::from_value(res2_val).unwrap();
    assert_eq!(res2.imported_count, 1);
    assert_eq!(res2.skipped_count, 1);
    assert_eq!(res2.skipped_names, vec!["Nasi Uduk Biasa"]);

    // Verify original price of Nasi Uduk Biasa was untouched
    let (_, menus_val, _) =
        send_json_with_cookie(&app, Method::GET, "/api/menus", Some(&admin_cookie), None).await;
    let menus: Vec<MenuItem> = serde_json::from_value(menus_val).unwrap();
    let nasi = menus.iter().find(|m| m.name == "Nasi Uduk Biasa").unwrap();
    assert_eq!(nasi.price, 10000);
}

#[tokio::test]
async fn test_unified_login_rbac_paid_void_rules_and_session_timestamps() {
    let (app, _pool, admin_cookie) = setup_app().await;

    // 1. Unauthenticated calls must return 401
    for path in [
        "/api/menus",
        "/api/stocks",
        "/api/orders",
        "/api/reports/daily",
        "/api/analytics/performance",
        "/api/admin/users",
    ] {
        let (status, _, _) = send_json_with_cookie(&app, Method::GET, path, None, None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "expected 401 for {path}");
    }

    // 2. Admin creates waiter, cashier, and owner
    for (uname, fname, role) in [
        ("pelayan1", "Siti Pelayan", "waiter"),
        ("kasir1", "Andi Kasir", "cashier"),
        ("pemilik1", "Bu Kosambi", "owner"),
    ] {
        let (status, _, _) = send_json_with_cookie(
            &app,
            Method::POST,
            "/api/admin/users",
            Some(&admin_cookie),
            Some(json!({
                "username": uname,
                "full_name": fname,
                "role": role,
                "password": "password123"
            })),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
    }

    let (_, owner_val, owner_cookie) = login_request(&app, "pemilik1", "password123").await;
    let owner_me: AuthUserResponse = serde_json::from_value(owner_val).unwrap();
    assert_eq!(
        owner_me.allowed_tabs,
        vec!["waiter", "cashier", "menu", "expenses", "report"]
    );
    let owner_cookie = owner_cookie.unwrap();

    // Owner gets 403 on admin endpoint
    let (status, _, _) = send_json_with_cookie(
        &app,
        Method::GET,
        "/api/admin/users",
        Some(&owner_cookie),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // Owner sets up stock + menu + opens store
    let stk = create_stock(&app, &owner_cookie, "Ayam Bakar", "potong").await;
    let (status, m_val, _) = send_json_with_cookie(
        &app,
        Method::POST,
        "/api/menus",
        Some(&owner_cookie),
        Some(json!({
            "name": "Ayam Bakar",
            "category": "Lauk",
            "price": 20000,
            "stock_requirements": [{ "stock_item_id": stk.id, "qty_per_unit": 1 }]
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let menu: MenuItem = serde_json::from_value(m_val).unwrap();

    let (status, _, _) = send_json_with_cookie(
        &app,
        Method::POST,
        "/api/store/open",
        Some(&owner_cookie),
        Some(json!({ "stocks": [{ "stock_item_id": stk.id, "initial_stock": 10 }] })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // Waiter creates an auto-paid GoFood order -> waiter_name must be "pelayan1"
    let (_, _, waiter_cookie) = login_request(&app, "pelayan1", "password123").await;
    let waiter_cookie = waiter_cookie.unwrap();

    let (_, ch_val, _) =
        send_json_with_cookie(&app, Method::GET, "/api/channels", Some(&waiter_cookie), None).await;
    let channels: Vec<SalesChannel> = serde_json::from_value(ch_val).unwrap();
    let ch_gofood = channels.iter().find(|c| c.code == "gofood").unwrap();

    let (status, o_val, _) = send_json_with_cookie(
        &app,
        Method::POST,
        "/api/orders",
        Some(&waiter_cookie),
        Some(json!({
            "channel_id": ch_gofood.id,
            "items": [{ "menu_item_id": menu.id, "quantity": 2 }]
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let order: OrderDetail = serde_json::from_value(o_val).unwrap();
    assert_eq!(order.status, "PAID");
    assert_eq!(order.waiter_name, "pelayan1");

    // Cashier CANNOT void a PAID online order (403 Forbidden)
    let (_, _, cashier_cookie) = login_request(&app, "kasir1", "password123").await;
    let cashier_cookie = cashier_cookie.unwrap();

    let (status, _, _) = send_json_with_cookie(
        &app,
        Method::POST,
        &format!("/api/orders/{}/void", order.id),
        Some(&cashier_cookie),
        Some(json!({ "reason": "Salah input" })),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // Owner CAN void the PAID order -> stock restores from 8 back to 10
    let (status, _, _) = send_json_with_cookie(
        &app,
        Method::POST,
        &format!("/api/orders/{}/void", order.id),
        Some(&owner_cookie),
        Some(json!({ "reason": "Salah input driver" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (_, stocks_val, _) =
        send_json_with_cookie(&app, Method::GET, "/api/stocks", Some(&owner_cookie), None).await;
    let stocks: Vec<StockItem> = serde_json::from_value(stocks_val).unwrap();
    assert_eq!(stocks.iter().find(|s| s.id == stk.id).unwrap().current_stock, 10);

    // Waiter logout records logout_at
    let (status, _, _) = send_json_with_cookie(
        &app,
        Method::POST,
        "/api/auth/logout",
        Some(&waiter_cookie),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (_, users_val, _) = send_json_with_cookie(
        &app,
        Method::GET,
        "/api/admin/users",
        Some(&admin_cookie),
        None,
    )
    .await;
    let users: Vec<AdminUserSummary> = serde_json::from_value(users_val).unwrap();
    let w = users.iter().find(|u| u.username == "pelayan1").unwrap();
    assert!(w.last_login_at.is_some());
    assert!(w.last_logout_at.is_some());

    let (_, sess_val, _) = send_json_with_cookie(
        &app,
        Method::GET,
        &format!("/api/admin/sessions?user_id={}", w.id),
        Some(&admin_cookie),
        None,
    )
    .await;
    let sessions: Vec<UserSessionLog> = serde_json::from_value(sess_val).unwrap();
    assert_eq!(sessions[0].status, "LOGGED_OUT");
}

#[tokio::test]
async fn test_lockout_after_failed_attempts_and_zero_downtime_unlock() {
    let cfg = test_auth_config(3, 15);
    let (app, pool) = setup_app_with_config(cfg.clone()).await;

    let (status, _, admin_cookie) =
        login_request(&app, &cfg.admin_username, &cfg.admin_password).await;
    assert_eq!(status, StatusCode::OK);
    let admin_cookie = admin_cookie.unwrap();

    let (status, created_val, _) = send_json_with_cookie(
        &app,
        Method::POST,
        "/api/admin/users",
        Some(&admin_cookie),
        Some(json!({
            "username": "budi",
            "full_name": "Budi",
            "role": "waiter",
            "password": "rightpassword"
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let created: AdminUserSummary = serde_json::from_value(created_val).unwrap();

    let (status, _, _) = login_request(&app, "budi", "wrong1").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _, _) = login_request(&app, "budi", "wrong2").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, err_val, _) = login_request(&app, "budi", "wrong3").await;
    assert_eq!(status, StatusCode::LOCKED);
    assert_eq!(err_val["code"], "ACCOUNT_LOCKED");

    let (status, _, _) = login_request(&app, "budi", "rightpassword").await;
    assert_eq!(status, StatusCode::LOCKED);

    let (status, _, _) = send_json_with_cookie(
        &app,
        Method::POST,
        &format!("/api/admin/users/{}/unlock", created.id),
        Some(&admin_cookie),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, _, _) = login_request(&app, "budi", "rightpassword").await;
    assert_eq!(status, StatusCode::OK);

    // Lock admin & unlock via zero-downtime CLI helper
    for _ in 0..3 {
        let _ = login_request(&app, &cfg.admin_username, "wrong-admin").await;
    }
    let (status, _, _) = login_request(&app, &cfg.admin_username, &cfg.admin_password).await;
    assert_eq!(status, StatusCode::LOCKED);

    unlock_user_by_username(&pool, &cfg.admin_username, "CLI unlock test", "local-cli")
        .await
        .expect("CLI unlock should succeed");

    let (status, _, _) = login_request(&app, &cfg.admin_username, &cfg.admin_password).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn test_security_hardening_regression_guards() {
    let (app, _pool, admin_cookie) = setup_app().await;

    // 1. Unknown /api/* path returns JSON 404 + security headers + Cache-Control: no-store
    let req = Request::builder()
        .method(Method::GET)
        .uri("/api/does-not-exist")
        .body(Body::empty())
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
    assert_eq!(
        res.headers().get("x-content-type-options").unwrap(),
        "nosniff"
    );
    assert_eq!(res.headers().get("x-frame-options").unwrap(), "DENY");
    assert!(res.headers().get("content-security-policy").is_some());
    assert_eq!(res.headers().get("cache-control").unwrap(), "no-store");

    // 2. Cross-site mutating request rejected by CSRF guard (403)
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/stocks")
        .header(header::COOKIE, &admin_cookie)
        .header(header::CONTENT_TYPE, "application/json")
        .header("sec-fetch-site", "cross-site")
        .body(Body::from(json!({ "name": "CsrfTest" }).to_string()))
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::FORBIDDEN);

    // 3. Invalid business_date rejected with 400
    let (status, _, _) = send_json_with_cookie(
        &app,
        Method::POST,
        "/api/expenses",
        Some(&admin_cookie),
        Some(json!({ "business_date": "2026/11/26", "title": "Bad Date", "amount": 5000 })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // 4. CSV decimal price parsing (Excel .00 / ,00 must NOT inflate 100x)
    let csv = "name,category,price,stock_items\nSoto Ayam,Makanan,15000.00,Soto:1\nEs Jeruk,Minuman,\"8.000,00\",Es Jeruk:1\n";
    let (status, _, _) = send_json_with_cookie(
        &app,
        Method::POST,
        "/api/menus/import-csv",
        Some(&admin_cookie),
        Some(json!({ "csv_content": csv })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (_, menus_val, _) =
        send_json_with_cookie(&app, Method::GET, "/api/menus", Some(&admin_cookie), None).await;
    let menus: Vec<MenuItem> = serde_json::from_value(menus_val).unwrap();
    assert_eq!(menus.iter().find(|m| m.name == "Soto Ayam").unwrap().price, 15000);
    assert_eq!(menus.iter().find(|m| m.name == "Es Jeruk").unwrap().price, 8000);

    // 5. Waiter cannot see closing_summary financials on GET /api/store/status after close
    let (status, _, _) = send_json_with_cookie(
        &app,
        Method::POST,
        "/api/admin/users",
        Some(&admin_cookie),
        Some(json!({
            "username": "waiter_sec",
            "full_name": "Waiter Sec",
            "role": "waiter",
            "password": "password1234"
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let (_, _, waiter_cookie) = login_request(&app, "waiter_sec", "password1234").await;
    let waiter_cookie = waiter_cookie.unwrap();

    let (status, _, _) = send_json_with_cookie(
        &app,
        Method::POST,
        "/api/store/open",
        Some(&admin_cookie),
        Some(json!({ "stocks": [] })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, _, _) = send_json_with_cookie(
        &app,
        Method::POST,
        "/api/store/close",
        Some(&admin_cookie),
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, admin_st_val, _) = send_json_with_cookie(
        &app,
        Method::GET,
        "/api/store/status",
        Some(&admin_cookie),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let admin_st: StoreStatusResponse = serde_json::from_value(admin_st_val).unwrap();
    assert!(admin_st.closing_summary.is_some());

    let (status, waiter_st_val, _) = send_json_with_cookie(
        &app,
        Method::GET,
        "/api/store/status",
        Some(&waiter_cookie),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let waiter_st: StoreStatusResponse = serde_json::from_value(waiter_st_val).unwrap();
    assert!(waiter_st.closing_summary.is_none());
}
