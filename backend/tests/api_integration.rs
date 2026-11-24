use axum::{
    body::Body,
    http::{Method, Request, StatusCode},
};
use http_body_util::BodyExt;
use nota_digital_backend::{
    build_router,
    db::init_pool,
    models::{DailyReportResponse, MenuItem, OrderDetail},
    AppState,
};
use serde_json::{json, Value};
use tower::ServiceExt;

async fn setup_app() -> axum::Router {
    let pool = init_pool("sqlite::memory:", false)
        .await
        .expect("failed to init in-memory sqlite");
    build_router(AppState { pool }, None)
}

async fn send_json(
    app: &axum::Router,
    method: Method,
    uri: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let builder = Request::builder().method(method).uri(uri);
    let req = match body {
        Some(val) => builder
            .header("content-type", "application/json")
            .body(Body::from(val.to_string()))
            .unwrap(),
        None => builder.body(Body::empty()).unwrap(),
    };

    let response = app.clone().oneshot(req).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let parsed = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into_owned()))
    };
    (status, parsed)
}

#[tokio::test]
async fn test_full_order_stock_reconciliation_and_void_flow() {
    let app = setup_app().await;

    // 1. Create two menu items
    let (status, nasi_val) = send_json(
        &app,
        Method::POST,
        "/api/menus",
        Some(json!({
            "name": "Nasi Uduk",
            "category": "Makanan",
            "price": 10000,
            "current_stock": 20,
            "default_daily_stock": 20
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let nasi: MenuItem = serde_json::from_value(nasi_val).unwrap();

    let (status, ayam_val) = send_json(
        &app,
        Method::POST,
        "/api/menus",
        Some(json!({
            "name": "Ayam Goreng",
            "category": "Lauk",
            "price": 18000,
            "current_stock": 5,
            "default_daily_stock": 10
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let ayam: MenuItem = serde_json::from_value(ayam_val).unwrap();

    // 2. Order exceeding stock on second item must FAIL (409) and ROLLBACK first item
    let (status, err_val) = send_json(
        &app,
        Method::POST,
        "/api/orders",
        Some(json!({
            "customer_label": "Meja 1",
            "items": [
                { "menu_item_id": nasi.id, "quantity": 4 },
                { "menu_item_id": ayam.id, "quantity": 6 }
            ]
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(err_val["code"], "INSUFFICIENT_STOCK");

    // Verify Nasi Uduk stock was NOT deducted
    let (_, menus_val) = send_json(&app, Method::GET, "/api/menus", None).await;
    let menus: Vec<MenuItem> = serde_json::from_value(menus_val).unwrap();
    let nasi_after_fail = menus.iter().find(|m| m.id == nasi.id).unwrap();
    assert_eq!(nasi_after_fail.current_stock, 20);

    // 3. Create valid Order #1
    let (status, order1_val) = send_json(
        &app,
        Method::POST,
        "/api/orders",
        Some(json!({
            "customer_label": "Meja 2",
            "waiter_name": "Budi",
            "items": [
                { "menu_item_id": nasi.id, "quantity": 3, "item_note": "sambal pisah" },
                { "menu_item_id": ayam.id, "quantity": 2 }
            ]
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let order1: OrderDetail = serde_json::from_value(order1_val).unwrap();
    assert_eq!(order1.status, "UNPAID");
    assert_eq!(order1.total_amount, 3 * 10000 + 2 * 18000);
    assert!(order1.order_number.ends_with("-001"));

    // 4. Change price of Nasi Uduk -> existing order snapshot must remain untouched
    let (status, _) = send_json(
        &app,
        Method::PUT,
        &format!("/api/menus/{}", nasi.id),
        Some(json!({
            "name": "Nasi Uduk Spesial",
            "category": "Makanan",
            "price": 15000,
            "default_daily_stock": 20,
            "is_active": true
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (_, fetched_order1_val) =
        send_json(&app, Method::GET, &format!("/api/orders/{}", order1.id), None).await;
    let fetched_order1: OrderDetail = serde_json::from_value(fetched_order1_val).unwrap();
    assert_eq!(fetched_order1.total_amount, 66000);
    assert_eq!(fetched_order1.items[0].menu_name_snapshot, "Nasi Uduk");
    assert_eq!(fetched_order1.items[0].unit_price_snapshot, 10000);

    // 5. Pay Order #1 -> PAID; double-pay must return 409; voiding PAID must return 409
    let (status, paid_val) =
        send_json(&app, Method::POST, &format!("/api/orders/{}/pay", order1.id), None).await;
    assert_eq!(status, StatusCode::OK);
    let paid_order: OrderDetail = serde_json::from_value(paid_val).unwrap();
    assert_eq!(paid_order.status, "PAID");
    assert!(paid_order.paid_at.is_some());

    let (status, _) =
        send_json(&app, Method::POST, &format!("/api/orders/{}/pay", order1.id), None).await;
    assert_eq!(status, StatusCode::CONFLICT);

    let (status, _) = send_json(
        &app,
        Method::POST,
        &format!("/api/orders/{}/void", order1.id),
        Some(json!({ "reason": "Salah" })),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);

    // 6. Create Order #2 and VOID it -> stock must be restored
    let (status, order2_val) = send_json(
        &app,
        Method::POST,
        "/api/orders",
        Some(json!({
            "customer_label": "Meja 5",
            "items": [
                { "menu_item_id": ayam.id, "quantity": 3 }
            ]
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let order2: OrderDetail = serde_json::from_value(order2_val).unwrap();

    // Ayam stock should now be 0 (5 - 2 - 3)
    let (_, menus_val) = send_json(&app, Method::GET, "/api/menus", None).await;
    let menus: Vec<MenuItem> = serde_json::from_value(menus_val).unwrap();
    assert_eq!(menus.iter().find(|m| m.id == ayam.id).unwrap().current_stock, 0);

    // Void Order #2
    let (status, voided_val) = send_json(
        &app,
        Method::POST,
        &format!("/api/orders/{}/void", order2.id),
        Some(json!({ "reason": "Pelanggan batal pesan" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let voided: OrderDetail = serde_json::from_value(voided_val).unwrap();
    assert_eq!(voided.status, "VOIDED");
    assert_eq!(voided.void_reason.as_deref(), Some("Pelanggan batal pesan"));

    // Restock Ayam +4 mid-day (3 + 4 = 7 remaining)
    let (status, _) = send_json(
        &app,
        Method::POST,
        &format!("/api/menus/{}/stock/restock", ayam.id),
        Some(json!({ "quantity": 4, "note": "Goreng batch 2" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // 7. Submit physical stock opname and verify daily report reconciliation
    let (status, report_val) = send_json(
        &app,
        Method::PUT,
        "/api/reports/daily/physical-stock",
        Some(json!({
            "entries": [
                { "menu_item_id": nasi.id, "physical_stock": 17, "notes": "Cocok" },
                { "menu_item_id": ayam.id, "physical_stock": 6, "notes": "1 potong jatuh" }
            ]
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let report: DailyReportResponse = serde_json::from_value(report_val).unwrap();

    assert_eq!(report.revenue.paid_count, 1);
    assert_eq!(report.revenue.paid_total, 66000);
    assert_eq!(report.revenue.unpaid_count, 0);
    assert_eq!(report.revenue.voided_count, 1);
    assert_eq!(report.revenue.voided_total, 54000);
    assert_eq!(report.revenue.total_portions_sold, 5);

    let ayam_rec = report
        .stock_reconciliation
        .iter()
        .find(|r| r.menu_item_id == ayam.id)
        .unwrap();
    assert_eq!(ayam_rec.initial_stock, 5);
    assert_eq!(ayam_rec.restocked_qty, 4);
    assert_eq!(ayam_rec.sold_qty, 2);
    assert_eq!(ayam_rec.voided_qty, 3);
    assert_eq!(ayam_rec.system_remaining, 7);
    assert_eq!(ayam_rec.physical_stock, Some(6));
    assert_eq!(ayam_rec.variance, Some(-1));

    let nasi_rec = report
        .stock_reconciliation
        .iter()
        .find(|r| r.menu_item_id == nasi.id)
        .unwrap();
    assert_eq!(nasi_rec.system_remaining, 17);
    assert_eq!(nasi_rec.variance, Some(0));
}

#[tokio::test]
async fn test_start_day_set_initial_and_menu_delete_rules() {
    let app = setup_app().await;

    let (_, menu_a_val) = send_json(
        &app,
        Method::POST,
        "/api/menus",
        Some(json!({
            "name": "Es Teh Manis",
            "category": "Minuman",
            "price": 5000,
            "current_stock": 10,
            "default_daily_stock": 50
        })),
    )
    .await;
    let menu_a: MenuItem = serde_json::from_value(menu_a_val).unwrap();

    let (_, menu_b_val) = send_json(
        &app,
        Method::POST,
        "/api/menus",
        Some(json!({
            "name": "Kerupuk",
            "category": "Tambahan",
            "price": 2000,
            "current_stock": 5,
            "default_daily_stock": 25
        })),
    )
    .await;
    let menu_b: MenuItem = serde_json::from_value(menu_b_val).unwrap();

    // Start day should reset both menus to their default_daily_stock
    let (status, start_val) = send_json(&app, Method::POST, "/api/stock/start-day", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(start_val["initialized_count"], 2);
    assert_eq!(start_val["skipped_with_sales"], 0);

    // Order 10 Es Teh Manis
    let (status, _) = send_json(
        &app,
        Method::POST,
        "/api/orders",
        Some(json!({
            "items": [{ "menu_item_id": menu_a.id, "quantity": 10 }]
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);

    // Setting initial stock below already-sold qty (5 < 10) must fail with 400
    let (status, _) = send_json(
        &app,
        Method::POST,
        &format!("/api/menus/{}/stock/set-initial", menu_a.id),
        Some(json!({ "initial_stock": 5 })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Setting initial stock to 40 should adjust current_stock to 40 - 10 = 30
    let (status, updated_val) = send_json(
        &app,
        Method::POST,
        &format!("/api/menus/{}/stock/set-initial", menu_a.id),
        Some(json!({ "initial_stock": 40, "note": "Koreksi stok pagi" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let updated_a: MenuItem = serde_json::from_value(updated_val).unwrap();
    assert_eq!(updated_a.current_stock, 30);

    // Deleting menu_a (referenced by order) must soft-delete; menu_b (unused) must hard-delete
    let (status, del_a) = send_json(
        &app,
        Method::DELETE,
        &format!("/api/menus/{}", menu_a.id),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(del_a["soft_deleted"], true);

    let (status, del_b) = send_json(
        &app,
        Method::DELETE,
        &format!("/api/menus/{}", menu_b.id),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(del_b["soft_deleted"], false);
}

#[tokio::test]
async fn test_csv_export_and_stock_movements() {
    let app = setup_app().await;

    let (_, menu_val) = send_json(
        &app,
        Method::POST,
        "/api/menus",
        Some(json!({
            "name": "Tempe Goreng",
            "category": "Lauk",
            "price": 4000,
            "current_stock": 15
        })),
    )
    .await;
    let menu: MenuItem = serde_json::from_value(menu_val).unwrap();

    let (status, _) = send_json(
        &app,
        Method::POST,
        "/api/orders",
        Some(json!({
            "customer_label": "Meja 7",
            "items": [{ "menu_item_id": menu.id, "quantity": 3 }]
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);

    let (status, movements_val) =
        send_json(&app, Method::GET, "/api/reports/movements", None).await;
    assert_eq!(status, StatusCode::OK);
    assert!(movements_val.as_array().unwrap().len() >= 2);

    let req = Request::builder()
        .method(Method::GET)
        .uri("/api/reports/daily/export.csv")
        .body(Body::empty())
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert!(res
        .headers()
        .get("content-type")
        .unwrap()
        .to_str()
        .unwrap()
        .starts_with("text/csv"));
    let body = String::from_utf8(res.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap();
    assert!(body.contains("REKONSILIASI STOK HARIAN"));
    assert!(body.contains("Tempe Goreng"));
    assert!(body.contains("Meja 7"));
}
