//! Shared JSON shapes — same contract as `@realdigit/test-reporting`.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Finding {
    pub id: String,
    pub severity: String,
    #[serde(rename = "ruleId")]
    pub rule_id: String,
    pub file: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evidence: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SidecarFinding {
    pub id: String,
    pub rule: String,
    pub severity: String,
    pub file: String,
    pub baselined: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditSidecar {
    pub audit: String,
    pub ran_at: String,
    pub rules_implemented: Vec<String>,
    pub baseline_size: usize,
    pub findings: Vec<SidecarFinding>,
    pub summary: SidecarSummary,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SidecarSummary {
    pub total: usize,
    pub baselined: usize,
    pub unbaselined: usize,
    pub review: usize,
    pub by_severity: BTreeMap<String, usize>,
    pub by_rule: BTreeMap<String, usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BaselineEntry {
    pub id: String,
    pub severity: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BaselineFile {
    pub version: u32,
    pub findings: Vec<BaselineEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestRow {
    pub name: String,
    pub status: String,
    #[serde(rename = "durationMs")]
    pub duration_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SuiteRun {
    pub suite: String,
    pub timestamp: String,
    pub category: String,
    pub passed: usize,
    pub failed: usize,
    pub skipped: usize,
    #[serde(rename = "durationMs")]
    pub duration_ms: u64,
    pub results: Vec<TestRow>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatusBlocker {
    pub page: String,
    pub severity: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatusArchitecture {
    pub audit: String,
    pub ran_at: String,
    pub rules_implemented: usize,
    pub total: usize,
    pub baselined: usize,
    pub unbaselined: usize,
    pub review: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatusJson {
    pub generated_at: String,
    pub ready: bool,
    pub last_run: String,
    pub suites_recorded: usize,
    pub counts: BTreeMap<String, usize>,
    pub blockers: Vec<StatusBlocker>,
    pub architecture: Vec<StatusArchitecture>,
}
