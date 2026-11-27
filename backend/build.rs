use std::{fs, path::Path, process::Command};

fn sanitize_sha(raw: &str) -> Option<String> {
    let cleaned: String = raw
        .trim()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(16)
        .collect();
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
    }
}

fn watch_git_head() {
    let git_dir = Path::new("../.git");
    let head_path = git_dir.join("HEAD");
    if !head_path.exists() {
        return;
    }
    println!("cargo:rerun-if-changed=../.git/HEAD");
    if let Ok(head_contents) = fs::read_to_string(&head_path) {
        if let Some(ref_rel) = head_contents.trim().strip_prefix("ref:") {
            let ref_rel = ref_rel.trim();
            if git_dir.join(ref_rel).exists() {
                println!("cargo:rerun-if-changed=../.git/{ref_rel}");
            }
        }
    }
    if git_dir.join("packed-refs").exists() {
        println!("cargo:rerun-if-changed=../.git/packed-refs");
    }
}

fn main() {
    println!("cargo:rerun-if-env-changed=GIT_SHA");

    let env_sha = std::env::var("GIT_SHA").ok().and_then(|v| sanitize_sha(&v));
    if env_sha.is_none() {
        watch_git_head();
    }

    let git_sha = env_sha
        .or_else(|| {
            Command::new("git")
                .args(["rev-parse", "--short", "HEAD"])
                .output()
                .ok()
                .filter(|o| o.status.success())
                .and_then(|o| String::from_utf8(o.stdout).ok())
                .and_then(|s| sanitize_sha(&s))
        })
        .unwrap_or_else(|| "unknown".to_string());

    println!("cargo:rustc-env=APP_GIT_SHA={git_sha}");
}
