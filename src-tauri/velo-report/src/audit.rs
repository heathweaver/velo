use std::fs;
use std::path::{Path, PathBuf};

use crate::schema::Finding;
use crate::sidecar::load_baseline;

const SLOP_RULES: &[&str] = &[
    "unwrap-in-prod",
    "todo-in-prod",
    "swallow-result",
    "allow-without-reason",
];

const PRACTICE_RULES: &[&str] = &[
    "spawn-without-join",
    "mutex-held-across-await",
    "blocking-in-async",
    "imap-work-unlabeled",
    "sql-string-concat",
    "fat-tauri-command",
    "module-monolith",
];

pub struct AuditRun {
    pub name: String,
    pub rules: Vec<String>,
    pub findings: Vec<Finding>,
    pub baseline: Vec<crate::schema::BaselineEntry>,
}

pub fn run_audits(src_tauri: &Path, baselines_dir: &Path) -> Vec<AuditRun> {
    let files = rust_prod_files(src_tauri);
    let slop = scan_slop(&files);
    let practices = scan_practices(&files);
    vec![
        AuditRun {
            name: "slop".into(),
            rules: SLOP_RULES.iter().map(|s| (*s).to_string()).collect(),
            findings: slop,
            baseline: load_baseline(&baselines_dir.join("slop_baseline.json")),
        },
        AuditRun {
            name: "rust-practices".into(),
            rules: PRACTICE_RULES.iter().map(|s| (*s).to_string()).collect(),
            findings: practices,
            baseline: load_baseline(&baselines_dir.join("rust_practices_baseline.json")),
        },
    ]
}

struct RustFile {
    rel: String,
    lines: Vec<String>,
    in_test: Vec<bool>,
}

fn rust_prod_files(src_tauri: &Path) -> Vec<RustFile> {
    let mut out = Vec::new();
    for entry in walkdir::WalkDir::new(src_tauri).into_iter().filter_map(|e| e.ok()) {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("rs") {
            continue;
        }
        let rel = path
            .strip_prefix(src_tauri)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/");
        if rel.starts_with("target/") || rel.starts_with("gen/") || rel.starts_with("velo-report/") {
            continue;
        }
        if rel.ends_with("build.rs") {
            continue;
        }
        let Ok(text) = fs::read_to_string(path) else {
            continue;
        };
        let lines: Vec<String> = text.lines().map(|l| l.to_string()).collect();
        let in_test = mark_test_lines(&lines);
        out.push(RustFile {
            rel: format!("src-tauri/{rel}"),
            lines,
            in_test,
        });
    }
    out
}

/// Mark lines inside `#[cfg(test)]` modules / blocks so audits skip them.
fn mark_test_lines(lines: &[String]) -> Vec<bool> {
    let mut flags = vec![false; lines.len()];
    let mut i = 0;
    while i < lines.len() {
        let trimmed = lines[i].trim();
        if trimmed.starts_with("#[cfg(test)]") {
            let mut j = i + 1;
            while j < lines.len() && lines[j].trim().is_empty() {
                j += 1;
            }
            let mut depth = 0;
            let mut started = false;
            let mut k = j;
            while k < lines.len() {
                for ch in lines[k].chars() {
                    if ch == '{' {
                        depth += 1;
                        started = true;
                    } else if ch == '}' && started {
                        depth -= 1;
                    }
                }
                if started {
                    flags[k] = true;
                    if depth == 0 {
                        break;
                    }
                }
                k += 1;
            }
            i = k + 1;
            continue;
        }
        i += 1;
    }
    flags
}

fn is_allowed(lines: &[String], idx: usize, rule: &str) -> bool {
    let marker = format!("slop: allow {rule}");
    let current = lines.get(idx).map(|s| s.as_str()).unwrap_or("");
    let previous = if idx > 0 {
        lines.get(idx - 1).map(|s| s.as_str()).unwrap_or("")
    } else {
        ""
    };
    current.contains(&marker) || previous.contains(&marker)
}

fn finding(rule: &str, severity: &str, file: &str, line: usize, message: &str, evidence: &str) -> Finding {
    Finding {
        id: format!("{rule}:{file}:{line}"),
        severity: severity.into(),
        rule_id: rule.into(),
        file: file.into(),
        message: message.into(),
        evidence: Some(evidence.trim().to_string()),
    }
}

fn scan_slop(files: &[RustFile]) -> Vec<Finding> {
    let mut findings = Vec::new();
    for f in files {
        for (i, line) in f.lines.iter().enumerate() {
            if f.in_test[i] {
                continue;
            }
            let trimmed = line.trim();
            if trimmed.starts_with("//") {
                continue;
            }
            if line.contains(".unwrap()") && !is_allowed(&f.lines, i, "unwrap-in-prod") {
                findings.push(finding(
                    "unwrap-in-prod",
                    "ERROR",
                    &f.rel,
                    i + 1,
                    "unwrap in production code",
                    trimmed,
                ));
            }
            if line.contains(".expect(") && !is_allowed(&f.lines, i, "unwrap-in-prod") {
                findings.push(finding(
                    "unwrap-in-prod",
                    "ERROR",
                    &f.rel,
                    i + 1,
                    "expect in production code",
                    trimmed,
                ));
            }
            if (line.contains("todo!(") || line.contains("unimplemented!("))
                && !is_allowed(&f.lines, i, "todo-in-prod")
            {
                findings.push(finding(
                    "todo-in-prod",
                    "ERROR",
                    &f.rel,
                    i + 1,
                    "todo!/unimplemented! in production code",
                    trimmed,
                ));
            }
            if trimmed.starts_with("let _ =") && !is_allowed(&f.lines, i, "swallow-result") {
                findings.push(finding(
                    "swallow-result",
                    "ERROR",
                    &f.rel,
                    i + 1,
                    "discarded Result via let _ =",
                    trimmed,
                ));
            }
            if trimmed.ends_with(".ok();") && !is_allowed(&f.lines, i, "swallow-result") {
                findings.push(finding(
                    "swallow-result",
                    "ERROR",
                    &f.rel,
                    i + 1,
                    "discarded Result via .ok()",
                    trimmed,
                ));
            }
            if trimmed.contains("#[allow(")
                && !line.contains("//")
                && !is_allowed(&f.lines, i, "allow-without-reason")
            {
                let prev_ok = i > 0 && f.lines[i - 1].trim().starts_with("//");
                if !prev_ok {
                    findings.push(finding(
                        "allow-without-reason",
                        "WARN",
                        &f.rel,
                        i + 1,
                        "#[allow(...)] without a reason comment",
                        trimmed,
                    ));
                }
            }
        }
    }
    findings
}

fn scan_practices(files: &[RustFile]) -> Vec<Finding> {
    let mut findings = Vec::new();
    for f in files {
        if f.lines.len() > 800 {
            findings.push(finding(
                "module-monolith",
                "WARN",
                &f.rel,
                1,
                "production .rs file over 800 lines",
                &format!("{} lines", f.lines.len()),
            ));
        }
        let mut i = 0;
        while i < f.lines.len() {
            if f.in_test[i] {
                i += 1;
                continue;
            }
            let line = &f.lines[i];
            let trimmed = line.trim();
            if trimmed.starts_with("//") {
                i += 1;
                continue;
            }
            if line.contains("tokio::spawn")
                && !line.contains("let ")
                && !line.contains(".push(")
                && !is_allowed(&f.lines, i, "spawn-without-join")
            {
                findings.push(finding(
                    "spawn-without-join",
                    "ERROR",
                    &f.rel,
                    i + 1,
                    "tokio::spawn without an owned JoinHandle",
                    trimmed,
                ));
            }
            if trimmed.contains("std::thread::sleep") && !is_allowed(&f.lines, i, "blocking-in-async") {
                findings.push(finding(
                    "blocking-in-async",
                    "ERROR",
                    &f.rel,
                    i + 1,
                    "blocking sleep on the async runtime",
                    trimmed,
                ));
            }
            if (trimmed.contains("std::fs::") || trimmed.contains("std::net::"))
                && !is_allowed(&f.lines, i, "blocking-in-async")
            {
                findings.push(finding(
                    "blocking-in-async",
                    "WARN",
                    &f.rel,
                    i + 1,
                    "blocking std I/O — use tokio equivalent or spawn_blocking",
                    trimmed,
                ));
            }
            if looks_like_sql_concat(trimmed) && !is_allowed(&f.lines, i, "sql-string-concat") {
                findings.push(finding(
                    "sql-string-concat",
                    "ERROR",
                    &f.rel,
                    i + 1,
                    "SQL built with format!/push_str",
                    trimmed,
                ));
            }
            if is_guard_lock(trimmed) && !is_allowed(&f.lines, i, "mutex-held-across-await") {
                if holds_across_await(&f.lines, i, &f.in_test) {
                    findings.push(finding(
                        "mutex-held-across-await",
                        "ERROR",
                        &f.rel,
                        i + 1,
                        "tokio mutex guard held across .await",
                        trimmed,
                    ));
                }
            }
            if trimmed == "#[tauri::command]" {
                let end = fn_end(&f.lines, i);
                let body_len = end.saturating_sub(i);
                if body_len > 25 && !is_allowed(&f.lines, i, "fat-tauri-command") {
                    findings.push(finding(
                        "fat-tauri-command",
                        "WARN",
                        &f.rel,
                        i + 1,
                        "#[tauri::command] body is more than a thin adapter",
                        &format!("{body_len} lines"),
                    ));
                }
            }
            i += 1;
        }
        if f.rel.ends_with("src/commands.rs") {
            scan_imap_unlabeled(f, &mut findings);
        }
    }
    findings
}

fn looks_like_sql_concat(line: &str) -> bool {
    if !line.contains("format!") && !line.contains("push_str") {
        return false;
    }
    let upper = line.to_ascii_uppercase();
    (upper.contains("SELECT ") && upper.contains(" FROM "))
        || upper.contains("INSERT INTO")
        || (upper.contains("UPDATE ") && upper.contains(" SET "))
        || upper.contains("DELETE FROM")
        || upper.contains("CREATE TABLE")
}

fn is_guard_lock(line: &str) -> bool {
    line.contains("let ") && line.contains(".lock().await") && line.trim().ends_with(';')
}

fn holds_across_await(lines: &[String], start: usize, in_test: &[bool]) -> bool {
    let mut depth = 0;
    for (j, line) in lines.iter().enumerate().skip(start + 1).take(40) {
        if in_test.get(j) == Some(&true) {
            continue;
        }
        depth += line.chars().filter(|c| *c == '{').count() as i32;
        depth -= line.chars().filter(|c| *c == '}').count() as i32;
        if line.contains(".await") {
            return true;
        }
        if depth < 0 {
            break;
        }
    }
    false
}

fn fn_end(lines: &[String], attr_idx: usize) -> usize {
    let mut depth = 0;
    let mut started = false;
    for (j, line) in lines.iter().enumerate().skip(attr_idx) {
        for ch in line.chars() {
            if ch == '{' {
                depth += 1;
                started = true;
            } else if ch == '}' && started {
                depth -= 1;
                if depth == 0 {
                    return j;
                }
            }
        }
    }
    attr_idx
}

fn scan_imap_unlabeled(f: &RustFile, findings: &mut Vec<Finding>) {
    let mut i = 0;
    while i < f.lines.len() {
        let trimmed = f.lines[i].trim();
        if trimmed.starts_with("pub async fn imap_") && trimmed.contains('(') {
            let name = trimmed
                .trim_start_matches("pub async fn ")
                .split('(')
                .next()
                .unwrap_or("");
            if name == "imap_test_connection" || name == "imap_evict_sessions" {
                i += 1;
                continue;
            }
            let end = fn_end(&f.lines, i);
            let body = f.lines[i..=end.min(f.lines.len() - 1)].join("\n");
            if body.contains("ops::imap_") && !body.contains("Priority::from_label")
                && !is_allowed(&f.lines, i, "imap-work-unlabeled")
            {
                findings.push(finding(
                    "imap-work-unlabeled",
                    "ERROR",
                    &f.rel,
                    i + 1,
                    "IMAP command does not pass Priority::from_label",
                    name,
                ));
            }
            i = end + 1;
            continue;
        }
        i += 1;
    }
}

pub fn write_sidecars(
    results_dir: &Path,
    audits: &[AuditRun],
) -> std::io::Result<Vec<PathBuf>> {
    let mut paths = Vec::new();
    for a in audits {
        paths.push(crate::sidecar::write_audit_sidecar(
            results_dir,
            &a.name,
            &a.rules,
            &a.findings,
            &a.baseline,
        )?);
    }
    Ok(paths)
}
