use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

use crate::schema::{
    AuditSidecar, BaselineEntry, Finding, SidecarFinding, SidecarSummary,
};
use crate::now_iso;

pub fn write_audit_sidecar(
    results_dir: &Path,
    audit: &str,
    rules_implemented: &[String],
    findings: &[Finding],
    baseline: &[BaselineEntry],
) -> std::io::Result<std::path::PathBuf> {
    let ran_at = now_iso();
    let baseline_set: HashSet<String> = baseline
        .iter()
        .map(|b| format!("{}|{}", b.id, b.severity))
        .collect();

    let mut rules: Vec<String> = rules_implemented.to_vec();
    rules.sort();

    let sidecar = AuditSidecar {
        audit: audit.to_string(),
        ran_at: ran_at.clone(),
        rules_implemented: rules,
        baseline_size: baseline.len(),
        findings: findings
            .iter()
            .map(|f| SidecarFinding {
                id: f.id.clone(),
                rule: f.rule_id.clone(),
                severity: f.severity.clone(),
                file: f.file.clone(),
                baselined: baseline_set.contains(&format!("{}|{}", f.id, f.severity)),
            })
            .collect(),
        summary: summarize(findings, &baseline_set),
    };

    fs::create_dir_all(results_dir)?;
    let fname = format!(
        "architecture-{}-findings-{}.json",
        audit,
        ran_at.replace([':', '.'], "-")
    );
    let out = results_dir.join(fname);
    fs::write(
        &out,
        serde_json::to_string_pretty(&sidecar)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?
            + "\n",
    )?;
    Ok(out)
}

fn summarize(findings: &[Finding], baseline_set: &HashSet<String>) -> SidecarSummary {
    let mut by_severity: HashMap<String, usize> = HashMap::new();
    let mut by_rule: HashMap<String, usize> = HashMap::new();
    let mut baselined = 0;
    let mut review = 0;
    for f in findings {
        *by_severity.entry(f.severity.clone()).or_insert(0) += 1;
        *by_rule.entry(f.rule_id.clone()).or_insert(0) += 1;
        if f.severity == "REVIEW" {
            review += 1;
        } else if baseline_set.contains(&format!("{}|{}", f.id, f.severity)) {
            baselined += 1;
        }
    }
    let blocking = findings.iter().filter(|f| f.severity != "REVIEW").count();
    SidecarSummary {
        total: findings.len(),
        baselined,
        unbaselined: blocking - baselined,
        review,
        by_severity: by_severity.into_iter().collect(),
        by_rule: by_rule.into_iter().collect(),
    }
}

pub fn load_baseline(path: &Path) -> Vec<BaselineEntry> {
    let Ok(raw) = fs::read_to_string(path) else {
        return Vec::new();
    };
    match serde_json::from_str::<crate::schema::BaselineFile>(&raw) {
        Ok(b) => b.findings,
        Err(_) => Vec::new(),
    }
}

pub fn write_suite_run(
    results_dir: &Path,
    run: &crate::schema::SuiteRun,
) -> std::io::Result<std::path::PathBuf> {
    fs::create_dir_all(results_dir)?;
    let fname = format!(
        "{}-{}.json",
        run.suite,
        run.timestamp.replace([':', '.'], "-")
    );
    let out = results_dir.join(fname);
    fs::write(
        &out,
        serde_json::to_string_pretty(run)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?
            + "\n",
    )?;
    Ok(out)
}
