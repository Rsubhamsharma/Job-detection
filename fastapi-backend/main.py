from fastapi import FastAPI, Depends, HTTPException, status, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional
import uvicorn
import time
import json
from pathlib import Path
import sqlite3

from scoring import calculate_energy_sink_score
from auth import create_access_token, get_password_hash, verify_password, decode_access_token
from mail_service import send_otp_email, generate_otp, analyze_email_signals

# OTP Storage (In-memory for demo)
otp_db = {} # {email: {"otp": str, "expiry": int}}

# Try to import ML, use a simple fallback if libraries are missing
try:
    from ml_engine import predict_authenticity, predict_ghost_job_likelihood
except ImportError:
    print("Warning: ML libraries not found. Using fallbacks.")
    def predict_authenticity(text: str) -> float: return 85.0
    def predict_ghost_job_likelihood(d, h): return {"ghost_likelihood": 10.0}

app = FastAPI(title="JobZoid AI", description="AI/ML powered Applicant Energy Sink Detector")

# CORS Configuration
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mock DB
DB_PATH = Path(__file__).with_name("aesd_demo.db").resolve()
print(f"Active AESD DB path: {DB_PATH}")

jobs_db = [
    {"id": 1, "title": "Senior Frontend Developer", "company_name": "ABC Corp", "score": 72, "status": "Ghosted"},
    {"id": 2, "title": "Product Designer", "company_name": "Meta", "score": 18, "status": "Active"},
    {"id": 3, "title": "Staff Engineer", "company_name": "Stripe", "score": 42, "status": "Slow"},
]
signals_db = []
tracked_jobs_db = {}
SUPPORTED_SIGNAL_TYPES = {
    "page_visit",
    "time_spent",
    "scroll_depth",
    "apply_click",
    "easy_apply_click",
    "application_submitted",
    "external_apply_redirect",
    "form_interaction",
    "resume_upload",
    "cover_letter_detected",
    "repeated_visit",
    "saved_job",
    "employer_response_detected",
    "interview_detected",
    "rejection_detected",
    "assessment_detected",
    "no_response_after_delay",
    "status_change_detected",
    "email_response_detected",
}
MEANINGFUL_DIRECT_SIGNALS = {
    "apply_click",
    "easy_apply_click",
    "application_submitted",
    "external_apply_redirect",
}
RESPONSE_SIGNALS = {
    "employer_response_detected",
    "interview_detected",
    "rejection_detected",
    "status_change_detected",
    "email_response_detected",
}

def clamp(value, low=0, high=100):
    return max(low, min(high, value))

def calculate_signal_score(signal_rows):
    signal_types = [normalize_signal_type(row["signal_type"] or row["event_type"]) for row in signal_rows]
    apply_clicks = signal_types.count("apply_click")
    easy_apply_clicks = signal_types.count("easy_apply_click")
    application_submitted = signal_types.count("application_submitted")
    external_redirects = signal_types.count("external_apply_redirect")
    form_interactions = signal_types.count("form_interaction")
    resume_uploads = signal_types.count("resume_upload")
    cover_letters = signal_types.count("cover_letter_detected")
    repeated_visits = signal_types.count("repeated_visit")
    page_visits = signal_types.count("page_visit")
    no_response_events = signal_types.count("no_response_after_delay")
    response_events = sum(1 for value in signal_types if value in RESPONSE_SIGNALS)
    time_spent = sum(int(row["timestamp"] and 0) for row in [])
    scroll_depth = 0
    for row in signal_rows:
        try:
            metadata = json.loads(row["metadata"] or "{}")
        except json.JSONDecodeError:
            metadata = {}
        if normalize_signal_type(row["signal_type"] or row["event_type"]) == "time_spent":
            time_spent += int(metadata.get("timeSpentSeconds") or metadata.get("timeSpent") or 0)
        if normalize_signal_type(row["signal_type"] or row["event_type"]) == "scroll_depth":
            scroll_depth = max(scroll_depth, int(metadata.get("scrollDepth") or 0))

    meaningful_effort = bool(
        apply_clicks or easy_apply_clicks or application_submitted or external_redirects or
        form_interactions or resume_uploads or cover_letters or time_spent >= 30 or scroll_depth >= 20
    )
    effort_score = clamp(
        min(page_visits, 1) * 2 +
        (20 if time_spent >= 30 else 0) +
        (10 if scroll_depth >= 20 else 0) +
        apply_clicks * 35 +
        easy_apply_clicks * 35 +
        application_submitted * 40 +
        external_redirects * 30 +
        form_interactions * 25 +
        resume_uploads * 35 +
        cover_letters * 30 +
        repeated_visits * 5
    )
    response_score = clamp(response_events * 25)
    delay_penalty = 35 if no_response_events else 0
    authenticity_penalty = 0

    if not meaningful_effort:
        return {
            "signalTypes": signal_types,
            "applyClicks": apply_clicks,
            "easyApplyClicks": easy_apply_clicks,
            "applicationSubmitted": application_submitted,
            "timeSpent": time_spent,
            "scrollDepth": scroll_depth,
            "meaningfulEffort": False,
            "effortScore": effort_score,
            "responseScore": response_score,
            "energySinkScore": None,
            "scoreStatus": "not_enough_effort_data",
            "recommendation": "Tracking",
        }

    energy_sink_score = round(clamp(
        effort_score * 0.45 +
        delay_penalty * 0.30 +
        authenticity_penalty * 0.15 -
        response_score * 0.25
    ), 1)
    score_status = "scored" if no_response_events or response_events else "tracking_response_pending"
    if score_status == "scored":
        if energy_sink_score >= 70:
            recommendation = "Avoid"
        elif energy_sink_score >= 40:
            recommendation = "Apply cautiously"
        else:
            recommendation = "Apply confidently"
    else:
        recommendation = "Apply cautiously" if energy_sink_score >= 40 else "Tracking"

    return {
        "signalTypes": signal_types,
        "applyClicks": apply_clicks,
        "easyApplyClicks": easy_apply_clicks,
        "applicationSubmitted": application_submitted,
        "timeSpent": time_spent,
        "scrollDepth": scroll_depth,
        "meaningfulEffort": True,
        "effortScore": effort_score,
        "responseScore": response_score,
        "energySinkScore": energy_sink_score,
        "scoreStatus": score_status,
        "recommendation": recommendation,
    }

def get_current_user_email(request: Request) -> str:
    auth_header = request.headers.get("Authorization", "")
    if auth_header.lower().startswith("bearer "):
        token = auth_header.split(" ", 1)[1].strip()
        try:
            return (decode_access_token(token).email or "demo@example.com").strip().lower()
        except Exception as exc:
            print("AESD auth decode failed:", str(exc))
    return "demo@example.com"

def get_user_id(email: str) -> int:
    return abs(hash(email.strip().lower())) % 100000000

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    with get_db() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS signals (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                user_email TEXT NOT NULL,
                job_id TEXT NOT NULL,
                job_title TEXT NOT NULL,
                company_name TEXT NOT NULL,
                job_url TEXT NOT NULL,
                platform TEXT NOT NULL,
                page_type TEXT NOT NULL,
                signal_type TEXT NOT NULL,
                timestamp INTEGER NOT NULL,
                metadata TEXT,
                created_at INTEGER NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS tracked_jobs (
                job_id TEXT NOT NULL,
                user_id INTEGER NOT NULL,
                user_email TEXT NOT NULL,
                job_title TEXT NOT NULL,
                company_name TEXT NOT NULL,
                job_url TEXT NOT NULL,
                platform TEXT NOT NULL,
                page_type TEXT NOT NULL,
                effort_score INTEGER NOT NULL DEFAULT 0,
                response_score INTEGER NOT NULL DEFAULT 0,
                total_time_spent INTEGER NOT NULL DEFAULT 0,
                max_scroll_depth INTEGER NOT NULL DEFAULT 0,
                apply_clicks INTEGER NOT NULL DEFAULT 0,
                score_status TEXT NOT NULL DEFAULT 'not_enough_effort_data',
                recommendation TEXT NOT NULL DEFAULT 'Tracking',
                energy_sink_score REAL,
                last_interaction_time INTEGER,
                PRIMARY KEY (job_id, user_id)
            )
        """)
        ensure_columns(conn, "signals", {
            "user_email": "TEXT NOT NULL DEFAULT 'demo@example.com'",
            "job_title": "TEXT NOT NULL DEFAULT ''",
            "company_name": "TEXT NOT NULL DEFAULT ''",
            "job_url": "TEXT NOT NULL DEFAULT ''",
            "platform": "TEXT NOT NULL DEFAULT ''",
            "page_type": "TEXT NOT NULL DEFAULT ''",
            "signal_type": "TEXT NOT NULL DEFAULT ''",
            "event_type": "TEXT NOT NULL DEFAULT ''",
            "timestamp": "INTEGER NOT NULL DEFAULT 0",
            "metadata": "TEXT",
            "created_at": "INTEGER NOT NULL DEFAULT 0",
        })
        ensure_columns(conn, "tracked_jobs", {
            "user_email": "TEXT NOT NULL DEFAULT 'demo@example.com'",
            "job_title": "TEXT NOT NULL DEFAULT ''",
            "company_name": "TEXT NOT NULL DEFAULT ''",
            "job_url": "TEXT NOT NULL DEFAULT ''",
            "platform": "TEXT NOT NULL DEFAULT ''",
            "page_type": "TEXT NOT NULL DEFAULT 'job_detail'",
            "effort_score": "INTEGER NOT NULL DEFAULT 0",
            "response_score": "INTEGER NOT NULL DEFAULT 0",
            "total_time_spent": "INTEGER NOT NULL DEFAULT 0",
            "max_scroll_depth": "INTEGER NOT NULL DEFAULT 0",
            "apply_clicks": "INTEGER NOT NULL DEFAULT 0",
            "score_status": "TEXT NOT NULL DEFAULT 'not_enough_effort_data'",
            "recommendation": "TEXT NOT NULL DEFAULT 'Tracking'",
            "energy_sink_score": "REAL",
            "last_interaction_time": "INTEGER",
        })

def ensure_columns(conn, table, columns):
    existing = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
    for name, definition in columns.items():
        if name not in existing:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {definition}")

init_db()

# Demo Users for submission stability
USER_STORE_PATH = Path(__file__).with_name("users.json")
MOCK_USERS = {
    "alex@example.com": {"name": "Alex Rivera", "password": "password"},
    "demo@example.com": {"name": "Demo User", "password": "password123"},
}

def load_users():
    if USER_STORE_PATH.exists():
        try:
            MOCK_USERS.update(json.loads(USER_STORE_PATH.read_text()))
        except (json.JSONDecodeError, OSError):
            pass

def save_users():
    USER_STORE_PATH.write_text(json.dumps(MOCK_USERS, indent=2))

load_users()

# Models
class SignupBypassRequest(BaseModel):
    name: str
    email: str
    password: str

class UserAuth(BaseModel):
    email: str
    password: str

class OTPRequest(BaseModel):
    email: str

class OTPVerify(BaseModel):
    email: str
    otp: str

class ResetPasswordRequest(BaseModel):
    email: str

class ResetPasswordFinal(BaseModel):
    email: str
    otp: str
    new_password: str

class TrackSignal(BaseModel):
    type: str # ATS_SUBMISSION, INTERVIEW_REDIRECT, STATUS_CHANGE
    payload: dict
    user_id: Optional[int] = 1

class EffortMetrics(BaseModel):
    time_spent: float
    fields_filled: int
    ats_redirects: int
    uploads: int

class JobAnalysisRequest(BaseModel):
    title: str
    description: str
    company: str

class MailAnalysisRequest(BaseModel):
    headers: List[dict]

# Endpoints
@app.get("/")
async def root():
    return {"status": "JobZoid Backend Active", "engine": "FastAPI/Python"}

@app.post("/api/auth/request-otp")
async def request_otp(req: OTPRequest):
    otp = generate_otp()
    otp_db[req.email] = {"otp": otp, "expiry": int(time.time()) + 600}
    success = send_otp_email(req.email, otp)
    if success:
        return {"status": "success", "message": "OTP sent to email"}
    else:
        raise HTTPException(status_code=500, detail="Failed to send email. Check SMTP config.")

@app.post("/api/auth/verify-otp")
async def verify_otp(req: OTPVerify):
    data = otp_db.get(req.email)
    if not data:
        raise HTTPException(status_code=400, detail="No OTP requested for this email")
    
    if int(time.time()) > data["expiry"]:
        raise HTTPException(status_code=400, detail="OTP expired")
    
    if req.otp != data["otp"]:
        raise HTTPException(status_code=400, detail="Invalid OTP")
    
    # Generate token
    access_token = create_access_token(data={"sub": req.email})
    return {
        "access_token": access_token, 
        "token_type": "bearer", 
        "user": {
            "name": req.email.split('@')[0], 
            "email": req.email,
            "isEmailVerified": True,
            "isOnboarded": False
        }
    }

@app.post("/api/auth/forgot-password")
async def forgot_password(req: ResetPasswordRequest):
    otp = generate_otp()
    otp_db[req.email] = {"otp": otp, "expiry": int(time.time()) + 600}
    success = send_otp_email(req.email, otp)
    if success:
        return {"status": "success", "message": "Reset OTP sent"}
    raise HTTPException(status_code=500, detail="Mail delivery failed")

@app.post("/api/auth/reset-password")
async def reset_password(req: ResetPasswordFinal):
    email = req.email.strip().lower()
    data = otp_db.get(email)
    if not data or data["otp"] != req.otp:
        raise HTTPException(status_code=400, detail="Invalid or expired OTP")
    if email in MOCK_USERS:
        MOCK_USERS[email]["password"] = req.new_password
        save_users()
    return {"status": "success", "message": "Password updated successfully"}

@app.post("/api/auth/login")
async def login(auth: UserAuth):
    email = auth.email.strip().lower()
    user = MOCK_USERS.get(email)
    if user and user["password"] == auth.password:
        access_token = create_access_token(data={"sub": email})
        return {"access_token": access_token, "token_type": "bearer", "user": {"name": user["name"], "email": email}}
    raise HTTPException(status_code=400, detail="Incorrect email or password")

@app.post("/api/auth/signup-bypass")
async def signup_bypass(req: SignupBypassRequest):
    email = req.email.strip().lower()
    name = req.name.strip() or email.split('@')[0]
    MOCK_USERS[email] = {"name": name, "password": req.password}
    save_users()
    access_token = create_access_token(data={"sub": email})
    return {
        "access_token": access_token,
        "token_type": "bearer",
        "user": {
            "name": name,
            "email": email,
            "isEmailVerified": True,
            "isOnboarded": False
        }
    }

@app.post("/api/analyze")
async def analyze_job(job: JobAnalysisRequest):
    authenticity_score = predict_authenticity(f"{job.title} {job.description}")
    
    # Mock company history
    history = {"avg_sink_score": 35.5}
    ghost_pred = predict_ghost_job_likelihood({"description": job.description}, history)
    
    # Mock effort (initial state)
    effort = {"time_spent": 15, "fields_filled": 10, "ats_redirects": 1, "uploads": 1}
    sink_result = calculate_energy_sink_score(effort, [])
    
    return {
        "company": job.company,
        "ai_authenticity_score": authenticity_score,
        "energy_sink_score": sink_result["score"],
        "ghost_likelihood": ghost_pred["ghost_likelihood"],
        "is_ghost_listing": ghost_pred["is_ghost_listing"],
        "recommendation": sink_result["recommendation"],
        "needs_alert": sink_result["alert"]
    }

@app.get("/api/dashboard")
async def get_dashboard(request: Request):
  user_email = get_current_user_email(request)
  user_id = get_user_id(user_email)
  print("AESD dashboard requested:", {"user_id": user_id, "email": user_email})
  enhanced_jobs = []
  with get_db() as conn:
    rows = conn.execute("""
      SELECT * FROM tracked_jobs
      WHERE user_id = ?
      ORDER BY COALESCE(last_interaction_time, 0) DESC
    """, (user_id,)).fetchall()
    signal_count = conn.execute("SELECT COUNT(*) AS count FROM signals WHERE user_id = ?", (user_id,)).fetchone()["count"]
  for tracked in rows:
    job_id = tracked["job_id"]
    with get_db() as conn:
      score = score_job_from_db(conn, user_id, job_id)
    print("AESD scoring debug:", {
      "jobId": job_id,
      "jobTitle": tracked["job_title"],
      "company": tracked["company_name"],
      **score,
    })
    enhanced_jobs.append({
      "id": job_id,
      "jobId": job_id,
      "title": tracked["job_title"],
      "company_name": tracked["company_name"],
      "jobTitle": tracked["job_title"],
      "companyName": tracked["company_name"],
      "ai_score": 0,
      "energySinkScore": score["energySinkScore"],
      "scoreStatus": score["scoreStatus"],
      "effortScore": score["effortScore"],
      "responseScore": score["responseScore"],
      "recommendation": score["recommendation"],
      "totalTimeSpent": score["timeSpent"],
      "maxScrollDepth": score["scrollDepth"],
      "applyClicks": score["applyClicks"] + score["easyApplyClicks"] + score["applicationSubmitted"],
      "delayPenalty": 0,
      "lastInteractionTime": tracked["last_interaction_time"],
    })
  for j in jobs_db:
    j_copy = j.copy()
    ai_score = predict_authenticity(f"{j['title']} at {j['company_name']}")
    j_copy["ai_score"] = ai_score
    j_copy["jobId"] = str(j["id"])
    j_copy["jobTitle"] = j["title"]
    j_copy["companyName"] = j["company_name"]
    j_copy["energySinkScore"] = j.get("score", 0)
    j_copy["scoreStatus"] = "scored" if j.get("score") is not None else "not_enough_effort_data"
    j_copy["effortScore"] = 0
    j_copy["responseScore"] = 0
    j_copy["recommendation"] = "Tracking"
    j_copy["totalTimeSpent"] = 0
    j_copy["maxScrollDepth"] = 0
    j_copy["applyClicks"] = 0
    j_copy["delayPenalty"] = 0
    j_copy["lastInteractionTime"] = None
    if j_copy["scoreStatus"] == "scored":
      if j_copy["energySinkScore"] >= 70:
        j_copy["recommendation"] = "Avoid"
      elif j_copy["energySinkScore"] >= 40:
        j_copy["recommendation"] = "Apply cautiously"
      else:
        j_copy["recommendation"] = "Apply confidently"
    enhanced_jobs.append(j_copy)
  return {
    "jobs": enhanced_jobs,
    "signalCount": signal_count,
    "latestScore": max([(job.get("energySinkScore") or 0) for job in enhanced_jobs] + [j.get("score", 0) for j in jobs_db], default=0),
    "lastUpdated": int(time.time())
  }

@app.post("/api/signals")
async def receive_signal(signal: dict, request: Request):
    user_email = get_current_user_email(request)
    user_id = get_user_id(user_email)
    payload = normalize_signal_payload(signal)
    validation_error = validate_signal_payload(payload)
    if validation_error:
        print("AESD signal rejected:", {
            "user_id": user_id,
            "email": user_email,
            "reason": validation_error,
            "payload": payload,
        })
        raise HTTPException(status_code=422, detail=validation_error)

    signal_id = store_signal(user_id, user_email, payload)
    payload["id"] = signal_id
    signals_db.append(payload)
    upsert_tracked_job(user_id, user_email, payload)
    print("AESD signal stored:", {
        "user_id": user_id,
        "email": user_email,
        "signal_id": signal_id,
        "signalType": payload["signalType"],
        "jobId": payload["jobId"],
        "jobTitle": payload["jobTitle"],
        "company": payload["companyName"],
    })
    return {"status": "captured", "id": signal_id, "jobId": payload["jobId"], "timestamp": int(time.time())}

def normalize_signal_type(value):
    value = str(value or "").strip().lower()
    return {
        "apply": "apply_click",
        "easy_apply": "easy_apply_click",
        "easyapply": "easy_apply_click",
        "submitted": "application_submitted",
        "application": "application_submitted",
        "job_page_visit": "page_visit",
        "response": "employer_response_detected",
    }.get(value, value)

def normalize_signal_payload(signal):
    if "payload" in signal and ("type" in signal or "signalType" not in signal):
        payload = dict(signal.get("payload") or {})
        payload["signalType"] = signal.get("type") or payload.get("signalType") or payload.get("eventType")
    else:
        payload = dict(signal)
    signal_type = normalize_signal_type(payload.get("signalType") or payload.get("eventType") or payload.get("type"))
    metadata = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}
    payload["signalType"] = signal_type
    payload["eventType"] = signal_type
    payload["jobTitle"] = payload.get("jobTitle") or payload.get("title") or ""
    payload["companyName"] = payload.get("companyName") or payload.get("company") or ""
    payload["company"] = payload.get("company") or payload.get("companyName") or ""
    payload["jobUrl"] = payload.get("jobUrl") or payload.get("url") or metadata.get("jobUrl") or ""
    payload["platform"] = payload.get("platform") or metadata.get("platform") or ""
    payload["pageType"] = payload.get("pageType") or metadata.get("pageType") or ""
    payload["timestamp"] = payload.get("timestamp") or int(time.time() * 1000)
    payload["metadata"] = {
        **metadata,
        "timeSpentSeconds": payload.get("timeSpentSeconds") or payload.get("timeSpent") or metadata.get("timeSpentSeconds"),
        "scrollDepth": payload.get("scrollDepth") or metadata.get("scrollDepth"),
    }
    return payload

def validate_signal_payload(payload):
    if payload["signalType"] not in SUPPORTED_SIGNAL_TYPES:
        return f"Invalid signalType: {payload['signalType']}"
    if not payload.get("jobId") or not payload.get("jobUrl") or not payload.get("platform"):
        return "Invalid job context: missing jobId, jobUrl, or platform"
    if payload.get("pageType") != "job_detail":
        return "Invalid job context: pageType must be job_detail"
    title = str(payload.get("jobTitle") or "").strip().lower()
    company = str(payload.get("companyName") or "").strip().lower()
    generic_titles = {"", "unknown", "unknown job", "linkedin", "jobs | linkedin", "search results", "job search", "debug job", "jobzoid"}
    generic_companies = {"", "unknown", "unknown company", "localhost", "linkedin", "google", "jobzoid"}
    if title in generic_titles or company in generic_companies:
        return "Invalid job context: generic title or company"
    return None

def score_job_from_db(conn, user_id, job_id):
    rows = conn.execute(
        "SELECT * FROM signals WHERE user_id = ? AND job_id = ?",
        (user_id, job_id),
    ).fetchall()
    return calculate_signal_score(rows)

def store_signal(user_id, user_email, payload):
    with get_db() as conn:
        cursor = conn.execute("""
            INSERT INTO signals (
                user_id, user_email, job_id, job_title, company_name, job_url,
                platform, page_type, signal_type, event_type, timestamp, metadata, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            user_id,
            user_email,
            payload["jobId"],
            payload["jobTitle"],
            payload["companyName"],
            payload["jobUrl"],
            payload["platform"],
            payload["pageType"],
            payload["signalType"],
            payload["signalType"],
            int(payload.get("timestamp") or int(time.time() * 1000)),
            json.dumps(payload.get("metadata") or {}),
            int(time.time()),
        ))
        return cursor.lastrowid

def upsert_tracked_job(user_id, user_email, payload):
    job_id = payload["jobId"]
    now = int(time.time())
    with get_db() as conn:
        signal_rows = conn.execute(
            "SELECT * FROM signals WHERE job_id = ? AND user_id = ?",
            (job_id, user_id),
        ).fetchall()
        score = calculate_signal_score(signal_rows)
        existing = conn.execute(
            "SELECT * FROM tracked_jobs WHERE job_id = ? AND user_id = ?",
            (job_id, user_id),
        ).fetchone()
        if existing:
            conn.execute("""
                UPDATE tracked_jobs
                SET job_title = ?,
                    company_name = ?,
                    job_url = ?,
                    platform = ?,
                    page_type = ?,
                    effort_score = ?,
                    response_score = ?,
                    total_time_spent = ?,
                    max_scroll_depth = ?,
                    apply_clicks = ?,
                    score_status = ?,
                    recommendation = ?,
                    energy_sink_score = ?,
                    last_interaction_time = ?
                WHERE job_id = ? AND user_id = ?
            """, (
                payload["jobTitle"] or existing["job_title"],
                payload["companyName"] or existing["company_name"],
                payload["jobUrl"],
                payload["platform"],
                payload["pageType"],
                score["effortScore"],
                score["responseScore"],
                score["timeSpent"],
                score["scrollDepth"],
                score["applyClicks"] + score["easyApplyClicks"] + score["applicationSubmitted"],
                score["scoreStatus"],
                score["recommendation"],
                score["energySinkScore"],
                now,
                job_id,
                user_id,
            ))
        else:
            conn.execute("""
                INSERT INTO tracked_jobs (
                    job_id, user_id, user_email, job_title, company_name, job_url,
                    platform, page_type, effort_score, response_score, total_time_spent,
                    max_scroll_depth, apply_clicks, score_status, recommendation,
                    energy_sink_score, last_interaction_time
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                job_id,
                user_id,
                user_email,
                payload["jobTitle"],
                payload["companyName"],
                payload["jobUrl"],
                payload["platform"],
                payload["pageType"],
                score["effortScore"],
                score["responseScore"],
                score["timeSpent"],
                score["scrollDepth"],
                score["applyClicks"] + score["easyApplyClicks"] + score["applicationSubmitted"],
                score["scoreStatus"],
                score["recommendation"],
                score["energySinkScore"],
                now,
            ))
    print("AESD scoring debug:", {
        "jobId": job_id,
        "jobTitle": payload["jobTitle"],
        "company": payload["companyName"],
        **score,
    })

@app.get("/api/scores")
async def get_score_by_query(request: Request, jobId: str, jobTitle: Optional[str] = None, companyName: Optional[str] = None):
    user_email = get_current_user_email(request)
    user_id = get_user_id(user_email)
    with get_db() as conn:
        tracked = conn.execute(
            "SELECT * FROM tracked_jobs WHERE job_id = ? AND user_id = ?",
            (jobId, user_id),
        ).fetchone()
        score = score_job_from_db(conn, user_id, jobId) if tracked else None
    if not tracked:
        return {
            "jobId": jobId,
            "jobTitle": jobTitle,
            "companyName": companyName,
            "energySinkScore": None,
            "scoreStatus": "not_enough_effort_data",
            "recommendation": "Tracking",
            "effortScore": 0,
            "responseScore": 0,
        }
    print("AESD scoring debug:", {
        "jobId": jobId,
        "jobTitle": tracked["job_title"],
        "company": tracked["company_name"],
        **score,
    })
    return {
        "jobId": jobId,
        "jobTitle": tracked["job_title"],
        "companyName": tracked["company_name"],
        "energySinkScore": score["energySinkScore"],
        "scoreStatus": score["scoreStatus"],
        "effortScore": score["effortScore"],
        "responseScore": score["responseScore"],
        "recommendation": score["recommendation"],
        "totalTimeSpent": score["timeSpent"],
        "maxScrollDepth": score["scrollDepth"],
        "applyClicks": score["applyClicks"] + score["easyApplyClicks"] + score["applicationSubmitted"],
        "lastInteractionTime": tracked["last_interaction_time"],
    }

@app.get("/api/debug/signals/recent")
async def recent_signals(request: Request):
    user_email = get_current_user_email(request)
    user_id = get_user_id(user_email)
    with get_db() as conn:
        rows = conn.execute("""
            SELECT job_id, job_title, company_name, signal_type, created_at
            FROM signals
            WHERE user_id = ?
            ORDER BY id DESC
            LIMIT 10
        """, (user_id,)).fetchall()
    return {
        "dbPath": str(DB_PATH),
        "user_id": user_id,
        "email": user_email,
        "signals": [dict(row) for row in rows],
    }

@app.get("/api/scores/{job_id}")
async def get_score(job_id: int):
    # SQL Implementation Example (Commented):
    # SELECT (SUM(e.value * weight) / MAX(1, COUNT(s.id))) FROM effort_logs e...

    effort = {"time_spent": 45, "fields_filled": 20, "ats_redirects": 2, "uploads": 2}
    responses = [{"type": "ACK"}]
    result = calculate_energy_sink_score(effort, responses)
    return {
        "job_id": job_id,
        "energySinkScore": result["score"],
        "scoreStatus": result.get("scoreStatus", "scored"),
        "recommendation": result["recommendation"],
        "alert": result["alert"]
    }

@app.get("/api/analytics")
async def get_analytics():
    return {
        "totalApplications": 0,
        "averageResponseRate": 0,
        "averageEnergyScore": 0,
        "topRiskyCompanies": [],
        "bestCompanies": [],
        "signalCount": 0,
        "lastUpdated": None
    }

@app.post("/api/mail/analyze")
async def analyze_mail(req: MailAnalysisRequest):
    signals = analyze_email_signals(req.headers)
    return {
        "status": "success",
        "signal_count": len(signals),
        "signals": signals
    }

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
