# JobZoid

JobZoid is an applicant authenticity and effort tracking platform. It combines a FastAPI scoring backend, a React/Vite dashboard, and a Manifest V3 Chrome extension that captures job-search activity signals such as page visits, scroll depth, time spent, apply clicks, and response markers.

## Tech Stack

- FastAPI, Python, SQLite
- React, Vite, Tailwind CSS
- Chrome Extension API, Manifest V3
- Scikit-learn TF-IDF and RandomForest model
- Legacy Node/Express files are still present, but FastAPI is the primary backend

## Project Structure

```text
.
|-- extension/          # Chrome extension
|-- fastapi-backend/    # FastAPI API, auth, ML, scoring, SQLite demo DB
|-- frontend/           # React/Vite dashboard
|-- server.js           # Legacy Express server
|-- package.json        # Legacy Node dependencies
`-- README.md
```

## Local Setup

### Backend

```bash
cd fastapi-backend
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
python main.py
```

The backend runs on `http://localhost:8000`. Keep this port for local frontend and extension compatibility unless you update the extension popup setting and `VITE_API_URL`.

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Set `VITE_API_URL=http://localhost:8000` when using a non-default backend URL.

### Chrome Extension

1. Open `chrome://extensions/`.
2. Enable Developer Mode.
3. Click "Load unpacked".
4. Select the `extension/` folder.
5. Open the extension popup and confirm the backend URL, for example `http://localhost:8000`.

## Demo Login

The FastAPI seed user is:

- Email: `alex@example.com`
- Password: `password`

## Current Notes

- The extension now uses a popup, configurable backend URL, canonical job IDs, and job-page gating.
- `/api/analyze` calls the local ML authenticity predictor.
- Dashboard, analytics, leaderboard, employer, admin, password reset, and email-header analysis flows are backed by FastAPI routes.
