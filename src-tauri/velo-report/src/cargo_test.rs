use std::path::Path;
use std::process::Command;
use std::time::Instant;

use crate::schema::{SuiteRun, TestRow};
use crate::now_iso;
use crate::sidecar::write_suite_run;

pub fn run_cargo_suite(
    src_tauri: &Path,
    package: &str,
    extra: &[&str],
    suite: &str,
    category: &str,
) -> SuiteRun {
    let started = Instant::now();
    let mut cmd = Command::new("cargo");
    cmd.arg("test")
        .arg("-p")
        .arg(package)
        .args(extra)
        .arg("--")
        .arg("--color=never")
        .current_dir(src_tauri)
        .env("CARGO_TERM_COLOR", "never");
    let output = cmd.output();
    let duration_ms = started.elapsed().as_millis() as u64;
    let timestamp = now_iso();

    match output {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            let stderr = String::from_utf8_lossy(&out.stderr);
            let combined = format!("{stdout}\n{stderr}");
            let mut results = parse_cargo_test(&stdout);
            if results.is_empty() && !out.status.success() {
                results.push(TestRow {
                    name: format!("{package} compile/run"),
                    status: "failed".into(),
                    duration_ms,
                    message: Some(tail(&combined, 40)),
                });
            }
            let passed = results.iter().filter(|r| r.status == "passed").count();
            let failed = results.iter().filter(|r| r.status == "failed").count();
            let skipped = results.iter().filter(|r| r.status == "skipped").count();
            SuiteRun {
                suite: suite.into(),
                timestamp,
                category: category.into(),
                passed,
                failed,
                skipped,
                duration_ms,
                results,
            }
        }
        Err(e) => SuiteRun {
            suite: suite.into(),
            timestamp,
            category: category.into(),
            passed: 0,
            failed: 1,
            skipped: 0,
            duration_ms,
            results: vec![TestRow {
                name: format!("cargo test -p {package}"),
                status: "failed".into(),
                duration_ms,
                message: Some(e.to_string()),
            }],
        },
    }
}

pub fn parse_cargo_test(stdout: &str) -> Vec<TestRow> {
    let mut rows = Vec::new();
    for line in stdout.lines() {
        let line = line.trim();
        if !line.starts_with("test ") || !line.contains(" ... ") {
            continue;
        }
        let rest = &line["test ".len()..];
        let Some((name, status_raw)) = rest.rsplit_once(" ... ") else {
            continue;
        };
        let status_raw = status_raw.trim();
        let status = if status_raw.starts_with("ok") {
            "passed"
        } else if status_raw.starts_with("FAILED") || status_raw.starts_with("failed") {
            "failed"
        } else if status_raw.starts_with("ignored") {
            "skipped"
        } else {
            continue;
        };
        rows.push(TestRow {
            name: name.trim().to_string(),
            status: status.into(),
            duration_ms: 0,
            message: None,
        });
    }
    attach_failure_messages(stdout, &mut rows);
    rows
}

fn attach_failure_messages(stdout: &str, rows: &mut [TestRow]) {
    let mut current: Option<String> = None;
    let mut buf = String::new();
    for line in stdout.lines() {
        if let Some(name) = line.strip_prefix("---- ") {
            if let Some(name) = name.strip_suffix(" stdout ----") {
                if let Some(cur) = current.take() {
                    apply_message(rows, &cur, &buf);
                }
                current = Some(name.trim().to_string());
                buf.clear();
                continue;
            }
        }
        if current.is_some() {
            if line.starts_with("---- ") || line.starts_with("failures:") {
                if let Some(cur) = current.take() {
                    apply_message(rows, &cur, &buf);
                }
                buf.clear();
            } else {
                buf.push_str(line);
                buf.push('\n');
            }
        }
    }
    if let Some(cur) = current {
        apply_message(rows, &cur, &buf);
    }
}

fn apply_message(rows: &mut [TestRow], name: &str, buf: &str) {
    let msg = buf.trim();
    if msg.is_empty() {
        return;
    }
    if let Some(row) = rows.iter_mut().find(|r| r.name == name && r.status == "failed") {
        row.message = Some(msg.to_string());
    }
}

fn tail(s: &str, n: usize) -> String {
    let lines: Vec<&str> = s.lines().collect();
    lines
        .iter()
        .rev()
        .take(n)
        .cloned()
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn persist_suite(results_dir: &Path, run: &SuiteRun) -> std::io::Result<std::path::PathBuf> {
    write_suite_run(results_dir, run)
}

#[cfg(test)]
mod tests {
    use super::parse_cargo_test;

    #[test]
    fn parses_ok_failed_ignored() {
        let out = "\
test imap::scheduler::interactive_first ... ok
test store::chunk ... FAILED
test smtp::skip_me ... ignored
";
        let rows = parse_cargo_test(out);
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].status, "passed");
        assert_eq!(rows[1].status, "failed");
        assert_eq!(rows[2].status, "skipped");
    }
}
