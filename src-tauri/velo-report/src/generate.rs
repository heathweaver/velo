use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::Path;

use crate::schema::{
    AuditSidecar, StatusArchitecture, StatusBlocker, StatusJson, SuiteRun,
};
use crate::now_iso;

const STYLE: &str = include_str!("../style.css");

pub struct GenerateResult {
    pub status: StatusJson,
    pub status_path: std::path::PathBuf,
    pub pages: Vec<std::path::PathBuf>,
}

pub fn generate(
    results_dir: &Path,
    report_dir: &Path,
    title: &str,
) -> std::io::Result<GenerateResult> {
    let generated_at = now_iso();
    let (sidecars, runs) = load_results(results_dir)?;
    let status = build_status(&sidecars, &runs, &generated_at);

    let data_dir = report_dir.join("data");
    fs::create_dir_all(&data_dir)?;
    fs::create_dir_all(report_dir)?;
    fs::write(report_dir.join("style.css"), STYLE)?;

    let mut pages = vec![
        report_dir.join("index.html"),
        report_dir.join("architecture.html"),
    ];
    fs::write(&pages[0], page_index(title, &status, &sidecars, &runs))?;
    fs::write(
        &pages[1],
        page_architecture(title, &sidecars, &runs),
    )?;

    let mut categories: Vec<String> = runs.iter().map(|r| r.category.clone()).collect();
    categories.sort();
    categories.dedup();
    for cat in &categories {
        let path = report_dir.join(format!("{cat}.html"));
        fs::write(&path, page_category(title, cat, &runs))?;
        pages.push(path);
        fs::write(data_dir.join(format!("{cat}.md")), markdown_category(cat, &runs))?;
    }

    fs::write(data_dir.join("architecture.md"), markdown_architecture(&sidecars))?;
    fs::write(data_dir.join("status.md"), markdown_status(&status))?;
    let status_path = data_dir.join("status.json");
    fs::write(
        &status_path,
        serde_json::to_string_pretty(&status)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?
            + "\n",
    )?;

    Ok(GenerateResult {
        status,
        status_path,
        pages,
    })
}

fn load_results(
    results_dir: &Path,
) -> std::io::Result<(Vec<AuditSidecar>, Vec<SuiteRun>)> {
    let mut latest: HashMap<String, AuditSidecar> = HashMap::new();
    let mut runs: Vec<SuiteRun> = Vec::new();
    if !results_dir.exists() {
        return Ok((Vec::new(), runs));
    }
    for entry in walkdir::WalkDir::new(results_dir)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let Ok(raw) = fs::read_to_string(path) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
            continue;
        };
        if value.get("audit").and_then(|v| v.as_str()).is_some()
            && value.get("rules_implemented").and_then(|v| v.as_array()).is_some()
        {
            if let Ok(sc) = serde_json::from_value::<AuditSidecar>(value) {
                let replace = latest
                    .get(&sc.audit)
                    .map(|p| p.ran_at < sc.ran_at)
                    .unwrap_or(true);
                if replace {
                    latest.insert(sc.audit.clone(), sc);
                }
            }
            continue;
        }
        if value.get("suite").and_then(|v| v.as_str()).is_some()
            && value.get("category").and_then(|v| v.as_str()).is_some()
            && value.get("results").and_then(|v| v.as_array()).is_some()
        {
            if let Ok(run) = serde_json::from_value::<SuiteRun>(value) {
                runs.push(run);
            }
        }
    }
    let mut sidecars: Vec<AuditSidecar> = latest.into_values().collect();
    sidecars.sort_by(|a, b| a.audit.cmp(&b.audit));
    runs.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    Ok((sidecars, runs))
}

fn build_status(
    sidecars: &[AuditSidecar],
    runs: &[SuiteRun],
    generated_at: &str,
) -> StatusJson {
    let mut blockers = Vec::new();
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut latest_by_suite: HashMap<String, &SuiteRun> = HashMap::new();
    for run in runs {
        let replace = latest_by_suite
            .get(&run.suite)
            .map(|p| p.timestamp < run.timestamp)
            .unwrap_or(true);
        if replace {
            latest_by_suite.insert(run.suite.clone(), run);
        }
    }
    for run in latest_by_suite.values() {
        *counts.entry(run.category.clone()).or_insert(0) += 1;
        if run.failed > 0 {
            blockers.push(StatusBlocker {
                page: run.category.clone(),
                severity: "blocker".into(),
                message: format!("{}: {} failed", run.suite, run.failed),
            });
        }
    }
    counts.insert("architecture".into(), sidecars.len());
    for sc in sidecars {
        if sc.summary.unbaselined > 0 {
            let s = if sc.summary.unbaselined == 1 { "" } else { "s" };
            blockers.push(StatusBlocker {
                page: "architecture".into(),
                severity: "blocker".into(),
                message: format!(
                    "{}: {} unbaselined finding{}",
                    sc.audit, sc.summary.unbaselined, s
                ),
            });
        }
    }
    let mut timestamps: Vec<String> = sidecars.iter().map(|s| s.ran_at.clone()).collect();
    timestamps.extend(runs.iter().map(|r| r.timestamp.clone()));
    timestamps.push(generated_at.to_string());
    timestamps.sort();
    let last_run = timestamps
        .last()
        .cloned()
        .unwrap_or_else(|| generated_at.to_string());
    let architecture = sidecars
        .iter()
        .map(|sc| StatusArchitecture {
            audit: sc.audit.clone(),
            ran_at: sc.ran_at.clone(),
            rules_implemented: sc.rules_implemented.len(),
            total: sc.summary.total,
            baselined: sc.summary.baselined,
            unbaselined: sc.summary.unbaselined,
            review: sc.summary.review,
        })
        .collect();
    StatusJson {
        generated_at: generated_at.to_string(),
        ready: blockers.is_empty(),
        last_run,
        suites_recorded: latest_by_suite.len() + sidecars.len(),
        counts,
        blockers,
        architecture,
    }
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

struct NavItem {
    href: String,
    label: String,
}

fn layout(title: &str, active: &str, body: &str, nav: &[NavItem]) -> String {
    let links: String = nav
        .iter()
        .map(|n| {
            let cls = if n.label == active {
                "nav-link active"
            } else {
                "nav-link"
            };
            format!(
                "<a class=\"{cls}\" href=\"{}\">{}</a>",
                n.href,
                esc(&n.label)
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        r#"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>{} — {}</title>
  <link rel="stylesheet" href="style.css"/>
</head>
<body>
  <nav class="sidenav">
    <div class="brand">{}</div>
    <div class="nav">{links}</div>
    <div class="meta">Read data/status.json first. Do not rerun to ask if it passed.</div>
  </nav>
  <main>{body}</main>
</body>
</html>
"#,
        esc(active),
        esc(title),
        esc(title)
    )
}

fn nav_for(runs: &[SuiteRun]) -> Vec<NavItem> {
    let mut cats: Vec<String> = runs.iter().map(|r| r.category.clone()).collect();
    cats.sort();
    cats.dedup();
    let mut nav = vec![
        NavItem {
            href: "index.html".into(),
            label: "Overview".into(),
        },
        NavItem {
            href: "architecture.html".into(),
            label: "Architecture".into(),
        },
    ];
    for c in cats {
        let mut label = c.clone();
        if let Some(first) = label.get_mut(0..1) {
            first.make_ascii_uppercase();
        }
        nav.push(NavItem {
            href: format!("{c}.html"),
            label,
        });
    }
    nav
}

fn page_index(
    title: &str,
    status: &StatusJson,
    sidecars: &[AuditSidecar],
    runs: &[SuiteRun],
) -> String {
    let banner = if status.ready {
        format!(
            "<section class=\"ship-banner ready\"><div class=\"ship-status\">READY</div><div class=\"ship-detail\">No blockers · last run {}</div></section>",
            esc(&status.last_run)
        )
    } else {
        let n = status.blockers.len();
        let s = if n == 1 { "" } else { "s" };
        let detail = status
            .blockers
            .iter()
            .map(|b| esc(&b.message))
            .collect::<Vec<_>>()
            .join(" · ");
        format!(
            "<section class=\"ship-banner blocked\"><div class=\"ship-status\">NOT READY · {n} blocker{s}</div><div class=\"ship-detail\">{detail}</div></section>"
        )
    };
    let audit_cards: String = sidecars
        .iter()
        .map(|sc| {
            format!(
                "<div class=\"stat\"><div class=\"n\">{}</div><div class=\"l\">{} unbaselined</div></div>",
                sc.summary.unbaselined,
                esc(&sc.audit)
            )
        })
        .collect();
    let mut latest_by_cat: HashMap<String, &SuiteRun> = HashMap::new();
    for run in runs {
        latest_by_cat.entry(run.category.clone()).or_insert(run);
    }
    let mut cats: Vec<_> = latest_by_cat.into_iter().collect();
    cats.sort_by(|a, b| a.0.cmp(&b.0));
    let suite_cards: String = cats
        .iter()
        .map(|(cat, run)| {
            let total = run.passed + run.failed + run.skipped;
            format!(
                "<div class=\"stat\"><div class=\"n\">{}/{}</div><div class=\"l\">{} passed</div></div>",
                run.passed,
                total,
                esc(cat)
            )
        })
        .collect();
    let body = format!(
        "
    <div class=\"hero\">
      <h1>Overview</h1>
      <p class=\"muted\">Agents: read <code>data/status.json</code>. Humans: these pages.</p>
    </div>
    {banner}
    <div class=\"quick-stats\">{audit_cards}{suite_cards}</div>
  "
    );
    layout(title, "Overview", &body, &nav_for(runs))
}

fn page_architecture(title: &str, sidecars: &[AuditSidecar], runs: &[SuiteRun]) -> String {
    let sections = if sidecars.is_empty() {
        "<p class=\"empty\">No audit sidecars.</p>".to_string()
    } else {
        sidecars.iter().map(render_sidecar).collect::<Vec<_>>().join("\n")
    };
    let body = format!(
        "
    <div class=\"hero\">
      <h1>Architecture</h1>
      <p class=\"muted\">One sidecar per audit. Unbaselined findings are blockers.</p>
    </div>
    {sections}
  "
    );
    layout(title, "Architecture", &body, &nav_for(runs))
}

fn render_sidecar(sc: &AuditSidecar) -> String {
    let s = &sc.summary;
    let rule_rows: String = sc
        .rules_implemented
        .iter()
        .map(|rule| {
            let count = s.by_rule.get(rule).copied().unwrap_or(0);
            format!(
                "<tr><td><code>{}</code></td><td class=\"num\">{count}</td></tr>",
                esc(rule)
            )
        })
        .collect();
    let finding_rows: String = sc
        .findings
        .iter()
        .map(|f| {
            let flag = if f.baselined {
                "<span class=\"muted\">baselined</span>"
            } else {
                "<span class=\"status-bad\">unbaselined</span>"
            };
            format!(
                "<tr><td><span class=\"badge\">{}</span></td><td><code>{}</code></td><td><code>{}</code></td><td>{flag}</td></tr>",
                esc(&f.severity),
                esc(&f.rule),
                esc(&f.file)
            )
        })
        .collect();
    format!(
        "<section>
    <h2>{} <span class=\"muted\">({} rules · {} findings)</span></h2>
    <div class=\"quick-stats\">
      <div class=\"stat\"><div class=\"n\">{}</div><div class=\"l\">Unbaselined</div></div>
      <div class=\"stat\"><div class=\"n\">{}</div><div class=\"l\">Baselined</div></div>
      <div class=\"stat\"><div class=\"n\">{}</div><div class=\"l\">Review</div></div>
    </div>
    <table class=\"wide\"><thead><tr><th>rule</th><th class=\"num\">findings</th></tr></thead><tbody>{rule_rows}</tbody></table>
    <table class=\"wide\"><thead><tr><th>severity</th><th>rule</th><th>file</th><th>baseline</th></tr></thead><tbody>{finding_rows}</tbody></table>
  </section>",
        esc(&sc.audit),
        sc.rules_implemented.len(),
        s.total,
        s.unbaselined,
        s.baselined,
        s.review
    )
}

fn page_category(title: &str, cat: &str, runs: &[SuiteRun]) -> String {
    let mine: Vec<&SuiteRun> = runs.iter().filter(|r| r.category == cat).collect();
    let latest = mine.first().copied();
    let rows = latest
        .map(|run| {
            run.results
                .iter()
                .map(|row| {
                    let cls = match row.status.as_str() {
                        "failed" => "status-bad",
                        "skipped" => "muted",
                        _ => "status-good",
                    };
                    let msg = row.message.as_deref().unwrap_or("");
                    format!(
                        "<tr><td class=\"{cls}\">{}</td><td><code>{}</code></td><td>{}</td></tr>",
                        esc(&row.status),
                        esc(&row.name),
                        esc(msg)
                    )
                })
                .collect::<String>()
        })
        .unwrap_or_default();
    let mut label = cat.to_string();
    if let Some(first) = label.get_mut(0..1) {
        first.make_ascii_uppercase();
    }
    let table = if rows.is_empty() {
        "<p class=\"empty\">No tests in the latest run.</p>".to_string()
    } else {
        format!(
            "<section><h2>Tests</h2><table class=\"wide\"><thead><tr><th>status</th><th>test</th><th>message</th></tr></thead><tbody>{rows}</tbody></table></section>"
        )
    };
    let muted = match latest {
        Some(run) => format!(
            "{} passed · {} failed · {} skipped",
            run.passed, run.failed, run.skipped
        ),
        None => "No runs yet.".into(),
    };
    let body = format!(
        "
    <div class=\"hero\">
      <h1>{}</h1>
      <p class=\"muted\">{muted}</p>
    </div>
    {table}
  ",
        esc(&label)
    );
    layout(title, &label, &body, &nav_for(runs))
}

fn markdown_architecture(sidecars: &[AuditSidecar]) -> String {
    let mut parts = vec![
        "# Architecture\n".into(),
        format!("**Audits:** {}\n", sidecars.len()),
    ];
    for sc in sidecars {
        parts.push(format!("## `{}`\n", sc.audit));
        parts.push(format!(
            "- Rules implemented: **{}**\n- Findings total: **{}**\n- Baselined: **{}** · Unbaselined: **{}**\n- Last run: {}\n",
            sc.rules_implemented.len(),
            sc.summary.total,
            sc.summary.baselined,
            sc.summary.unbaselined,
            sc.ran_at
        ));
        parts.push("| severity | rule | file | baseline |\n| --- | --- | --- | --- |\n".into());
        for f in &sc.findings {
            let base = if f.baselined { "baselined" } else { "unbaselined" };
            parts.push(format!(
                "| {} | `{}` | `{}` | {base} |\n",
                f.severity, f.rule, f.file
            ));
        }
        parts.push("\n".into());
    }
    parts.join("")
}

fn markdown_category(cat: &str, runs: &[SuiteRun]) -> String {
    let mine: Vec<&SuiteRun> = runs.iter().filter(|r| r.category == cat).collect();
    let latest = mine.first().copied();
    let mut lines = vec![format!("# {cat}\n")];
    match latest {
        Some(run) => {
            lines.push(format!(
                "**Last run:** {} · {} passed · {} failed · {} skipped\n",
                run.timestamp, run.passed, run.failed, run.skipped
            ));
            let fails: Vec<_> = run.results.iter().filter(|r| r.status == "failed").collect();
            if !fails.is_empty() {
                lines.push("\n## Failures\n".into());
                for f in fails {
                    match &f.message {
                        Some(m) => lines.push(format!("- `{}`: {m}\n", f.name)),
                        None => lines.push(format!("- `{}`\n", f.name)),
                    }
                }
            }
        }
        None => lines.push("No runs.\n".into()),
    }
    lines.join("")
}

fn markdown_status(status: &StatusJson) -> String {
    let ready = if status.ready { "READY" } else { "NOT READY" };
    let extra = if status.blockers.is_empty() {
        String::new()
    } else {
        format!(" · {} blockers", status.blockers.len())
    };
    let mut lines = vec![
        format!("# Status — {ready}{extra}"),
        format!("\n\n**Last run:** {}\n", status.last_run),
    ];
    if !status.blockers.is_empty() {
        lines.push("\n## Blockers\n".into());
        for b in &status.blockers {
            lines.push(format!("- **{}** — {}\n", b.page, b.message));
        }
    }
    lines.push("\n## Architecture\n".into());
    for a in &status.architecture {
        lines.push(format!(
            "- `{}`: {} rules, {} findings, {} unbaselined\n",
            a.audit, a.rules_implemented, a.total, a.unbaselined
        ));
    }
    lines.push("\nRead `data/status.json` instead of rerunning tests.\n".into());
    lines.join("")
}
