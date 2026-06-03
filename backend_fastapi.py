from __future__ import annotations

import hashlib
import json
import math
import os
import re
import time
import urllib.error
import urllib.request
from collections import Counter, defaultdict
from datetime import date
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

try:
    import chromadb  # type: ignore
except Exception:  # pragma: no cover - optional dependency
    chromadb = None

try:
    from neo4j import GraphDatabase  # type: ignore
except Exception:  # pragma: no cover - optional dependency
    GraphDatabase = None


ROOT = Path(__file__).resolve().parent
DEEPSEEK_MODEL = os.getenv("DEEPSEEK_MODEL", "deepseek-chat")
DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY", "")
MINIMAX_MODEL = os.getenv("MINIMAX_MODEL", "MiniMax-M2.5")
MINIMAX_API_KEY = os.getenv("MINIMAX_API_KEY", "")
AI_PROVIDER = os.getenv("AI_PROVIDER", "deepseek" if DEEPSEEK_API_KEY else "minimax")
DAILY_AI_LIMIT = int(os.getenv("DAILY_AI_LIMIT", "30"))
CHROMA_DIR = os.getenv("CHROMA_PERSIST_DIR", str(ROOT / ".chroma"))
NEO4J_URI = os.getenv("NEO4J_URI", "")
NEO4J_USER = os.getenv("NEO4J_USER", "neo4j")
NEO4J_PASSWORD = os.getenv("NEO4J_PASSWORD", "")


class IndexBody(BaseModel):
    title: str = "学习材料"
    text: str = ""
    profile: dict[str, Any] = Field(default_factory=dict)


class DiagnoseBody(BaseModel):
    profile: dict[str, Any] = Field(default_factory=dict)
    source: dict[str, Any] | None = None
    graph: dict[str, Any] | None = None


class PlanBody(BaseModel):
    profile: dict[str, Any] = Field(default_factory=dict)
    goal: dict[str, Any] | None = None
    answers: list[dict[str, Any]] = Field(default_factory=list)
    weakPoints: list[str] = Field(default_factory=list)
    graph: dict[str, Any] | None = None


class PracticeBody(BaseModel):
    profile: dict[str, Any] = Field(default_factory=dict)
    goal: dict[str, Any] | None = None
    answers: list[dict[str, Any]] = Field(default_factory=list)
    weakPoints: list[str] = Field(default_factory=list)
    source: dict[str, Any] | None = None
    previousQuestions: list[str] = Field(default_factory=list)


class RagBody(BaseModel):
    question: str = ""
    profile: dict[str, Any] = Field(default_factory=dict)
    weakPoints: list[str] = Field(default_factory=list)
    source: dict[str, Any] | None = None
    graph: dict[str, Any] | None = None


app = FastAPI(title="Personalized KG Learning System")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

usage: dict[str, int] = defaultdict(int)
memory_chunks: list[dict[str, Any]] = []
memory_graph: dict[str, Any] = {"nodes": [], "edges": []}


def create_chroma_collection():
    if chromadb is None:
        return None
    client = chromadb.PersistentClient(path=CHROMA_DIR)
    return client.get_or_create_collection(name="learning_chunks")


def create_neo4j_driver():
    if GraphDatabase is None or not NEO4J_URI or not NEO4J_PASSWORD:
        return None
    return GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))


chroma_collection = create_chroma_collection()
neo4j_driver = create_neo4j_driver()


@app.middleware("http")
async def no_store(request: Request, call_next):
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store"
    return response


@app.get("/api/status")
def status(request: Request):
    return {
        "ok": True,
        "backend": "FastAPI",
        "provider": active_provider(),
        "model": active_model(),
        "apiConfigured": api_configured(),
        "neo4jConnected": neo4j_driver is not None,
        "chromaConnected": chroma_collection is not None,
        "dailyLimit": DAILY_AI_LIMIT,
        "remaining": remaining_for(request),
    }


@app.post("/api/index")
def index_material(body: IndexBody):
    chunks = chunk_text(body.text)
    source_id = f"source_{int(time.time() * 1000)}"
    records = []
    for index, chunk in enumerate(chunks):
        record = {
            "id": f"{source_id}_{index}",
            "sourceId": source_id,
            "title": body.title,
            "text": chunk,
            "terms": dict(term_counter(f"{body.title} {body.profile.get('subject', '')} {chunk}")),
        }
        records.append(record)

    if chroma_collection is not None and records:
        chroma_collection.add(
            ids=[item["id"] for item in records],
            documents=[item["text"] for item in records],
            metadatas=[{"sourceId": item["sourceId"], "title": item["title"]} for item in records],
            embeddings=[hash_embedding(item["text"]) for item in records],
        )
    else:
        memory_chunks.extend(records)

    graph = build_graph(" ".join(chunks), body.profile.get("goal") or body.title)
    persist_graph(graph, body.profile)
    return {
        "source": {"id": source_id, "title": body.title, "chunkCount": len(chunks)},
        "graph": graph,
        "storage": {"chroma": chroma_collection is not None, "neo4j": neo4j_driver is not None},
    }


@app.post("/api/diagnose")
def diagnose(body: DiagnoseBody, request: Request):
    consume_or_raise(request)
    retrieved = retrieve(body.profile.get("goal", ""), body.source, limit=3)
    graph = body.graph or graph_from_neo4j(body.profile.get("goal", ""))
    fallback = fallback_diagnosis(body.profile, body.source, graph)
    data = call_llm_json(
        {
            "task": "diagnose",
            "profile": body.profile,
            "retrievedChunks": retrieved,
            "graph": graph,
            "output_schema": {
                "goalTitle": "string",
                "goalDescription": "string",
                "problemGuess": "string",
                "questions": [{"skill": "string", "question": "string", "answer": "string", "options": ["string"]}],
            },
        },
        fallback,
    )
    return data | {"remaining": remaining_for(request), "model": active_model()}


@app.post("/api/plan")
def plan(body: PlanBody, request: Request):
    consume_or_raise(request)
    fallback = fallback_plan(body)
    data = call_llm_json(
        {
            "task": "plan",
            "profile": body.profile,
            "goal": body.goal,
            "answers": body.answers,
            "weakPoints": body.weakPoints,
            "graph": body.graph or graph_from_neo4j(body.profile.get("goal", "")),
            "output_schema": {
                "level": "string",
                "score": "number",
                "weakSkills": ["string"],
                "advice": "string",
                "path": [{"title": "string", "desc": "string", "type": "string", "minutes": "number"}],
            },
        },
        fallback,
    )
    return data | {"remaining": remaining_for(request), "model": active_model()}


@app.post("/api/practice")
def practice(body: PracticeBody, request: Request):
    consume_or_raise(request)
    query = " ".join([*body.weakPoints, body.profile.get("goal", "")])
    fallback = fallback_practice(body)
    data = fallback | {"source": "fallback"}
    for attempt in range(2):
        payload = {
            "task": "practice",
            "nonce": f"{int(time.time() * 1000)}-{attempt}",
            "profile": body.profile,
            "goal": body.goal,
            "weakPoints": body.weakPoints,
            "answers": body.answers,
            "previousQuestions": body.previousQuestions[-12:],
            "constraints": [
                "不要重复 previousQuestions 中已经出现过的题目。",
                "answer 必须与 options 中某一个完整选项文本完全一致，不能只写 A/B/C/D。",
                "题目要围绕 weakPoints 中的薄弱点变化问法。",
                "reason 用一句话说明为什么当前用户需要做这道题。",
            ],
            "retrievedChunks": retrieve(query, body.source, limit=3),
            "output_schema": {
                "reason": "string",
                "question": {"skill": "string", "question": "string", "answer": "string", "options": ["string"]},
            },
        }
        data = call_llm_json(payload, fallback)
        candidate = (data.get("question") or data).get("question", "")
        if not is_duplicate_question(candidate, body.previousQuestions):
            break
    return data | {"remaining": remaining_for(request), "model": active_model()}


@app.post("/api/rag")
def rag(body: RagBody, request: Request):
    consume_or_raise(request)
    chunks = retrieve(body.question, body.source, limit=4)
    graph = body.graph or graph_from_neo4j(body.question)
    fallback = fallback_rag(body, chunks, graph)
    data = call_llm_json(
        {
            "task": "rag_answer",
            "question": body.question,
            "profile": body.profile,
            "weakPoints": body.weakPoints,
            "retrievedChunks": chunks,
            "graph": graph,
            "output_schema": {
                "answer": "string",
                "citations": ["string"],
                "related": {"nodes": ["string"], "edges": [{"from": "string", "to": "string", "label": "string"}]},
            },
        },
        fallback,
    )
    return data | {"remaining": remaining_for(request), "model": active_model()}


def chunk_text(text: str) -> list[str]:
    clean = re.sub(r"\s+", " ", text or "").strip()
    if not clean:
        return []
    return [clean[i : i + 220] for i in range(0, min(len(clean), 3520), 180)]


def term_counter(text: str) -> Counter:
    words = re.findall(r"[\u4e00-\u9fff]{2,}|[a-zA-Z0-9]{2,}", (text or "").lower())
    return Counter(words)


def hash_embedding(text: str, dim: int = 64) -> list[float]:
    vector = [0.0] * dim
    for term, count in term_counter(text).items():
        digest = hashlib.sha1(term.encode("utf-8")).digest()
        index = int.from_bytes(digest[:2], "big") % dim
        vector[index] += float(count)
    norm = math.sqrt(sum(value * value for value in vector)) or 1.0
    return [value / norm for value in vector]


def retrieve(query: str, source: dict[str, Any] | None, limit: int = 3) -> list[str]:
    if chroma_collection is not None:
        where = {"sourceId": source["id"]} if source and source.get("id") else None
        result = chroma_collection.query(query_embeddings=[hash_embedding(query)], n_results=limit, where=where)
        return list((result.get("documents") or [[]])[0])

    query_terms = term_counter(query)
    pool = [item for item in memory_chunks if not source or item.get("sourceId") == source.get("id")]
    scored = sorted(pool, key=lambda item: score_terms(query_terms, Counter(item["terms"])), reverse=True)
    return [item["text"] for item in scored[:limit] if score_terms(query_terms, Counter(item["terms"])) > 0]


def score_terms(a: Counter, b: Counter) -> float:
    return float(sum(min(value, b.get(key, 0)) for key, value in a.items()))


def build_graph(text: str, goal: str) -> dict[str, Any]:
    terms = list(term_counter(f"{goal} {text}").keys())[:14]
    nodes = list(dict.fromkeys(terms or ["目标", "基础", "练习", "复习"]))
    edges = [{"from": nodes[i], "to": nodes[i + 1], "label": "先学" if i % 2 == 0 else "关联"} for i in range(len(nodes) - 1)]
    return {"nodes": nodes, "edges": edges}


def persist_graph(graph: dict[str, Any], profile: dict[str, Any]):
    memory_graph["nodes"] = list(dict.fromkeys([*memory_graph["nodes"], *graph.get("nodes", [])]))
    memory_graph["edges"].extend(graph.get("edges", []))
    if neo4j_driver is None:
        return
    with neo4j_driver.session() as session:
        for node in graph.get("nodes", []):
            session.run(
                "MERGE (k:KnowledgePoint {name: $name}) SET k.subject = coalesce($subject, k.subject)",
                name=node,
                subject=profile.get("subject"),
            )
        for edge in graph.get("edges", []):
            session.run(
                """
                MERGE (a:KnowledgePoint {name: $from})
                MERGE (b:KnowledgePoint {name: $to})
                MERGE (a)-[r:RELATED {label: $label}]->(b)
                """,
                **edge,
            )


def graph_from_neo4j(query: str) -> dict[str, Any]:
    if neo4j_driver is None:
        return memory_graph
    with neo4j_driver.session() as session:
        rows = session.run(
            """
            MATCH (a:KnowledgePoint)-[r:RELATED]->(b:KnowledgePoint)
            WHERE a.name CONTAINS $q OR b.name CONTAINS $q OR $q = ''
            RETURN a.name AS from, b.name AS to, r.label AS label
            LIMIT 20
            """,
            q=(query or "")[:12],
        )
        edges = [dict(row) for row in rows]
    nodes = list(dict.fromkeys([value for edge in edges for value in (edge["from"], edge["to"])]))
    return {"nodes": nodes, "edges": edges}


def active_provider() -> str:
    if AI_PROVIDER == "deepseek" and DEEPSEEK_API_KEY:
        return "deepseek"
    if AI_PROVIDER == "minimax" and MINIMAX_API_KEY:
        return "minimax"
    if DEEPSEEK_API_KEY:
        return "deepseek"
    if MINIMAX_API_KEY:
        return "minimax"
    return "fallback"


def active_model() -> str:
    provider = active_provider()
    if provider == "deepseek":
        return DEEPSEEK_MODEL
    if provider == "minimax":
        return MINIMAX_MODEL
    return "local-fallback"


def api_configured() -> bool:
    return active_provider() != "fallback"


def call_llm_json(payload: dict[str, Any], fallback: dict[str, Any]) -> dict[str, Any]:
    provider = active_provider()
    if provider == "deepseek":
        return call_openai_compatible_json(
            url="https://api.deepseek.com/chat/completions",
            api_key=DEEPSEEK_API_KEY,
            model=DEEPSEEK_MODEL,
            payload=payload,
            fallback=fallback,
            source="deepseek",
        )
    if provider == "minimax":
        return call_openai_compatible_json(
            url="https://api.minimax.io/v1/chat/completions",
            api_key=MINIMAX_API_KEY,
            model=MINIMAX_MODEL,
            payload=payload,
            fallback=fallback,
            source="minimax",
            max_token_key="max_completion_tokens",
        )
    return fallback | {"source": "fallback"}


def call_openai_compatible_json(
    *,
    url: str,
    api_key: str,
    model: str,
    payload: dict[str, Any],
    fallback: dict[str, Any],
    source: str,
    max_token_key: str = "max_tokens",
) -> dict[str, Any]:
    request_body = {
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": (
                    "You are an adaptive self-learning planner. "
                    "Return only valid JSON matching the requested output_schema. "
                    "If options are requested, the answer field must exactly equal one full option string. "
                    "Avoid repeating any question listed in previousQuestions."
                ),
            },
            {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
        ],
        "temperature": 0.35,
        "top_p": 0.9,
        max_token_key: 1800,
    }
    body = json.dumps(request_body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=35) as response:
            raw = json.loads(response.read().decode("utf-8"))
        content = raw.get("choices", [{}])[0].get("message", {}).get("content", "")
        parsed = parse_json(content)
        return (parsed or fallback) | {"source": source}
    except Exception:
        return fallback | {"source": "fallback"}


def parse_json(text: str) -> dict[str, Any]:
    cleaned = re.sub(r"<think>[\s\S]*?</think>", "", text or "").strip()
    try:
        return json.loads(cleaned)
    except Exception:
        match = re.search(r"\{[\s\S]*\}", cleaned)
        if not match:
            return {}
        return json.loads(match.group(0))


def normalize_question(text: str) -> str:
    return re.sub(r"[\s，。？！,.?!：“”\"']", "", str(text or "")).lower()


def is_duplicate_question(question: str, previous: list[str]) -> bool:
    current = normalize_question(question)
    if not current:
        return False
    return any(current == normalize_question(item) for item in previous)


def fallback_diagnosis(profile: dict[str, Any], source: dict[str, Any] | None, graph: dict[str, Any] | None) -> dict[str, Any]:
    goal = str(profile.get("goal") or "自学目标")
    problem = str(profile.get("problem") or "")
    nodes = (graph or {}).get("nodes") or []
    return {
        "goalTitle": goal[:30],
        "goalDescription": "已结合学习材料做初步判断" if source else "先用通用诊断题确认基础",
        "problemGuess": f"你现在更像是卡在：{problem}" if problem and problem != "未填写" else "需要先确认基础、题目识别和复习习惯",
        "questions": [
            {"skill": nodes[0] if nodes else "基础概念", "question": "开始学习一个新主题时，最先应该确认什么？", "answer": "哪些内容是前置基础", "options": ["哪些内容是前置基础", "资料一共有几页", "哪个软件最流行", "封面是否好看"]},
            {"skill": nodes[1] if len(nodes) > 1 else "题目识别", "question": "看到题目不会下手时，通常先做哪一步？", "answer": "找已知条件和目标之间的关系", "options": ["找已知条件和目标之间的关系", "直接套最长公式", "先猜答案", "跳过所有基础"]},
            {"skill": nodes[2] if len(nodes) > 2 else "复习安排", "question": "为了减少学完就忘，学习路线里应该加入什么？", "answer": "按错题和时间安排回顾", "options": ["按错题和时间安排回顾", "只往后学新内容", "每天换一个主题", "只整理目录"]},
        ],
    }


def fallback_plan(body: PlanBody) -> dict[str, Any]:
    score = len([item for item in body.answers if item.get("correct")])
    first_weak = (body.weakPoints or ["知识脉络"])[0]
    goal = (body.goal or {}).get("goalTitle") or body.profile.get("goal") or "你的目标"
    return {
        "level": "基础比较稳" if score >= 3 else "可以继续学，但有缺口" if score == 2 else "需要先补基础",
        "score": score,
        "weakSkills": body.weakPoints,
        "advice": f"先处理「{first_weak}」，再继续抽题确认是否稳定。",
        "path": [
            {"title": f"先补：{first_weak}", "desc": "用短解释和两道基础题确认这个点，不急着往后学。", "type": "今天先做", "minutes": 25},
            {"title": f"推进：{goal}", "desc": "把目标拆成一个小任务，每学完一块就用题目确认掌握情况。", "type": "新内容", "minutes": 40},
            {"title": "安排回顾", "desc": "把错题和不确定的地方放入复习清单，下次学习先回看。", "type": "复习", "minutes": 15},
        ],
    }


def fallback_practice(body: PracticeBody) -> dict[str, Any]:
    skill = (body.weakPoints or [body.source.get("title") if body.source else "知识脉络"])[-1]
    return {
        "reason": f"系统记录到「{skill}」仍需要巩固，所以继续用变式题检查。",
        "question": {
            "skill": skill,
            "question": f"关于「{skill}」，下面哪种做法最能帮助你真正掌握？",
            "answer": "先说明关系，再做一道对应题",
            "options": ["先说明关系，再做一道对应题", "只把资料收藏起来", "直接跳到最难内容", "只看答案不复盘"],
        }
    }


def fallback_rag(body: RagBody, chunks: list[str], graph: dict[str, Any]) -> dict[str, Any]:
    weak = (body.weakPoints or ["当前薄弱点"])[0]
    return {
        "answer": f"可以先把问题拆成两件事：缺哪个前置概念，哪一步不会用。从记录看，优先处理「{weak}」。",
        "citations": chunks or ["当前没有可引用的材料片段，回答主要依据学习档案和诊断记录。"],
        "related": graph or {"nodes": [weak, "练习", "复习"], "edges": [{"from": weak, "to": "练习", "label": "巩固"}]},
    }
def day_key() -> str:
    return date.today().isoformat()


def client_key(request: Request) -> str:
    return f"{day_key()}:{request.client.host if request.client else 'local'}"


def remaining_for(request: Request) -> int:
    return max(0, DAILY_AI_LIMIT - usage[client_key(request)])


def consume_or_raise(request: Request):
    key = client_key(request)
    if usage[key] >= DAILY_AI_LIMIT:
        raise HTTPException(status_code=429, detail="今天的规划次数已用完，请明天再试。")
    usage[key] += 1


@app.get("/")
def root():
    return FileResponse(ROOT / "index.html")


app.mount("/", StaticFiles(directory=ROOT, html=True), name="static")
