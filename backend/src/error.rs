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

    #[error("{0}")]
    Unauthorized(String),

    #[error("{0}")]
    Forbidden(String),

    #[error("{0}")]
    Locked(String),

    #[error("{0}")]
    TooManyRequests(String),

    #[error("{0}")]
    Internal(String),

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
            AppError::Unauthorized(msg) => (StatusCode::UNAUTHORIZED, "UNAUTHORIZED", msg.clone()),
            AppError::Forbidden(msg) => (StatusCode::FORBIDDEN, "FORBIDDEN", msg.clone()),
            AppError::Locked(msg) => (StatusCode::LOCKED, "ACCOUNT_LOCKED", msg.clone()),
            AppError::TooManyRequests(msg) => (
                StatusCode::TOO_MANY_REQUESTS,
                "TOO_MANY_REQUESTS",
                msg.clone(),
            ),
            AppError::Internal(msg) => {
                tracing::error!(error = %msg, "internal error");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "INTERNAL_ERROR",
                    "Terjadi kesalahan internal pada server".to_string(),
                )
            }
            AppError::Database(err) => {
                // Map SQLite UNIQUE constraint violation (2067) to 409 Conflict as defense-in-depth
                if let sqlx::Error::Database(db_err) = err {
                    if db_err.code().as_deref() == Some("2067")
                        || db_err.code().as_deref() == Some("1555")
                    {
                        return (
                            StatusCode::CONFLICT,
                            Json(ErrorBody {
                                code: "CONFLICT",
                                error: "Data duplikat atau sudah terdaftar".to_string(),
                            }),
                        )
                            .into_response();
                    }
                }
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
