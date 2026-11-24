use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("{0}")]
    NotFound(String),

    #[error("{0}")]
    Validation(String),

    #[error("Stok '{menu_name}' tidak mencukupi (tersedia {available}, diminta {requested})")]
    InsufficientStock {
        menu_name: String,
        available: i64,
        requested: i64,
    },

    #[error("{0}")]
    Conflict(String),

    #[error("Terjadi kesalahan database: {0}")]
    Database(#[from] sqlx::Error),
}

#[derive(Serialize)]
struct ErrorBody {
    code: &'static str,
    error: String,
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, code, message) = match &self {
            AppError::NotFound(msg) => (StatusCode::NOT_FOUND, "NOT_FOUND", msg.clone()),
            AppError::Validation(msg) => (StatusCode::BAD_REQUEST, "VALIDATION_ERROR", msg.clone()),
            AppError::InsufficientStock { .. } => (
                StatusCode::CONFLICT,
                "INSUFFICIENT_STOCK",
                self.to_string(),
            ),
            AppError::Conflict(msg) => (StatusCode::CONFLICT, "CONFLICT", msg.clone()),
            AppError::Database(err) => {
                tracing::error!(error = %err, "database error");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "DATABASE_ERROR",
                    "Terjadi kesalahan pada database internal".to_string(),
                )
            }
        };

        (status, Json(ErrorBody { code, error: message })).into_response()
    }
}

pub type AppResult<T> = Result<T, AppError>;
