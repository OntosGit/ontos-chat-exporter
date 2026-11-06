#!/usr/bin/env python3
"""ONTOS Memory: local, offline, provenance-preserving conversation archaeology.

No third-party packages, network operations, API tokens, or Todoist writes.
Do not publish the SQLite database: it contains private conversations.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sqlite3
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path

SCHEMA = 1
MAX_FILE_BYTES = 256 * 1024 * 1024
MAX_ZIP_TOTAL = 512 * 1024 * 1024
SIGNALS = (
    (r"\b(?:давай|давайте|хочу|нужно|надо|предлагаю|запусти|создай|создадим|сделаем|разработаем|построим|воплоти)\b", 3),
    (r"\b(?:архитектур\w*|проект\w*|модел\w*|протокол\w*|инструмент\w*|систем\w*|исследован\w*|гипотез\w*)\b", 2),
    (r"\b(?:иде[яию]|различени\w*|незаверш\w*|возможност\w*|продолжени\w*|сохраним|зафиксир\w*)\b", 1),
    (r"\b(?:let's|we should|build|create|design|architecture|project|research|implement|continue)\b", 2),
)


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canon(value: object) -> str:
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def connect(db: Path) -> sqlite3.Connection:
    db.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA journal_mode=WAL")
    if conn.execute("PRAGMA user_version").fetchone()[0] not in (0, SCHEMA):
        raise ValueError("Unsupported database schema version")
    conn.executescript("""
    CREATE TABLE IF NOT EXISTS imports (
       source_hash TEXT PRIMARY KEY, origin TEXT NOT NULL, imported_utc TEXT NOT NULL,
       conversations INTEGER NOT NULL, messages INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS conversations (
       id TEXT PRIMARY KEY, title TEXT NOT NULL, current_snapshot INTEGER,
       source_updated_at REAL,
       FOREIGN KEY(current_snapshot) REFERENCES snapshots(id)
    );
    CREATE TABLE IF NOT EXISTS snapshots (
       id INTEGER PRIMARY KEY, conversation_id TEXT NOT NULL,
       fingerprint TEXT NOT NULL, imported_utc TEXT NOT NULL,
       UNIQUE(conversation_id, fingerprint),
       FOREIGN KEY(conversation_id) REFERENCES conversations(id)
    );
    CREATE TABLE IF NOT EXISTS revisions (
       id INTEGER PRIMARY KEY, conversation_id TEXT NOT NULL, message_id TEXT NOT NULL,
       content_sha TEXT NOT NULL, role TEXT NOT NULL, body TEXT NOT NULL,
       created_at TEXT, UNIQUE(conversation_id, message_id, content_sha),
       FOREIGN KEY(conversation_id) REFERENCES conversations(id)
    );
    CREATE TABLE IF NOT EXISTS snapshot_messages (
       snapshot_id INTEGER NOT NULL, position INTEGER NOT NULL, revision_id INTEGER NOT NULL,
       PRIMARY KEY(snapshot_id,position),
       FOREIGN KEY(snapshot_id) REFERENCES snapshots(id),
       FOREIGN KEY(revision_id) REFERENCES revisions(id)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(body, content='revisions',content_rowid='id');
    CREATE TABLE IF NOT EXISTS candidates (
       id TEXT PRIMARY KEY, revision_id INTEGER NOT NULL UNIQUE,
       score INTEGER NOT NULL, review_state TEXT NOT NULL DEFAULT 'unreviewed',
       FOREIGN KEY(revision_id) REFERENCES revisions(id)
    );
    CREATE TABLE IF NOT EXISTS architectures (
       id TEXT PRIMARY KEY, title TEXT NOT NULL, state TEXT NOT NULL,
       note TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS evidence (
       architecture_id TEXT NOT NULL, revision_id INTEGER NOT NULL,
       relation TEXT NOT NULL,
       PRIMARY KEY(architecture_id, revision_id, relation),
       FOREIGN KEY(architecture_id) REFERENCES architectures(id),
       FOREIGN KEY(revision_id) REFERENCES revisions(id)
    );
    CREATE TABLE IF NOT EXISTS external_links (
       architecture_id TEXT NOT NULL, kind TEXT NOT NULL, url TEXT NOT NULL,
       observation TEXT NOT NULL DEFAULT '',
       PRIMARY KEY(architecture_id,kind,url),
       FOREIGN KEY(architecture_id) REFERENCES architectures(id)
    );
    """)
    conn.execute("PRAGMA user_version=1")
    return conn


def visible(msg: object) -> bool:
    if not isinstance(msg, dict):
        return False
    role = (msg.get("author") or {}).get("role")
    if role not in ("user", "assistant"):
        return False
    meta = msg.get("metadata") or {}
    if meta.get("is_visually_hidden_from_conversation"):
        return False
    if (msg.get("channel") or meta.get("channel") or meta.get("message_type")) in (
        "analysis", "justify", "confidence", "notification"):
        return False
    if role == "assistant" and msg.get("recipient") not in (None, "all"):
        return False
    kind = (msg.get("content") or {}).get("content_type")
    if kind in ("thoughts", "reasoning_recap", "analysis"):
        return False
    if role == "assistant" and kind not in (None, "text", "multimodal_text"):
        return False
    return True


def extract_text(content: object) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, dict):
        return ""
    parts = content.get("parts")
    if isinstance(parts, list):
        texts = []
        for p in parts:
            if isinstance(p, str):
                texts.append(p)
            elif isinstance(p, dict):
                val = p.get("text") or p.get("transcript")
                if isinstance(val, str):
                    texts.append(val)
        return "\n\n".join(texts).strip()
    for key in ("text", "content", "summary", "result"):
        if isinstance(content.get(key), str):
            return content[key]
    return ""


def message_path(conv: dict) -> list[dict]:
    mapping = conv.get("mapping")
    if isinstance(mapping, dict):
        current = conv.get("current_node") or conv.get("current_node_id")
        if current not in mapping:
            raise ValueError("Conversation missing current_node; refusing incomplete tree")
        out, seen = [], set()
        while current is not None:
            if current in seen:
                raise ValueError("Cycle in conversation parent chain")
            seen.add(current)
            node = mapping.get(current)
            if node is None:
                raise ValueError("Missing parent node")
            if isinstance(node.get("message"), dict):
                out.append(node["message"])
            current = node.get("parent") or None
        return list(reversed(out))
    msgs = conv.get("messages")
    if isinstance(msgs, list):
        page = conv.get("page_info") or {}
        if page.get("has_previous_page") or page.get("has_next_page"):
            raise ValueError("Partial paginated conversation; refusing import")
        return [x.get("message", x) if isinstance(x, dict) else x for x in msgs]
    raise ValueError("Unsupported conversation format: missing mapping/messages")


def normalized(conv: dict) -> tuple[str, str, list[tuple[str, str, str, str | None]]]:
    if not isinstance(conv, dict):
        raise ValueError("Expected conversation object")
    cid = conv.get("conversation_id") or conv.get("id")
    if not isinstance(cid, str) or not cid.strip():
        raise ValueError("Conversation ID required for stable provenance")
    title = str(conv.get("title") or "Untitled")
    output = []
    for index, msg in enumerate(message_path(conv)):
        if not visible(msg):
            continue
        role = msg["author"]["role"]
        body = extract_text(msg.get("content"))
        if not body:
            continue
        mid = str(msg.get("id") or f"position-{index}-{digest(body.encode('utf-8'))[:12]}")
        when = msg.get("create_time")
        if when is None:
            date = None
        elif isinstance(when, (int, float)):
            date = datetime.fromtimestamp(when, timezone.utc).isoformat()
        else:
            date = str(when)
        output.append((mid, role, body, date))
    return cid, title, output


def iter_json(source_name: str, b: bytes):
    root = json.loads(b.decode("utf-8-sig"))
    if isinstance(root, list):
        for conv in root:
            yield conv
    elif isinstance(root, dict):
        if isinstance(root.get("conversations"), list):
            yield from root["conversations"]
        else:
            yield root
    else:
        raise ValueError(f"Invalid JSON conversation root: {source_name}")


def load_source(path: Path):
    if path.suffix.lower() == ".zip":
        with zipfile.ZipFile(path) as archive:
            candidates = [f for f in archive.infolist() if not f.is_dir() and re.search(r"(?:^|/)conversations(?:-\d+)?\.json$", f.filename, re.I)]
            if not candidates:
                raise ValueError("No conversations*.json files in ZIP")
            if sum(f.file_size for f in candidates) > MAX_ZIP_TOTAL:
                raise ValueError("ZIP JSON expands beyond safety limit")
            for info in sorted(candidates, key=lambda x: x.filename):
                yield from iter_json(info.filename, archive.read(info))
    elif path.suffix.lower() == ".json":
        if path.stat().st_size > MAX_FILE_BYTES:
            raise ValueError("JSON exceeds local pilot size limit")
        yield from iter_json(path.name, path.read_bytes())
    else:
        raise ValueError("Use direct JSON or official export ZIP")


def import_file(conn: sqlite3.Connection, source: Path) -> dict:
    source = source.expanduser().resolve()
    sha = hashlib.sha256()
    with source.open('rb') as file:
        while True:
            chunk = file.read(1024 * 1024)
            if not chunk:
                break
            sha.update(chunk)
    raw_sha = sha.hexdigest()
    if conn.execute("SELECT 1 FROM imports WHERE source_hash=?", (raw_sha,)).fetchone():
        return {"status": "already_imported", "source_sha256": raw_sha, "conversations": 0, "messages": 0}
    # Validate all conversations before changing DB; duplicate IDs in an archive are updated in sequence.
    total = 0
    count = 0
    timestamp = datetime.now(timezone.utc).isoformat()
    with conn:
        for conv in load_source(source):
            cid, title, msgs = normalized(conv)
            count += 1
            total += len(msgs)
            conn.execute("INSERT OR IGNORE INTO conversations(id,title) VALUES (?,?)", (cid, title))
            identity = digest(canon([title, msgs]).encode("utf-8"))
            snap = conn.execute("SELECT id FROM snapshots WHERE conversation_id=? AND fingerprint=?", (cid, identity)).fetchone()
            if snap is None:
                sid = conn.execute("INSERT INTO snapshots(conversation_id,fingerprint,imported_utc) VALUES (?,?,?)", (cid, identity, timestamp)).lastrowid
                for pos, (mid, role, body, date) in enumerate(msgs):
                    h = digest((role + "\0" + body).encode("utf-8"))
                    row = conn.execute("SELECT id FROM revisions WHERE conversation_id=? AND message_id=? AND content_sha=?", (cid, mid, h)).fetchone()
                    if row:
                        rid = row[0]
                    else:
                        rid = conn.execute("INSERT INTO revisions(conversation_id,message_id,content_sha,role,body,created_at) VALUES (?,?,?,?,?,?)", (cid, mid, h, role, body, date)).lastrowid
                        conn.execute("INSERT INTO message_fts(rowid,body) VALUES (?,?)", (rid, body))
                    conn.execute("INSERT INTO snapshot_messages(snapshot_id,position,revision_id) VALUES (?,?,?)", (sid, pos, rid))
            else:
                sid = snap[0]
            incoming = conv.get("update_time")
            try:
                source_time = float(incoming) if incoming is not None else None
            except (TypeError, ValueError):
                source_time = None
            known = conn.execute("SELECT source_updated_at FROM conversations WHERE id=?", (cid,)).fetchone()[0]
            if known is None or source_time is None or source_time >= known:
                conn.execute("UPDATE conversations SET title=?, current_snapshot=?, source_updated_at=? WHERE id=?", (title, sid, source_time, cid))
        conn.execute("INSERT INTO imports(source_hash,origin,imported_utc,conversations,messages) VALUES (?,?,?,?,?)", (raw_sha, str(source), timestamp, count, total))
    return {"status": "imported", "source_sha256": raw_sha, "conversations": count, "messages": total}


def current_query() -> str:
    return "FROM conversations c JOIN snapshot_messages sm ON sm.snapshot_id=c.current_snapshot JOIN revisions r ON r.id=sm.revision_id"


def evidence_link(cid: str) -> str:
    return "https://chatgpt.com/c/" + cid if re.fullmatch(r"[0-9a-fA-F-]{32,40}", cid) else ""


def compact_row(r: sqlite3.Row) -> dict:
    return {"revision_id": r["id"], "conversation_id": r["conversation_id"], "conversation_title": r["title"], "message_id": r["message_id"], "role": r["role"], "created_at": r["created_at"], "link": evidence_link(r["conversation_id"]), "excerpt": r["body"][:450]}


def search(conn: sqlite3.Connection, phrase: str, limit: int) -> list[dict]:
    tokens = re.findall(r"[\w]+", phrase, re.UNICODE)[:10]
    if not tokens:
        return []
    query = " AND ".join('"' + t.replace('"','') + '"' for t in tokens)
    sql = "SELECT r.id,r.conversation_id,c.title,r.message_id,r.role,r.created_at,r.body " + current_query() + " JOIN message_fts f ON f.rowid=r.id WHERE message_fts MATCH ? ORDER BY bm25(message_fts) LIMIT ?"
    return [compact_row(x) for x in conn.execute(sql, (query, limit))]


def candidate_score(body: str, role: str) -> int:
    if role != "user":
        return 0
    low = body.casefold()
    hits = sum(weight for pattern, weight in SIGNALS if re.search(pattern, low, re.I))
    if len(body) < 15:
        return 0
    return hits


def discover(conn: sqlite3.Connection, limit: int) -> list[dict]:
    rows = conn.execute("SELECT r.id,r.conversation_id,c.title,r.message_id,r.role,r.created_at,r.body " + current_query() + " WHERE r.role='user' ORDER BY r.id").fetchall()
    scored = [(r, candidate_score(r["body"], r["role"])) for r in rows]
    candidates = [(r, score) for r, score in scored if score >= 3]
    with conn:
        for r, score in candidates:
            key = "C-" + digest(f"{r['conversation_id']}:{r['message_id']}:{r['id']}".encode())[:16]
            conn.execute("INSERT OR IGNORE INTO candidates(id,revision_id,score) VALUES (?,?,?)", (key, r["id"], score))
    out = []
    for r, score in sorted(candidates, key=lambda pair: (-pair[1],pair[0]["id"]))[:limit]:
        x = compact_row(r)
        x["candidate_id"] = "C-" + digest(f"{r['conversation_id']}:{r['message_id']}:{r['id']}".encode())[:16]
        x["score"] = score
        x["review_state"] = conn.execute("SELECT review_state FROM candidates WHERE id=?", (x["candidate_id"],)).fetchone()[0]
        out.append(x)
    return out


def record_architecture(conn: sqlite3.Connection, aid: str, title: str, state: str, cid: str, note: str) -> dict:
    candidate = conn.execute("SELECT revision_id FROM candidates WHERE id=?", (cid,)).fetchone()
    if not candidate:
        raise ValueError("Candidate not found; run discover first")
    if conn.execute("SELECT 1 FROM architectures WHERE id=?",(aid,)).fetchone():
        raise ValueError("Architecture exists; use attach or link instead")
    with conn:
        conn.execute("INSERT INTO architectures(id,title,state,note) VALUES (?,?,?,?)",(aid,title,state,note))
        conn.execute("INSERT INTO evidence(architecture_id,revision_id,relation) VALUES (?,?,?)",(aid,candidate[0],"origin"))
        conn.execute("UPDATE candidates SET review_state='confirmed' WHERE id=?",(cid,))
    return {"id":aid,"title":title,"state":state,"evidence_candidate":cid}


def architecture_details(conn:sqlite3.Connection, aid:str) -> dict:
    row=conn.execute("SELECT * FROM architectures WHERE id=?",(aid,)).fetchone()
    if not row:
        raise ValueError("Architecture not found")
    result=dict(row)
    result["evidence"]=[dict(x) for x in conn.execute("SELECT e.relation,r.id AS revision_id,r.conversation_id,r.message_id,r.created_at FROM evidence e JOIN revisions r ON r.id=e.revision_id WHERE e.architecture_id=? ORDER BY r.created_at",(aid,))]
    result["external_links"]=[dict(x) for x in conn.execute("SELECT kind,url,observation FROM external_links WHERE architecture_id=?",(aid,))]
    return result


def summary(conn: sqlite3.Connection) -> dict:
    tables = ("imports","conversations","snapshots","revisions","candidates","architectures","evidence","external_links")
    return {"schema":SCHEMA,**{name:conn.execute(f"SELECT COUNT(*) FROM {name}").fetchone()[0] for name in tables}}


def main(argv: list[str] | None = None) -> int:
    parser=argparse.ArgumentParser(description="ONTOS memory: local chat architecture archaeology. No network or external writes.")
    parser.add_argument("--db",type=Path,default=Path("private/ontos-memory.sqlite3"),help="PRIVATE SQLite database path")
    commands=parser.add_subparsers(dest="command",required=True)
    commands.add_parser("init")
    imp=commands.add_parser("import"); imp.add_argument("source",type=Path)
    find=commands.add_parser("search");find.add_argument("phrase");find.add_argument("--limit",type=int,default=20)
    disc=commands.add_parser("discover");disc.add_argument("--limit",type=int,default=50)
    commands.add_parser("stats")
    rec=commands.add_parser("record");rec.add_argument("--id",required=True);rec.add_argument("--title",required=True);rec.add_argument("--candidate",required=True);rec.add_argument("--state",default="researching");rec.add_argument("--note",default="")
    attach=commands.add_parser("attach");attach.add_argument("--id",required=True);attach.add_argument("--candidate",required=True);attach.add_argument("--relation",choices=["development","revision","realization","contradiction"],default="development")
    link=commands.add_parser("link");link.add_argument("--id",required=True);link.add_argument("--kind",choices=["github","todoist","drive","other"],required=True);link.add_argument("--url",required=True);link.add_argument("--observation",default="")
    show=commands.add_parser("show");show.add_argument("id",nargs="?")
    args=parser.parse_args(argv)
    if hasattr(args,"limit") and not 1<=args.limit<=500:
        parser.error("limit must be 1..500")
    conn=connect(args.db)
    try:
        if args.command=="init": result={"status":"ready","db":str(args.db),**summary(conn)}
        elif args.command=="import":result=import_file(conn,args.source)
        elif args.command=="search":result=search(conn,args.phrase,args.limit)
        elif args.command=="discover":result=discover(conn,args.limit)
        elif args.command=="stats":result=summary(conn)
        elif args.command=="record":result=record_architecture(conn,args.id,args.title,args.state,args.candidate,args.note)
        elif args.command=="attach":
            if not conn.execute("SELECT 1 FROM architectures WHERE id=?",(args.id,)).fetchone():raise ValueError("Architecture not found")
            candidate=conn.execute("SELECT revision_id FROM candidates WHERE id=?",(args.candidate,)).fetchone()
            if not candidate:raise ValueError("Candidate not found")
            with conn:conn.execute("INSERT OR IGNORE INTO evidence(architecture_id,revision_id,relation) VALUES (?,?,?)",(args.id,candidate[0],args.relation))
            result=architecture_details(conn,args.id)
        elif args.command=="link":
            if not conn.execute("SELECT 1 FROM architectures WHERE id=?",(args.id,)).fetchone():raise ValueError("Architecture not found")
            if not re.match(r"^https://",args.url):raise ValueError("Link must be HTTPS")
            with conn:conn.execute("INSERT OR IGNORE INTO external_links(architecture_id,kind,url,observation) VALUES (?,?,?,?)",(args.id,args.kind,args.url,args.observation))
            result=architecture_details(conn,args.id)
        elif args.command=="show":
            result=architecture_details(conn,args.id) if args.id else [dict(x) for x in conn.execute("SELECT id,title,state,note FROM architectures ORDER BY id")]
        else:raise ValueError("Unsupported command")
        print(json.dumps(result,ensure_ascii=False,indent=2))
        return 0
    except (ValueError,sqlite3.Error,zipfile.BadZipFile,json.JSONDecodeError,OSError) as exc:
        print(f"Error: {type(exc).__name__}: {exc}",file=sys.stderr)
        return 2
    finally:conn.close()

if __name__=="__main__":
    raise SystemExit(main())