//! Test-only: a tiny in-memory IMAP server on a local TCP port, just enough of
//! the protocol for the mail-rule code paths (LIST/STATUS/CREATE/RENAME/SELECT,
//! UID SEARCH/FETCH/MOVE/STORE/EXPUNGE, APPEND). Each server holds folders of
//! messages; tests inspect the folders afterwards and can make RENAME or APPEND
//! fail to prove the "nothing is lost" paths.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use velo_core::imap::types::ImapConfig;
use velo_core::smtp::types::SmtpConfig;

use crate::mailboxes::MailboxCreds;

#[derive(Clone, Debug)]
pub struct Msg {
    pub uid: u32,
    pub flags: String,
    pub body: Vec<u8>,
}

#[derive(Default)]
pub struct Srv {
    pub folders: BTreeMap<String, Vec<Msg>>,
    pub next_uid: u32,
    /// Folders flagged `\Trash` in LIST.
    pub trash: Vec<String>,
    pub fail_rename: bool,
    pub fail_append: bool,
    /// Commands seen, in order (verb + folder, never message content).
    pub log: Vec<String>,
}

#[derive(Clone)]
pub struct Fixture {
    pub srv: Arc<Mutex<Srv>>,
    pub port: u16,
}

pub fn message(id: &str, from: &str, subject: &str) -> Vec<u8> {
    format!("Message-ID: <{id}@fx>\r\nFrom: {from}\r\nTo: me@fx\r\nSubject: {subject}\r\nDate: Mon, 1 Jan 2024 00:00:00 +0000\r\n\r\nbody {id}\r\n")
        .into_bytes()
}

impl Fixture {
    /// Start a server with the given folders (name → message bodies).
    pub async fn start(folders: &[(&str, Vec<Vec<u8>>)]) -> Fixture {
        let mut srv = Srv { next_uid: 1, ..Default::default() };
        for (name, msgs) in folders {
            let list = msgs
                .iter()
                .map(|b| {
                    srv.next_uid += 1;
                    Msg { uid: srv.next_uid - 1, flags: String::new(), body: b.clone() }
                })
                .collect();
            srv.folders.insert(name.to_string(), list);
        }
        let srv = Arc::new(Mutex::new(srv));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let shared = srv.clone();
        tokio::spawn(async move {
            loop {
                let Ok((sock, _)) = listener.accept().await else { return };
                let s = shared.clone();
                tokio::spawn(async move { serve(sock, s).await });
            }
        });
        Fixture { srv, port }
    }

    pub fn creds(&self, id: &str) -> MailboxCreds {
        MailboxCreds {
            id: id.into(),
            owner_user_id: "owner".into(),
            email: format!("{id}@fx"),
            imap: ImapConfig {
                host: "127.0.0.1".into(),
                port: self.port,
                security: "none".into(),
                username: "u".into(),
                password: "p".into(),
                auth_method: "password".into(),
                accept_invalid_certs: false,
            },
            smtp: SmtpConfig {
                host: "127.0.0.1".into(),
                port: 1,
                security: "none".into(),
                username: "u".into(),
                password: "p".into(),
                auth_method: "password".into(),
                accept_invalid_certs: false,
            },
        }
    }

    pub fn names(&self) -> Vec<String> {
        self.srv.lock().unwrap().folders.keys().cloned().collect()
    }

    pub fn count(&self, folder: &str) -> Option<usize> {
        self.srv.lock().unwrap().folders.get(folder).map(Vec::len)
    }

    pub fn uids(&self, folder: &str) -> Vec<u32> {
        self.srv.lock().unwrap().folders.get(folder).map(|m| m.iter().map(|x| x.uid).collect()).unwrap_or_default()
    }
}

fn tokens(line: &str) -> Vec<String> {
    let (mut out, mut cur, mut quoted) = (Vec::new(), String::new(), false);
    for c in line.chars() {
        match c {
            '"' => quoted = !quoted,
            ' ' if !quoted => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            _ => cur.push(c),
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

fn in_set(set: &str, uid: u32) -> bool {
    set.split(',').any(|p| match p.split_once(':') {
        Some((a, b)) => {
            let lo = a.parse::<u32>().unwrap_or(0);
            let hi = if b == "*" { u32::MAX } else { b.parse().unwrap_or(0) };
            uid >= lo && uid <= hi
        }
        None => p.parse::<u32>().ok() == Some(uid),
    })
}

async fn serve(sock: TcpStream, srv: Arc<Mutex<Srv>>) {
    let (rd, mut wr) = sock.into_split();
    let mut rd = BufReader::new(rd);
    let _ = wr.write_all(b"* OK fixture ready\r\n").await;
    let mut selected = String::new();
    loop {
        let mut line = String::new();
        if rd.read_line(&mut line).await.unwrap_or(0) == 0 {
            return;
        }
        let line = line.trim_end().to_string();
        let t = tokens(&line);
        if t.len() < 2 {
            continue;
        }
        let tag = t[0].clone();
        let verb = t[1].to_uppercase();
        let mut out = String::new();
        let mut done = format!("{tag} OK done\r\n");
        let arg = |i: usize| t.get(i).cloned().unwrap_or_default();
        match verb.as_str() {
            "LOGIN" | "NOOP" => {}
            "CAPABILITY" => out.push_str("* CAPABILITY IMAP4rev1 UIDPLUS MOVE\r\n"),
            "LOGOUT" => {
                let _ = wr.write_all(format!("* BYE\r\n{tag} OK bye\r\n").as_bytes()).await;
                return;
            }
            "LIST" => {
                let s = srv.lock().unwrap();
                for name in s.folders.keys() {
                    let attr = if s.trash.contains(name) { "\\HasNoChildren \\Trash" } else { "\\HasNoChildren" };
                    out.push_str(&format!("* LIST ({attr}) \".\" \"{name}\"\r\n"));
                }
            }
            "STATUS" => {
                let s = srv.lock().unwrap();
                match s.folders.get(&arg(2)) {
                    Some(m) => {
                        let next = m.iter().map(|x| x.uid).max().unwrap_or(0).max(s.next_uid - 1) + 1;
                        out.push_str(&format!(
                            "* STATUS \"{}\" (MESSAGES {} UNSEEN 0 UIDNEXT {next} UIDVALIDITY 1)\r\n",
                            arg(2),
                            m.len()
                        ));
                    }
                    None => done = format!("{tag} NO no such folder\r\n"),
                }
            }
            "CREATE" => {
                let mut s = srv.lock().unwrap();
                s.log.push(format!("CREATE {}", arg(2)));
                if s.folders.contains_key(&arg(2)) {
                    done = format!("{tag} NO [ALREADYEXISTS] exists\r\n");
                } else {
                    s.folders.insert(arg(2), vec![]);
                }
            }
            "RENAME" => {
                let mut s = srv.lock().unwrap();
                s.log.push(format!("RENAME {} {}", arg(2), arg(3)));
                if s.fail_rename || s.folders.contains_key(&arg(3)) {
                    done = format!("{tag} NO rename refused\r\n");
                } else if let Some(m) = s.folders.remove(&arg(2)) {
                    s.folders.insert(arg(3), m);
                } else {
                    done = format!("{tag} NO no such folder\r\n");
                }
            }
            "SELECT" => {
                let s = srv.lock().unwrap();
                match s.folders.get(&arg(2)) {
                    Some(m) => {
                        selected = arg(2);
                        let next = m.iter().map(|x| x.uid).max().unwrap_or(0).max(s.next_uid - 1) + 1;
                        out.push_str(&format!(
                            "* {} EXISTS\r\n* 0 RECENT\r\n* FLAGS (\\Seen \\Deleted)\r\n* OK [UIDVALIDITY 1] v\r\n* OK [UIDNEXT {next}] n\r\n",
                            m.len()
                        ));
                        done = format!("{tag} OK [READ-WRITE] selected\r\n");
                    }
                    None => done = format!("{tag} NO no such folder\r\n"),
                }
            }
            "UID" => {
                let sub = arg(2).to_uppercase();
                let mut s = srv.lock().unwrap();
                match sub.as_str() {
                    "SEARCH" => {
                        let rest = &t[3..];
                        let msgs = s.folders.get(&selected).cloned().unwrap_or_default();
                        let hits: Vec<u32> = if let Some(p) = rest.iter().position(|x| x.eq_ignore_ascii_case("HEADER")) {
                            let needle = rest.get(p + 2).cloned().unwrap_or_default().to_lowercase();
                            msgs.iter()
                                .filter(|m| String::from_utf8_lossy(&m.body).to_lowercase().contains(&format!("message-id: {needle}")))
                                .map(|m| m.uid)
                                .collect()
                        } else if let Some(p) = rest.iter().position(|x| x.eq_ignore_ascii_case("UID")) {
                            let set = rest.get(p + 1).cloned().unwrap_or_default();
                            msgs.iter().filter(|m| in_set(&set, m.uid)).map(|m| m.uid).collect()
                        } else {
                            msgs.iter().map(|m| m.uid).collect()
                        };
                        out.push_str(&format!(
                            "* SEARCH{}\r\n",
                            hits.iter().map(|u| format!(" {u}")).collect::<String>()
                        ));
                    }
                    "MOVE" | "COPY" => {
                        let (set, dest) = (arg(3), arg(4));
                        s.log.push(format!("{sub} {selected} -> {dest}"));
                        if !s.folders.contains_key(&dest) {
                            done = format!("{tag} NO [TRYCREATE] no such folder\r\n");
                        } else {
                            let src = s.folders.get_mut(&selected).unwrap();
                            let moving: Vec<Msg> = src.iter().filter(|m| in_set(&set, m.uid)).cloned().collect();
                            if sub == "MOVE" {
                                src.retain(|m| !in_set(&set, m.uid));
                            }
                            let mut next = s.next_uid;
                            let d = s.folders.get_mut(&dest).unwrap();
                            for mut m in moving {
                                m.uid = next;
                                next += 1;
                                d.push(m);
                            }
                            s.next_uid = next;
                        }
                    }
                    "STORE" => {
                        let (set, op) = (arg(3), arg(4).to_uppercase());
                        let flags = t[5..].join(" ");
                        if let Some(msgs) = s.folders.get_mut(&selected) {
                            for m in msgs.iter_mut().filter(|m| in_set(&set, m.uid)) {
                                for flag in flags.split_whitespace().map(|f| f.trim_matches(['(', ')'])) {
                                    if op.starts_with('+') && !m.flags.split_whitespace().any(|f| f == flag) {
                                        m.flags.push_str(flag);
                                        m.flags.push(' ');
                                    }
                                }
                            }
                        }
                    }
                    "EXPUNGE" => {
                        let set = arg(3);
                        s.log.push(format!("EXPUNGE {selected} {set}"));
                        if let Some(msgs) = s.folders.get_mut(&selected) {
                            msgs.retain(|m| !(in_set(&set, m.uid) && m.flags.contains("\\Deleted")));
                        }
                    }
                    "FETCH" => {
                        let set = arg(3);
                        let msgs = s.folders.get(&selected).cloned().unwrap_or_default();
                        for (i, m) in msgs.iter().enumerate().filter(|(_, m)| in_set(&set, m.uid)) {
                            let headers_only = line.to_uppercase().contains("BODY.PEEK[HEADER]");
                            let payload = if headers_only {
                                let end = m.body.windows(4).position(|w| w == b"\r\n\r\n").map(|p| p + 4).unwrap_or(m.body.len());
                                &m.body[..end]
                            } else {
                                &m.body[..]
                            };
                            let section = if headers_only { "HEADER" } else { "" };
                            out.push_str(&format!(
                                "* {} FETCH (UID {} FLAGS ({}) INTERNALDATE \"01-Jan-2024 00:00:00 +0000\" RFC822.SIZE {} BODY[{section}] {{{}}}\r\n",
                                i + 1,
                                m.uid,
                                m.flags.trim(),
                                m.body.len(),
                                payload.len()
                            ));
                            out.push_str(&String::from_utf8_lossy(payload));
                            out.push_str(")\r\n");
                        }
                    }
                    other => done = format!("{tag} BAD unsupported UID {other}\r\n"),
                }
            }
            "APPEND" => {
                let folder = arg(2);
                let size: usize = t.last().and_then(|x| x.trim_matches(|c| c == '{' || c == '}' || c == '+').parse().ok()).unwrap_or(0);
                let refuse = {
                    let mut s = srv.lock().unwrap();
                    s.log.push(format!("APPEND {folder}"));
                    s.fail_append || !s.folders.contains_key(&folder)
                };
                if refuse {
                    let _ = wr.write_all(format!("{tag} NO [TRYCREATE] append refused\r\n").as_bytes()).await;
                    continue;
                }
                let _ = wr.write_all(b"+ go ahead\r\n").await;
                let mut body = vec![0u8; size];
                if rd.read_exact(&mut body).await.is_err() {
                    return;
                }
                let mut rest = String::new();
                let _ = rd.read_line(&mut rest).await;
                let mut s = srv.lock().unwrap();
                let uid = s.next_uid;
                s.next_uid += 1;
                s.folders.get_mut(&folder).unwrap().push(Msg { uid, flags: String::new(), body });
            }
            _ => done = format!("{tag} BAD unsupported {verb}\r\n"),
        }
        out.push_str(&done);
        if wr.write_all(out.as_bytes()).await.is_err() {
            return;
        }
    }
}
