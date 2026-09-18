fn main() {
    let cmd = std::env::args().nth(1).unwrap_or_else(|| "report".into());
    match cmd.as_str() {
        "report" => finish(velo_report::report()),
        "audits" => finish(velo_report::audits()),
        "gate" => {
            let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
            let status = root.join("tests/reporting/data/status.json");
            match velo_report::gate(&status) {
                Ok(true) => {}
                Ok(false) => {
                    eprintln!("not ready — see {}", status.display());
                    std::process::exit(1);
                }
                Err(e) => {
                    eprintln!("gate failed: {e}");
                    std::process::exit(1);
                }
            }
        }
        _ => {
            eprintln!("usage: velo-report [report|audits|gate]");
            std::process::exit(2);
        }
    }
}

fn finish(result: std::io::Result<velo_report::ReportResult>) {
    match result {
        Ok(r) => {
            println!("{}", r.index_html.display());
            println!("ready={}", r.ready);
        }
        Err(e) => {
            eprintln!("report failed: {e}");
            std::process::exit(1);
        }
    }
}
