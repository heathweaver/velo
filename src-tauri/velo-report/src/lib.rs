//! Local reporting kernel for Velo.
//!
//! Same JSON + HTML contract as `@realdigit/test-reporting` (Deno). Frontend
//! reporting can land later; both writers emit `tests/results/` sidecars and
//! `tests/reporting/data/status.json`.

mod audit;
mod cargo_test;
mod generate;
mod schema;
mod sidecar;

use std::path::{Path, PathBuf};

use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

pub use generate::generate;
pub use schema::StatusJson;

pub struct ReportResult {
    pub ready: bool,
    pub index_html: PathBuf,
    pub status_path: PathBuf,
}

pub fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .expect("rfc3339 timestamp")
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("repo root")
}

fn src_tauri() -> PathBuf {
    repo_root().join("src-tauri")
}

/// Run cargo tests + architecture audits and write HTML / data/.
pub fn report() -> std::io::Result<ReportResult> {
    let root = repo_root();
    let src_tauri = src_tauri();
    let results_dir = root.join("tests/results");
    let report_dir = root.join("tests/reporting");
    let baselines = root.join("tests/architecture");

    let unit = cargo_test::run_cargo_suite(
        &src_tauri,
        "velo-core",
        &["--lib"],
        "velo-core",
        "unit",
    );
    cargo_test::persist_suite(&results_dir, &unit)?;

    let integration = cargo_test::run_cargo_suite(
        &src_tauri,
        "velo-server",
        &["--bins"],
        "velo-server",
        "integration",
    );
    cargo_test::persist_suite(&results_dir, &integration)?;

    let audits = audit::run_audits(&src_tauri, &baselines);
    audit::write_sidecars(&results_dir, &audits)?;

    let gen = generate::generate(&results_dir, &report_dir, "Velo")?;
    Ok(ReportResult {
        ready: gen.status.ready,
        index_html: report_dir.join("index.html"),
        status_path: gen.status_path,
    })
}

/// Re-run architecture audits and regenerate HTML from existing suite JSON.
pub fn audits() -> std::io::Result<ReportResult> {
    let root = repo_root();
    let results_dir = root.join("tests/results");
    let report_dir = root.join("tests/reporting");
    let baselines = root.join("tests/architecture");
    let audits = audit::run_audits(&src_tauri(), &baselines);
    audit::write_sidecars(&results_dir, &audits)?;
    let gen = generate::generate(&results_dir, &report_dir, "Velo")?;
    Ok(ReportResult {
        ready: gen.status.ready,
        index_html: report_dir.join("index.html"),
        status_path: gen.status_path,
    })
}

pub fn gate(status_path: &Path) -> std::io::Result<bool> {
    let raw = std::fs::read_to_string(status_path)?;
    let status: StatusJson = serde_json::from_str(&raw)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    Ok(status.ready)
}
